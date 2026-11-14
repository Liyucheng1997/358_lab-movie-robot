(function () {
  // ---------- 线路检测：在浏览器里实际请求播放列表和第一个视频分片 ----------
  // 在用户自己的网络和浏览器里检测，跨域、防盗链、地区屏蔽等情况和真正播放时一致
  var PROBE_TIMEOUT = 10000;
  var PROBE_CONCURRENCY = 6;
  var SLOW_MS = 2500;
  var SEEK_STEP = 30; // 方向键快进快退的秒数

  function firstUri(text) {
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line && line.charAt(0) !== '#') return line;
    }
    return '';
  }

  function probe(url, signal) {
    var start = performance.now();
    var ctrl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, PROBE_TIMEOUT);
    function stop() { ctrl.abort(); }
    signal.addEventListener('abort', stop);
    var height = 0;
    function get(u) { return fetch(u, { signal: ctrl.signal, credentials: 'omit' }); }
    function playlist(u, depth) {
      return get(u).then(function (r) {
        if (!r.ok) throw new Error('地址返回 ' + r.status);
        return r.text();
      }).then(function (text) {
        if (text.indexOf('#EXTM3U') < 0) throw new Error('不是有效的播放列表');
        var uri = firstUri(text);
        if (!uri) throw new Error('播放列表为空');
        var next = new URL(uri, u).href;
        if (text.indexOf('#EXT-X-STREAM-INF') < 0) return next;
        var res = text.match(/RESOLUTION=\d+x(\d+)/);
        if (res) height = Number(res[1]);
        if (depth > 1) throw new Error('播放列表嵌套过深');
        return playlist(next, depth + 1);
      });
    }
    return playlist(url, 0).then(function (segment) {
      return get(segment).then(function (r) {
        if (!r.ok) throw new Error('视频分片返回 ' + r.status);
        var ms = Math.round(performance.now() - start);
        // 只确认分片能开始下载，不把整段视频下完，避免浪费流量
        if (r.body) r.body.cancel().catch(function () {});
        return { ok: true, ms: ms, height: height };
      });
    }).catch(function (e) {
      if (signal.aborted) return null;
      return { ok: false, reason: timedOut ? '连接超时' : e instanceof TypeError ? '无法连接或不允许跨域' : e.message };
    }).finally(function () {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    });
  }

  function seconds(ms) { return (Math.max(ms, 100) / 1000).toFixed(1); }

  function speedText(result) {
    if (!result) return '检测中';
    if (!result.ok) return '失效';
    var quality = result.height >= 1080 ? '1080P · ' : result.height >= 720 ? '720P · ' : '';
    return quality + seconds(result.ms) + 's';
  }

  window.initSources = function (record) {
    var video = document.getElementById('player');
    var status = document.getElementById('player-status');
    var sourceStatus = document.getElementById('source-status');
    var box = document.getElementById('source-lines');
    var retry = document.getElementById('retry-sources');
    var hls = null;
    var selected = false;
    var generation = 0;
    var selectedType = '';
    var probeAbort = null;
    var autoPanel = null; // 自动选中的线路；用户手动选择后为 null
    // 播放历史：上次的线路、选集和进度；打开页面时自动选回去，点播放从上次的位置继续
    var watchHist = window.WatchHistory || null;
    var resume = watchHist && watchHist.get(record.id);
    if (!resume || resume.index == null) resume = null;
    var resumeBar = document.getElementById('resume-bar');
    var playing = null; // 正在播放的选集 { panel, index, epTitle }
    var pendingSeek = 0; // 加载完成后跳到的位置（秒）
    var started = false; // 本次打开页面后是否真正开始播放过
    var lastSave = 0;

    // 弹幕按「第几集」对应到各平台：优先用选集标题里的集数，标题没有集数时按顺序
    function episodeNumber(panel, button) {
      var index = panel.buttons.indexOf(button);
      var title = String((panel.line.episodes[index] || {}).title || '');
      var m = title.match(/第\s*0*(\d+)\s*[集话期回]/) || title.match(/^\s*0*(\d+)\s*$/);
      return m ? Number(m[1]) : index + 1;
    }

    // seek：指定起播位置；不传时，换线路看同一集会接着当前进度播放
    function select(button, url, type, poster, autoplay, panel, seek) {
      selected = true;
      var index = panel ? panel.buttons.indexOf(button) : -1;
      var epTitle = panel ? String((panel.line.episodes[index] || {}).title || '') : '';
      var carry = panel && playing && playing.epTitle === epTitle && video.currentTime > 5 ? video.currentTime : 0;
      pendingSeek = seek != null ? seek : carry;
      if (playing && (!panel || playing.epTitle !== epTitle)) hideResume();
      playing = panel ? { panel: panel, index: index, epTitle: epTitle } : null;
      var detail = panel ? {
        kind: 'episode', ep: episodeNumber(panel, button), label: panel.line.name + ' · ' + button.textContent,
        line: panel.line.name, index: index, epTitle: epTitle, epCount: panel.line.episodes.length,
      } : { kind: 'trailer' };
      window.lastPlayerSelect = detail;
      document.dispatchEvent(new CustomEvent('player:select', { detail: detail }));
      // 用户手动点选时立刻记下线路和选集；自动预选不写，避免覆盖上次记录
      if (panel && autoplay && watchHist) {
        watchHist.update(record.id, { line: panel.line.name, flag: panel.line.flag, index: index, epTitle: epTitle,
          epCount: panel.line.episodes.length, pos: Math.round(pendingSeek), dur: 0 });
      }
      selectedType = type;
      autoPanel = autoplay ? null : panel;
      generation++;
      var current = generation;
      if (hls) { hls.destroy(); hls = null; }
      video.pause();
      video.removeAttribute('src');
      video.load();
      document.querySelectorAll('.line-res .active').forEach(function (b) {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      if (poster) video.poster = poster;
      status.textContent = '正在加载：' + (panel ? panel.line.name + ' · ' : '') + button.textContent;
      function play() {
        if (current !== generation) return;
        if (autoplay) video.play().catch(function (error) {
          if (current === generation) status.textContent = error.name === 'NotAllowedError'
            ? '请点击播放器中的播放按钮。' : '此线路无法播放，请切换其他线路。';
        });
        else if (!resumeBar || resumeBar.hidden) status.textContent = '已为你选好可用线路「' + (panel ? panel.line.name : button.textContent) + '」，点击播放即可观看。';
        else status.textContent = '';
      }
      if (type === 'hls' && window.Hls && Hls.isSupported()) {
        // hls.js 直接从续播位置开始加载分片，不用先加载开头再跳
        hls = new Hls(pendingSeek > 0 ? { startPosition: pendingSeek } : undefined);
        pendingSeek = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, function (_, data) {
          if (data.fatal && current === generation) {
            status.textContent = '此线路加载失败，请切换其他线路。';
            if (panel) panel.fail('播放时加载失败');
            hls.destroy();
            hls = null;
          }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        if (type === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
          status.textContent = '当前浏览器不支持此线路，请使用其他浏览器或选择预告片。';
          return;
        }
        video.src = url;
        play();
      }
    }

    // 手机上选集列表在播放器下方较远处，点选后把播放器滚回视野
    function revealPlayer() {
      var rect = video.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        video.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    video.addEventListener('error', function () {
      if (video.getAttribute('src')) status.textContent = '播放失败，请切换其他线路。';
    });
    video.addEventListener('playing', function () {
      status.textContent = '';
      started = true;
      if (resumeBar && !resumeBar.hidden) setTimeout(hideResume, 6000);
    });

    // ---------- 播放进度 ----------
    video.addEventListener('loadedmetadata', function () {
      if (pendingSeek > 0 && (!video.duration || pendingSeek < video.duration - 5)) video.currentTime = pendingSeek;
      pendingSeek = 0;
    });
    function saveProgress(force) {
      if (!playing || !watchHist || video.currentTime < 3) return;
      var now = Date.now();
      if (!force && now - lastSave < 5000) return;
      lastSave = now;
      var line = playing.panel.line;
      watchHist.update(record.id, {
        line: line.name, flag: line.flag, index: playing.index, epTitle: playing.epTitle, epCount: line.episodes.length,
        pos: Math.round(video.currentTime), dur: isFinite(video.duration) ? Math.round(video.duration) : 0,
      });
    }
    video.addEventListener('timeupdate', function () { saveProgress(false); });
    video.addEventListener('pause', function () { saveProgress(true); });
    video.addEventListener('ended', function () { saveProgress(true); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) saveProgress(true); });

    // ---------- 快进快退 ----------
    // 原生控件按方向键一次跳的幅度由浏览器决定（长片会跳一分多钟），统一改成每次 30 秒
    function seekBy(delta) {
      if (video.readyState < 1) return;
      var end = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.max(0, Math.min(end - 0.5, video.currentTime + delta));
    }
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      // 焦点在播放器上、页面空白处，或者播放器所在区域全屏时才接管方向键
      var full = document.fullscreenElement;
      if (t !== video && t !== document.body && t !== document.documentElement && !(full && full.contains(video))) return;
      if (video.readyState < 1) return;
      e.preventDefault();
      e.stopPropagation();
      seekBy(e.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP);
    }, true);
    // 耳机、锁屏、系统媒体控件上的快进快退
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('seekbackward', function (d) { seekBy(-(d && d.seekOffset || SEEK_STEP)); });
        navigator.mediaSession.setActionHandler('seekforward', function (d) { seekBy(d && d.seekOffset || SEEK_STEP); });
      } catch (e) {}
    }

    // ---------- 续播 ----------
    function hideResume() { if (resumeBar) resumeBar.hidden = true; }
    // 在某条线路里找上次那一集：先按选集标题，再按序号；上次已看完就接下一集
    function resumeTarget(p) {
      if (!resume) return { i: 0, seek: 0 };
      var eps = p.line.episodes;
      var i = -1;
      for (var k = 0; k < eps.length && resume.epTitle; k++) if (eps[k].title === resume.epTitle) { i = k; break; }
      if (i < 0) i = Math.min(resume.index || 0, eps.length - 1);
      if (watchHist.finished(resume)) return i + 1 < eps.length ? { i: i + 1, seek: 0, next: true } : { i: i, seek: 0 };
      return { i: i, seek: resume.pos || 0 };
    }
    function resumeLine(panels) {
      if (!resume) return null;
      return panels.filter(function (p) { return p.line.name === resume.line && p.line.flag === resume.flag; })[0]
        || panels.filter(function (p) { return p.line.name === resume.line; })[0]
        || panels.filter(function (p) { return resume.flag && p.line.flag === resume.flag; })[0] || null;
    }
    // 自动选中某条线路时同样落到上次那一集
    function autoSelect(p) {
      var target = resumeTarget(p);
      var ep = p.line.episodes[target.i];
      if (resume && playing && playing.epTitle !== ep.title) hideResume();
      playing = playing && playing.epTitle === ep.title ? playing : null;
      if (resume) showResume(p, target);
      select(p.buttons[target.i], ep.url, ep.type, '', false, p, target.seek);
    }
    function showResume(p, target) {
      if (!resumeBar || started) return;
      var ep = p.line.episodes.length > 1 ? (p.line.episodes[target.i].title || '第 ' + (target.i + 1) + ' 集') : '';
      var where = target.next ? '上次看完了' + (resume.epTitle || '') + '，接着看「' + ep + '」'
        : '上次看到' + (ep ? '「' + ep + '」' : '') + ' ' + formatClock(target.seek);
      var line = p.line.name === resume.line ? '线路「' + p.line.name + '」' : '上次的线路「' + resume.line + '」不可用，已换到「' + p.line.name + '」';
      resumeBar.querySelector('.resume-text').textContent = where + ' · ' + line + '，点播放继续';
      resumeBar.querySelector('.resume-restart').hidden = !target.seek;
      resumeBar.hidden = false;
    }
    if (resumeBar) {
      resumeBar.querySelector('.resume-restart').addEventListener('click', function () {
        pendingSeek = 0;
        video.currentTime = 0;
        hideResume();
        if (video.paused) video.play().catch(function () {});
      });
      resumeBar.querySelector('.resume-close').addEventListener('click', hideResume);
    }
    document.querySelectorAll('.line-res div[data-src]').forEach(function (button) {
      button.setAttribute('role', 'button');
      button.setAttribute('tabindex', '0');
      button.addEventListener('click', function () {
        select(button, button.dataset.src, 'mp4', button.dataset.poster, true);
        revealPlayer();
      });
      button.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); button.click(); }
      });
    });

    function createPanel(line) {
      var p = { line: line, result: null };
      p.tab = document.createElement('button');
      p.tab.type = 'button';
      p.tab.className = 'line-tab';
      p.tab.setAttribute('role', 'tab');
      p.tab.title = line.name + ' · 共 ' + line.episodes.length + ' 集';
      var dot = document.createElement('span');
      dot.className = 'line-dot';
      var label = document.createElement('span');
      label.textContent = line.name;
      p.speed = document.createElement('small');
      p.speed.className = 'line-speed';
      p.tab.append(dot, label, p.speed);

      p.group = document.createElement('div');
      p.group.className = 'line-box';
      p.group.setAttribute('role', 'tabpanel');
      p.info = document.createElement('p');
      p.info.className = 'line-info';
      var episodes = document.createElement('div');
      episodes.className = 'line-res episode-grid';
      p.buttons = line.episodes.map(function (episode) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'episode-button';
        button.textContent = episode.title;
        button.title = episode.title;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', function () {
          select(button, episode.url, episode.type, '', true, p);
          revealPlayer();
        });
        episodes.appendChild(button);
        return button;
      });
      p.group.append(p.info, episodes);

      p.set = function (result) {
        p.result = result;
        p.tab.classList.remove('is-checking', 'is-ok', 'is-slow', 'is-fail');
        p.tab.classList.add(!result ? 'is-checking' : !result.ok ? 'is-fail' : result.ms < SLOW_MS ? 'is-ok' : 'is-slow');
        p.speed.textContent = speedText(result);
        var state = !result ? '正在检测能否播放…'
          : result.ok ? '检测可以播放，响应 ' + seconds(result.ms) + ' 秒' + (result.ms < SLOW_MS ? '' : '（较慢）')
            : '检测无法播放（' + result.reason + '），也可以手动试试';
        p.info.textContent = line.name + ' · 共 ' + line.episodes.length + ' 集 · ' + state;
      };
      p.fail = function (reason) { p.set({ ok: false, reason: reason }); };
      p.set(null);
      return p;
    }

    function renderLines(lines) {
      // 线路做成横向标签，一次只展开一条线路的选集，避免几十个滚动框叠在一起
      var tabs = document.createElement('div');
      tabs.className = 'line-tabs';
      tabs.setAttribute('role', 'tablist');
      var panels = lines.map(createPanel);
      var userPickedTab = false;

      function showLine(p) {
        panels.forEach(function (other) {
          other.tab.classList.toggle('active', other === p);
          other.tab.setAttribute('aria-selected', String(other === p));
          other.group.hidden = other !== p;
        });
        tabs.scrollLeft = p.tab.offsetLeft - (tabs.clientWidth - p.tab.offsetWidth) / 2;
      }

      panels.forEach(function (p) {
        tabs.appendChild(p.tab);
        box.appendChild(p.group);
        p.tab.addEventListener('click', function () { userPickedTab = true; showLine(p); });
      });
      box.insertBefore(tabs, box.firstChild);
      showLine(panels[0]);

      // 并发检测每条线路的第一集；最先检测通过的线路自动选中（不自动播放）
      var signal = probeAbort.signal;
      var done = 0, okCount = 0, next = 0;
      // 有上次的记录时，不等检测，先直接选回上次的线路和选集
      var resumePanel = selected ? null : resumeLine(panels);
      if (resumePanel) {
        autoSelect(resumePanel);
        autoPanel = null;
        showLine(resumePanel);
      }
      function report() {
        if (done < panels.length) {
          sourceStatus.textContent = '共 ' + panels.length + ' 条线路，正在检测能否播放（' + done + '/' + panels.length + '），已找到 ' + okCount + ' 条可用…';
        } else if (okCount) {
          sourceStatus.textContent = '检测完成：' + panels.length + ' 条线路中 ' + okCount + ' 条可以播放，已按响应速度排在前面。';
        } else {
          sourceStatus.textContent = panels.length + ' 条线路在当前网络下都无法播放，可稍后点「重新检测」再试，或观看下方的豆瓣预告。';
        }
      }
      function finish() {
        // 可播放的按速度排前面，失效的放最后
        var rank = function (p) { return p.result && p.result.ok ? p.result.ms : Infinity; };
        panels.slice().sort(function (a, b) { return rank(a) - rank(b); })
          .forEach(function (p) { tabs.appendChild(p.tab); });
        var active = panels.filter(function (p) { return !p.group.hidden; })[0];
        // 用户还没开始看时，把自动选中的线路换成响应最快的那条
        var fastest = panels.filter(function (p) { return p.result && p.result.ok; })
          .sort(function (a, b) { return a.result.ms - b.result.ms; })[0];
        if (fastest && autoPanel && autoPanel !== fastest && video.paused && !started) {
          autoSelect(fastest);
          if (!userPickedTab) active = fastest;
        }
        if (active) showLine(active);
      }
      function worker() {
        if (signal.aborted || next >= panels.length) return Promise.resolve();
        var p = panels[next++];
        return probe(p.line.episodes[0].url, signal).then(function (result) {
          if (signal.aborted || !result) return;
          // 检测期间如果真实播放已经失败，以播放结果为准
          if (!(p.result && !p.result.ok)) p.set(result);
          done++;
          if (p.result.ok) {
            okCount++;
            if (!selected) {
              autoSelect(p);
              if (!userPickedTab) showLine(p);
            }
          } else if (p === resumePanel && playing && playing.panel === p && !started) {
            // 上次的线路检测失效：换到目前最快的可用线路，仍然接着上次那一集
            var ok = panels.filter(function (o) { return o.result && o.result.ok; })
              .sort(function (a, b) { return a.result.ms - b.result.ms; })[0];
            if (ok) { autoSelect(ok); if (!userPickedTab) showLine(ok); } else selected = false;
          }
          report();
          if (done === panels.length) finish();
        }).then(worker);
      }
      report();
      for (var w = 0; w < Math.min(PROBE_CONCURRENCY, panels.length); w++) worker();
    }

    async function load() {
      retry.disabled = true;
      sourceStatus.textContent = '正在匹配影片并加载线路…';
      try {
        var staticBase = document.body.dataset.staticBase;
        var endpoint = staticBase ? staticBase + 'api/sources/' + encodeURIComponent(record.id) + '.json'
          : '/api/sources/' + encodeURIComponent(record.id);
        var response = await fetch(endpoint);
        var data = await response.json();
        if (!response.ok) throw new Error(data.message || '线路加载失败');
        // 重新加载时停止正在播放的第三方线路，避免选中状态与播放内容不一致。
        if (selectedType === 'hls') {
          generation++;
          if (hls) { hls.destroy(); hls = null; }
          video.pause(); video.removeAttribute('src'); video.load();
          status.textContent = '';
          selected = false;
          started = false;
        }
        if (watchHist) {
          resume = watchHist.get(record.id);
          if (!resume || resume.index == null) resume = null;
        }
        if (probeAbort) probeAbort.abort();
        probeAbort = new AbortController();
        box.replaceChildren();
        if (data.lines && data.lines.length) renderLines(data.lines);
        else sourceStatus.textContent = data.message;
      } catch (e) {
        sourceStatus.textContent = e.message || '线路加载失败，请重新加载。';
      } finally { retry.disabled = false; }
    }
    retry.addEventListener('click', load);
    window.addEventListener('pagehide', function () {
      saveProgress(true);
      if (hls) hls.destroy();
      if (probeAbort) probeAbort.abort();
    });
    load();
  };
})();
