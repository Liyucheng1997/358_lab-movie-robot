const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staticHTML } = require('../scripts/build-pages');

test('Pages 使用仓库子目录，播放和搜索指向目录首页', () => {
  const html = staticHTML('<head></head><body><a href="/play/1292052">影片</a><form action="/search"></form><script src="/resources/player.js"></script></body>', '2026-10-11');
  assert.match(html, /href="\/movie-robot\/play\/1292052\/"/);
  assert.match(html, /action="\/movie-robot\/search\/"/);
  assert.match(html, /src="\/movie-robot\/resources\/player.js"/);
  assert.match(html, /data-static-base="\/movie-robot\/"/);
});

test('Pages 直接使用媒体 URL，不依赖服务端代理', () => {
  const url = 'https://img.example.com/poster.jpg';
  const html = staticHTML(`<head></head><body><img src="/img?u=${encodeURIComponent(url)}"><video src="/video?u=${encodeURIComponent('https://video.example.com/trailer.mp4')}"></video></body>`, '2026-10-11');
  assert.match(html, /src="https:\/\/img.example.com\/poster.jpg"/);
  assert.match(html, /src="https:\/\/video.example.com\/trailer.mp4"/);
  assert.doesNotMatch(html, /\/(img|video)\?u=/);
});
