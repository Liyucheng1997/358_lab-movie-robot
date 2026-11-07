const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const douban = require('./src/douban');
const views = require('./src/views');
const sources = require('./src/sources');
const recommend = require('./src/recommend');
const danmaku = require('./src/danmaku');
const tv = require('./src/tv');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// 电视直播源：服务端每 6 小时抓取并检测一次，结果写在 DATA_DIR/tv（TV_UPDATE=0 关闭定时更新）
const TV_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'tv');
const TV_FILES = { json: 'application/json; charset=utf-8', m3u: 'audio/x-mpegurl; charset=utf-8', txt: 'text/plain; charset=utf-8' };
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// 只允许代理豆瓣的图片/视频域名，避免成为开放代理
function allowedUpstream(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)doubanio\.com$/.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

async function proxy(req, res, raw, kind) {
  const upstream = allowedUpstream(raw);
  if (!upstream) return send(res, 400, 'bad url');
  const headers = { 'User-Agent': douban.UA, Referer: 'https://movie.douban.com/' };
  if (kind === 'video' && req.headers.range) headers.Range = req.headers.range;
  const r = await fetch(upstream, { headers, signal: AbortSignal.timeout(kind === 'video' ? 60000 : 15000) });
  const out = { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' };
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    if (r.headers.get(h)) out[h] = r.headers.get(h);
  }
  out['Cache-Control'] = kind === 'img' ? 'public, max-age=604800' : 'no-store';
  res.writeHead(r.status, out);
  if (!r.body) return res.end();
  const stream = Readable.fromWeb(r.body);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, views.errorPage(404, '资源不存在'));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buf);
  });
}

// 电视直播的数据和播放列表；有预先压缩的 .gz 就直接发
function serveTV(req, res, rel) {
  const ext = path.extname(rel).slice(1);
  const file = path.join(TV_DIR, rel);
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const headers = {
    'Content-Type': TV_FILES[ext], 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*', Vary: 'Accept-Encoding',
  };
  const sendFile = (f, extra) => fs.readFile(f, (err, buf) => {
    if (err) {
      if (extra) return sendFile(file, null); // 没有压缩版就发原文件
      if (rel === 'data/index.json') return json(res, 404, { pending: true, message: '直播源正在首次更新，大约 20 分钟后刷新再看。' });
      return json(res, 404, { error: '没有这个文件' });
    }
    res.writeHead(200, { ...headers, ...(extra || {}) });
    res.end(buf);
  });
  sendFile(gzip ? file + '.gz' : file, gzip ? { 'Content-Encoding': 'gzip' } : null);
}

async function home(res) {
  const [movies, tvs, weekly] = await Promise.all([
    douban.hotList('movie', '热门', 1, 12).then((r) => r.items).catch(() => []),
    douban.hotList('tv', '热门', 1, 12).then((r) => r.items).catch(() => []),
    douban.collection('movie_weekly_best').catch(() => null),
  ]);
  send(res, 200, views.homePage({ movies, tvs, weekly }));
}

async function hot(res, type, tag, page) {
  const tags = type === 'movie' ? douban.MOVIE_TAGS : douban.TV_TAGS;
  if (!tags.includes(tag)) return send(res, 404, views.errorPage(404, `没有「${tag}」这个分类`));
  const { items, hasNext } = await douban.hotList(type, tag, page);
  send(res, 200, views.hotPage({ type, tag, tags, page, items, hasNext }));
}

async function billboard(res) {
  const boards = await Promise.all(
    douban.BILLBOARDS.map((b) =>
      douban
        .collection(b.id, b.count)
        .then((c) => ({ ...b, ...c }))
        .catch(() => ({ ...b, items: [], updatedAt: '', description: '', error: true }))
    )
  );
  send(res, 200, views.billboardPage(boards));
}

function json(res, status, data, cache = 'no-store') {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache });
  res.end(JSON.stringify(data));
}

// nginx 反向代理时取真实访客 IP；直连时不信任这些请求头
function clientIP(req) {
  const remote = req.socket.remoteAddress || '';
  if (!/^(::1|127\.|::ffff:127\.)/.test(remote)) return remote;
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || remote).split(',')[0].trim();
}

