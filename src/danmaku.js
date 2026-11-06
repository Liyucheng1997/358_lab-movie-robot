// 弹幕：外部弹幕取自豆瓣「正版播放平台」给出的节目 ID（哔哩哔哩番剧 season、腾讯视频 cid、爱奇艺 aid/tvid），
// 不靠片名模糊匹配；本站用户发送的弹幕按影片追加写入 JSONL 文件。
// 统一格式 [秒, 模式, 颜色, 文字, 来源]，模式 0 滚动 / 1 顶部 / 2 底部，颜色为 6 位十六进制。
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const inflate = promisify(zlib.inflate);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SEG = 300; // 按 5 分钟分段加载，和爱奇艺的分段一致
const SEG_LIMIT = 300; // 每个来源每段最多取这么多条，按点赞数优先
const MIN = 60 * 1000;
const SOURCE_NAMES = { bili: '哔哩哔哩', iqiyi: '爱奇艺', qq: '腾讯视频', site: '本站' };
const EXTRA = /预告|花絮|彩蛋|片花|特辑|幕后|看点|抢先/;

// ---------- 缓存：存 Promise，同一请求并发时只抓一次，失败不缓存 ----------
const caches = new Map();
function cached(bucket, key, ttl, max, loader) {
  if (!caches.has(bucket)) caches.set(bucket, new Map());
  const map = caches.get(bucket);
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = loader();
  map.set(key, { value, expires: Date.now() + ttl });
  value.catch(() => map.get(key)?.value === value && map.delete(key));
  if (map.size > max) map.delete(map.keys().next().value);
  return value;
}

async function get(url, { referer, type = 'json', init = {} } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}), ...init.headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw Object.assign(new Error(`弹幕接口返回 ${res.status}`), { status: res.status });
  if (type === 'json') return res.json();
  if (type === 'text') return res.text();
  return Buffer.from(await res.arrayBuffer());
}

