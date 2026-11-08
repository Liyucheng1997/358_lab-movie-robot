// AI 选片：用访客自己的 API Key 在浏览器里直接调用 Claude，按推荐片名回查站内条目。
// 实时版通过 /api/search 查豆瓣；静态版只在 catalog.json 已收录的影片里匹配。
import { MODEL, readKey, onKeyChange, openKeyDialog, createClient, friendlyError, FALLBACK } from './ai-common.js?v=1';

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

const SYSTEM = `你是「片刻」影视站的选片助手。用户会用自然语言描述想看的内容（心情、场合、题材、年代、地区、类似作品等），请推荐 6 部最契合的电影或剧集。

- 只推荐真实存在、豆瓣有条目的作品。title 用豆瓣上的中文通用片名，original_title 用原名（与中文名相同时照抄），year 为首映年份，网站会用它们检索影片。
- 用户没说要剧集时以电影为主；kind 标明 movie 或 tv。
- 兼顾口碑与多样性，不要都出自同一导演或同一系列。
- reason 用一两句中文说明它为什么符合用户的描述，具体到情节、气质或看点，不超过 60 字，不剧透关键反转。
- summary 用一句话复述你理解的需求。
- 如果描述与影视无关，在 summary 里礼貌说明，picks 返回空数组。`;

// 首页大搜索框：搜索和 AI 推荐共用
const omni = document.getElementById('omni');
const input = omni.querySelector('.omni-input');
const searchBtn = omni.querySelector('.omni-search');
const aiBtn = omni.querySelector('.omni-ai');
const extras = document.querySelector('.omni-extras');
const status = panel.querySelector('.ai-status');
const results = panel.querySelector('.ai-results');
function syncKeyState(has) {
  extras.classList.toggle('has-key', has);
  extras.querySelector('.ai-key-label').textContent = has ? '已设置 Key' : 'API Key';
}
extras.querySelector('.ai-key-btn').addEventListener('click', () => openKeyDialog());

// ---------- 回车走搜索还是 AI ----------
// 像描述（带「想看」「适合」「类似」之类的词、有标点或比较长）→ AI；像片名、人名 → 搜索
const DESCRIBE = /想看|想要|适合|类似|像《|那种|那样|来点|来部|有没有|推荐|几部|一部|什么片|好看的|心情|周末|晚上|下班|下雨|一个人|全家|孩子|情侣|治愈|烧脑|轻松|好笑|搞笑|感人|催泪|刺激|下饭|不费脑|[，,。！？?!]/;
function guessMode(q) {
  q = q.trim();
  if (!q) return 'search';
  if (DESCRIBE.test(q)) return 'ai';
  return q.length > 16 ? 'ai' : 'search';
}
// 窄屏输入框短，换成短一点的提示
if (window.matchMedia('(max-width: 767px)').matches) input.placeholder = '搜片名，或说说想看什么';
let mode = 'search';
let manual = false; // 用户点过按钮后，同一段文字不再自动切换
function setMode(m) {
  mode = m;
  searchBtn.classList.toggle('is-primary', m === 'search');
  aiBtn.classList.toggle('is-primary', m === 'ai');
  searchBtn.setAttribute('aria-pressed', String(m === 'search'));
  aiBtn.setAttribute('aria-pressed', String(m === 'ai'));
  input.enterKeyHint = m === 'ai' ? 'go' : 'search';
}
input.addEventListener('input', () => {
  if (!input.value.trim()) manual = false;
  if (!manual) setMode(guessMode(input.value));
});
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (mode === 'ai') { e.preventDefault(); startAI(); }
  // 搜索：交给表单原生提交到搜索页
});
omni.addEventListener('submit', (e) => {
  if (!input.value.trim()) { e.preventDefault(); input.focus(); return; }
  manual = true;
  setMode('search');
});
aiBtn.addEventListener('click', () => {
  if (current && current.controller) return current.controller.abort();
  startAI();
});
function startAI() {
  const prompt = input.value.trim();
  manual = true;
  setMode('ai');
  if (!prompt) { input.focus(); return; }
  run(prompt, false);
}
panel.querySelector('.ai-close').addEventListener('click', () => {
  if (current && current.controller) current.controller.abort();
  panel.hidden = true;
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
async function recommend(prompt, exclude, signal) {
  const { Anthropic, client } = await createClient();
  let system = SYSTEM;
  if (isStatic) {
    // 静态版只能播放快照里的影片，把片单交给模型优先挑选
    const list = (await loadCatalog()).map((d) => `${d.title}（${d.year || '?'}）`).join('、');
    system += `\n\n本站已收录、可以直接播放的影片：${list}\n同样契合时优先推荐这些影片，但不要为了凑数推荐不相关的作品。`;
  }
  let content = prompt;
  if (exclude.length) content += `\n\n（请换一批，不要再推荐：${exclude.join('、')}）`;

  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
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
    if (e instanceof SyntaxError) throw new Error('推荐结果格式异常，请再试一次。');
    throw friendlyError(Anthropic, e);
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
  omni.classList.toggle('is-busy', busy);
  aiBtn.querySelector('span').textContent = busy ? '停止' : 'AI 推荐';
}

async function run(prompt, more) {
  if (!readKey()) return openKeyDialog(() => run(prompt, more));
  if (current && current.controller) current.controller.abort();
  const shown = more && current && current.prompt === prompt ? current.shown : [];
  const controller = new AbortController();
  current = { prompt, shown, controller };
  setBusy(true);
  setStatus('');
  panel.hidden = false;
  skeleton();
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

extras.querySelectorAll('.ai-examples button').forEach((btn) => {
  btn.addEventListener('click', () => {
    input.value = btn.textContent;
    startAI();
  });
});

// 搜索页「让 AI 推荐」跳回首页时带 ?ai=关键词，直接交给 AI
const fromSearch = new URLSearchParams(location.search).get('ai');
if (fromSearch && fromSearch.trim()) {
  history.replaceState(null, '', location.pathname);
  input.value = fromSearch.trim().slice(0, 300);
  startAI();
}

onKeyChange(syncKeyState);
