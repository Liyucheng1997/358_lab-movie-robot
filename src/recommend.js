// 推荐候选池：把各分类列表、榜单（和静态版的影片详情）合并成带特征的影片列表，供浏览器端排序
const core = require('../public/rec-core');
const douban = require('./douban');

function typeOfBoard(id) {
  if (id.startsWith('tv_')) return 'tv';
  if (id.startsWith('show_')) return 'show';
  return 'movie';
}

function typeOfDetail(d) {
  if (!d.isTv) return 'movie';
  return (d.genres || []).includes('真人秀') ? 'show' : 'tv';
}

// 影片详情 → 特征（主创取导演和前 3 位主演）
function detailFeatures(d) {
  return core.featuresOf({
    type: typeOfDetail(d),
    genres: d.genres,
    countries: d.countries,
    people: [...(d.directors || []).slice(0, 1), ...(d.actors || []).slice(0, 3)],
    year: d.year,
  });
}

// lists: [{ type, tag, items }]；boards: [{ id, items }]；details: { id: detail }
// cover(url) 把豆瓣图片地址换成站内可用地址；keep(id) 过滤掉没有详情页的影片（静态版用）
function buildPool({ lists = [], boards = [], details = {} }, cover = (u) => u, keep = () => true) {
  const map = new Map();
  const get = (it, type) => {
    const id = String(it.id);
    if (!/^\d+$/.test(id) || !keep(id)) return null;
    let m = map.get(id);
    if (!m) {
      m = { id, title: it.title, cover: it.cover, rate: Number(it.rate) || null, year: it.year || '', type, f: new Set(), hot: false, isNew: false };
      map.set(id, m);
    }
    if (!m.rate && Number(it.rate)) m.rate = Number(it.rate);
    if (!m.year && it.year) m.year = String(it.year);
    return m;
  };
  for (const list of lists) {
    const tagF = (core.TAG_FEATURES[list.type] || {})[list.tag] || [];
    const type = list.type === 'tv' && list.tag === '综艺' ? 'show' : list.type;
    for (const it of list.items || []) {
      const m = get(it, type);
      if (!m) continue;
      tagF.forEach((f) => m.f.add(f));
      m.f.add(`t:${type}`);
      if (list.tag === '热门' || list.tag === '最新') m.hot = true;
      if (it.isNew) m.isNew = true;
    }
  }
  for (const b of boards) {
    const type = typeOfBoard(b.id || '');
    for (const it of b.items || []) {
      const m = get(it, type);
      if (!m) continue;
      core.featuresOf({ type, genres: it.genres, countries: String(it.region || '').split(','), people: String(it.people || '').split(','), year: it.year })
        .forEach((f) => m.f.add(f));
      if (/weekly/.test(b.id || '')) m.hot = true;
    }
  }
  // 有详情时用完整特征覆盖推断出来的特征
  for (const [id, d] of Object.entries(details)) {
    const m = map.get(String(id)) || get(d, typeOfDetail(d));
    if (!m) continue;
    m.type = typeOfDetail(d);
    m.f = new Set(detailFeatures(d));
    if (!m.rate && d.rating) m.rate = Number(d.rating);
    if (d.year) m.year = String(d.year);
    if (!m.cover) m.cover = d.cover;
  }
  return [...map.values()].map((m) => ({ ...m, cover: cover(m.cover), f: [...m.f] }));
}

// 豆瓣相关推荐（card_subtitle: "1993 / 中国香港 / 喜剧 爱情 古装 / 导演 / 主演1 主演2"）
function parseRelated(list, cover = (u) => u) {
  return (Array.isArray(list) ? list : [])
    .filter((it) => it && /^\d+$/.test(String(it.id)))
    .map((it) => {
      const parts = String(it.card_subtitle || '').split(' / ');
      const genres = (parts[2] || '').split(' ').filter(Boolean);
      const type = it.type === 'tv' ? (genres.includes('真人秀') ? 'show' : 'tv') : 'movie';
      return {
        id: String(it.id),
        title: it.title,
        cover: cover((it.pic && (it.pic.large || it.pic.normal)) || it.cover_url || ''),
        rate: (it.rating && Number(it.rating.value)) || null,
        year: parts[0] || '',
        type,
        f: core.featuresOf({
          type, genres, countries: (parts[1] || '').split(' '),
          people: [...(parts[3] || '').split(' ').slice(0, 1), ...(parts[4] || '').split(' ').slice(0, 3)], year: parts[0],
        }),
      };
    });
}

const proxied = (u) => (u ? `/img?u=${encodeURIComponent(u)}` : '');

// 实时版候选池：全部分类第一页（每类 30 部）+ 全部榜单，限制并发避免触发豆瓣限流
let poolCache = null;
let poolLoading = null;
function livePool() {
  if (poolCache && poolCache.expires > Date.now()) return Promise.resolve(poolCache.value);
  // 同时到达的请求共用一次加载
  if (!poolLoading) poolLoading = loadPool().finally(() => { poolLoading = null; });
  return poolLoading;
}

async function loadPool() {
  const jobs = [
    ...douban.MOVIE_TAGS.map((tag) => ['movie', tag]),
    ...douban.TV_TAGS.map((tag) => ['tv', tag]),
  ];
  const lists = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [type, tag] = jobs[next++];
      try {
        lists.push({ type, tag, items: (await douban.hotList(type, tag, 1, 30)).items });
      } catch (e) {
        console.error(`推荐候选 ${type}/${tag} 加载失败:`, e.message);
      }
    }
  }
  const boardsP = Promise.all(
    douban.BILLBOARDS.map((b) => douban.collection(b.id, b.count).then((c) => ({ id: b.id, items: c.items })).catch(() => null))
  );
  await Promise.all([worker(), worker(), worker(), worker()]);
  const boards = (await boardsP).filter(Boolean);
  const value = buildPool({ lists, boards }, proxied);
  if (!value.length) throw new Error('推荐候选池为空');
  // 部分分类失败时缓存时间短一些，尽快补齐
  const ttl = lists.length === jobs.length ? 30 * 60 * 1000 : 5 * 60 * 1000;
  poolCache = { value, expires: Date.now() + ttl };
  return value;
}

async function liveRelated(id) {
  return parseRelated(await douban.related(id), proxied);
}

module.exports = { buildPool, parseRelated, detailFeatures, typeOfDetail, livePool, liveRelated };
