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
  assert.ok(html.includes(`<script type="module" src="${base}resources/ai.js?v=1"></script>`));
});
