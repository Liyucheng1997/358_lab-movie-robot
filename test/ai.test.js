const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-'));
process.env.AI_KEY_FILE = path.join(dir, 'anthropic-key');
delete process.env.ANTHROPIC_API_KEY;
const ai = require('../src/ai');

test('Key 存在文件里，改了马上生效，删掉后关闭', () => {
  assert.equal(ai.enabled(), false);
  ai.saveKey('sk-ant-test-1234567890');
  assert.equal(ai.getKey(), 'sk-ant-test-1234567890');
  assert.ok(ai.enabled());
  ai.saveKey('');
  assert.equal(ai.enabled(), false);
});

test('只放行网站用到的模型，限制输出长度', () => {
  const ok = (o) => ai.validate(JSON.stringify(o));
  assert.equal(ok({ model: 'claude-opus-5-5', max_tokens: 16000, messages: [] }).kind, 'chat');
  assert.equal(ok({ model: 'claude-haiku-5-5', max_tokens: 800, messages: [] }).kind, 'translate');
  assert.ok(ok({ model: 'claude-opus-5-5', max_tokens: 64000, messages: [] }).error);
  assert.ok(ok({ model: 'claude-haiku-5-5', max_tokens: 8000, messages: [] }).error);
  assert.ok(ok({ model: 'some-other-model', max_tokens: 10, messages: [] }).error);
  assert.ok(ok({ model: 'claude-opus-5-5', max_tokens: 10 }).error);
  assert.ok(ai.validate('not json').error);
});

test('每个账号、全站都有每日上限，24 小时后恢复', () => {
  const limits = { chat: { perUser: 2, global: 3 }, translate: { perUser: 5, global: 100 } };
  const t = 50_000_000;
  assert.equal(ai.take('a', 'chat', t, limits), '');
  assert.equal(ai.take('a', 'chat', t + 1, limits), '');
  assert.match(ai.take('a', 'chat', t + 2, limits), /今天的 AI 次数用完了/);
  assert.equal(ai.take('a', 'translate', t + 3, limits), '', '翻译单独计数');
  assert.equal(ai.take('b', 'chat', t + 4, limits), '');
  assert.match(ai.take('c', 'chat', t + 5, limits), /全站/);
  assert.deepEqual(ai.usage(t + 6).a, { chat: 2, translate: 1 });
  assert.equal(ai.take('a', 'chat', t + 25 * 3600000, limits), '');
});

// 用假的上游和假的请求走一遍转发
function call(body, { fetchImpl, method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => ai.proxy(req, res, 'tester', fetchImpl)).listen(0, '127.0.0.1', async () => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/v1/messages?beta=true`, {
        method, headers: { 'content-type': 'application/json', 'x-api-key': 'server', ...headers }, body: method === 'POST' ? body : undefined,
      });
      const text = await r.text();
      server.close();
      resolve({ status: r.status, text, type: r.headers.get('content-type') });
    });
  });
}

test('转发：换上服务器的 Key，不透传浏览器发来的 Key；没配置 Key 时 503', async () => {
  const body = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await call(body)).status, 503);

  ai.saveKey('sk-ant-real-key-0000000000');
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response('event: message_start\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const r = await call(body, { fetchImpl, headers: { 'anthropic-beta': 'x-beta', 'anthropic-version': '2023-06-01' } });
  assert.equal(r.status, 200);
  assert.equal(r.type, 'text/event-stream');
  assert.match(r.text, /message_start/);
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-real-key-0000000000');
  assert.equal(seen.init.headers['anthropic-beta'], 'x-beta');
  assert.equal(seen.init.body, body);

  const bad = await call(JSON.stringify({ model: 'gpt', max_tokens: 1, messages: [] }), { fetchImpl });
  assert.equal(bad.status, 400);
});

test('转发：站长的 Key 失效时不把 401 交给访客，也不泄露 Key', async () => {
  const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 100, messages: [] });
  const r = await call(body, { fetchImpl: async () => new Response('{"error":{"message":"invalid x-api-key sk-ant-real"}}', { status: 401 }) });
  assert.equal(r.status, 502);
  assert.ok(!r.text.includes('sk-ant'));
  assert.match(JSON.parse(r.text).error.message, /暂时不可用/);
});
