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
      if (episodes.length) lines.push({
        id: `${videoId}-${item.id}-${index}`,
        name: `${group.flag || '第三方线路'} · ${lines.length + 1}`,
        episodes,
      });
    });
  }
  return lines;
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

module.exports = { resolve, candidates, tokenFor, parseLines };
