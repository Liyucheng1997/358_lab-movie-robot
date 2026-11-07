const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staticHTML, base } = require('../scripts/build-pages');
const views = require('../src/views');

test('Pages 使用仓库子目录，播放和搜索指向目录首页', () => {
  const html = staticHTML('<head></head><body><a href="/play/1292052">影片</a><form action="/search"></form><script src="/resources/player.js"></script></body>', '2026-10-11');
  assert.equal(base, '/358_lab-movie-robot/');
  assert.ok(html.includes(`href="${base}play/1292052/"`));
  assert.ok(html.includes(`action="${base}search/"`));
  assert.ok(html.includes(`src="${base}resources/player.js"`));
  assert.ok(html.includes(`data-static-base="${base}"`));
});

test('Pages 直接使用媒体 URL，不依赖服务端代理', () => {
  const url = 'https://img.example.com/poster.jpg';
  const html = staticHTML(`<head></head><body><img src="/img?u=${encodeURIComponent(url)}"><video src="/video?u=${encodeURIComponent('https://video.example.com/trailer.mp4')}"></video></body>`, '2026-10-11');
  assert.match(html, /src="https:\/\/img.example.com\/poster.jpg"/);
  assert.match(html, /src="https:\/\/video.example.com\/trailer.mp4"/);
  assert.doesNotMatch(html, /\/(img|video)\?u=/);
});

test('Pages 海报、播放器封面和历史记录使用本地图片快照，避免防盗链', () => {
  const url = 'https://img3.doubanio.com/view/photo/public/poster.jpg';
  const html = staticHTML(`<head></head><body><img data-src="/img?u=${encodeURIComponent(url)}"><video poster="/img?u=${encodeURIComponent(url)}"></video><script>initPlay({"cover":"/img?u=${encodeURIComponent(url)}"})</script></body>`, '2026-10-11', { [url]: 'poster.jpg' });
  assert.doesNotMatch(html, /img3\.doubanio\.com/);
  assert.equal(html.split(`${base}resources/covers/poster.jpg`).length - 1, 3);
  assert.ok(!html.includes(base + base.slice(1)));
});

test('首页带 AI 选片面板，静态版脚本和 SDK 走仓库子目录', () => {
  const home = views.homePage({ movies: [], tvs: [], weekly: null });
  assert.ok(home.includes('id="ai-panel"'));
  assert.ok(home.includes('<dialog class="ai-dialog"'));
  const html = staticHTML(home, '2026-10-26');
  assert.ok(html.includes(`<script type="module" src="${base}resources/ai.js?v=4"></script>`));
  assert.ok(home.includes('id="continue-watch"'));
});

test('首页搜索和 AI 推荐合成一个框；搜索页可以把关键词交给 AI', () => {
  const home = views.homePage({ movies: [], tvs: [], weekly: null });
  assert.equal(home.split('role="search"').length - 1, 1, '首页只有一个搜索框');
  assert.ok(home.includes('id="omni"'));
  assert.ok(home.includes('omni-search') && home.includes('omni-ai'));
  const page = views.searchPage('下雨天 治愈', { items: [], total: 0, hasNext: false });
  assert.ok(page.includes(`href="/?ai=${encodeURIComponent('下雨天 治愈')}"`));
  const html = staticHTML(page, '2026-11-07');
  assert.ok(html.includes(`href="${base}?ai=`));
  assert.match(views.searchPage(''), /class="ai-fallback" hidden/);
});

