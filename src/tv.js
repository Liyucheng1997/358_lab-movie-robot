// 电视直播：参照 iptv 开源项目的做法——定时抓取公开直播源，逐条检测能否播放，导出网页用的频道数据和 M3U / TXT 播放列表。
// 数据来自 iptv-org（https://github.com/iptv-org/iptv）公开整理的频道库，另外可以用 TV_EXTRA_M3U 追加其他公开 M3U 源。
// 只收录公开、免费的直播地址；遵守 iptv-org 的屏蔽名单（版权投诉、成人内容），并排除已停播和成人频道。
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const API = 'https://iptv-org.github.io/api/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// 检测跨域时用的来源，和网页实际播放时浏览器发出的 Origin 一致
const ORIGIN = process.env.TV_CHECK_ORIGIN || 'https://movie.liyucheng.me';
const UPDATE_HOURS = 6;

const CATEGORY_NAMES = {
  general: '综合', news: '新闻', sports: '体育', movies: '电影', series: '剧集', kids: '少儿', animation: '动画',
  music: '音乐', entertainment: '娱乐', documentary: '纪录', science: '科学', education: '教育', culture: '文化',
  business: '财经', lifestyle: '生活', cooking: '美食', travel: '旅行', outdoor: '户外', auto: '汽车', comedy: '喜剧',
  classic: '经典', family: '家庭', relax: '休闲', weather: '天气', legislative: '议会', public: '公共', religious: '宗教',
  shop: '购物', interactive: '互动', other: '其他',
};
// 中文用户常看的地区排在前面，其余按频道数
const COUNTRY_FIRST = ['CN', 'HK', 'TW', 'MO', 'SG', 'MY', 'JP', 'KR', 'US', 'UK', 'CA', 'AU', 'FR', 'DE'];
const countryOrder = (code) => { const i = COUNTRY_FIRST.indexOf(code); return i < 0 ? (code === 'ZZ' ? 999 : 99) : i; };

const regionNames = (() => {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch (e) { return null; }
})();
// 地区名太长的用简称
const SHORT_NAMES = { HK: '香港', MO: '澳门', TW: '台湾' };
// iptv-org 用 UK 表示英国；ZZ 是没有归属国家的频道
function countryName(code, fallback) {
  if (code === 'ZZ') return '其他';
  if (SHORT_NAMES[code]) return SHORT_NAMES[code];
  try { return (regionNames && regionNames.of(code === 'UK' ? 'GB' : code)) || fallback || code; } catch (e) { return fallback || code; }
}

// ---------- 抓取 ----------
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`${url} 返回 ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url} 返回 ${r.status}`);
  return r.text();
}

// 解析 M3U：#EXTINF 行里的 tvg-id、tvg-logo、group-title 和频道名，下一行是地址
function parseM3U(text) {
  const out = [];
  let info = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = (k) => (line.match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
      const comma = line.lastIndexOf(',');
      info = { tvgId: attr('tvg-id'), logo: attr('tvg-logo'), group: attr('group-title'), name: comma >= 0 ? line.slice(comma + 1).trim() : '' };
    } else if (!line.startsWith('#')) {
      if (info && /^https?:\/\//i.test(line)) out.push({ ...info, url: line });
      info = null;
    }
  }
  return out;
}

// 没有频道编号的地址只有名字，按文字猜地区：有假名 → 日本，有谚文 → 韩国，有汉字 → 中国，否则归为「其他」
function guessCountry(name) {
  if (/[぀-ヿ]/.test(name)) return 'JP';
  if (/[가-힯]/.test(name)) return 'KR';
  if (/[一-鿿]/.test(name)) return 'CN';
  return 'ZZ';
}

