// AI 选片和 AI 陪看共用：API Key、Key 弹窗、按需加载 SDK、错误提示。
// 本站自带 AI 时（页面里有 window.AI_SERVER）请求发到本站 /api/ai，由服务器带上站长的 Key 转发；
// 访客填了自己的 Key（只存在本机 localStorage）就改为从浏览器直接调用 Anthropic。
export const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'anthropic_api_key';

const SERVER_AI = typeof window !== 'undefined' && window.AI_SERVER === true;
// 访客自己填的 Key
export function ownKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}
// 能不能用 AI：自己的 Key，或者本站自带（返回占位值 'server'，真正的 Key 只在服务器上）
export function readKey() {
  return ownKey() || (SERVER_AI ? 'server' : '');
}

const listeners = new Set();
// 订阅 Key 状态，订阅时立即回调一次
export function onKeyChange(fn) {
  listeners.add(fn);
  fn(Boolean(readKey()));
}
export function writeKey(key) {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch (e) {}
  const has = Boolean(readKey());
  listeners.forEach((fn) => fn(has));
}

// ---------- API Key 弹窗（页面里的 <dialog class="ai-dialog">） ----------
let dialog = null;
let afterSave = null;
function wire() {
  if (dialog) return dialog;
  dialog = document.querySelector('.ai-dialog');
  if (!dialog) return null;
  const input = dialog.querySelector('.ai-key-input');
  const error = dialog.querySelector('.ai-dialog-error');
  dialog.querySelector('.ai-key-cancel').addEventListener('click', () => dialog.close());
  dialog.querySelector('.ai-key-clear').addEventListener('click', () => { writeKey(''); dialog.close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.querySelector('form').addEventListener('submit', (e) => {
    const key = input.value.trim();
    if (!/^sk-ant-\S{10,}$/.test(key)) {
      e.preventDefault();
      error.textContent = 'Key 应以 sk-ant- 开头';
      return;
    }
    writeKey(key);
    const then = afterSave;
    afterSave = null;
    if (then) setTimeout(then);
  });
  onKeyChange(() => { dialog.querySelector('.ai-key-clear').hidden = !ownKey(); });
  return dialog;
}

export function openKeyDialog(then) {
  const d = wire();
  if (!d) return;
  afterSave = then || null;
  d.querySelector('.ai-key-input').value = ownKey();
  d.querySelector('.ai-dialog-error').textContent = '';
  d.showModal();
  d.querySelector('.ai-key-input').focus();
}

// ---------- SDK ----------
let sdk = null;
export async function loadSDK() {
  sdk = sdk || import('./vendor/anthropic-sdk.mjs');
  return (await sdk).default;
}

export async function createClient() {
  const Anthropic = await loadSDK();
  const own = ownKey();
  const opts = own ? { apiKey: own } : { apiKey: 'server', baseURL: location.origin + '/api/ai' };
  return { Anthropic, client: new Anthropic({ ...opts, dangerouslyAllowBrowser: true, maxRetries: own ? 1 : 0 }) };
}

// 被安全分类器拒绝时由服务端按类别自动换用备选模型
export const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// 把 SDK 的异常换成给访客看的中文提示；用户主动停止的原样抛出
export function friendlyError(Anthropic, e) {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  // 走本站服务器时，提示语由服务器给出（次数用完、服务不可用等）
  const viaServer = !ownKey() && SERVER_AI;
  const serverMsg = e instanceof Anthropic.APIError && e.error && e.error.error && e.error.error.message;
  if (viaServer && e instanceof Anthropic.AuthenticationError) return new Error('登录已失效，请刷新页面重新登录。');
  if (viaServer && serverMsg && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 413)) return new Error(serverMsg);
  if (viaServer && e instanceof Anthropic.APIConnectionError) return new Error('连不上服务器，请检查网络后再试。');
  if (e instanceof Anthropic.AuthenticationError) return Object.assign(new Error('API Key 无效，请重新设置。'), { badKey: true });
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('这个 Key 没有调用 Claude Opus 5.5 的权限。');
  if (e instanceof Anthropic.RateLimitError) return new Error('请求太频繁或额度已用完，稍后再试。');
  if (e instanceof Anthropic.APIConnectionError) return new Error('连不上 api.anthropic.com，请检查网络（部分地区需要代理）。');
  if (e instanceof Anthropic.APIError) {
    return new Error(`Claude 接口出错（${e.status || '网络'}）：${(e.error && e.error.error && e.error.error.message) || e.message}`);
  }
  return e;
}
