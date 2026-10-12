(function () {
  // ---------- 线路检测：在浏览器里实际请求播放列表和第一个视频分片 ----------
  // 在用户自己的网络和浏览器里检测，跨域、防盗链、地区屏蔽等情况和真正播放时一致
  var PROBE_TIMEOUT = 10000;
  var PROBE_CONCURRENCY = 6;
  var SLOW_MS = 2500;

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

    function select(button, url, type, poster, autoplay, panel) {
      selected = true;
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
        else status.textContent = '已为你选好可用线路「' + (panel ? panel.line.name : button.textContent) + '」，点击播放即可观看。';
      }
      if (type === 'hls' && window.Hls && Hls.isSupported()) {
        hls = new Hls();
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
    video.addEventListener('playing', function () { status.textContent = ''; });
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
        if (fastest && autoPanel && autoPanel !== fastest && video.paused && !video.currentTime) {
          select(fastest.buttons[0], fastest.line.episodes[0].url, fastest.line.episodes[0].type, '', false, fastest);
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
              select(p.buttons[0], p.line.episodes[0].url, p.line.episodes[0].type, '', false, p);
              if (!userPickedTab) showLine(p);
            }
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
      if (hls) hls.destroy();
      if (probeAbort) probeAbort.abort();
    });
    load();
  };
})();