// 合并 iptv-org 数据和额外 M3U 源，得到 频道 → 候选地址
function collect({ channels = [], streams = [], logos = [], blocklist = [], extra = [] }) {
  const blocked = new Set(blocklist.map((b) => b.channel));
  const meta = new Map();
  for (const c of channels) {
    if (c.closed || c.is_nsfw || blocked.has(c.id) || (c.categories || []).includes('xxx')) continue;
    meta.set(c.id, c);
  }
  // 每个频道挑一个正在使用的台标，优先频道主台标（不带 feed）
  const logoOf = new Map();
  for (const l of logos) {
    if (!l.url || !meta.has(l.channel)) continue;
    const rank = (l.in_use ? 0 : 2) + (l.feed ? 1 : 0);
    const cur = logoOf.get(l.channel);
    if (!cur || rank < cur.rank) logoOf.set(l.channel, { url: l.url, rank });
  }
  const out = new Map();
  const seen = new Set();
  function add(id, base, stream) {
    if (seen.has(stream.url)) return;
    seen.add(stream.url);
    if (!out.has(id)) out.set(id, { ...base, streams: [] });
    out.get(id).streams.push(stream);
  }
  for (const s of streams) {
    // 需要特定 Referer / User-Agent 的地址浏览器和大多数播放器都带不上，跳过
    if (s.referrer || s.user_agent || !/^https?:\/\//i.test(s.url || '')) continue;
    if (s.channel) {
      const c = meta.get(s.channel);
      if (!c) continue; // 停播、成人或被屏蔽的频道
      add(c.id, {
        id: c.id, name: c.name, alt: (c.alt_names || []).slice(0, 3), country: c.country || 'ZZ',
        categories: (c.categories || []).filter((x) => CATEGORY_NAMES[x]), logo: (logoOf.get(c.id) || {}).url || '',
      }, { url: s.url, title: s.title || '', quality: s.quality || '' });
    } else if (s.title) {
      if (blocked.has(s.title)) continue;
      add('t:' + s.title, { id: 't:' + s.title, name: s.title, alt: [], country: guessCountry(s.title), categories: [], logo: '' },
        { url: s.url, title: s.title, quality: s.quality || '' });
    }
  }
  for (const e of extra) {
    const c = e.tvgId && meta.get(e.tvgId);
    if (e.tvgId && blocked.has(e.tvgId)) continue;
    if (c) {
      add(c.id, { id: c.id, name: c.name, alt: (c.alt_names || []).slice(0, 3), country: c.country || 'ZZ',
        categories: (c.categories || []).filter((x) => CATEGORY_NAMES[x]), logo: (logoOf.get(c.id) || {}).url || e.logo || '' },
      { url: e.url, title: e.name, quality: '' });
    } else if (e.name) {
      add('x:' + e.name, { id: 'x:' + e.name, name: e.name, alt: [], country: guessCountry(e.name), categories: [], logo: e.logo || '', group: e.group },
        { url: e.url, title: e.name, quality: '' });
    }
  }
  return [...out.values()];
}

// ---------- 检测 ----------
function firstUri(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && line[0] !== '#') return line;
  }
  return '';
}

// 最多读 limit 字节；有的「m3u8」其实是不断流的 TS，不能整个读完
async function readLimited(res, limit) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= limit) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

// 和网页播放器一样：取播放列表 →（多码率时）取子播放列表 → 取第一个视频分片的开头。
// web 表示浏览器能直接播：全程 HTTPS，且每一步都允许跨域
async function checkStream(url, { timeout = 10000, origin = ORIGIN } = {}) {
  const start = Date.now();
  const signal = AbortSignal.timeout(timeout);
  const headers = { 'User-Agent': UA, Origin: origin, Accept: '*/*' };
  let cors = true;
  let https = /^https:/i.test(url);
  const note = (r) => {
    const allow = r.headers.get('access-control-allow-origin');
    if (allow !== '*' && allow !== origin) cors = false;
    if (!/^https:/i.test(r.url || url)) https = false;
  };
  async function playlist(u) {
    const r = await fetch(u, { headers, signal, redirect: 'follow' });
    if (!r.ok) throw new Error('返回 ' + r.status);
    note(r);
    const body = await readLimited(r, 512 * 1024);
    if (!body.includes('#EXTM3U')) throw new Error('不是播放列表');
    return { body, at: r.url || u };
  }
  try {
    let { body, at } = await playlist(url);
    let height = 0;
    if (body.includes('#EXT-X-STREAM-INF')) {
      const heights = [...body.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
      if (heights.length) height = Math.max(...heights);
      const variant = firstUri(body);
      if (!variant) throw new Error('播放列表为空');
      ({ body, at } = await playlist(new URL(variant, at).href));
    }
    const seg = firstUri(body);
    if (!seg) throw new Error('播放列表为空');
    const r = await fetch(new URL(seg, at), { headers: { ...headers, Range: 'bytes=0-4095' }, signal, redirect: 'follow' });
    if (!r.ok) throw new Error('分片返回 ' + r.status);
    note(r);
    if (r.body) r.body.cancel().catch(() => {});
    return { ok: true, ms: Date.now() - start, height, web: https && cors };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message };
  }
}

