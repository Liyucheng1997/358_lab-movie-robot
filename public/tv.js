(function () {
  // 电视直播：读取服务端检测好的频道数据（/tv/data/），按地区、类型浏览，hls.js 播放；
  // 一条线路播不了自动换下一条。收藏和最近观看只存在本机。
  var base = document.body.dataset.staticBase || '/';
  var DATA = base + 'tv/data/';
  var FAV_KEY = 'tv_fav_v1';
  var RECENT_KEY = 'tv_recent_v1';
  var COUNTRY_KEY = 'tv_country';
  var PAGE = 96; // 一次渲染多少个频道
  var START_TIMEOUT = 15000; // 一条线路多久没开始播就换下一条
  var CAT = {
    general: '综合', news: '新闻', sports: '体育', movies: '电影', series: '剧集', kids: '少儿', animation: '动画',
    music: '音乐', entertainment: '娱乐', documentary: '纪录', science: '科学', education: '教育', culture: '文化',
    business: '财经', lifestyle: '生活', cooking: '美食', travel: '旅行', outdoor: '户外', auto: '汽车', comedy: '喜剧',
    classic: '经典', family: '家庭', relax: '休闲', weather: '天气', legislative: '议会', public: '公共', religious: '宗教',
    shop: '购物', interactive: '互动', other: '其他',
  };

  var $ = function (id) { return document.getElementById(id); };
  var video = $('tv-video');
  var empty = $('tv-empty');
  var now = $('tv-now');
  var lines = $('tv-lines');
  var statusEl = $('tv-status');
  var meta = $('tv-meta');
  var countriesBox = $('tv-countries');
  var catsBox = $('tv-cats');
  var grid = $('tv-grid');
  var sentinel = $('tv-sentinel');
  var qInput = $('tv-q');
  var favBtn = now.querySelector('.tv-fav-btn');

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function status(text) { statusEl.textContent = text || ''; }

  var index = null;
  var cache = {}; // 地区 → 频道列表
  var country = '';
  var list = [];
  var filtered = [];
  var shown = 0;
  var cat = 'all';
  var current = null; // 正在播的频道
  var lineIdx = 0;
  var hls = null;
  var startTimer = 0;
  var generation = 0;

  // ---------- 收藏 / 最近观看（存频道本身，换地区也能直接播） ----------
  function slim(ch) { return { id: ch.id, n: ch.n, l: ch.l, c: ch.c, cat: ch.cat, s: ch.s }; }
  function favs() { return readJSON(FAV_KEY, []); }
  function isFav(ch) { return favs().some(function (f) { return f.id === ch.id; }); }
  function toggleFav(ch) {
    var list = favs();
    var on = isFav(ch);
    list = list.filter(function (f) { return f.id !== ch.id; });
    if (!on) list.unshift(slim(ch));
    writeJSON(FAV_KEY, list.slice(0, 200));
    return !on;
  }
  function pushRecent(ch) {
    var list = readJSON(RECENT_KEY, []).filter(function (f) { return f.id !== ch.id; });
    list.unshift(slim(ch));
    writeJSON(RECENT_KEY, list.slice(0, 30));
  }

  // Windows 不显示国旗表情（会变成两个字母），只写地区名
  var FLAGS = !/Windows/.test(navigator.userAgent);
  function regionLabel(c) { return (FLAGS && c.flag ? c.flag + ' ' : '') + c.name; }
  function countryOf(code) {
    return (index && index.countries.filter(function (c) { return c.code === code; })[0]) || { code: code, name: code, flag: '' };
  }

  // ---------- 地区 ----------
  function renderCountries() {
    countriesBox.replaceChildren();
    var tabs = [];
    var fav = favs(), recent = readJSON(RECENT_KEY, []);
    if (fav.length) tabs.push({ code: 'fav', label: '★ 收藏', count: fav.length });
    if (recent.length) tabs.push({ code: 'recent', label: '最近观看', count: recent.length });
    index.countries.forEach(function (c) { tabs.push({ code: c.code, label: regionLabel(c), count: c.count }); });
    tabs.forEach(function (t) {
      var b = el('button', 'tv-country');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.code = t.code;
      b.append(el('span', null, t.label), el('small', null, String(t.count)));
      b.setAttribute('aria-selected', String(t.code === country));
      b.addEventListener('click', function () { selectCountry(t.code); });
      countriesBox.appendChild(b);
    });
  }

  function selectCountry(code, then) {
    country = code;
    cat = 'all';
    qInput.value = '';
    if (code !== 'fav' && code !== 'recent') {
      try { localStorage.setItem(COUNTRY_KEY, code); } catch (e) {}
    }
    countriesBox.querySelectorAll('.tv-country').forEach(function (b) {
      var on = b.dataset.code === code;
      b.setAttribute('aria-selected', String(on));
      if (on && b.scrollIntoView && countriesBox.scrollWidth > countriesBox.clientWidth) b.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    if (code === 'fav' || code === 'recent') {
      setList(readJSON(code === 'fav' ? FAV_KEY : RECENT_KEY, []));
      if (then) then();
      return;
    }
    grid.replaceChildren(el('p', 'text-muted tv-loading', '正在加载频道…'));
    loadCountry(code).then(function (items) {
      if (country !== code) return;
      setList(items);
      if (then) then();
    }).catch(function () {
      grid.replaceChildren(el('p', 'text-muted', '频道列表加载失败，请刷新重试。'));
    });
  }

  function loadCountry(code) {
    if (!cache[code]) {
      cache[code] = fetch(DATA + 'c/' + code + '.json').then(function (r) {
        if (!r.ok) throw new Error('加载失败');
        return r.json();
      }).then(function (items) {
        items.forEach(function (ch) { ch.c = code; });
        return items;
      });
      cache[code].catch(function () { delete cache[code]; });
    }
    return cache[code];
  }

  // ---------- 类型 + 搜索 ----------
  function setList(items) {
    list = items;
    renderCats();
    applyFilter();
  }
  function renderCats() {
    var count = {};
    list.forEach(function (ch) { (ch.cat || ['other']).forEach(function (k) { count[k] = (count[k] || 0) + 1; }); });
    // 宗教、购物、其他排在最后
    var LAST = ['religious', 'shop', 'other'];
    var keys = Object.keys(count).sort(function (a, b) { return (LAST.indexOf(a) >= 0) - (LAST.indexOf(b) >= 0) || count[b] - count[a]; });
    catsBox.replaceChildren();
    if (keys.length < 2) return;
    [['all', '全部', list.length]].concat(keys.map(function (k) { return [k, CAT[k] || k, count[k]]; })).forEach(function (c) {
      var li = el('li');
      var a = el('a', c[0] === cat ? 'active' : '', c[1] + ' ' + c[2]);
      a.href = '#';
      a.addEventListener('click', function (e) {
        e.preventDefault();
        cat = c[0];
        catsBox.querySelectorAll('a').forEach(function (x) { x.classList.toggle('active', x === a); });
        applyFilter();
      });
      li.appendChild(a);
      catsBox.appendChild(li);
    });
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s\-_·.]+/g, ''); }
  function applyFilter() {
    var q = norm(qInput.value);
    filtered = list.filter(function (ch) {
      if (cat !== 'all' && (ch.cat || ['other']).indexOf(cat) < 0) return false;
      if (!q) return true;
      return [ch.n, ch.id].concat(ch.a || []).some(function (t) { return norm(t).indexOf(q) >= 0; });
    });
    shown = 0;
    grid.replaceChildren();
    if (!filtered.length) {
      grid.appendChild(el('p', 'text-muted tv-loading', country === 'fav' ? '还没有收藏频道。' : q ? '没有找到这个频道，换个关键词或地区试试。' : '这里暂时没有可以播放的频道。'));
      return;
    }
    more();
  }
  qInput.addEventListener('input', applyFilter);

  // ---------- 频道格子 ----------
  function logo(ch, cls) {
    var box = el('span', cls);
    var initial = el('span', 'tv-initial', String(ch.n || '?').replace(/^[\s\W]+/, '').slice(0, 2) || '?');
    box.appendChild(initial);
    if (ch.l) {
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { box.classList.add('has-img'); };
      img.onerror = function () { img.remove(); };
      img.src = ch.l;
      box.appendChild(img);
    }
    return box;
  }
  function best(ch) {
    var q = ch.s.map(function (s) { return parseInt(s.q, 10) || 0; });
    var h = Math.max.apply(null, q);
    return h >= 1080 ? '1080P' : h >= 720 ? '720P' : '';
  }
  function tile(ch) {
    var b = el('button', 'tv-ch');
    b.type = 'button';
    b.dataset.id = ch.id;
    if (current && current.id === ch.id) b.classList.add('is-playing');
    var body = el('span', 'tv-ch-body');
    body.appendChild(el('span', 'tv-ch-name', ch.n));
    var info = [best(ch), ch.s.length > 1 ? ch.s.length + ' 条线路' : ''].filter(Boolean).join(' · ');
    if (country === 'fav' || country === 'recent') info = [regionLabel(countryOf(ch.c)), info].filter(Boolean).join(' · ');
    if (info) body.appendChild(el('span', 'tv-ch-info', info));
    b.append(logo(ch, 'tv-logo'), body);
    b.addEventListener('click', function () { play(ch, true); });
    return b;
  }
  function more() {
    var next = filtered.slice(shown, shown + PAGE);
    next.forEach(function (ch) { grid.appendChild(tile(ch)); });
    shown += next.length;
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && shown < filtered.length) more();
    }, { rootMargin: '600px' }).observe(sentinel);
  }

  // ---------- 播放 ----------
  function stop() {
    generation++;
    clearTimeout(startTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  function play(ch, autoplay) {
    current = ch;
    lineIdx = 0;
    pushRecent(ch);
    grid.querySelectorAll('.tv-ch').forEach(function (b) { b.classList.toggle('is-playing', b.dataset.id === ch.id); });
    renderNow();
    try { history.replaceState(null, '', '#' + ch.c + '/' + encodeURIComponent(ch.id)); } catch (e) {}
    playLine(autoplay);
    var rect = video.getBoundingClientRect();
    if (autoplay && (rect.top < 0 || rect.bottom > window.innerHeight)) video.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderNow() {
    var ch = current;
    now.hidden = false;
    empty.hidden = true;
    now.querySelector('.tv-now-logo').replaceChildren(logo(ch, 'tv-logo tv-logo-lg'));
    now.querySelector('.tv-now-name').textContent = ch.n;
    now.querySelector('.tv-now-meta').textContent = [regionLabel(countryOf(ch.c))]
      .concat((ch.cat || []).map(function (k) { return CAT[k] || k; })).join(' · ');
    syncFav();
    lines.replaceChildren();
    if (ch.s.length < 2) return;
    ch.s.forEach(function (s, i) {
      var b = el('button', 'tv-line', '线路 ' + (i + 1) + (s.q ? ' · ' + s.q : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i === lineIdx));
      b.addEventListener('click', function () { lineIdx = i; playLine(true); });
      lines.appendChild(b);
    });
  }
  function syncLines() {
    lines.querySelectorAll('.tv-line').forEach(function (b, i) {
      b.setAttribute('aria-pressed', String(i === lineIdx));
      b.classList.toggle('is-failed', current && current.s[i] && current.s[i].failed);
    });
  }
  function syncFav() {
    var on = current && isFav(current);
    favBtn.setAttribute('aria-pressed', String(!!on));
    favBtn.querySelector('span').textContent = on ? '已收藏' : '收藏';
  }
  favBtn.addEventListener('click', function () {
    if (!current) return;
    toggleFav(current);
    syncFav();
    renderCountries();
    countriesBox.querySelectorAll('.tv-country').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.code === country)); });
    if (country === 'fav') setList(favs());
  });

  function playLine(autoplay) {
    stop();
    var gen = generation;
    var ch = current;
    var s = ch.s[lineIdx];
    syncLines();
    status('正在连接' + (ch.s.length > 1 ? '线路 ' + (lineIdx + 1) : '') + '…');
    function fail() {
      if (gen !== generation) return;
      s.failed = true;
      if (lineIdx + 1 < ch.s.length) {
        lineIdx++;
        status('这条线路播不了，换线路 ' + (lineIdx + 1) + ' 试试…');
        playLine(autoplay);
      } else {
        stop();
        status('这个频道现在播不了（可能有地区限制、不是 24 小时播出，或者源站失效），换个频道试试。');
        syncLines();
      }
    }
    function start() {
      if (gen !== generation) return;
      if (!autoplay) { status('点播放开始看。'); return; }
      video.play().catch(function (e) {
        if (gen !== generation) return;
        if (e.name === 'NotAllowedError') status('点播放开始看。');
      });
    }
    if (autoplay) startTimer = setTimeout(function () { if (video.paused || video.readyState < 3) fail(); }, START_TIMEOUT);
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true });
      hls.on(Hls.Events.MANIFEST_PARSED, start);
      hls.on(Hls.Events.ERROR, function (_, data) { if (data.fatal) fail(); });
      hls.loadSource(s.u);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = s.u;
      video.onerror = fail;
      start();
    } else {
      status('当前浏览器不支持直播播放，请换用 Chrome、Edge 或 Safari。');
    }
  }
  video.addEventListener('playing', function () {
    clearTimeout(startTimer);
    status('');
  });

  // ---------- 启动 ----------
  function ago(iso) {
    var h = (Date.now() - new Date(iso).getTime()) / 3600e3;
    return h < 1 ? Math.max(1, Math.round(h * 60)) + ' 分钟前' : h < 48 ? Math.round(h) + ' 小时前' : Math.round(h / 24) + ' 天前';
  }
  fetch(DATA + 'index.json').then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.message || '频道数据暂时不可用，请稍后刷新。');
      return data;
    });
  }).then(function (data) {
    index = data;
    meta.textContent = data.stats.web + ' 个频道可在网页直接看 · 共 ' + data.countries.length + ' 个地区 · ' + ago(data.updatedAt) + '检测';
    // 地址带 #地区/频道ID 时直接打开；否则用上次的地区，第一次来默认中国
    var hash = decodeURIComponent(location.hash.slice(1)).split('/');
    var codes = data.countries.map(function (c) { return c.code; });
    var saved = '';
    try { saved = localStorage.getItem(COUNTRY_KEY) || ''; } catch (e) {}
    var first = codes.indexOf(hash[0]) >= 0 ? hash[0] : codes.indexOf(saved) >= 0 ? saved : codes.indexOf('CN') >= 0 ? 'CN' : codes[0];
    country = first;
    renderCountries();
    selectCountry(first, function () {
      var id = hash[1];
      var ch = id && list.filter(function (x) { return x.id === id; })[0];
      if (ch) play(ch, false);
    });
  }).catch(function (e) {
    meta.textContent = e.message || '频道数据暂时不可用，请稍后刷新。';
    grid.replaceChildren();
  });

  window.addEventListener('pagehide', stop);
})();
