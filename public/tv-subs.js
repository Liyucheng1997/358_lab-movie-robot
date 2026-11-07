// 电视直播字幕：把视频的声音交给浏览器语音识别（Web Speech API 的 SpeechRecognition.start(音轨)），
// 生成原语言字幕；再用浏览器本机翻译（Translator API）翻成中文，本机翻译用不了时改用访客自己的 Claude Key。
// 识别默认用浏览器的在线语音服务；连不上时可以手动下载本机识别模型改用本机识别（processLocally）。
// 识别中的半句话会不停变化，所以只用说完的整句：等识别定稿、翻译完成，再一条一条按阅读时长显示。
import { readKey, openKeyDialog, createClient, friendlyError } from './ai-common.js?v=1';

const MODE_KEY = 'tv_sub_mode'; // off | orig | zh | both
const LANG_KEY = 'tv_sub_lang'; // 频道 ID → 识别语言（手动改过的才存）
const TRANSLATE_MODEL = 'claude-haiku-5-5'; // 字幕要快，用小模型
const LINGER = 3000; // 最后一条字幕放完后再留多久
const FORCE_FINAL_MS = 10000; // 一口气说太久一直不定稿时，强制定稿，免得字幕迟迟不出
const FORCE_FINAL_CHARS = 160;

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
  const limit = max || (cjk ? 60 : 130);
  if (text.length <= limit) return text;
  let start = text.length - limit;
  // 拼音文字往后挪到下一个词的开头（最多挪 20 个字符），中日韩文字直接截
  if (!cjk) {
    const space = text.indexOf(' ', start - 1);
    if (space >= 0 && space - start < 20) start = space + 1;
  }
  return '…' + text.slice(start).trim();
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