test('播放页带续播提示和 AI 陪看面板，影片资料传给陪看脚本', () => {
  const d = {
    id: '1292052', title: '肖申克的救赎', originalTitle: 'The Shawshank Redemption', aka: [], year: '1994', isTv: false,
    cover: 'https://img3.doubanio.com/p.jpg', trailers: [], vendors: [], intro: '希望让人自由。', rating: '9.7', ratingCount: '1',
    genres: ['剧情', '犯罪'], countries: ['美国'], directors: ['弗兰克·德拉邦特'], actors: ['蒂姆·罗宾斯'], episodes: '',
    durations: ['142分钟'], pubdate: ['1994-09-10'], url: 'https://movie.douban.com/subject/1292052/',
  };
  const html = views.playPage(d);
  assert.ok(html.includes('id="resume-bar"'));
  assert.ok(html.includes('id="companion"'));
  assert.ok(html.includes('<dialog class="ai-dialog"'));
  assert.match(html, /companion\.js\?v=\d+"><\/script>[\s\S]*initPlay\(/);
  assert.ok(html.includes('"originalTitle":"The Shawshank Redemption"'));
  const page = staticHTML(html, '2026-11-07');
  assert.ok(page.includes(`src="${base}resources/companion.js?v=3"`));
});

test('电视直播页：导航有入口，静态版播放列表和数据走仓库子目录', () => {
  const page = views.tvPage();
  assert.ok(page.includes('href="/tv.html"'));
  assert.ok(page.includes('id="tv-video"') && page.includes('id="tv-grid"'));
  const html = staticHTML(page, '2026-11-07');
  assert.ok(html.includes(`href="${base}tv/playlist.m3u"`));
  assert.ok(html.includes(`src="${base}resources/tv.js?v=2"`));
});

test('电视直播页：有字幕开关、字幕层和 API Key 弹窗，字幕脚本按模块加载', () => {
  const page = views.tvPage();
  assert.ok(page.includes('class="pill-btn pill-btn-sm tv-subs-btn"'));
  assert.ok(page.includes('id="tv-subs"') && page.includes('id="tv-subs-bar"') && page.includes('id="tv-sub-lang"'));
  assert.ok(page.includes('<dialog class="ai-dialog"'));
  assert.ok(page.includes('<script type="module" src="/resources/tv-subs.js?v=3"></script>'));
});

test('直播字幕：按地区选识别语言、中文不用翻译、长字幕只留结尾', async () => {
  const subs = await import('../public/tv-subs.js');
  assert.equal(subs.langForCountry('IT'), 'it-IT');
  assert.equal(subs.langForCountry('hk'), 'yue-Hant-HK');
  assert.equal(subs.langForCountry('MX'), 'es-MX');
  assert.equal(subs.langForCountry('ZZ'), 'en-US');
  assert.equal(subs.langForCountry(''), 'en-US');
  assert.ok(subs.isChinese('zh-CN') && subs.isChinese('yue-Hant-HK') && !subs.isChinese('en-US'));
  const codes = subs.LANGS.map((l) => l[0]);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(subs.tail('short line'), 'short line');
  const long = 'one two three four five six seven eight nine ten';
  const cut = subs.tail(long, 20);
  assert.ok(cut.startsWith('…') && long.endsWith(cut.slice(1)) && cut.length <= 21);
  assert.equal(subs.tail('一二三四五六七八九十'.repeat(8)).length, 61);
  // 中文译文里夹着空格也不能截成只剩省略号
  const zh = subs.tail('延续民主党候选人的优势 ' + '似乎有某种被创造出来的局面'.repeat(4));
  assert.ok(zh.length > 30 && zh.startsWith('…'));
  // 一个很长的词也不能把整句截没
  assert.ok(subs.tail('x '.repeat(10) + 'y'.repeat(200), 50).length > 40);
});

test('直播字幕：说完的一段话切成长度相近的几条，按阅读时长显示', async () => {
  const subs = await import('../public/tv-subs.js');
  assert.deepEqual(subs.splitSentences(''), []);
  assert.deepEqual(subs.splitSentences('Buonasera a tutti.'), ['Buonasera a tutti.']);
  assert.deepEqual(subs.splitSentences('Hello there. How are you? Fine!'), ['Hello there.', 'How are you?', 'Fine!']);
  // 没有标点的长句按词切，每条不超过上限、不丢词
  const long = 'abbiamo già detto che questo si deve alla vittoria ultima strepitosa vittoria ricco ogni 40 punti per lui dietro però Alessandro che arriva';
  const parts = subs.splitSentences(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((x) => x.length <= 84));
  assert.equal(parts.join(' '), long);
  // 中文优先在逗号处断
  const zh = subs.splitSentences('我们已经说过，这要归功于胜利，最后一场惊人的胜利，富人每四十分但是亚历山德罗在后面追赶得很紧');
  assert.ok(zh.length >= 2 && zh.every((x) => x.length <= 32));
  assert.equal(zh.join(''), '我们已经说过，这要归功于胜利，最后一场惊人的胜利，富人每四十分但是亚历山德罗在后面追赶得很紧');
  // 显示时长：短句至少 1.6 秒，长句最多 6 秒，积压时放快
  assert.equal(subs.cueDuration({ orig: 'Ciao', zh: '你好' }, 0), 1600);
  assert.equal(subs.cueDuration({ orig: 'word '.repeat(40), zh: '' }, 0), 6000);
  assert.ok(subs.cueDuration({ orig: 'word '.repeat(10), zh: '' }, 4) < subs.cueDuration({ orig: 'word '.repeat(10), zh: '' }, 0));
});