function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('内容太长'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function danmakuAPI(req, res, id, url) {
  if (req.method === 'POST') {
    let input;
    try { input = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.status || 400, { error: e.status ? e.message : '格式不正确' }); }
    const item = danmaku.validate(input);
    if (typeof item === 'string') return json(res, 400, { error: item });
    const allowed = danmaku.allowSend(clientIP(req));
    if (allowed !== true) return json(res, 429, { error: allowed });
    try {
      await douban.detail(id); // 只接受存在的影片，避免随意创建文件
      const saved = await danmaku.add(id, item);
      return json(res, 200, { item: [saved.t, saved.mode, saved.color, saved.text, 'site'] });
    } catch (e) {
      if (e.notFound) return json(res, 404, { error: e.message });
      console.error('弹幕保存失败:', e.message);
      return json(res, 500, { error: '弹幕保存失败，请稍后再试' });
    }
  }
  const ep = Number(url.searchParams.get('ep'));
  const seg = Number(url.searchParams.get('seg'));
  if (!Number.isInteger(ep) || ep < 1 || ep > 5000 || !Number.isInteger(seg) || seg < 0 || seg > 72) {
    return json(res, 400, { error: '参数不正确', items: [] });
  }
  try {
    const detail = await douban.detail(id);
    return json(res, 200, await danmaku.segment(detail.danmaku || {}, id, ep, seg), 'public, max-age=60');
  } catch (e) {
    if (e.notFound) return json(res, 404, { error: e.message, items: [] });
    console.error('弹幕加载失败:', e.message);
    return json(res, 502, { error: '弹幕暂时无法加载', items: [] });
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, views.errorPage(400, '地址格式不正确'));
  }

  if (pathname === '/' || pathname === '/index.html') return home(res);

  const hotMatch = pathname.match(/^\/hot\/index-(movie|tv)-(.+?)(?:-p-(\d+))?\.html$/);
  if (hotMatch) return hot(res, hotMatch[1], hotMatch[2], Math.max(1, Number(hotMatch[3]) || 1));

  if (pathname === '/billboard.html') return billboard(res);
  if (pathname === '/history.html') return send(res, 200, views.historyPage());
  if (pathname === '/foryou.html') return send(res, 200, views.forYouPage());
  if (pathname === '/tv.html') return send(res, 200, views.tvPage());
  const tvMatch = pathname.match(/^\/tv\/(data\/index\.json|data\/c\/[A-Z]{2}\.json|playlist\.(?:m3u|txt))$/);
  if (tvMatch) return serveTV(req, res, tvMatch[1]);

  // 推荐候选池和相关影片：排序在浏览器里按本地行为画像完成，服务端不保存任何用户数据
  if (pathname === '/api/rec/pool') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const items = await recommend.livePool();
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.end(JSON.stringify({ items }));
    } catch (e) {
      console.error('推荐候选池加载失败:', e.message);
      res.statusCode = 502;
      return res.end(JSON.stringify({ items: [] }));
    }
  }
  const relatedMatch = pathname.match(/^\/api\/rec\/related\/(\d+)$/);
  if (relatedMatch) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const items = await recommend.liveRelated(relatedMatch[1]);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(JSON.stringify({ items }));
    } catch (e) {
      console.error('相关推荐加载失败:', e.message);
      res.statusCode = 502;
      return res.end(JSON.stringify({ items: [] }));
    }
  }

  // 弹幕：GET 取一集里一个 5 分钟分段（外部平台 + 本站），POST 发送本站弹幕
  const danmakuMatch = pathname.match(/^\/api\/danmaku\/(\d+)$/);
  if (danmakuMatch) return danmakuAPI(req, res, danmakuMatch[1], url);

  if (pathname === '/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const page = Math.min(50, Math.max(1, Number(url.searchParams.get('page')) || 1));
    if (!q) return send(res, 200, views.searchPage(''));
    try {
      return send(res, 200, views.searchPage(q, await douban.search(q, page), false, page));
    } catch (e) {
      console.error(e.message);
      return send(res, 200, views.searchPage(q, undefined, true, page));
    }
  }

  const playMatch = pathname.match(/^\/play\/(\d+)$/);
  if (playMatch) {
    try {
      return send(res, 200, views.playPage(await douban.detail(playMatch[1])));
    } catch (e) {
      if (e.notFound) return send(res, 404, views.errorPage(404, e.message));
      console.error('影片详情加载失败:', e.message);
      return send(res, 502, views.errorPage(502, '数据源暂时无法访问，请稍后刷新重试。'));
    }
  }

  // AI 选片用来把推荐的片名对应到豆瓣条目
  if (pathname === '/api/search') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return res.end(JSON.stringify({ items: [] }));
    try {
      return res.end(JSON.stringify({ items: (await douban.search(q, 1)).items }));
    } catch (e) {
      console.error('搜索接口失败:', e.message);
      res.statusCode = 502;
      return res.end(JSON.stringify({ items: [] }));
    }
  }

  const sourceMatch = pathname.match(/^\/api\/sources\/(\d+)$/);
  if (sourceMatch) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const detail = await douban.detail(sourceMatch[1]);
      return res.end(JSON.stringify(await sources.resolve(detail)));
    } catch (e) {
      console.error('播放源加载失败:', e.message);
      res.statusCode = 502;
      return res.end(JSON.stringify({ lines: [], message: '第三方播放源暂时不可用，请重试或选择豆瓣预告。' }));
    }
  }

  if (pathname === '/img') return proxy(req, res, url.searchParams.get('u'), 'img');
  if (pathname === '/video') return proxy(req, res, url.searchParams.get('u'), 'video');
  if (pathname.startsWith('/resources/')) return serveStatic(res, pathname.slice('/resources/'.length));
  if (pathname === '/favicon.ico') return serveStatic(res, 'logo.svg');

  send(res, 404, views.errorPage(404, '你访问的页面不存在'));
}

http
  .createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error(req.url, e);
      if (!res.headersSent) send(res, 502, views.errorPage(502, '数据源暂时无法访问，请稍后刷新重试。'));
      else res.destroy();
    });
  })
  .listen(PORT, process.env.HOST, () => console.log(`服务已启动: http://${process.env.HOST || 'localhost'}:${PORT}`));

if (process.env.TV_UPDATE !== '0') tv.schedule({ dir: TV_DIR });
