// AI 选片和 AI 陪看共用：访客自己的 API Key（只存在本机 localStorage）、Key 弹窗、按需加载 SDK、错误提示。
export const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'anthropic_api_key';

export function readKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
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
  onKeyChange((has) => { dialog.querySelector('.ai-key-clear').hidden = !has; });
  return dialog;
}

export function openKeyDialog(then) {
  const d = wire();
  if (!d) return;
  afterSave = then || null;
  d.querySelector('.ai-key-input').value = readKey();
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
  return { Anthropic, client: new Anthropic({ apiKey: readKey(), dangerouslyAllowBrowser: true, maxRetries: 1 }) };
}

// 被安全分类器拒绝时由服务端按类别自动换用备选模型
export const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// 把 SDK 的异常换成给访客看的中文提示；用户主动停止的原样抛出
export function friendlyError(Anthropic, e) {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError) return Object.assign(new Error('API Key 无效，请重新设置。'), { badKey: true });
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('这个 Key 没有调用 Claude Opus 5.5 的权限。');
  if (e instanceof Anthropic.RateLimitError) return new Error('请求太频繁或额度已用完，稍后再试。');
  if (e instanceof Anthropic.APIConnectionError) return new Error('连不上 api.anthropic.com，请检查网络（部分地区需要代理）。');
  if (e instanceof Anthropic.APIError) {
    return new Error(`Claude 接口出错（${e.status || '网络'}）：${(e.error && e.error.error && e.error.error.message) || e.message}`);
  }
  return e;
}
