const fs = require('node:fs/promises');
const path = require('node:path');
const views = require('../src/views');
const sources = require('../src/sources');
const douban = require('../src/douban');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const base = '/' + (process.env.PAGES_BASE_PATH || '358_lab-movie-robot').replace(/^\/+|\/+$/g, '') + '/';

// 旧快照里的线路名是「代号 · 序号」，构建时统一换成中文名
const withNames = s => (s ? { ...s, lines: sources.nameLines(s.lines || []) } : { lines: [], message: '暂无线路快照。' });

function staticHTML(html, date, images = {}) {
  html = html.replace(/\/(?:img|video)\?u=([^"'<>\s\\)]+)/g, (_, u) => decodeURIComponent(u));
  html = html.replace(/(href|src|action|data-src|data-poster)="\/(?!\/)([^"]*)"/g, (_, attr, target) => {
    if (/^play\/\d+$/.test(target) || target === 'search') target += '/';
    return `${attr}="${base}${target}"`;
  });
  for (const [url, filename] of Object.entries(images)) html = html.split(url).join(`${base}resources/covers/${filename}`);
  return html.replace('<body>', `<body data-static-base="${base}"><div class="snapshot-banner">静态快照 · ${date} 更新 · 搜索范围为本站已收录影片</div>`)
    .replace('</head>', '<meta name="referrer" content="no-referrer"></head>')
    .replace('</body>', `<script src="${base}resources/static.js"></script></body>`);
}

async function write(rel, content) {
  const file = path.join(out, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function main() {
  const data = JSON.parse(await fs.readFile(path.join(root, 'snapshots/site.json'), 'utf8'));
  const images = JSON.parse(await fs.readFile(path.join(root, 'snapshots/images/manifest.json'), 'utf8'));
  for (const url of require('./snapshot-images').imageURLs(data)) {
    if (!images[url]) throw new Error(`缺少图片快照: ${url}，请运行 npm run snapshot:images`);
    await fs.access(path.join(root, 'snapshots/images', images[url]));
  }
  const date = data.builtAt.slice(0, 10);
  await fs.mkdir(out, { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(out, 'resources'), { recursive: true });
  await fs.cp(path.join(root, 'snapshots/images'), path.join(out, 'resources/covers'), { recursive: true });
  const render = html => staticHTML(html, date, images);
  const popular = type => data.lists.find(l => l.type === type && l.tag === '热门')?.items || [];
  await write('index.html', render(views.homePage({ movies: popular('movie'), tvs: popular('tv'), weekly: data.boards[0] })));
  for (const list of data.lists) {
    const tags = list.type === 'movie' ? douban.MOVIE_TAGS : douban.TV_TAGS;
    const url = decodeURIComponent(views.hotUrl(list.type, list.tag));
    await write(url.slice(1), render(views.hotPage({ ...list, tags, page: 1, hasNext: false })));
  }
  await write('billboard.html', render(views.billboardPage(data.boards)));
  await write('history.html', render(views.historyPage()));
  await write('search/index.html', render(views.searchPage('')));
  await write('404.html', render(views.errorPage(404, '此页面尚未收录到静态快照，请返回首页搜索。')));
  for (const [id, d] of Object.entries(data.details)) {
    await write(`play/${id}/index.html`, render(views.playPage(d)));
    await write(`api/sources/${id}.json`, JSON.stringify(withNames(data.sources[id])));
  }
  const catalog = Object.values(data.details).map(d => ({ id: d.id, title: d.title, year: d.year,
    cover: images[d.cover] ? `${base}resources/covers/${images[d.cover]}` : d.cover, aka: d.aka, originalTitle: d.originalTitle }));
  await write('catalog.json', JSON.stringify(catalog));
  await write('.nojekyll', '');
  console.log(`Pages 构建完成: ${catalog.length} 部影片，路径 ${base}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { staticHTML, base };
