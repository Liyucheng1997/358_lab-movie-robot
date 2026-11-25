const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/guard');

test('robots.txt 整站禁止所有爬虫', () => {
  assert.equal(guard.ROBOTS_TXT, 'User-agent: *\nDisallow: /\n');
});

test('按 UA 拦截 AI 爬虫，不误伤普通浏览器和谷歌搜索', () => {
  assert.ok(guard.isBlockedBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)'));
  assert.ok(!guard.isBlockedBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15'));
  assert.ok(!guard.isBlockedBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'));
  assert.ok(!guard.isBlockedBot(undefined));
});

test('限流窗口：超过次数拒绝，窗口过后恢复', () => {
  const allow = guard.limiter({ windowMs: 1000, max: 2 });
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), false);
  assert.equal(allow('b', 20), true);
  assert.equal(allow('a', 1011), true);
});

test('只限制会问豆瓣的地址', () => {
  assert.ok(guard.DOUBAN_ROUTES.test('/play/37215318'));
  assert.ok(guard.DOUBAN_ROUTES.test('/api/sources/37215318'));
  assert.ok(!guard.DOUBAN_ROUTES.test('/resources/common.css'));
  assert.ok(!guard.DOUBAN_ROUTES.test('/api/danmaku/1'));
  let last;
  for (let i = 0; i < 61; i++) last = guard.allowRequest('9.9.9.9', '/play/1', 1000 + i);
  assert.equal(last, false);
  assert.equal(guard.allowRequest('9.9.9.9', '/resources/common.css', 1100), true);
});