// ---------- 解析 ----------
function vendorIds(vendors = []) {
  const ids = {};
  for (const v of vendors) {
    const s = `${v.url || ''} ${v.uri || ''}`;
    let m;
    if (v.id === 'bilibili' && (m = s.match(/\/ss(\d+)|pgc\/season\/(\d+)/))) ids.bili = m[1] || m[2];
    if (v.id === 'qq' && (m = s.match(/cid=([a-z0-9]+)/i))) ids.qq = m[1];
    if (v.id === 'iqiyi' && (m = s.match(/aid=(\d+)&tvid=(\d+)/))) ids.iqiyi = { aid: m[1], tvid: m[2] };
  }
  return ids;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXML(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

const hex = (n) => (Number(n) & 0xffffff).toString(16).padStart(6, '0');
const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

// B 站 XML：<d p="秒,模式,字号,颜色十进制,...">文字</d>，模式 1-3 滚动、4 底部、5 顶部，7 以上是高级弹幕
function parseBili(xml) {
  const out = [];
  for (const [, p, text] of xml.matchAll(/<d p="([^"]+)">([^<]*)<\/d>/g)) {
    const [t, mode, , color] = p.split(',');
    const m = Number(mode);
    if (m > 5) continue;
    const s = clean(unescapeXML(text));
    if (s) out.push([Number(t), m === 5 ? 1 : m === 4 ? 2 : 0, hex(color), s, 'bili', 0]);
  }
  return out;
}

// 爱奇艺 XML：每个 <bulletInfo> 带 content、showTime（秒）、color、likeCount
function parseIqiyi(xml) {
  const out = [];
  for (const [, block] of xml.matchAll(/<bulletInfo>([\s\S]*?)<\/bulletInfo>/g)) {
    const tag = (name) => (block.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1] || '';
    const s = clean(unescapeXML(tag('content')));
    const color = /^[0-9a-f]{6}$/i.test(tag('color')) ? tag('color').toLowerCase() : 'ffffff';
    // 爱奇艺的 position 编码没有公开说明，统一按滚动弹幕显示
    if (s) out.push([Number(tag('showTime')) || 0, 0, color, s, 'iqiyi', Number(tag('likeCount')) || 0]);
  }
  return out;
}

// 腾讯视频 JSON：time_offset 毫秒，content_style 里有颜色
function parseQQ(json) {
  return (json.barrage_list || []).map((b) => {
    let style = {};
    try { style = b.content_style ? JSON.parse(b.content_style) : {}; } catch { /* 部分弹幕没有样式 */ }
    const color = /^[0-9a-f]{6}$/i.test(style.color || '') ? style.color.toLowerCase() : 'ffffff';
    // 位置编码同样没有公开说明，统一滚动
    return [Number(b.time_offset) / 1000, 0, color, clean(b.content || ''), 'qq', Number(b.up_count) || 0];
  }).filter((d) => d[3]);
}

// 只留点赞多的；点赞相同时保持时间均匀
function top(list, limit = SEG_LIMIT) {
  if (list.length <= limit) return list;
  return list.map((d, i) => [d, i]).sort((a, b) => b[0][5] - a[0][5] || a[1] - b[1]).slice(0, limit).map(([d]) => d);
}

const strip = (list) => list.map((d) => d.slice(0, 5)).sort((a, b) => a[0] - b[0]);

// ---------- 各平台：正片列表 ----------
async function biliEpisodes(seasonId) {
  const j = await get(`https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`, { referer: 'https://www.bilibili.com/' });
  if (j.code !== 0) throw new Error(`B 站接口返回 ${j.code}`);
  return (j.result?.episodes || [])
    .filter((e) => !EXTRA.test(`${e.badge || ''}${e.title || ''}${e.long_title || ''}`))
    .map((e) => ({ key: String(e.cid), duration: Math.round((e.duration || 0) / 1000) }));
}

async function qqPage(cid, pageContext = '') {
  const body = {
    page_params: { req_from: 'web_vsite', page_id: 'vsite_episode_list', page_type: 'detail_operation', id_type: '1', page_size: '', cid, vid: '', lid: '', page_num: '', page_context: pageContext, detail_page_type: '1' },
    has_cache: 1,
  };
  const j = await get('https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vplatform=2', {
    referer: 'https://v.qq.com/',
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://v.qq.com' }, body: JSON.stringify(body) },
  });
  const module = j.data?.module_list_datas?.[0]?.module_datas?.[0] || {};
  let tabs = [];
  try { tabs = JSON.parse(module.module_params?.tabs || '[]'); } catch { /* 没有分页 */ }
  return { items: module.item_data_lists?.item_datas || [], tabs };
}

async function qqEpisodes(cid) {
  const first = await qqPage(cid);
  // 超过 30 集时按「1-30」「31-60」等分页标签继续取
  const rest = await Promise.all(first.tabs.slice(1).map((t) => qqPage(cid, t.page_context).then((p) => p.items)));
  return [first.items, ...rest].flat()
    .map((i) => i.item_params || {})
    .filter((p) => p.vid && p.is_trailer !== '1' && !EXTRA.test(p.title || ''))
    .map((p) => ({ key: p.vid, duration: Number(p.duration) || 0 }));
}

async function iqiyiEpisodes({ aid, tvid }) {
  if (aid === tvid) return [{ key: tvid, duration: 0 }]; // 电影的专辑 ID 就是视频 ID
  // tvId 可能超过 2^53，先把数字改成字符串再解析
  const text = await get(`https://pcw-api.iqiyi.com/albums/album/avlistinfo?aid=${aid}&page=1&size=200`, { type: 'text' });
  const j = JSON.parse(text.replace(/"tvId":(\d+)/g, '"tvId":"$1"'));
  return (j.data?.epsodelist || [])
    .filter((e) => e.contentType === 1 && !EXTRA.test(e.name || ''))
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ key: e.tvId, duration: 0 }));
}

const EPISODES = { bili: biliEpisodes, qq: qqEpisodes, iqiyi: iqiyiEpisodes };

function episodes(src, id) {
  return cached('episodes', `${src}:${JSON.stringify(id)}`, 6 * 60 * MIN, 500, () => EPISODES[src](id));
}

// ---------- 各平台：取一段弹幕 ----------
function biliAll(cid) {
  // B 站一次返回整集（上限几千条），整集缓存后再切段
  return cached('bili-all', cid, 60 * MIN, 30, async () =>
    parseBili(await get(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { type: 'text' })));
}

async function biliSegment(cid, seg) {
  const all = await biliAll(cid);
  return all.filter((d) => d[0] >= seg * SEG && d[0] < (seg + 1) * SEG);
}

async function iqiyiSegment(tvid, seg) {
  const url = `https://cmts.iqiyi.com/bullet/${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_${seg + 1}.z`;
  try {
    return parseIqiyi((await inflate(await get(url, { type: 'buffer' }))).toString('utf8'));
  } catch (e) {
    if (e.status === 404) return []; // 超出片长
    throw e;
  }
}

