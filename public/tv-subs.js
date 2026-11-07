// 电视直播字幕：把视频的声音交给浏览器语音识别（Web Speech API 的 SpeechRecognition.start(音轨)），
// 实时生成原语言字幕；再用浏览器本机翻译（Translator API）翻成中文，本机翻译用不了时改用访客自己的 Claude Key。
// 识别优先在本机进行（processLocally），不支持时由浏览器的在线语音服务识别。
import { readKey, openKeyDialog, createClient, friendlyError } from './ai-common.js?v=1';

const MODE_KEY = 'tv_sub_mode'; // off | orig | zh | both
const LANG_KEY = 'tv_sub_lang'; // 频道 ID → 识别语言（手动改过的才存）
const TRANSLATE_MODEL = 'claude-haiku-5-5'; // 字幕要快，用小模型
const CLEAR_AFTER = 6000; // 多久没有新的识别结果就清掉字幕

export const LANGS = [
  ['en-US', '英语（美国）'], ['en-GB', '英语（英国）'], ['zh-CN', '普通话'], ['zh-TW', '国语（台湾）'], ['yue-Hant-HK', '粤语'],
  ['ja-JP', '日语'], ['ko-KR', '韩语'], ['fr-FR', '法语'], ['de-DE', '德语'], ['es-ES', '西班牙语（西班牙）'],
  ['es-MX', '西班牙语（拉美）'], ['it-IT', '意大利语'], ['pt-BR', '葡萄牙语（巴西）'], ['pt-PT', '葡萄牙语（葡萄牙）'],
  ['ru-RU', '俄语'], ['uk-UA', '乌克兰语'], ['pl-PL', '波兰语'], ['nl-NL', '荷兰语'], ['sv-SE', '瑞典语'], ['nb-NO', '挪威语'],
  ['da-DK', '丹麦语'], ['fi-FI', '芬兰语'], ['cs-CZ', '捷克语'], ['hu-HU', '匈牙利语'], ['ro-RO', '罗马尼亚语'],
  ['el-GR', '希腊语'], ['tr-TR', '土耳其语'], ['ar-SA', '阿拉伯语'], ['he-IL', '希伯来语'], ['fa-IR', '波斯语'],
  ['hi-IN', '印地语'], ['ur-PK', '乌尔都语'], ['bn-BD', '孟加拉语'], ['th-TH', '泰语'], ['vi-VN', '越南语'],
  ['id-ID', '印尼语'], ['ms-MY', '马来语'], ['fil-PH', '菲律宾语'],
];

const COUNTRY_LANG = {
  CN: 'zh-CN', TW: 'zh-TW', HK: 'yue-Hant-HK', MO: 'yue-Hant-HK', JP: 'ja-JP', KR: 'ko-KR',
  UK: 'en-GB', GB: 'en-GB', IE: 'en-GB', FR: 'fr-FR', DE: 'de-DE', AT: 'de-DE', CH: 'de-DE', IT: 'it-IT', SM: 'it-IT',
  ES: 'es-ES', PT: 'pt-PT', BR: 'pt-BR', AO: 'pt-PT', MZ: 'pt-PT', RU: 'ru-RU', BY: 'ru-RU', KZ: 'ru-RU', UA: 'uk-UA',
  PL: 'pl-PL', NL: 'nl-NL', BE: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', CZ: 'cs-CZ', HU: 'hu-HU',
  RO: 'ro-RO', MD: 'ro-RO', GR: 'el-GR', CY: 'el-GR', TR: 'tr-TR', IL: 'he-IL', IR: 'fa-IR', AF: 'fa-IR',
  IN: 'hi-IN', PK: 'ur-PK', BD: 'bn-BD', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', MY: 'ms-MY', PH: 'fil-PH',
  MX: 'es-MX', AR: 'es-MX', CO: 'es-MX', CL: 'es-MX', PE: 'es-MX', VE: 'es-MX', EC: 'es-MX', BO: 'es-MX', PY: 'es-MX',
  UY: 'es-MX', CR: 'es-MX', PA: 'es-MX', DO: 'es-MX', GT: 'es-MX', HN: 'es-MX', SV: 'es-MX', NI: 'es-MX', CU: 'es-MX', PR: 'es-MX',
  SA: 'ar-SA', AE: 'ar-SA', EG: 'ar-SA', QA: 'ar-SA', KW: 'ar-SA', BH: 'ar-SA', OM: 'ar-SA', JO: 'ar-SA', LB: 'ar-SA',
  SY: 'ar-SA', IQ: 'ar-SA', YE: 'ar-SA', LY: 'ar-SA', TN: 'ar-SA', DZ: 'ar-SA', MA: 'ar-SA', SD: 'ar-SA', PS: 'ar-SA',
};

