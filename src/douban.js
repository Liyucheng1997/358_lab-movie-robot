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
  if (!res.ok) {
    const err = new Error(`豆瓣接口返回 ${res.status}: ${url}`);
    err.status = res.status;
    throw err;
  }
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
// short 用作榜单页的切换标签；count 为条目数，默认 10
const BILLBOARDS = [
  { id: 'movie_weekly_best', name: '豆瓣一周电影口碑榜', short: '一周电影' },
  { id: 'tv_global_best_weekly', name: '豆瓣全球口碑剧集榜', short: '全球剧集' },
  { id: 'tv_chinese_best_weekly', name: '豆瓣华语口碑剧集榜', short: '华语剧集' },
  { id: 'show_chinese_best_weekly', name: '豆瓣国内综艺口碑榜', short: '国内综艺' },
  { id: 'show_global_best_weekly', name: '豆瓣国外综艺口碑榜', short: '国外综艺' },
  { id: 'movie_top250', name: '豆瓣电影 Top250', short: 'Top250', count: 250 },
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

// 影片详情：subject 接口电影、剧集通用；movie/tv 接口会被豆瓣按 IP 单独限流（subject_ip_rate_limit），只作后备
function detail(id) {
  if (!/^\d+$/.test(id)) return Promise.reject(Object.assign(new Error('无效的影片 ID'), { notFound: true }));
  return cached(`detail:${id}`, 30 * MIN, async () => {
    let d;
    let failure;
    for (const kind of ['subject', 'movie', 'tv']) {
      try {
        d = await getJSON(`https://m.douban.com/rexxar/api/v2/${kind}/${id}`, 'https://m.douban.com/');
        if (d && d.title) break;
      } catch (e) {
        d = null;
        if (e.status === 404 && kind === 'subject') break; // subject 不分类型，404 即确实不存在
        if (e.status !== 404) failure = e;
      }
    }
    if (!d || !d.title) {
      // 只有全部接口都明确返回 404 才算影片不存在；限流或网络错误交给调用方按 502 处理
      if (failure) throw failure;
      throw Object.assign(new Error('未找到该影片'), { notFound: true });
    }
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

const SEARCH_PAGE_SIZE = 20;

// 移动版搜索接口，支持分页，也能按演职人员搜索；失败时退回搜索建议接口（只有第一页、约 10 条）
function search(q, page = 1) {
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const url = `https://m.douban.com/rexxar/api/v2/search/movie?q=${encodeURIComponent(q)}&start=${start}&count=${SEARCH_PAGE_SIZE}`;
  return cached(url, 30 * MIN, async () => {
    try {
      const data = await getJSON(url, 'https://m.douban.com/');
      const items = (data.items || [])
        .filter((it) => it.target && /^\d+$/.test(it.target_id || it.target.id))
        .map((it) => {
          const t = it.target;
          return {
            id: it.target_id || t.id,
            title: String(t.title || '').replace(/\s+/g, ' ').trim(),
            subTitle: t.card_subtitle,
            year: t.year,
            // 接口给的是 120px 高的缩略图，放大到 240px 适配高清屏
            cover: (t.cover_url || '').replace('/h/120/', '/h/240/'),
            rate: t.rating && t.rating.value,
            typeName: it.type_name,
          };
        });
      const total = Number(data.total) || 0;
      return { items, total, hasNext: start + SEARCH_PAGE_SIZE < total };
    } catch (e) {
      if (page > 1) throw e;
      return { items: await suggest(q), total: 0, hasNext: false };
    }
  });
}

function suggest(q) {
  const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(q)}`;
  return cached(url, 30 * MIN, async () => {
    const data = await getJSON(url);
    return (Array.isArray(data) ? data : [])
      .filter((s) => /^\d+$/.test(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title,
        subTitle: [s.sub_title, s.episode ? `${s.episode}集` : ''].filter(Boolean).join(' / '),
        year: s.year,
        cover: bigCover(s.img),
      }));
  });
}

function bigCover(url) {
  return (url || '').replace('/s_ratio_poster/', '/m_ratio_poster/');
}

module.exports = { MOVIE_TAGS, TV_TAGS, PAGE_SIZE, SEARCH_PAGE_SIZE, BILLBOARDS, hotList, collection, detail, search, UA };