async function qqSegment(vid, seg) {
  // 腾讯按 30 秒一个分段
  const parts = await Promise.all(Array.from({ length: SEG / 30 }, (_, i) => {
    const start = (seg * SEG + i * 30) * 1000;
    return get(`https://dm.video.qq.com/barrage/segment/${vid}/t/v1/${start}/${start + 30000}`)
      .then(parseQQ, (e) => (e.status === 404 ? [] : Promise.reject(e)));
  }));
  return parts.flat();
}

const SEGMENTS = { bili: biliSegment, iqiyi: iqiyiSegment, qq: qqSegment };

function external(src, key, seg) {
  return cached('segments', `${src}:${key}:${seg}`, 60 * MIN, 600, async () => top(await SEGMENTS[src](key, seg)));
}

// 第 ep 集（从 1 开始）在各平台对应的节目；集数超出某个平台的正片数时那个平台不提供弹幕
async function resolve(ids, ep) {
  const found = await Promise.all(Object.entries(ids).map(async ([src, id]) => {
    try {
      const list = await episodes(src, id);
      const hit = list.length === 1 && ep === 1 ? list[0] : list[ep - 1];
      return hit ? { src, key: hit.key } : null;
    } catch (e) {
      console.error(`弹幕：${SOURCE_NAMES[src]}选集加载失败:`, e.message);
      return null;
    }
  }));
  return found.filter(Boolean);
}

// ---------- 本站弹幕 ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const fileOf = (id) => path.join(DATA_DIR, 'danmaku', `${id}.jsonl`);
const local = new Map(); // 影片 ID → Promise<数组>，写入时同步追加

function localAll(id) {
  if (!local.has(id)) {
    local.set(id, fs.readFile(fileOf(id), 'utf8').then(
      (text) => text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean),
      (e) => (e.code === 'ENOENT' ? [] : Promise.reject(e))
    ));
    if (local.size > 500) local.delete(local.keys().next().value);
  }
  return local.get(id);
}

const MODES = [0, 1, 2];
function validate(input) {
  if (!input || typeof input !== 'object') return '格式不正确';
  const text = clean(input.text || '');
  if (!text) return '弹幕不能为空';
  if ([...text].length > 50) return '弹幕最多 50 个字';
  const ep = Number(input.ep);
  const t = Number(input.t);
  if (!Number.isInteger(ep) || ep < 1 || ep > 5000) return '集数不正确';
  if (!Number.isFinite(t) || t < 0 || t > 6 * 3600) return '时间不正确';
  if (!/^[0-9a-f]{6}$/i.test(input.color || 'ffffff')) return '颜色不正确';
  if (!MODES.includes(Number(input.mode || 0))) return '位置不正确';
  return { ep, t: Math.round(t * 10) / 10, mode: Number(input.mode || 0), color: (input.color || 'ffffff').toLowerCase(), text };
}

async function add(id, item) {
  const record = { ...item, at: Date.now() };
  const list = await localAll(id);
  await fs.mkdir(path.dirname(fileOf(id)), { recursive: true });
  await fs.appendFile(fileOf(id), JSON.stringify(record) + '\n');
  list.push(record);
  return record;
}

// 每个 IP 3 秒一条、10 分钟最多 30 条
const senders = new Map();
function allowSend(ip, now = Date.now()) {
  const recent = (senders.get(ip) || []).filter((at) => now - at < 10 * MIN);
  if (recent.length && now - recent[recent.length - 1] < 3000) return '发得太快了，歇 3 秒再发';
  if (recent.length >= 30) return '发送太频繁，请稍后再试';
  recent.push(now);
  senders.set(ip, recent);
  if (senders.size > 5000) senders.delete(senders.keys().next().value);
  return true;
}

// ---------- 对外：一集的一段弹幕 ----------
async function segment(ids, filmId, ep, seg) {
  const targets = await resolve(ids, ep);
  const results = await Promise.all(targets.map(({ src, key }) =>
    external(src, key, seg).catch((e) => {
      console.error(`弹幕：${SOURCE_NAMES[src]}第 ${seg} 段加载失败:`, e.message);
      return [];
    })));
  const mine = (await localAll(filmId))
    .filter((d) => d.ep === ep && d.t >= seg * SEG && d.t < (seg + 1) * SEG)
    .map((d) => [d.t, d.mode, d.color, d.text, 'site']);
  return {
    segment: SEG,
    sources: [...targets.map((x) => ({ id: x.src, name: SOURCE_NAMES[x.src] })), { id: 'site', name: SOURCE_NAMES.site }],
    items: strip([...results.flat(), ...mine]),
  };
}

module.exports = { SEG, SOURCE_NAMES, vendorIds, parseBili, parseIqiyi, parseQQ, top, validate, allowSend, segment, add, resolve };
