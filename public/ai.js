// AI 选片：用访客自己的 API Key 在浏览器里直接调用 Claude，按推荐片名回查站内条目。
// 实时版通过 /api/search 查豆瓣；静态版只在 catalog.json 已收录的影片里匹配。
const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'anthropic_api_key';
const base = document.body.dataset.staticBase || '';
const isStatic = Boolean(base);
const panel = document.getElementById('ai-panel');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'picks'],
  properties: {
    summary: { type: 'string' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'original_title', 'year', 'kind', 'genres', 'reason'],
        properties: {
          title: { type: 'string' },
          original_title: { type: 'string' },
          year: { type: 'integer' },
          kind: { type: 'string', enum: ['movie', 'tv'] },
          genres: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `你是「看片机器人」影视站的选片助手。用户会用自然语言描述想看的内容（心情、场合、题材、年代、地区、类似作品等），请推荐 6 部最契合的电影或剧集。

- 只推荐真实存在、豆瓣有条目的作品。title 用豆瓣上的中文通用片名，original_title 用原名（与中文名相同时照抄），year 为首映年份，网站会用它们检索影片。
- 用户没说要剧集时以电影为主；kind 标明 movie 或 tv。
- 兼顾口碑与多样性，不要都出自同一导演或同一系列。
- reason 用一两句中文说明它为什么符合用户的描述，具体到情节、气质或看点，不超过 60 字，不剧透关键反转。
- summary 用一句话复述你理解的需求。
- 如果描述与影视无关，在 summary 里礼貌说明，picks 返回空数组。`;

const $ = (sel) => panel.querySelector(sel);
const form = $('.ai-form');
const input = $('.ai-input');
const submit = $('.ai-submit');
const status = $('.ai-status');
const results = $('.ai-results');
const dialog = document.querySelector('.ai-dialog');
const keyInput = dialog.querySelector('.ai-key-input');
const keyError = dialog.querySelector('.ai-dialog-error');

function readKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}
function writeKey(key) {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch (e) {}
  syncKeyState();
}
function syncKeyState() {
  const has = Boolean(readKey());
  panel.classList.toggle('has-key', has);
  $('.ai-key-label').textContent = has ? '已设置 Key' : 'API Key';
  dialog.querySelector('.ai-key-clear').hidden = !has;
}

// ---------- API Key 弹窗 ----------
let afterSave = null;
function openKeyDialog(then) {
  afterSave = then || null;
  keyInput.value = readKey();
  keyError.textContent = '';
  dialog.showModal();
  keyInput.focus();
}
$('.ai-key-btn').addEventListener('click', () => openKeyDialog());
dialog.querySelector('.ai-key-cancel').addEventListener('click', () => dialog.close());
dialog.querySelector('.ai-key-clear').addEventListener('click', () => {
  writeKey('');
  dialog.close();
});
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
dialog.querySelector('form').addEventListener('submit', (e) => {
  const key = keyInput.value.trim();
  if (!/^sk-ant-\S{10,}$/.test(key)) {
    e.preventDefault();
    keyError.textContent = 'Key 应以 sk-ant- 开头';
    return;
  }
  writeKey(key);
  const then = afterSave;
  afterSave = null;
  if (then) setTimeout(then);
});

// ---------- 站内条目匹配 ----------
// 忽略大小写、空格和标点；片名（含原名、又名）一致且年份相差不超过 1 年才算同一部
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function bestMatch(items, pick) {
  const names = [pick.title, pick.original_title].map(norm).filter(Boolean);
  return items.find((it) => {
    const titles = [it.title, it.originalTitle].concat(it.aka || []).map(norm);
    const year = Number(it.year);
    return titles.some((t) => names.includes(t)) && (!year || !pick.year || Math.abs(year - pick.year) <= 1);
  }) || null;
}

let catalog = null;
function loadCatalog() {
  if (!catalog) {
    catalog = fetch(base + 'catalog.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  }
  return catalog;
}

async function lookup(pick) {
  if (isStatic) return bestMatch(await loadCatalog(), pick);
  for (const q of [pick.title, pick.original_title]) {
    if (!q) continue;
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const hit = bestMatch((await r.json()).items || [], pick);
      if (hit) return { ...hit, cover: hit.cover ? '/img?u=' + encodeURIComponent(hit.cover) : '' };
    } catch (e) {}
  }
  return null;
}

const playUrl = (id) => (isStatic ? `${base}play/${id}/` : `/play/${id}`);
const searchUrl = (q) => (isStatic ? `${base}search/?q=` : '/search?q=') + encodeURIComponent(q);

// ---------- 调用 Claude ----------
let sdk = null;
async function recommend(prompt, exclude, signal) {
  sdk = sdk || import('./vendor/anthropic-sdk.mjs');
  const { default: Anthropic } = await sdk;
  let system = SYSTEM;
  if (isStatic) {
    // 静态版只能播放快照里的影片，把片单交给模型优先挑选
    const list = (await loadCatalog()).map((d) => `${d.title}（${d.year || '?'}）`).join('、');
    system += `\n\n本站已收录、可以直接播放的影片：${list}\n同样契合时优先推荐这些影片，但不要为了凑数推荐不相关的作品。`;
  }
  let content = prompt;
  if (exclude.length) content += `\n\n（请换一批，不要再推荐：${exclude.join('、')}）`;

  const client = new Anthropic({ apiKey: readKey(), dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // 被安全分类器拒绝时由服务端按类别自动换用备选模型
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system,
      messages: [{ role: 'user', content }],
    }, { signal });
    if (msg.stop_reason === 'refusal') throw new Error('Claude 拒绝了这次请求，换个说法试试。');
    if (msg.stop_reason === 'max_tokens') throw new Error('回答被截断了，请再试一次。');
    const text = msg.content.find((b) => b.type === 'text');
    if (!text) throw new Error('没有收到推荐结果，请再试一次。');
    return JSON.parse(text.text);
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw Object.assign(new Error('API Key 无效，请重新设置。'), { badKey: true });
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('这个 Key 没有调用 Claude Opus 5.5 的权限。');
    if (e instanceof Anthropic.RateLimitError) throw new Error('请求太频繁或额度已用完，稍后再试。');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('连不上 api.anthropic.com，请检查网络（部分地区需要代理）。');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude 接口出错（${e.status || '网络'}）：${(e.error && e.error.error && e.error.error.message) || e.message}`);
    if (e instanceof SyntaxError) throw new Error('推荐结果格式异常，请再试一次。');
    throw e;
  }
}

// ---------- 渲染 ----------
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text, kind) {
  status.hidden = !text;
  status.textContent = text || '';
  status.dataset.kind = kind || '';
}

function skeleton() {
  results.hidden = false;
  results.replaceChildren(el('p', 'ai-summary is-loading', 'Claude 正在为你挑片…'));
  const grid = el('div', 'ai-grid');
  for (let i = 0; i < 6; i++) grid.appendChild(el('div', 'ai-pick is-skeleton'));
  results.appendChild(grid);
}

function pickCard(pick) {
  const card = el('a', 'ai-pick');
  card.href = isStatic ? `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(pick.title)}` : searchUrl(pick.title);
  if (isStatic) { card.target = '_blank'; card.rel = 'noopener'; }
  const poster = el('div', 'ai-poster');
  poster.appendChild(el('span', 'ai-poster-initial', pick.title.slice(0, 1)));
  const body = el('div', 'ai-pick-body');
  const title = el('h3', 'ai-pick-title', pick.title);
  const meta = [pick.year, pick.kind === 'tv' ? '剧集' : '电影'].concat(pick.genres.slice(0, 3)).filter(Boolean).join(' · ');
  const action = el('span', 'ai-pick-action', '查找中…');
  body.append(title, el('p', 'ai-pick-meta', meta), el('p', 'ai-pick-reason', pick.reason), action);
  card.append(poster, body);

  lookup(pick).then((hit) => {
    if (hit) {
      card.href = playUrl(hit.id);
      card.removeAttribute('target');
      card.classList.add('is-playable');
      action.textContent = '去播放';
      if (hit.rate) title.appendChild(el('span', 'score', String(hit.rate)));
      if (hit.cover) {
        const img = el('img');
        img.alt = '';
        img.src = hit.cover;
        img.onload = () => poster.classList.add('has-img');
        poster.appendChild(img);
      }
    } else {
      action.textContent = isStatic ? '本站未收录 · 去豆瓣看看' : '站内搜索';
    }
  });
  return card;
}

let current = null; // { prompt, shown: [片名], controller }
function render(data, prompt) {
  results.hidden = false;
  results.replaceChildren(el('p', 'ai-summary', data.summary));
  if (!data.picks.length) return;
  const grid = el('div', 'ai-grid');
  data.picks.forEach((p) => grid.appendChild(pickCard(p)));
  const more = el('div', 'ai-more');
  const again = el('button', 'pill-btn', '换一批');
  again.type = 'button';
  again.addEventListener('click', () => run(prompt, true));
  more.appendChild(again);
  results.append(grid, more);
}

function setBusy(busy) {
  panel.classList.toggle('is-busy', busy);
  submit.querySelector('span').textContent = busy ? '停止' : '推荐';
}

async function run(prompt, more) {
  if (!readKey()) return openKeyDialog(() => run(prompt, more));
  if (current && current.controller) current.controller.abort();
  const shown = more && current && current.prompt === prompt ? current.shown : [];
  const controller = new AbortController();
  current = { prompt, shown, controller };
  setBusy(true);
  setStatus('');
  skeleton();
  try {
    const data = await recommend(prompt, shown, controller.signal);
    if (current.controller !== controller) return;
    current.shown = shown.concat(data.picks.map((p) => p.title));
    render(data, prompt);
    results.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {
    if (current.controller !== controller) return;
    results.hidden = true;
    if (controller.signal.aborted) setStatus('已停止。');
    else {
      setStatus(e.message || '出错了，请再试一次。', 'error');
      if (e.badKey) openKeyDialog(() => run(prompt, more));
    }
  } finally {
    if (current.controller === controller) {
      current.controller = null;
      setBusy(false);
    }
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (current && current.controller) return current.controller.abort();
  const prompt = input.value.trim();
  if (!prompt) return input.focus();
  run(prompt, false);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
panel.querySelectorAll('.ai-examples button').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.textContent;
    run(input.value, false);
  });
});

syncKeyState();
