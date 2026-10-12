const fs = require('node:fs/promises');
const path = require('node:path');
const douban = require('../src/douban');
const sources = require('../src/sources');

async function pool(items, fn, size = 4) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

async function main() {
  const file = path.join(__dirname, '..', 'snapshots', 'site.json');
  let previous = { details: {}, sources: {} };
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* 首次构建 */ }
  const categories = ['movie', 'tv'].flatMap(type =>
    (type === 'movie' ? douban.MOVIE_TAGS : douban.TV_TAGS).map(tag => ({ type, tag })));
  const lists = await pool(categories, async c => {
    try {
      const result = await douban.hotList(c.type, c.tag, 1, 12);
      console.log(`分类 ${c.type}/${c.tag}: ${result.items.length}`);
      return { ...c, items: result.items };
    } catch (e) {
      console.warn(`分类 ${c.tag} 暂时不可用: ${e.message}`);
      return { ...c, items: [] };
    }
  });
  // 每部影片都要抓详情、线路和海报，Top250 在静态版只收录前 50 部
  const boards = await pool(douban.BILLBOARDS, async b => {
    try { return { ...b, ...await douban.collection(b.id, Math.min(b.count || 10, 50)) }; }
    catch { return { ...b, items: [], description: '', updatedAt: '', error: true }; }
  });
  const ids = [...new Set([...lists.flatMap(l => l.items), ...boards.flatMap(b => b.items)].map(m => String(m.id)))];
  // 保留一个稳定的经典影片，方便验证静态版播放器。
  if (!ids.includes('1292052')) ids.push('1292052');
  const details = {};
  const lines = {};
  const fallback = new Map();
  for (const list of lists) for (const m of list.items) fallback.set(String(m.id), { ...m, isTv: list.type === 'tv' });
  for (const board of boards) for (const m of board.items) fallback.set(String(m.id), { ...fallback.get(String(m.id)), ...m });
  await pool(ids, async (id, i) => {
    let d;
    try {
      d = previous.details[id] && !previous.details[id].partial ? previous.details[id] : await douban.detail(id);
    } catch (e) {
      const m = fallback.get(id);
      if (!m) return;
      d = { id, title: m.title, year: m.year || '', cover: m.cover, rating: m.rate || '',
        ratingCount: '', originalTitle: '', aka: [], countries: [], genres: [], directors: [], actors: [],
        intro: '构建时豆瓣详情接口暂时不可用，仅展示目录中的基本资料。',
        durations: [], pubdate: [], isTv: !!m.isTv, episodes: m.episodes || '',
        url: `https://movie.douban.com/subject/${id}/`, trailers: [], vendors: [], partial: true };
    }
    details[id] = d;
    try {
      const sameDay = previous.builtAt?.slice(0, 10) === new Date().toISOString().slice(0, 10);
      lines[id] = sameDay && previous.sources[id] ? previous.sources[id] : await sources.resolve(d);
    }
    catch { lines[id] = { lines: [], message: '构建时未能获取此影片的第三方线路，可重新部署快照。' }; }
    console.log(`影片 ${i + 1}/${ids.length}: ${d.title}, ${lines[id].lines.length} 条线路${d.partial ? '（基本资料）' : ''}`);
  });
  if (Object.keys(details).length < 10 || !lists.some(l => l.items.length)) throw new Error('数据不足，保留原有快照');
  // 仅列出已经生成详情的条目，防止出现不可访问的播放链接。
  for (const l of [...lists, ...boards]) l.items = l.items.filter(m => details[m.id]);
  const snapshot = { builtAt: new Date().toISOString(), lists, boards, details, sources: lines };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(snapshot));
  console.log(`快照完成: ${Object.keys(details).length} 部影片`);
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
