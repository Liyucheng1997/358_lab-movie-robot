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

// 私人站点（要登录才能用），所有爬虫和搜索引擎都不收录
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

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

// ── 按账号防爬 ──
// 登录后爬虫换 IP 也没用：同一个账号一分钟内的豆瓣类请求同样限 60 次，
// 另外每个账号 24 小时内最多打开 PLAY_PER_DAY 部不同的影片（正常人一天看不了这么多，批量抓取会很快撞上）
const perUser = limiter({ windowMs: MIN, max: 60 });
const DAY = 24 * 60 * MIN;
const PLAY_PER_DAY = Number(process.env.PLAY_PER_DAY) || 150;
const PLAY_ROUTE = /^\/(?:play|api\/sources|api\/rec\/related|api\/danmaku)\/(\d+)$/;
const activity = new Map(); // 账号 → { plays: Map(影片 id → 时间), ips: Map(IP → 时间), blocked: 次数 }

function userActivity(name, now) {
  let a = activity.get(name);
  if (!a) activity.set(name, (a = { plays: new Map(), ips: new Map(), blocked: 0, last: now }));
  for (const m of [a.plays, a.ips]) for (const [k, at] of m) if (now - at >= DAY) m.delete(k);
  return a;
}

// 返回 '' 放行；否则是拒绝原因：'rate'（太快）或 'quota'（今天打开的影片太多）
function checkUser(name, ip, pathname, now = Date.now(), maxPlays = PLAY_PER_DAY) {
  const a = userActivity(name, now);
  a.last = now;
  if (ip) a.ips.set(ip, now);
  if (DOUBAN_ROUTES.test(pathname) && !perUser('u:' + name, now)) {
    a.blocked++;
    return 'rate';
  }
  const id = pathname.match(PLAY_ROUTE)?.[1];
  if (id && !a.plays.has(id)) {
    if (a.plays.size >= maxPlays) {
      if (!a.blocked++) console.warn(`账号 ${name} 24 小时内打开了 ${a.plays.size} 部影片，已限制（疑似批量抓取）`);
      return 'quota';
    }
    a.plays.set(id, now);
  }
  return '';
}

// 给管理页看：每个账号最近 24 小时打开了多少部影片、用过多少个 IP、被拦了多少次
function usage(now = Date.now()) {
  const out = {};
  for (const name of activity.keys()) {
    const a = userActivity(name, now);
    out[name] = { plays: a.plays.size, ips: a.ips.size, blocked: a.blocked, last: a.last };
  }
  return out;
}

module.exports = {
  checkUser, usage, PLAY_PER_DAY, MIN, ROBOTS_TXT, AI_BOTS, isBlockedBot, limiter, allowRequest, DOUBAN_ROUTES };