// 把说完的一段话切成一条条字幕：先按句末标点切，太长的再按词（中日韩按逗号或字数）切成长度相近的几段
export function splitSentences(text, max) {
  text = String(text || '').trim().replace(/\s+/g, ' ');
  if (!text) return [];
  const cjk = CJK.test(text);
  const limit = max || (cjk ? 32 : 84);
  const sentences = text.split(cjk ? /(?<=[。！？!?])/ : /(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  sentences.forEach((sentence) => {
    if (sentence.length <= limit) { out.push(sentence); return; }
    const n = Math.ceil(sentence.length / limit);
    const target = sentence.length / n;
    if (cjk) {
      // 优先在逗号后面断，找不到就按字数断
      let rest = sentence;
      while (rest.length > limit) {
        let cut = -1;
        for (let i = Math.min(limit, rest.length - 1); i >= target * 0.6; i--) if ('，、；：,;:'.includes(rest[i - 1])) { cut = i; break; }
        if (cut < 0) cut = Math.round(Math.min(limit, target));
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push(rest);
      return;
    }
    let line = '';
    sentence.split(' ').forEach((word) => {
      if (line && (line.length + 1 + word.length > limit || line.length >= target)) { out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    });
    if (line) out.push(line);
  });
  return out;
}

// 一条字幕显示多久：按原文词数 / 中文字数估算阅读时间；积压多了就放快点追上
export function cueDuration(cue, backlog) {
  const words = String(cue.orig || '').split(/\s+/).filter(Boolean).length;
  const chars = String(cue.zh || '').length;
  let ms = Math.max(words * 330, chars * 190, CJK.test(cue.orig || '') ? String(cue.orig).length * 190 : 0);
  ms = Math.min(6000, Math.max(1600, ms));
  if (backlog >= 4) ms *= 0.45;
  else if (backlog >= 2) ms *= 0.7;
  return Math.round(ms);
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

  // ---------- 显示：一条一条地放，每条是说完的一句和它的译文 ----------
  const cues = [];
  let cue = null; // 正在显示的 { orig, zh }
  let playing = false;
  let cueTimer = 0;
  let lingerTimer = 0;
  let pipeGen = 0; // 换频道、换语言、关字幕时作废还在识别 / 翻译中的句子
  function render() {
    const on = mode !== 'off' && Boolean(cue);
    box.hidden = !on;
    if (!on) return;
    const chinese = isChinese(lang);
    // 本身是中文，或者这句没有译文时，「中文」模式显示原文
    const zhText = chinese ? cue.orig : cue.zh;
    const showZh = mode !== 'orig' && Boolean(zhText);
    const showOrig = mode === 'orig' || (mode === 'both' && !chinese) || (mode === 'zh' && !zhText);
    zhLine.textContent = showZh ? tail(zhText) : '';
    origLine.textContent = showOrig ? tail(cue.orig) : '';
    zhLine.hidden = !showZh;
    origLine.hidden = !showOrig;
    box.classList.toggle('is-single', !(showZh && showOrig));
  }
  function enqueue(next) {
    cues.push(next);
    if (!playing) showNext();
  }
  function showNext() {
    clearTimeout(lingerTimer);
    const next = cues.shift();
    if (!next) {
      playing = false;
      lingerTimer = setTimeout(() => { cue = null; render(); }, LINGER);
      return;
    }
    playing = true;
    cue = next;
    render();
    cueTimer = setTimeout(showNext, cueDuration(next, cues.length));
  }
  function clearText() {
    pipeGen++;
    cues.length = 0;
    clearTimeout(cueTimer);
    clearTimeout(lingerTimer);
    playing = false;
    cue = null;
    render();
  }
  // 状态分两段：识别的状态和翻译的状态，互不覆盖
  let recNote = '';
  let trNote = '';
  function paintStatus() { statusEl.textContent = [recNote, trNote].filter(Boolean).join(' '); }
  function status(text) { recNote = text || ''; paintStatus(); }
  function trStatus(text) { trNote = text || ''; paintStatus(); }
  const keyBtn = bar.querySelector('.tv-subs-key');
  // 需要中文、浏览器又不能本机翻译时，给出「用 Claude 翻译」的入口
  function syncKey() {
    keyBtn.hidden = !(channel && mode !== 'off' && mode !== 'orig' && !isChinese(lang) &&
      (translation === 'none' || (translation === 'pending' && !readKey())));
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
  let translation = 'none'; // local（浏览器本机翻译）| claude | pending（正在下载翻译模型）| none
  let translator = null;
  let trGen = 0;
  async function setupTranslation() {
    const gen = ++trGen;
    if (translator) { try { translator.destroy(); } catch (e) {} translator = null; }
    translation = 'none';
    trStatus('');
    if (mode === 'orig' || isChinese(lang)) { syncKey(); return; }
    const source = lang.split('-')[0];
    if ('Translator' in window) {
      try {
        const state = await withTimeout(Translator.availability({ sourceLanguage: source, targetLanguage: 'zh' }), 6000, 'unavailable');
        if (gen !== trGen) return;
        if (state !== 'unavailable') {
          if (state !== 'available') {
            // 第一次用这种语言要下载 Chrome 的翻译语言包，Chrome 常常一直报 0% 直到下载完；下载期间先显示原文
            translation = 'pending';
            syncKey();
            trStatus('正在下载 Chrome 的翻译语言包（第一次要等一会儿，可能几分钟），好了之前先显示原文' + (readKey() ? '，中文暂由 Claude 翻译。' : '。'));
          }
          const t = await Translator.create({
            sourceLanguage: source,
            targetLanguage: 'zh',
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                if (gen === trGen && e.loaded > 0 && e.loaded < 1) trStatus('正在下载 Chrome 的翻译语言包 ' + Math.round(e.loaded * 100) + '%，好了之前先显示原文。');
              });
            },
          });
          if (gen !== trGen) { t.destroy(); return; }
          translator = t;
          translation = 'local';
          trStatus('中文由浏览器本机翻译。');
          syncKey();
          return;
        }
      } catch (e) {
        if (gen !== trGen) return;
        // 下载翻译模型要在点击时开始，错过了就提示再点一下
        if (e.name === 'NotAllowedError') {
          translation = readKey() ? 'claude' : 'none';
          syncKey();
          trStatus('点一下上面的「双语」或「中文」开始下载 Chrome 的翻译语言包。');
          return;
        }
      }
    }
    translation = readKey() ? 'claude' : 'none';
    syncKey();
    trStatus(translationNote() ? translationNote() + '。' : '');
  }
  function translationNote() {
    if (mode === 'orig' || isChinese(lang)) return '';
    if (translation === 'local') return '中文由浏览器本机翻译';
    if (translation === 'claude') return '中文由 Claude 翻译（用你的 API Key）';
    if (translation === 'pending') return '正在下载翻译语言包';
    return '这个浏览器不能本机翻译这种语言，暂时只显示原文；可以用 Claude 翻译';
  }

  // 说完一段话：切成几条字幕，按顺序翻译，全部翻好后再排进显示队列（保证先说的先显示）
  let chain = Promise.resolve();
  function onFinal(text) {
    const parts = splitSentences(text);
    if (!parts.length) return;
    const gen = pipeGen;
    chain = chain.then(async () => {
      if (gen !== pipeGen) return;
      const zh = await translateParts(parts);
      if (gen !== pipeGen) return;
      if (zh.merged != null) enqueue({ orig: parts.join(' '), zh: zh.merged });
      else parts.forEach((orig, i) => enqueue({ orig, zh: zh[i] || '' }));
    }).catch(() => {});
  }
  async function translateParts(parts) {
    if (mode === 'orig' || isChinese(lang)) return [];
    if (translation === 'local') {
      return Promise.all(parts.map((part) => withTimeout(translator.translate(part), 8000, '').catch(() => '')));
    }
    if (translation === 'claude' || (translation === 'pending' && readKey())) return translateClaude(parts);
    return []; // 翻译还在下载或用不了：先只显示原文
  }

  // Claude 翻译：一段话的几条字幕一次发，逐行对应；带上前几句帮助理解
  const said = [];
  async function translateClaude(parts) {
    let Anthropic = null;
    try {
      const made = await createClient();
      Anthropic = made.Anthropic;
      const msg = await made.client.messages.create({
        model: TRANSLATE_MODEL,
        max_tokens: 800,
        system: '你是电视直播的实时字幕翻译。用户给出语音识别得到的几行外语字幕（可能有识别错误、缺标点），逐行翻成自然、简洁的简体中文字幕：输出的行数和输入完全相同，一行对应一行。只输出译文，不要编号、解释或引号。',
        messages: [{
          role: 'user',
          content: `频道：${channel ? channel.n : ''}\n<前文>${said.slice(-3).join(' ')}</前文>\n<字幕>\n${parts.join('\n')}\n</字幕>`,
        }],
      });
      said.push(parts.join(' '));
      if (said.length > 6) said.shift();
      const lines = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').split('\n').map((x) => x.trim()).filter(Boolean);
      if (lines.length === parts.length) return lines;
      // 行数对不上：整段原文和整段译文合成一条
      return { merged: lines.join('') };
    } catch (e) {
      const err = Anthropic ? friendlyError(Anthropic, e) : e;
      if (translation === 'claude') translation = 'none';
      syncKey();
      trStatus('Claude 翻译失败：' + (err.message || err) + ' 先只显示原文。');
      if (err.badKey) openKeyDialog(() => { setupTranslation(); });
      return [];
    }
  }

  // ---------- 语音识别 ----------
  let rec = null;
  let recGen = 0;
  let startedAt = 0;
  let quickEnds = 0;
  let retryTimer = 0;
  let silentTimer = 0;
  function stopRec() {
    recGen++;
    clearTimeout(retryTimer);
    clearTimeout(silentTimer);
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
    // 默认在线识别；用户点过「改用本机识别」且模型装好了才在本机识别
    const local = useLocal && 'processLocally' in r;
    if (local) r.processLocally = true;
    let fatal = false;
    let heard = 0; // 听到说话的时间，用来发现「有声音却一直没有文字」
    r.onspeechstart = () => {
      if (gen !== recGen || heard) return;
      heard = Date.now();
      silentTimer = setTimeout(() => {
        if (gen !== recGen) return;
        status(`已经听到声音，但识别一直没有返回文字。换一个识别语言试试${local ? '，或者改回在线识别' : ''}。`);
        localBtn.hidden = !local;
        localBtn.textContent = '改回在线识别';
      }, 25000);
    };
    r.onstart = () => {
      if (gen !== recGen) return;
      startedAt = Date.now();
      const where = local ? '本机识别' : '在线识别（声音会发给浏览器的语音服务）';
      const muted = video.muted || video.volume === 0 ? ' 现在是静音，识别不到声音，请打开声音。' : '';
      status(`字幕：${where}，识别语言 ${langLabel(lang)}。等一句话说完、翻译好再显示，会比画面晚几秒。${muted}`);
    };
    // 只处理定稿的结果；半句话不显示，只用来判断是不是说太久了还没定稿
    const done = new Set();
    let utterSince = 0;
    let forcing = false;
    r.onresult = (e) => {
      if (gen !== recGen) return;
      quickEnds = 0;
      clearTimeout(silentTimer);
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          if (!done.has(i)) { done.add(i); onFinal(result[0].transcript); }
        } else interim += result[0].transcript;
      }
      if (!interim.trim()) { utterSince = 0; return; }
      if (!utterSince) utterSince = Date.now();
      // stop() 会把已经听到的部分定稿，结束后自动重开识别
      if (!forcing && (Date.now() - utterSince > FORCE_FINAL_MS || interim.length > FORCE_FINAL_CHARS)) {
        forcing = true;
        try { r.stop(); } catch (err) {}
      }
    };
    r.onerror = (e) => {
      if (gen !== recGen) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      fatal = true;
      if (e.error === 'network') {
        status('在线语音识别连不上（浏览器的语音服务在海外，部分网络需要代理），15 秒后重试。');
        retryTimer = setTimeout(() => { if (gen === recGen) startRec(); }, 15000);
        offerLocal();
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
    useLocal = false;
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
    if (mode === 'off') { stopRec(); clearText(); status(''); trStatus(''); return; }
    // 只是在「中文 / 双语」之间切换，不用重开识别
    if (before !== 'off' && before !== 'orig' && mode !== 'orig') {
      if (translation === 'none') setupTranslation();
      render();
      return;
    }
    restart();
  }
  function restart() {
    clearText();
    if (mode === 'off') return;
    if (!supportsTrack()) {
      status('这个浏览器不能识别视频里的声音。字幕需要电脑版新版 Chrome。');
      return;
    }
    if (!channel) { status('选一个频道，开始播放后自动出字幕。'); return; }
    localBtn.hidden = true;
    // 翻译模型可能要下载很久，识别不等它，先出原文
    setupTranslation();
    if (video.paused) { status('开始播放后自动出字幕。'); return; }
    startRec();
  }

  // 本机识别：在线识别连不上时才提供，模型要在用户点击时下载
  let useLocal = false;
  const localBtn = bar.querySelector('.tv-subs-local');
  async function offerLocal() {
    if (useLocal || !SR.available || !SR.install) return;
    const state = await withTimeout(SR.available({ langs: [lang], processLocally: true }).catch(() => 'unavailable'), 5000, 'unavailable');
    if (state === 'unavailable') return;
    localBtn.textContent = state === 'available' ? '改用本机识别' : '下载本机识别模型';
    localBtn.hidden = false;
  }
  localBtn.addEventListener('click', async () => {
    localBtn.hidden = true;
    if (useLocal) { useLocal = false; startRec(); return; } // 改回在线识别
    stopRec();
    status('正在下载本机识别模型…');
    let ok = false;
    try { ok = await SR.install({ langs: [lang], processLocally: true }); } catch (e) {}
    if (!ok) { status('本机识别模型下载失败。'); return; }
    useLocal = true;
    startRec();
  });
  button.addEventListener('click', () => {
    if (mode === 'off') setMode(lastMode);
    else setMode('off');
  });
  bar.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  keyBtn.addEventListener('click', () => openKeyDialog(() => restart()));

  // ---------- 跟随播放器 ----------
  document.addEventListener('tv:channel', (e) => {
    channel = e.detail;
    stopRec();
    pickLang();
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
