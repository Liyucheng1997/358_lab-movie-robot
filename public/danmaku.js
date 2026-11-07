(function () {
  // 弹幕：按 5 分钟分段向服务端取「外部平台 + 本站」弹幕，跟随视频时间显示在播放器上方。
  // 静态版没有服务端，只显示和保存本机发送的弹幕。
  var SEG = 300;
  var SETTINGS_KEY = 'danmaku_settings_v1';
  var LOCAL_KEY = 'danmaku_local_v1';
  var NAMES = { bili: '哔哩哔哩', iqiyi: '爱奇艺', qq: '腾讯视频', site: '本站' };
  var COLORS = ['ffffff', 'fe0302', 'ff7204', 'ffd302', '00cd00', '00a2ff', 'cc0273'];
  var SIZES = { s: 0.8, m: 1, l: 1.25 };
  var SPEEDS = { slow: 11, normal: 8, fast: 5.5 }; // 滚动弹幕穿过一屏的秒数
  // 选项用数组保证顺序（对象里像数字的键会被排到前面）
  var AREAS = [['0.25', '1/4'], ['0.5', '半屏'], ['0.75', '3/4'], ['1', '满屏']];
  var DEFAULTS = { on: true, opacity: 0.9, size: 'm', speed: 'normal', area: '0.75', offset: 0, off: {}, color: 'ffffff', mode: 0 };

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式等情况下不保存 */ }
  }

  window.initDanmaku = function (record) {
    var video = document.getElementById('player');
    var wrap = video && video.parentElement;
    var bar = document.getElementById('dm-bar');
    if (!video || !bar) return;
    var staticMode = !!document.body.dataset.staticBase;
    var settings = Object.assign({}, DEFAULTS, readJSON(SETTINGS_KEY, {}));
    var toggle = document.getElementById('dm-toggle');
    var form = document.getElementById('dm-form');
    var input = document.getElementById('dm-input');
    var gear = document.getElementById('dm-gear');
    var panel = document.getElementById('dm-panel');
    var statusEl = document.getElementById('dm-status');

    var stage = document.createElement('div');
    stage.className = 'dm-stage';
    stage.setAttribute('aria-hidden', 'true');
    wrap.appendChild(stage);

    // ---------- 状态 ----------
    var ctx = null; // { ep, label }，没选线路或在看预告片时为 null
    var items = []; // 已加载的弹幕，按显示时间排序
    var segments = {}; // 分段号 → 'loading' | 'done' | 'error'
    var sources = {}; // 来源 → 条数
    var ptr = 0; // 下一条待显示的位置
    var lastT = 0;
    var live = new Set(); // 屏幕上的滚动动画
    var tracks = { scroll: [], top: [], bottom: [] };
    var generation = 0;
    var raf = 0;

    function save() { writeJSON(SETTINGS_KEY, settings); }
    function status(text) { statusEl.textContent = text; }

    function shownTime(d) { return d.src === 'site' ? d.t : d.t + settings.offset; }
    function lowerBound(t) {
      var lo = 0, hi = items.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (items[mid].at < t) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function resort() {
      items.forEach(function (d) { d.at = shownTime(d); });
      items.sort(function (a, b) { return a.at - b.at; });
      ptr = lowerBound(lastT);
    }

    // AI 陪看用：取某个时间点前后已加载的弹幕文字（去重，按时间先后）
    window.danmakuNear = function (t, before, after) {
      if (!ctx) return [];
      var out = [], seen = {};
      for (var i = lowerBound(t - before); i < items.length && items[i].at <= t + after; i++) {
        var text = String(items[i].text || '').trim();
        if (text && !seen[text]) { seen[text] = 1; out.push(text); }
      }
      return out;
    };

    function summary() {
      if (!ctx) return;
      var names = Object.keys(sources).filter(function (k) { return sources[k]; });
      var total = names.reduce(function (n, k) { return n + sources[k]; }, 0);
      if (staticMode) {
        status(total ? '静态版只显示你在本机发送的弹幕（' + total + ' 条）。' : '静态版只保存你在本机发送的弹幕，实时版可看各平台弹幕。');
      } else if (!total) {
        status('这一段还没有弹幕，来发第一条吧。');
      } else {
        status('已加载 ' + total + ' 条弹幕 · ' + names.map(function (k) { return NAMES[k] + ' ' + sources[k]; }).join(' · '));
      }
      renderSources();
    }

    // ---------- 加载 ----------
    function add(list) {
      list.forEach(function (row) {
        var d = { t: row[0], mode: row[1], color: row[2], text: row[3], src: row[4] };
        d.at = shownTime(d);
        items.push(d);
        sources[d.src] = (sources[d.src] || 0) + 1;
      });
      items.sort(function (a, b) { return a.at - b.at; });
      ptr = lowerBound(lastT);
    }

    function localList(ep) {
      return readJSON(LOCAL_KEY, {})[record.id + ':' + ep] || [];
    }

    function load(seg) {
      if (!ctx || seg < 0 || segments[seg]) return;
      segments[seg] = 'loading';
      var current = generation;
      var ep = ctx.ep;
      var request = staticMode
        ? Promise.resolve({ items: localList(ep).filter(function (r) { return r[0] >= seg * SEG && r[0] < (seg + 1) * SEG; }) })
        : fetch('/api/danmaku/' + encodeURIComponent(record.id) + '?ep=' + ep + '&seg=' + seg).then(function (r) {
          return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || '弹幕加载失败'); return data; });
        });
      request.then(function (data) {
        if (current !== generation) return;
        segments[seg] = 'done';
        (data.sources || []).forEach(function (s) { if (!(s.id in sources)) sources[s.id] = 0; });
        add(data.items || []);
        summary();
      }).catch(function (e) {
        if (current !== generation) return;
        segments[seg] = 'error';
        status(e.message || '弹幕加载失败');
        // 30 秒后允许重试
        setTimeout(function () { if (current === generation && segments[seg] === 'error') delete segments[seg]; }, 30000);
      });
    }

    function prefetch(t) {
      // 外部弹幕有时间偏移，按偏移前后的时间都加载，并提前 30 秒加载下一段
      [t, t + 30, t - settings.offset, t - settings.offset + 30].forEach(function (x) { load(Math.floor(x / SEG)); });
    }

    // ---------- 显示 ----------
    function clearScreen() {
      live.forEach(function (a) { a.cancel(); });
      live.clear();
      stage.replaceChildren();
      tracks = { scroll: [], top: [], bottom: [] };
    }

    function reset(t) {
      clearScreen();
      lastT = t;
      ptr = lowerBound(t);
    }

    function lineHeight() { return Math.round(Math.max(16, Math.min(30, stage.clientWidth / 30)) * SIZES[settings.size] * 1.35); }

    // 找一条空闲轨道；都占满时丢掉这条，避免弹幕叠在一起
    function freeTrack(list, count, t) {
      for (var i = 0; i < count; i++) if (!(list[i] > t)) return i;
      return -1;
    }

    function show(d, t, own) {
      if (!settings.on || settings.off[d.src]) return;
      var width = stage.clientWidth, height = stage.clientHeight;
      if (!width || !height) return;
      var lh = lineHeight();
      var rows = Math.max(1, Math.floor(height * Number(settings.area) / lh));
      var el = document.createElement('span');
      el.className = 'dm-item' + (own ? ' dm-own' : '');
      el.textContent = d.text;
      el.style.color = '#' + d.color;
      el.style.fontSize = Math.round(lh / 1.35) + 'px';
      if (d.color === '000000') el.classList.add('dm-dark');

      if (d.mode === 0) {
        var row = freeTrack(tracks.scroll, rows, t);
        if (row < 0 && !own) return;
        if (row < 0) row = 0;
        el.style.top = row * lh + 'px';
        stage.appendChild(el);
        var w = el.offsetWidth;
        var speed = width / SPEEDS[settings.speed]; // 所有滚动弹幕同速，不会互相追尾
        tracks.scroll[row] = t + (w + 24) / speed;
        var anim = el.animate(
          [{ transform: 'translateX(' + width + 'px)' }, { transform: 'translateX(' + -w + 'px)' }],
          { duration: (width + w) / speed * 1000, easing: 'linear' }
        );
        anim.playbackRate = video.playbackRate;
        if (video.paused) anim.pause();
        live.add(anim);
        anim.onfinish = function () { live.delete(anim); el.remove(); };
      } else {
        var list = d.mode === 1 ? tracks.top : tracks.bottom;
        var slot = freeTrack(list, Math.max(1, Math.floor(rows / 2)), t);
        if (slot < 0 && !own) return;
        if (slot < 0) slot = 0;
        list[slot] = t + 4;
        el.classList.add('dm-fixed');
        el.style[d.mode === 1 ? 'top' : 'bottom'] = slot * lh + 'px';
        stage.appendChild(el);
        var fixed = el.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 4000 });
        fixed.playbackRate = video.playbackRate;
        if (video.paused) fixed.pause();
        live.add(fixed);
        fixed.onfinish = function () { live.delete(fixed); el.remove(); };
      }
    }

    function tick() {
      raf = 0;
      var t = video.currentTime;
      if (t < lastT - 0.5 || t > lastT + 3) reset(t); // 拖动进度或卡顿后跳到新位置
      var shown = 0;
      while (ptr < items.length && items[ptr].at <= t) {
        // 同一帧最多出 6 条，进度跳跃时不会一下子涌出很多
        if (items[ptr].at > lastT - 0.5 && shown < 6) { show(items[ptr], t); shown++; }
        ptr++;
      }
      lastT = t;
      prefetch(t);
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    }
    function start() { if (!raf && ctx) raf = requestAnimationFrame(tick); }

    video.addEventListener('play', function () { live.forEach(function (a) { a.play(); }); start(); });
    video.addEventListener('playing', function () { live.forEach(function (a) { a.play(); }); start(); });
    // 暂停和缓冲卡顿时弹幕一起停住，保持和画面同步
    video.addEventListener('pause', function () { live.forEach(function (a) { a.pause(); }); });
    video.addEventListener('waiting', function () { live.forEach(function (a) { a.pause(); }); });
    video.addEventListener('seeking', function () { reset(video.currentTime); prefetch(video.currentTime); });
    video.addEventListener('ratechange', function () { live.forEach(function (a) { a.playbackRate = video.playbackRate; }); });
    video.addEventListener('emptied', function () { clearScreen(); });

    // 原生控件的全屏只放大 <video>，弹幕层会被挡住；支持元素全屏的浏览器改为让外层容器全屏。
    // 全屏的是「播放器 + AI 陪看」整行，全屏时也能打开 AI 陪看。
    // iPhone 不支持元素全屏，保留系统全屏（不显示弹幕）。
    var fsTarget = document.getElementById('watch-row') || wrap;
    if (fsTarget.requestFullscreen) {
      video.setAttribute('controlslist', 'nofullscreen');
      var fsButton = document.createElement('button');
      fsButton.type = 'button';
      fsButton.className = 'dm-fullscreen';
      fsButton.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
      var toggleFull = function () {
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
        else fsTarget.requestFullscreen().catch(function () {});
      };
      var syncFull = function () {
        var full = document.fullscreenElement === fsTarget;
        fsButton.title = full ? '退出全屏' : '全屏（带弹幕）';
        fsButton.setAttribute('aria-label', fsButton.title);
        // 尺寸变了，屏幕上的弹幕位置不再准确
        clearScreen();
      };
      fsButton.addEventListener('click', toggleFull);
      video.addEventListener('dblclick', toggleFull);
      document.addEventListener('fullscreenchange', syncFull);
      wrap.appendChild(fsButton);
      syncFull();
    }

    // ---------- 切换影片集数 ----------
    document.addEventListener('player:select', function (e) {
      generation++;
      items = []; segments = {}; sources = {};
      reset(0);
      if (e.detail.kind !== 'episode') {
        ctx = null;
        status('预告片不显示弹幕，选择播放线路后可以看弹幕、发弹幕。');
        renderSources();
        return;
      }
      ctx = { ep: e.detail.ep, label: e.detail.label };
      status('正在加载弹幕…');
      prefetch(0);
    });

    // ---------- 发送 ----------
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (!ctx) { status('先选择一条播放线路再发弹幕。'); return; }
      var t = Math.round(video.currentTime * 10) / 10;
      var row = [t, Number(settings.mode), settings.color, text, 'site'];
      var d = { t: t, mode: row[1], color: row[2], text: text, src: 'site', at: t };
      var ep = ctx.ep;
      function accept() {
        input.value = '';
        // 放进列表供回看，并立刻在屏幕上显示（带边框标记是自己发的）
        items.splice(lowerBound(t), 0, d);
        ptr = lowerBound(lastT + 0.001);
        sources.site = (sources.site || 0) + 1;
        if (!settings.on) { settings.on = true; save(); syncToggle(); }
        show(d, video.currentTime, true);
        summary();
      }
      if (staticMode) {
        var all = readJSON(LOCAL_KEY, {});
        var key = record.id + ':' + ep;
        all[key] = (all[key] || []).concat([row]).slice(-500);
        writeJSON(LOCAL_KEY, all);
        accept();
        return;
      }
      var button = form.querySelector('button');
      button.disabled = true;
      fetch('/api/danmaku/' + encodeURIComponent(record.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ep: ep, t: t, text: text, color: settings.color, mode: Number(settings.mode) }),
      }).then(function (r) {
        return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || '发送失败'); });
      }).then(accept).catch(function (err) {
        status(err.message || '发送失败，请稍后再试');
      }).finally(function () { button.disabled = false; });
    });

    // ---------- 开关和设置面板 ----------
    function syncToggle() {
      toggle.setAttribute('aria-pressed', String(settings.on));
      toggle.classList.toggle('active', settings.on);
      stage.hidden = !settings.on;
      if (!settings.on) clearScreen();
    }
    toggle.addEventListener('click', function () {
      settings.on = !settings.on;
      save();
      syncToggle();
    });

    gear.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      gear.setAttribute('aria-expanded', String(!panel.hidden));
    });

    function el(tag, cls, text) {
      var node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }
    function row(label, control) {
      var r = el('div', 'dm-row');
      r.append(el('span', 'dm-label', label), control);
      return r;
    }
    // 分段控件：苹果式灰底分段按钮
    function segmented(options, value, onChange) {
      var box = el('div', 'dm-seg');
      options.forEach(function (option) {
        var key = option[0];
        var b = el('button', '', option[1]);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(String(value()) === key));
        b.addEventListener('click', function () {
          onChange(key);
          box.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        });
        box.appendChild(b);
      });
      return box;
    }

    var sourceBox = el('div', 'dm-sources');
    var offsetText = el('span', 'dm-offset tabular');
    function renderSources() {
      sourceBox.replaceChildren();
      var keys = Object.keys(sources);
      if (!keys.length) { sourceBox.append(el('span', 'text-muted', ctx ? '加载中…' : '选择播放线路后显示')); return; }
      keys.forEach(function (k) {
        var label = el('label', 'dm-check');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !settings.off[k];
        box.addEventListener('change', function () {
          if (box.checked) delete settings.off[k]; else settings.off[k] = true;
          save();
          clearScreen();
        });
        label.append(box, el('span', '', NAMES[k] || k), el('small', 'tabular', String(sources[k])));
        sourceBox.appendChild(label);
      });
    }
    function setOffset(value) {
      settings.offset = Math.max(-600, Math.min(600, value));
      offsetText.textContent = (settings.offset > 0 ? '+' : '') + settings.offset + ' 秒';
      save();
      resort();
      clearScreen();
      prefetch(video.currentTime);
    }

    function build() {
      var opacity = document.createElement('input');
      opacity.type = 'range';
      opacity.min = '0.2'; opacity.max = '1'; opacity.step = '0.05';
      opacity.value = settings.opacity;
      opacity.setAttribute('aria-label', '不透明度');
      opacity.addEventListener('input', function () {
        settings.opacity = Number(opacity.value);
        stage.style.opacity = settings.opacity;
        save();
      });

      var offset = el('div', 'dm-offset-box');
      [['−5', -5], ['−1', -1]].forEach(function (x) {
        var b = el('button', 'pill-btn pill-btn-sm', x[0]); b.type = 'button';
        b.addEventListener('click', function () { setOffset(settings.offset + x[1]); });
        offset.appendChild(b);
      });
      offset.appendChild(offsetText);
      [['+1', 1], ['+5', 5]].forEach(function (x) {
        var b = el('button', 'pill-btn pill-btn-sm', x[0]); b.type = 'button';
        b.addEventListener('click', function () { setOffset(settings.offset + x[1]); });
        offset.appendChild(b);
      });
      var zero = el('button', 'pill-btn pill-btn-sm', '归零'); zero.type = 'button';
      zero.addEventListener('click', function () { setOffset(0); });
      offset.appendChild(zero);

      var colors = el('div', 'dm-colors');
      COLORS.forEach(function (c) {
        var b = el('button', 'dm-color'); b.type = 'button';
        b.style.background = '#' + c;
        b.title = '#' + c;
        b.setAttribute('aria-label', '颜色 #' + c);
        b.setAttribute('aria-pressed', String(settings.color === c));
        b.addEventListener('click', function () {
          settings.color = c; save();
          colors.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        });
        colors.appendChild(b);
      });

      panel.replaceChildren(
        el('h3', 'dm-panel-title', '显示'),
        row('不透明度', opacity),
        row('字号', segmented([['s', '小'], ['m', '标准'], ['l', '大']], function () { return settings.size; }, function (v) { settings.size = v; save(); clearScreen(); })),
        row('速度', segmented([['slow', '慢'], ['normal', '标准'], ['fast', '快']], function () { return settings.speed; }, function (v) { settings.speed = v; save(); })),
        row('显示区域', segmented(AREAS, function () { return settings.area; }, function (v) { settings.area = v; save(); clearScreen(); })),
        row('来源', sourceBox),
        row('时间校准', offset),
        el('p', 'dm-hint', '外部弹幕来自正版平台，片源版本不同可能有几秒偏差，可在这里前后微调（只影响外部弹幕）。'),
        el('h3', 'dm-panel-title', '发送'),
        row('颜色', colors),
        row('位置', segmented([['0', '滚动'], ['1', '顶部'], ['2', '底部']], function () { return settings.mode; }, function (v) { settings.mode = Number(v); save(); }))
      );
      stage.style.opacity = settings.opacity;
      setOffset(settings.offset);
      renderSources();
    }

    build();
    syncToggle();
    status('选择播放线路后显示弹幕。');
  };
})();
