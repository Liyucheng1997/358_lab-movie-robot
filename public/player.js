(function () {
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

    function select(button, url, type, poster, autoplay) {
      selected = true;
      selectedType = type;
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
      status.textContent = '正在加载：' + button.textContent;
      function play() {
        if (current !== generation) return;
        if (autoplay) video.play().catch(function (error) {
          if (current === generation) status.textContent = error.name === 'NotAllowedError'
            ? '请点击播放器中的播放按钮。' : '此线路无法播放，请切换其他线路。';
        });
      }
      if (type === 'hls' && window.Hls && Hls.isSupported()) {
        hls = new Hls();
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, function (_, data) {
          if (data.fatal && current === generation) {
            status.textContent = '此线路加载失败，请切换其他线路。';
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
          selected = false;
        }
        box.replaceChildren();
        var first;
        // 线路做成横向标签，一次只展开一条线路的选集，避免几十个滚动框叠在一起
        var tabs = document.createElement('div');
        tabs.className = 'line-tabs';
        tabs.setAttribute('role', 'tablist');
        var panels = [];
        (data.lines || []).forEach(function (line, index) {
          var tab = document.createElement('button');
          tab.type = 'button';
          tab.className = 'line-tab';
          tab.textContent = line.name;
          tab.setAttribute('role', 'tab');
          var group = document.createElement('div');
          group.className = 'line-box';
          group.setAttribute('role', 'tabpanel');
          var episodes = document.createElement('div');
          episodes.className = 'line-res episode-grid';
          line.episodes.forEach(function (episode) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'episode-button';
            button.textContent = episode.title;
            button.title = episode.title;
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', function () {
              select(button, episode.url, episode.type, '', true);
              revealPlayer();
            });
            if (!first) first = { button: button, episode: episode };
            episodes.appendChild(button);
          });
          group.appendChild(episodes);
          tab.addEventListener('click', function () { showLine(index); });
          tabs.appendChild(tab);
          panels.push({ tab: tab, group: group });
          box.appendChild(group);
        });
        function showLine(index) {
          panels.forEach(function (p, i) {
            p.tab.classList.toggle('active', i === index);
            p.tab.setAttribute('aria-selected', String(i === index));
            p.group.hidden = i !== index;
          });
          var tab = panels[index].tab;
          tabs.scrollLeft = tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2;
        }
        if (panels.length) {
          box.insertBefore(tabs, box.firstChild);
          showLine(0);
        }
        sourceStatus.textContent = data.lines.length ? '共 ' + data.lines.length + ' 条线路，可切换线路和选集。' : data.message;
        if (first && !selected) select(first.button, first.episode.url, first.episode.type, '', false);
      } catch (e) {
        sourceStatus.textContent = e.message || '线路加载失败，请重新加载。';
      } finally { retry.disabled = false; }
    }
    retry.addEventListener('click', load);
    window.addEventListener('pagehide', function () { if (hls) hls.destroy(); });
    load();
  };
})();
