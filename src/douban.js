// 豆瓣公开接口封装 + 内存缓存
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const cache = new Map();

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

async function getJSON(url, referer = 'https://movie.douban.com/') {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`豆瓣接口返回 ${res.status}: ${url}`);
  return res.json();
}

const MIN = 60 * 1000;

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本',
  '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '文艺', '豆瓣top250'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];

const PAGE_SIZE = 24;

// 豆瓣「选电影/选剧集」列表；多取 1 条用来判断是否还有下一页
function hotList(type, tag, page = 1, limit = PAGE_SIZE) {
  const start = (page - 1) * limit;
  const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}` +
    `&page_limit=${limit + 1}&page_start=${start}`;
  return cached(url, 30 * MIN, async () => {
    const data = await getJSON(url);
    const subjects = data.subjects || [];
    const items = subjects.slice(0, limit).map((s) => ({
      id: s.id,
      title: s.title,
      rate: s.rate,
      cover: bigCover(s.cover),
      episodes: s.episodes_info,
      isNew: s.is_new,
    }));
    return { items, hasNext: subjects.length > limit };
  });
}

// 榜单（m.douban.com 的 subject_collection）
const BILLBOARDS = [
  { id: 'movie_weekly_best', name: '豆瓣一周电影口碑榜' },
  { id: 'tv_global_best_weekly', name: '豆瓣全球口碑剧集榜' },
  { id: 'tv_chinese_best_weekly', name: '豆瓣华语口碑剧集榜' },
  { id: 'show_chinese_best_weekly', name: '豆瓣国内综艺口碑榜' },
  { id: 'show_global_best_weekly', name: '豆瓣国外综艺口碑榜' },
];

function collection(id, count = 10) {
  const url = `https://m.douban.com/rexxar/api/v2/subject_collection/${id}/items?start=0&count=${count}`;
  return cached(url, 60 * MIN, async () => {
    const data = await getJSON(url, 'https://m.douban.com/');
    const meta = data.subject_collection || {};
    return {
      updatedAt: (meta.updated_at || '').slice(0, 10),
      description: meta.description || '',
      items: (data.subject_collection_items || []).map((it) => {
        // card_subtitle: "2026 / 奥地利 德国 / 剧情 / 导演 / 演员1 演员2"
        const parts = (it.card_subtitle || '').split(' / ');
        return {
          id: it.id,
          rank: it.rank,
          title: it.title,
          cover: it.cover_url || (it.pic && it.pic.large),
          rate: it.rating && it.rating.value,
          year: parts[0] || '',
          region: (parts[1] || '').split(' ').join(','),
          genres: parts[2] || '',
          people: parts.slice(3).join(' ').split(' ').filter(Boolean).join(','),
        };
      }),
    };
  });
}

// 影片详情：先按电影查，失败再按剧集查
function detail(id) {
  if (!/^\d+$/.test(id)) return Promise.reject(new Error('无效的影片 ID'));
  return cached(`detail:${id}`, 30 * MIN, async () => {
    let d;
    for (const kind of ['movie', 'tv']) {
      try {
        d = await getJSON(`https://m.douban.com/rexxar/api/v2/${kind}/${id}`, 'https://m.douban.com/');
        if (d && d.title) break;
      } catch (e) {
        d = null;
      }
    }
    if (!d || !d.title) throw new Error('未找到该影片');
    return {
      id: d.id,
      title: d.title,
      originalTitle: d.original_title,
      aka: d.aka || [],
      year: d.year,
      countries: d.countries || [],
      genres: d.genres || [],
      directors: (d.directors || []).map((p) => p.name),
      actors: (d.actors || []).map((p) => p.name),
      intro: d.intro || '',
      durations: d.durations || [],
      pubdate: d.pubdate || [],
      isTv: !!d.is_tv,
      episodes: d.episodes_info || (d.episodes_count ? `共${d.episodes_count}集` : ''),
      rating: d.rating && d.rating.value,
      ratingCount: d.rating && d.rating.count,
      cover: (d.pic && d.pic.large) || d.cover_url,
      url: d.url || `https://movie.douban.com/subject/${d.id}/`,
      trailers: (d.trailers || [])
        .filter((t) => t.video_url)
        .map((t) => ({ title: t.title, url: t.video_url, cover: t.cover_url, runtime: t.runtime })),
      vendors: (d.vendors || []).map((v) => ({
        title: v.title,
        icon: v.icon,
        paid: v.is_paid,
        payment: v.payment_desc || (v.is_paid ? '付费' : '免费'),
        episodes: v.episodes_info,
      })),
    };
  });
}

// 搜索建议接口（最多约 10 条）
function search(q) {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`;
  return cached(url, 30 * MIN, async () => {
    const data = await getJSON(url);
    return (Array.isArray(data) ? data : [])
      .filter((s) => /^\d+$/.test(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title,
        subTitle: s.sub_title,
        year: s.year,
        cover: bigCover(s.img),
        episode: s.episode,
      }));
  });
}

function bigCover(url) {
  return (url || '').replace('/s_ratio_poster/', '/m_ratio_poster/');
}

module.exports = { MOVIE_TAGS, TV_TAGS, PAGE_SIZE, BILLBOARDS, hotList, collection, detail, search, UA };
