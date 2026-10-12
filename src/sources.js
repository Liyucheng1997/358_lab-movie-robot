const BASE = 'https://www1.ikanbot.com';
const cache = new Map();
const pending = new Map();
const UA = require('./douban').UA;

async function get(relative, json = false) {
  const response = await fetch(new URL(relative, BASE), {
    headers: { 'User-Agent': UA, Referer: BASE + '/', Accept: json ? 'application/json' : 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('第三方播放源暂时不可用');
  return json ? response.json() : response.text();
}

// 资源站代号 → 中文名（代号来自苹果 CMS 采集站的播放器标识）
const FLAG_NAMES = {
  '360zy': '360资源', '1080zyk': '优质资源', bfzym3u8: '暴风资源', dbm3u8: '百度资源', dyttm3u8: '电影天堂',
  ffm3u8: '非凡资源', gsm3u8: '光速资源', hhm3u8: '豪华资源', hnm3u8: '红牛资源', hym3u8: '虎牙资源',
  ikm3u8: 'iKun资源', jinyingm3u8: '金鹰资源', jsm3u8: '极速资源', kcm3u8: '快车资源', lzm3u8: '量子资源',
  mtm3u8: '茅台资源', nnm3u8: '牛牛资源', okm3u8: 'OK资源', rym3u8: '如意资源', sdm3u8: '闪电资源',
  snm3u8: '索尼资源', subm3u8: '速播资源', tpm3u8: '淘片资源', ukm3u8: 'U酷资源', wjm3u8: '无尽资源',
  wolong: '卧龙资源', xiguam3u8: '西瓜资源', xlm3u8: '新浪资源', yym3u8: '歪歪资源', zuidam3u8: '最大资源',
};

function flagName(flag) {
  if (!flag) return '第三方线路';
  if (FLAG_NAMES[flag]) return FLAG_NAMES[flag];
  // 未收录的代号去掉 m3u8 后缀，显示成「XX线路」
  const code = flag.replace(/m3u8$/i, '').toUpperCase();
  return code ? code + '线路' : '第三方线路';
}

// 给线路起名，同一资源站出现多次时加序号区分
function nameLines(lines) {
  const seen = {};
  return lines.map(line => {
    const flag = line.flag || String(line.name || '').replace(/ · \d+$/, '');
    const base = flagName(flag);
    seen[base] = (seen[base] || 0) + 1;
    return { ...line, flag, name: seen[base] > 1 ? base + ' ' + seen[base] : base };
  });
}

function decode(s) {
  return s.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function candidates(html, title, year) {
  const matches = [];
  const normalize = s => s.replace(/\s+/g, '').toLowerCase();
  for (const m of html.matchAll(/<a\b[^>]*href="\/play\/(\d+)"[^>]*class="title-text"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = decode(m[2].replace(/<[^>]+>/g, '')).trim();
    const parts = label.match(/^(.*?)\s+(\d{4})$/);
    if (parts && normalize(parts[1]) === normalize(title) && (!year || String(year) === parts[2])) matches.push(m[1]);
  }
  return [...new Set(matches)];
}

function tokenFor(id, token) {
  const parts = [];
  for (const digit of id.slice(-4)) {
    const offset = Number(digit) % 3 + 1;
    parts.push(token.slice(offset, offset + 8));
    token = token.slice(offset + 8);
  }
  return parts.join('');
}

function parseLines(list, videoId) {
  const lines = [];
  for (const item of list) {
    if (!item || typeof item.resData !== 'string') continue;
    let groups;
    try { groups = JSON.parse(item.resData); } catch { continue; }
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      if (!group || typeof group !== 'object') return;
      const episodes = [];
      for (const entry of String(group.url || '').split('#')) {
        const split = entry.indexOf('$');
        if (split < 0) continue;
        const url = entry.slice(split + 1).trim();
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !/\.m3u8$/i.test(parsed.pathname)) continue;
          episodes.push({ title: entry.slice(0, split) || '播放', url, type: 'hls' });
        } catch { /* 忽略无效的播放地址 */ }
      }
      if (episodes.length) lines.push({ id: `${videoId}-${item.id}-${index}`, flag: String(group.flag || ''), episodes });
    });
  }
  return nameLines(lines);
}

async function load(detail) {
  const html = await get('/search?q=' + encodeURIComponent(detail.title));
  const ids = candidates(html, detail.title, detail.year);
  if (!ids.length) return { lines: [], message: '第三方站点暂未找到同名、同年份的影片。' };
  // 同名同年份仍有多个条目时，不自动选取，避免播放错误版本。
  if (ids.length > 1) return { lines: [], message: '第三方站点存在多个同名版本，暂未自动匹配。' };
  const id = ids[0];
  const page = await get('/play/' + id);
  const input = name => page.match(new RegExp('id="' + name + '"[^>]*value="([^"]*)"'))?.[1];
  const token = input('e_token');
  const mtype = input('mtype');
  if (!token || !mtype || input('current_id') !== id) throw new Error('第三方播放页格式发生变化');
  const data = await get('/api/getResN?' + new URLSearchParams({ videoId: id, mtype, token: tokenFor(id, token) }), true);
  if (data.state !== 1 || !Array.isArray(data.data?.list)) throw new Error('第三方线路获取失败，请稍后重试');
  const lines = parseLines(data.data.list, id);
  return { lines, pageUrl: BASE + '/play/' + id, message: lines.length ? '' : '第三方站点暂无可用播放线路。' };
}

function resolve(detail) {
  const key = String(detail.id);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (pending.has(key)) return pending.get(key);
  const promise = load(detail).then(value => {
    cache.set(key, { value, expires: Date.now() + 5 * 60 * 1000 });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

module.exports = { resolve, candidates, tokenFor, parseLines, nameLines, flagName };
