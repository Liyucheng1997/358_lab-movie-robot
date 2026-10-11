const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
const base = '/' + (process.env.PAGES_BASE_PATH || 'movie-robot').replace(/^\/+|\/+$/g, '') + '/';
const port = Number(process.env.PREVIEW_PORT) || 4173;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') { res.writeHead(302, { Location: base }); return res.end(); }
    if (!pathname.startsWith(base)) { res.writeHead(404); return res.end('Not found'); }
    const relative = pathname.slice(base.length) + (pathname.endsWith('/') ? 'index.html' : '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`静态预览: http://localhost:${port}${base}`));
