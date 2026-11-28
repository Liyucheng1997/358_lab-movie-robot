// 站点自带的 Claude：服务器保管站长的 API Key，登录用户的 AI 请求经 /api/ai 转发到 Anthropic
// Key 放在环境变量 ANTHROPIC_API_KEY 或 DATA_DIR/anthropic-key（用 scripts/ai-key.js 写入，改完不用重启），绝不发给浏览器。
// 费用算在站长账上，所以每个账号、全站都有每日次数上限。
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { limiter, MIN } = require('./guard');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = process.env.AI_KEY_FILE || path.join(DATA_DIR, 'anthropic-key');
const UPSTREAM = process.env.AI_UPSTREAM || 'https://api.anthropic.com';
const DAY = 24 * 60 * MIN;
const num = (name, fallback) => (Number(process.env[name]) >= 0 && process.env[name] !== undefined && process.env[name] !== '' ? Number(process.env[name]) : fallback);

// 只转发网站自己用到的模型：chat = AI 选片 / AI 陪看，translate = 直播字幕翻译（小模型，调用很密）
const MODELS = { 'claude-opus-5-5': 'chat', 'claude-haiku-5-5': 'translate' };
const MAX_TOKENS = { chat: 16000, translate: 1000 };
const LIMITS = {
  chat: { perUser: num('AI_PER_DAY', 60), global: num('AI_GLOBAL_PER_DAY', 1500) },
  translate: { perUser: num('AI_TRANSLATE_PER_DAY', 1500), global: num('AI_TRANSLATE_GLOBAL_PER_DAY', 20000) },
};
const BODY_LIMIT = 1024 * 1024; // 和 nginx 默认的请求体上限一致，够带两张截图

let keyCache = { mtime: -1, key: '' };
function getKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try {
    const st = fs.statSync(KEY_FILE);
    if (st.mtimeMs !== keyCache.mtime) keyCache = { mtime: st.mtimeMs, key: fs.readFileSync(KEY_FILE, 'utf8').trim() };
  } catch {
    keyCache = { mtime: -1, key: '' };
  }
  return keyCache.key;
}
const enabled = () => !!getKey();

function saveKey(key, file = KEY_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!key) return fs.rmSync(file, { force: true });
  fs.writeFileSync(file, key.trim() + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// 检查请求体：只放行网站用到的模型，限制单次输出长度。返回 { kind, body } 或 { error }
function validate(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { return { error: '格式不正确' }; }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return { error: '格式不正确' };
  const kind = MODELS[body.model];
  if (!kind) return { error: '不支持这个模型' };
  if (!(Number(body.max_tokens) > 0) || body.max_tokens > MAX_TOKENS[kind]) return { error: 'max_tokens 超出范围' };
  return { kind, body };
}

// 用量：账号 → { chat: [时间…], translate: [时间…] }，只留最近 24 小时
const used = new Map();
const perMinute = limiter({ windowMs: MIN, max: 20 });
const perMinuteTranslate = limiter({ windowMs: MIN, max: 90 });

function recent(name, kind, now) {
  let u = used.get(name);
  if (!u) used.set(name, (u = { chat: [], translate: [] }));
  u[kind] = u[kind].filter((at) => now - at < DAY);
  return u[kind];
}

function globalCount(kind, now) {
  let n = 0;
  for (const name of used.keys()) n += recent(name, kind, now).length;
  return n;
}

// 这次请求能不能发：返回 '' 放行并记一次，否则是给用户看的原因
function take(name, kind, now = Date.now(), limits = LIMITS) {
  const list = recent(name, kind, now);
  if (list.length >= limits[kind].perUser) return kind === 'chat' ? '今天的 AI 次数用完了，明天再来。' : '今天的字幕翻译次数用完了。';
  if (globalCount(kind, now) >= limits[kind].global) return '今天全站的 AI 额度用完了，明天再来。';
  if (!(kind === 'chat' ? perMinute : perMinuteTranslate)('ai:' + name, now)) return '请求太频繁，请稍后再试。';
  recent(name, kind, now).push(now);
  return '';
}

// 给管理页看：每个账号最近 24 小时用了多少次
function usage(now = Date.now()) {
  const out = {};
  for (const name of used.keys()) out[name] = { chat: recent(name, 'chat', now).length, translate: recent(name, 'translate', now).length };
  return out;
}

const apiError = (res, status, type, message) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('内容太长'), { status: 413 })); req.resume(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// POST /api/ai/v1/messages：格式和 Anthropic Messages API 一样（浏览器里的 SDK 把 baseURL 指到 /api/ai 即可），支持流式
async function proxy(req, res, user, fetchImpl = fetch) {
  const key = getKey();
  if (!key) return apiError(res, 503, 'api_error', '本站没有配置 AI，请在「API Key」里填自己的 Key。');
  if (req.method !== 'POST') return apiError(res, 405, 'invalid_request_error', '只支持 POST');
  let raw;
  try { raw = await readBody(req, BODY_LIMIT); } catch (e) { return apiError(res, e.status || 400, 'invalid_request_error', e.status ? '内容太长（截图太大）' : '格式不正确'); }
  const checked = validate(raw);
  if (checked.error) return apiError(res, 400, 'invalid_request_error', checked.error);
  const why = take(user, checked.kind);
  if (why) return apiError(res, 429, 'rate_limit_error', why);

  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']).slice(0, 300);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let up;
  try {
    up = await fetchImpl(UPSTREAM + '/v1/messages' + (/[?&]beta=true/.test(req.url) ? '?beta=true' : ''), {
      method: 'POST', headers, body: raw, signal: abort.signal,
    });
  } catch (e) {
    if (abort.signal.aborted) return;
    console.error('AI 转发失败:', e.message);
    return apiError(res, 502, 'api_error', '连不上 Claude，请稍后再试。');
  }
  // 站长的 Key 失效或没权限：不要让访客以为是自己的 Key 有问题
  if (up.status === 401 || up.status === 403) {
    console.error(`AI 转发：Anthropic 返回 ${up.status}，请检查服务器上的 API Key`);
    return apiError(res, 502, 'api_error', '本站的 AI 服务暂时不可用，请联系站长。');
  }
  const out = { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
  for (const h of ['request-id', 'retry-after']) if (up.headers.get(h)) out[h] = up.headers.get(h);
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

module.exports = { KEY_FILE, MODELS, LIMITS, enabled, getKey, saveKey, validate, take, usage, proxy };
