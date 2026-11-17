// 防爬虫：robots.txt + 按 IP 限制会触发豆瓣查询的请求频率
// 背景：爬虫每访问一个没缓存过的播放页，服务器就要替它去问一次豆瓣，问多了服务器 IP 会被豆瓣封掉
const MIN = 60 * 1000;

// AI 训练 / 数据采集爬虫：整站禁止
const AI_BOTS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-Web', 'anthropic-ai', 'CCBot',
  'Google-Extended', 'GoogleOther', 'Applebot-Extended', 'Bytespider', 'PerplexityBot', 'Amazonbot',
  'meta-externalagent', 'FacebookBot', 'Diffbot', 'cohere-ai', 'Omgilibot', 'Timpibot', 'ImagesiftBot',
  'Reflectionbot', 'PetalBot', 'YouBot', 'AhrefsBot', 'SemrushBot', 'MJ12bot', 'DotBot', 'DataForSeoBot',
];

// 搜索引擎：可以收录首页、榜单等页面，但不爬播放页、搜索和接口（这些都要实时问豆瓣）
const ROBOTS_TXT = [
  ...AI_BOTS.map((bot) => `User-agent: ${bot}\nDisallow: /\n`),
  'User-agent: *',
  'Disallow: /play/',
  'Disallow: /search',
  'Disallow: /api/',
  'Disallow: /img',
  'Disallow: /video',
  'Disallow: /tv/',
  'Crawl-delay: 10',
  '',
].join('\n');

// 带 UA 的爬虫不守 robots.txt 时直接拒绝
const BOT_RE = new RegExp(AI_BOTS.map((b) => b.replace(/[-]/g, '\\-')).join('|'), 'i');
function isBlockedBot(ua) {
  return BOT_RE.test(String(ua || ''));
}

// 滑动窗口限流：每个 key 在 windowMs 内最多 max 次
function limiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const list = (hits.get(key) || []).filter((at) => now - at < windowMs);
    hits.delete(key);
    if (list.length >= max) {
      hits.set(key, list);
      return false;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    return true;
  };
}

// 会触发豆瓣查询的地址：播放页、搜索、热门列表、播放源、相关推荐
const DOUBAN_ROUTES = /^\/(play\/\d+|search|api\/search|api\/sources\/\d+|api\/rec\/related\/\d+|hot\/.+)$/;

// 正常人一分钟打开不了几十个播放页；一个播放页大约算 3 次（页面、播放源、相关推荐）
const perIP = limiter({ windowMs: MIN, max: 60 });

function allowRequest(ip, pathname, now) {
  if (!DOUBAN_ROUTES.test(pathname)) return true;
  return perIP(ip, now);
}

module.exports = { MIN, ROBOTS_TXT, AI_BOTS, isBlockedBot, limiter, allowRequest, DOUBAN_ROUTES };