// 频道所在地区的默认识别语言；不认识的地区按英语识别
export function langForCountry(code) {
  return COUNTRY_LANG[String(code || '').toUpperCase()] || 'en-US';
}

// 识别语言是否本来就是中文（中文字幕不用翻译）
export function isChinese(lang) {
  return /^(zh|yue|cmn)\b/i.test(String(lang || ''));
}

// 字幕太长时只留最后一段：从词边界截断，前面加省略号；中日韩文字按更短的长度截
export function tail(text, max) {
  text = String(text || '').trim().replace(/\s+/g, ' ');
  const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
  const limit = max || (cjk ? 40 : 90);
  if (text.length <= limit) return text;
  let start = text.length - limit;
  // 拼音文字往后挪到下一个词的开头（最多挪 20 个字符），中日韩文字直接截
  if (!cjk) {
    const space = text.indexOf(' ', start - 1);
    if (space >= 0 && space - start < 20) start = space + 1;
  }
  return '…' + text.slice(start).trim();
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// 浏览器能不能把视频音轨交给语音识别：在临时 iframe 里用错误参数调 start()，
// 支持音轨参数的浏览器会因为参数类型不对抛 TypeError；不支持的会忽略参数（iframe 里没有麦克风权限，不会弹窗）
let trackSupport = null;
function supportsTrack() {
  if (trackSupport !== null) return trackSupport;
  trackSupport = false;
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return false;
  const frame = document.body.appendChild(document.createElement('iframe'));
  frame.hidden = true;
  const W = frame.contentWindow;
  const R = W.SpeechRecognition || W.webkitSpeechRecognition;
  if (!R) { frame.remove(); return false; }
  const probe = new R();
  frame.remove();
  try { probe.start(0); probe.stop(); } catch (e) { trackSupport = e.name === 'TypeError'; }
  return trackSupport;
}

function init() {
  const video = document.getElementById('tv-video');
  const wrap = video.closest('.tv-wrap');
  const button = document.querySelector('.tv-subs-btn');
  const bar = document.getElementById('tv-subs-bar');
  const langSelect = document.getElementById('tv-sub-lang');
  const statusEl = bar.querySelector('.tv-subs-status');
  const box = document.getElementById('tv-subs');
  const zhLine = box.querySelector('.tv-sub-zh');
  const origLine = box.querySelector('.tv-sub-orig');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  let mode = 'off';
  try { mode = localStorage.getItem(MODE_KEY) || 'off'; } catch (e) {}
  if (!['off', 'orig', 'zh', 'both'].includes(mode)) mode = 'off';
  let lastMode = mode === 'off' ? 'both' : mode;
  let channel = null;
  let lang = 'en-US';

  // ---------- 显示 ----------
  let orig = '';
  let zh = '';
  let clearTimer = 0;
  function render() {
    const on = mode !== 'off' && (orig || zh);
    box.hidden = !on;
    if (!on) return;
    const chinese = isChinese(lang);
    // 本身是中文，或者翻译不可用时，「中文」模式也先显示原文
    const zhText = chinese ? orig : zh;
    const showZh = mode !== 'orig' && Boolean(zhText);
    const showOrig = mode === 'orig' || (mode === 'both' && !chinese) || (mode === 'zh' && !zhText);
    zhLine.textContent = showZh ? tail(zhText) : '';
    origLine.textContent = showOrig ? tail(orig) : '';
    zhLine.hidden = !showZh;
    origLine.hidden = !showOrig;
    box.classList.toggle('is-single', !(showZh && showOrig));
  }
  function show(nextOrig, nextZh) {
    if (nextOrig != null) orig = nextOrig;
    if (nextZh != null) zh = nextZh;
    render();
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { orig = ''; zh = ''; render(); }, CLEAR_AFTER);
  }
  function clearText() {
    clearTimeout(clearTimer);
    orig = ''; zh = '';
    render();
  }
  function status(text) { statusEl.textContent = text || ''; }
  const keyBtn = bar.querySelector('.tv-subs-key');
  // 需要中文、浏览器又不能本机翻译时，给出「用 Claude 翻译」的入口
  function syncKey() {
    keyBtn.hidden = !(channel && mode !== 'off' && mode !== 'orig' && !isChinese(lang) && translation === 'none');
  }

  // ---------- 视频的声音 → 音轨 ----------
  // createMediaElementSource 每个 <video> 只能调一次，之后声音都经过这个 AudioContext，
  // 所以还要接回扬声器。hls.js 播放的是同源 blob，不受跨域限制。
  let audio = null;
  function audioTrack() {
    if (audio) {
      if (audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
      return audio.track;
    }
    // 页面还没被点过时 AudioContext 会被挂起，接上后视频反而没声音，所以等用户点过再接
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    source.connect(ctx.destination);
    ctx.resume().catch(() => {});
    audio = { ctx, track: dest.stream.getAudioTracks()[0] };
    return audio.track;
  }
  video.addEventListener('play', () => { if (audio && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {}); });

  // ---------- 翻译 ----------
  let translation = 'none'; // local（浏览器本机翻译）| claude | pending（正在准备）| none
  let translator = null;
  let trGen = 0;
  async function setupTranslation() {
    const gen = ++trGen;
    if (translator) { try { translator.destroy(); } catch (e) {} translator = null; }
    translation = 'none';
    if (mode === 'orig' || isChinese(lang)) return;
    translation = 'pending';
    syncKey();
    const source = lang.split('-')[0];
    if ('Translator' in window) {
      try {
        const state = await withTimeout(Translator.availability({ sourceLanguage: source, targetLanguage: 'zh' }), 6000, 'unavailable');
        if (gen !== trGen) return;
        if (state !== 'unavailable') {
          if (state !== 'available') status('正在下载浏览器的翻译模型…');
          const t = await Translator.create({
            sourceLanguage: source,
            targetLanguage: 'zh',
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                if (gen === trGen && e.loaded < 1) status('正在下载浏览器的翻译模型 ' + Math.round(e.loaded * 100) + '%…');
              });
            },
          });
          if (gen !== trGen) { t.destroy(); return; }
          translator = t;
          translation = 'local';
          return;
        }
      } catch (e) {
        if (gen !== trGen) return;
      }
    }
    translation = readKey() ? 'claude' : 'none';
  }
  function translationNote() {
    if (mode === 'orig' || isChinese(lang)) return '';
    if (translation === 'local') return '中文由浏览器本机翻译';
    if (translation === 'claude') return '中文由 Claude 翻译（用你的 API Key）';
    if (translation === 'pending') return '正在准备中文翻译';
    return '这个浏览器不能本机翻译这种语言，暂时只显示原文';
  }

  // 本机翻译很快，识别中的半句话也翻；同一时间只翻最新的一句
  let pending = null;
  let busy = false;
  async function translateLocal(text) {
    pending = text;
    if (busy) return;
    busy = true;
    const gen = trGen;
    while (pending != null) {
      const job = pending;
      pending = null;
      try {
        const out = await translator.translate(job);
        if (gen !== trGen) break;
        show(null, out);
      } catch (e) { /* 翻不了这一句就跳过 */ }
    }
    busy = false;
  }

  // Claude 翻译：只翻说完的整句，攒着一起发，带上前几句帮助理解
  const queue = [];
  const said = [];
  let claudeBusy = false;
  async function translateClaude(text) {
    queue.push(text);
    if (claudeBusy) return;
    claudeBusy = true;
    const gen = trGen;
    while (queue.length && gen === trGen) {
      const batch = queue.splice(0).join(' ');
      let Anthropic = null;
      try {
        const made = await createClient();
        Anthropic = made.Anthropic;
        const msg = await made.client.messages.create({
          model: TRANSLATE_MODEL,
          max_tokens: 400,
          system: '你是电视直播的实时字幕翻译。用户给出语音识别得到的一段外语字幕（可能有识别错误、缺标点），把它翻成自然、简洁的简体中文字幕。只输出译文，不要解释，不要加引号。',
          messages: [{
            role: 'user',
            content: `频道：${channel ? channel.n : ''}\n<前文>${said.slice(-3).join(' ')}</前文>\n<字幕>${batch}</字幕>`,
          }],
        });
        if (gen !== trGen) break;
        said.push(batch);
        if (said.length > 6) said.shift();
        const out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (out) show(null, out);
      } catch (e) {
        if (gen !== trGen) break;
        const err = Anthropic ? friendlyError(Anthropic, e) : e;
        translation = 'none';
        queue.length = 0;
        syncKey();
        status('Claude 翻译失败：' + (err.message || err) + ' 先只显示原文。');
        if (err.badKey) openKeyDialog(() => { setupTranslation().then(() => status(translationNote())); });
        render();
      }
    }
    claudeBusy = false;
  }

  // ---------- 语音识别 ----------
  let rec = null;
  let recGen = 0;
  let startedAt = 0;
  let quickEnds = 0;
  let retryTimer = 0;
  function stopRec() {
    recGen++;
    clearTimeout(retryTimer);
    if (rec) { try { rec.abort(); } catch (e) {} rec = null; }
  }
  async function startRec() {
    stopRec();
    if (mode === 'off' || !channel || video.paused) return;
    const gen = recGen;
    const track = audioTrack();
    if (!track) { status('点一下播放器，字幕就会开始。'); return; }
    const r = new SR();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let local = false;
    if (SR.available && 'processLocally' in r) {
      try {
        const state = await withTimeout(SR.available({ langs: [lang], processLocally: true }), 5000, 'unavailable');
        if (state === 'available') local = true;
        // 模型还没装好就先在线识别，装好后下一轮自动换成本机识别
        else if (state === 'downloadable' || state === 'downloading') SR.install({ langs: [lang], processLocally: true }).catch(() => {});
      } catch (e) { /* 走在线识别 */ }
    }
    if (gen !== recGen) return;
    if (local) r.processLocally = true;
    let fatal = false;
    r.onstart = () => {
      if (gen !== recGen) return;
      startedAt = Date.now();
      const where = local ? '本机识别' : '在线识别（声音会发给浏览器的语音服务）';
      const muted = video.muted || video.volume === 0 ? ' 现在是静音，识别不到声音，请打开声音。' : '';
      status(`字幕：${where}，识别语言 ${langLabel(lang)}。${translationNote() ? translationNote() + '。' : ''}字幕会比画面晚几秒。${muted}`);
    };
    r.onresult = (e) => {
      if (gen !== recGen) return;
      quickEnds = 0;
      let text = '';
      let final = true;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (!e.results[i].isFinal) final = false;
      }
      text = text.trim();
      if (!text) return;
      show(text, null);
      if (mode === 'orig' || isChinese(lang)) return;
      if (translation === 'local') translateLocal(text);
      else if (translation === 'claude' && final) translateClaude(text);
    };
    r.onerror = (e) => {
      if (gen !== recGen) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      fatal = true;
      if (e.error === 'network') {
        status('在线语音识别连不上（浏览器的语音服务在海外，部分网络需要代理），15 秒后重试。');
        retryTimer = setTimeout(() => { if (gen === recGen) startRec(); }, 15000);
      } else if (e.error === 'language-not-supported') {
        status(`浏览器不支持识别${langLabel(lang)}，换一个识别语言试试。`);
      } else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        status('浏览器不允许语音识别（可能被设置或策略禁用了）。');
      } else if (e.error === 'audio-capture') {
        status('拿不到视频的声音。');
      } else {
        status('语音识别出错（' + e.error + '），5 秒后重试。');
        retryTimer = setTimeout(() => { if (gen === recGen) startRec(); }, 5000);
      }
    };
    // 连续识别隔一阵会自己结束，接着重开；短时间内反复结束就歇一会儿，免得空转
    r.onend = () => {
      if (gen !== recGen || fatal) return;
      quickEnds = Date.now() - startedAt < 2000 ? quickEnds + 1 : 0;
      const wait = quickEnds >= 3 ? 3000 : 100;
      retryTimer = setTimeout(() => { if (gen === recGen && !video.paused) startRec(); }, wait);
    };
    try {
      r.start(track);
      rec = r;
    } catch (e) {
      status('语音识别启动失败：' + e.message);
    }
  }

  // ---------- 设置 ----------
  function langLabel(code) {
    const hit = LANGS.find((l) => l[0] === code);
    return hit ? hit[1] : code;
  }
  LANGS.forEach(([code, label]) => langSelect.add(new Option(label, code)));
  function savedLangs() {
    try { return JSON.parse(localStorage.getItem(LANG_KEY)) || {}; } catch (e) { return {}; }
  }
  function pickLang() {
    lang = (channel && savedLangs()[channel.id]) || langForCountry(channel && channel.c);
    langSelect.value = lang;
  }
  langSelect.addEventListener('change', () => {
    lang = langSelect.value;
    installLocal();
    if (channel) {
      const all = savedLangs();
      if (lang === langForCountry(channel.c)) delete all[channel.id];
      else all[channel.id] = lang;
      try { localStorage.setItem(LANG_KEY, JSON.stringify(all)); } catch (e) {}
    }
    restart();
  });

  function syncUI() {
    const on = mode !== 'off';
    button.setAttribute('aria-pressed', String(on));
    bar.hidden = !on || !channel;
    bar.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    syncKey();
    render();
  }
  function setMode(next) {
    const before = mode;
    mode = next;
    if (mode !== 'off') lastMode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
    syncUI();
    if (mode === 'off') { stopRec(); clearText(); status(''); return; }
    // 只是在「中文 / 双语」之间切换，不用重开识别
    if (before !== 'off' && before !== 'orig' && mode !== 'orig') { render(); return; }
    restart();
  }
  async function restart() {
    clearText();
    if (mode === 'off') return;
    if (!supportsTrack()) {
      status('这个浏览器不能识别视频里的声音。字幕需要电脑版新版 Chrome。');
      return;
    }
    if (!channel) { status('选一个频道，开始播放后自动出字幕。'); return; }
    await setupTranslation();
    syncKey();
    if (video.paused) { status('开始播放后自动出字幕。'); return; }
    startRec();
  }

  // 本机识别模型要在用户点击时才能开始下载：点开字幕、换识别语言时顺手装上，下次识别就在本机进行
  function installLocal() {
    if (!SR || !SR.install || !supportsTrack()) return;
    try { SR.install({ langs: [lang], processLocally: true }).catch(() => {}); } catch (e) {}
  }
  button.addEventListener('click', () => {
    if (mode === 'off') { installLocal(); setMode(lastMode); }
    else setMode('off');
  });
  bar.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  keyBtn.addEventListener('click', () => openKeyDialog(() => restart()));

  // ---------- 跟随播放器 ----------
  document.addEventListener('tv:channel', (e) => {
    channel = e.detail;
    stopRec();
    pickLang();
    // 点频道时（还在点击事件里）顺手装本机识别模型
    if (mode !== 'off') installLocal();
    syncUI();
    restart();
  });
  video.addEventListener('playing', () => {
    if (mode !== 'off' && channel && !rec) startRec();
  });
  video.addEventListener('pause', () => { stopRec(); });
  video.addEventListener('emptied', () => { stopRec(); clearText(); });
  video.addEventListener('volumechange', () => {
    if (mode !== 'off' && rec && (video.muted || video.volume === 0)) status('现在是静音，识别不到声音，请打开声音。');
  });

  if (window.tvChannel) { channel = window.tvChannel; pickLang(); }
  syncUI();
  if (mode !== 'off') restart();
  wrap.classList.add('has-subs');
}

if (typeof document !== 'undefined' && document.getElementById('tv-video') && document.getElementById('tv-subs')) init();