async function pool(items, concurrency, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

// ---------- 导出 ----------
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
const quality = (s) => (s.height ? s.height + 'p' : s.quality || '');

function groupName(c, countries) {
  const meta = countries[c.country] || {};
  return ((meta.flag ? meta.flag + ' ' : '') + countryName(c.country, meta.name)).trim();
}

// 通用 M3U：可导入 VLC、PotPlayer、TiviMate、Kodi 等播放器
function toM3U(list, countries) {
  const lines = ['#EXTM3U'];
  for (const c of list) {
    for (const s of c.streams) {
      const attrs = [`tvg-id="${c.id.startsWith('t:') || c.id.startsWith('x:') ? '' : c.id}"`, `tvg-logo="${c.logo || ''}"`, `group-title="${groupName(c, countries)}"`];
      lines.push(`#EXTINF:-1 ${attrs.join(' ')},${c.name}${quality(s) ? ' (' + quality(s) + ')' : ''}`, s.url);
    }
  }
  return lines.join('\n') + '\n';
}

// 国内 IPTV 工具常用的 TXT：「分组,#genre#」后面每行「频道名,地址」
function toTXT(list, countries) {
  const groups = new Map();
  for (const c of list) {
    const g = groupName(c, countries);
    if (!groups.has(g)) groups.set(g, []);
    for (const s of c.streams) groups.get(g).push(`${c.name.replace(/,/g, ' ')},${s.url}`);
  }
  return [...groups].map(([g, rows]) => `${g},#genre#\n${rows.join('\n')}`).join('\n\n') + '\n';
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
  // 顺便存一份 gzip，服务端直接发压缩版
  if (/\.(json|m3u|txt)$/.test(file)) {
    await fs.writeFile(tmp, zlib.gzipSync(content));
    await fs.rename(tmp, file + '.gz');
  }
}

// 把检测结果整理成网页数据：index.json（地区、类型、统计）和每个地区一个 c/XX.json，只含网页能直接播的地址
function buildWeb(list, countries, { updatedAt, checked }) {
  const web = [];
  for (const c of list) {
    const s = c.streams.filter((x) => x.web).sort((a, b) => a.ms - b.ms);
    if (s.length) web.push({ ...c, streams: s });
  }
  const byCountry = new Map();
  for (const c of web) {
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }
  const countryList = [...byCountry].map(([code, items]) => ({
    code, name: countryName(code, (countries[code] || {}).name), flag: (countries[code] || {}).flag || '', count: items.length,
  })).sort((a, b) => countryOrder(a.code) - countryOrder(b.code) || b.count - a.count);
  const catCount = {};
  for (const c of web) for (const k of c.categories.length ? c.categories : ['other']) catCount[k] = (catCount[k] || 0) + 1;
  const files = {};
  for (const [code, items] of byCountry) {
    files[code] = items.sort(byName).map((c) => ({
      id: c.id, n: c.name, a: c.alt.length ? c.alt : undefined, cat: c.categories.length ? c.categories : undefined, l: c.logo || undefined,
      s: c.streams.map((x) => ({ u: x.url, q: quality(x) || undefined, ms: x.ms })),
    }));
  }
  const index = {
    updatedAt, source: 'iptv-org',
    stats: { channels: list.length, streams: list.reduce((n, c) => n + c.streams.length, 0), web: web.length, checked },
    countries: countryList,
    categories: Object.entries(catCount).sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, name: CATEGORY_NAMES[id] || id, count })),
  };
  return { index, files };
}

