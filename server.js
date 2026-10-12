const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const douban = require('./src/douban');
const views = require('./src/views');
const sources = require('./src/sources');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
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