// 一次完整更新：抓取 → 检测 → 写文件。写完一个文件替换一个，旧数据在新数据写好前一直可用
async function update({ dir, concurrency = 64, timeout = 10000, limit = 0, log = console.log } = {}) {
  const t0 = Date.now();
  log('电视直播源：开始抓取 iptv-org 数据…');
  const [channels, streams, logos, blocklist, countryList] = await Promise.all(
    ['channels', 'streams', 'logos', 'blocklist', 'countries'].map((n) => getJSON(API + n + '.json'))
  );
  const extra = [];
  for (const url of String(process.env.TV_EXTRA_M3U || '').split(/[\s,]+/).filter(Boolean)) {
    try { extra.push(...parseM3U(await getText(url))); } catch (e) { log(`额外源 ${url} 抓取失败：${e.message}`); }
  }
  let list = collect({ channels, streams, logos, blocklist, extra });
  const all = list.flatMap((c) => c.streams.map((s) => ({ c, s })));
  // --limit 用于试跑：均匀抽样，各地区都能抽到
  const step = limit ? Math.max(1, Math.ceil(all.length / limit)) : 1;
  const jobs = step > 1 ? all.filter((_, i) => i % step === 0) : all;
  log(`电视直播源：${list.length} 个频道、${all.length} 个地址，开始检测${limit ? `（抽样 ${jobs.length} 个）` : ''}…`);
  let done = 0;
  await pool(jobs, concurrency, async ({ s }) => {
    Object.assign(s, await checkStream(s.url, { timeout }));
    done++;
    if (done % 1000 === 0) log(`电视直播源：已检测 ${done}/${jobs.length}`);
  });
  const tested = new Set(jobs.map((j) => j.s));
  list = list.map((c) => ({ ...c, streams: c.streams.filter((s) => tested.has(s) && s.ok) })).filter((c) => c.streams.length);
  // 播放列表的分组顺序和网页一致：中文地区在前
  list.sort((a, b) => countryOrder(a.country) - countryOrder(b.country) || a.country.localeCompare(b.country) || byName(a, b));
  const countries = Object.fromEntries(countryList.map((c) => [c.code, c]));
  const updatedAt = new Date().toISOString();
  const { index, files } = buildWeb(list, countries, { updatedAt, checked: jobs.length });
  for (const [code, items] of Object.entries(files)) await writeFile(path.join(dir, 'data', 'c', code + '.json'), JSON.stringify(items));
  await writeFile(path.join(dir, 'playlist.m3u'), toM3U(list, countries));
  await writeFile(path.join(dir, 'playlist.txt'), toTXT(list, countries));
  await writeFile(path.join(dir, 'data', 'index.json'), JSON.stringify(index)); // 最后写索引，前面的文件都已就绪
  log(`电视直播源：完成，${index.stats.channels} 个频道可用（网页可播 ${index.stats.web} 个），用时 ${Math.round((Date.now() - t0) / 60000)} 分钟`);
  return index;
}

// 服务端定时更新：启动时数据超过 6 小时就更新，之后每半小时看一眼是否到期
function schedule({ dir, hours = UPDATE_HOURS, log = console.log } = {}) {
  let running = false;
  async function tick() {
    if (running) return;
    try {
      const st = await fs.stat(path.join(dir, 'data', 'index.json'));
      if (Date.now() - st.mtimeMs < hours * 3600e3) return;
    } catch (e) { /* 还没有数据 */ }
    running = true;
    try { await update({ dir, log }); } catch (e) { log('电视直播源更新失败：' + e.message); } finally { running = false; }
  }
  setTimeout(tick, 15000).unref();
  setInterval(tick, 30 * 60e3).unref();
}

module.exports = { update, schedule, collect, guessCountry, parseM3U, checkStream, toM3U, toTXT, buildWeb, countryName, CATEGORY_NAMES, UPDATE_HOURS };
