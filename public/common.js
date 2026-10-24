(function () {
  // ---------- 图片懒加载 ----------
  function loadImg(img) {
    if (img.dataset.src) {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    }
  }
  function initLazy(root) {
    var imgs = (root || document).querySelectorAll('img.lazy[data-src]');
    if (!('IntersectionObserver' in window)) return imgs.forEach(loadImg);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          loadImg(e.target);
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '200px' });
    imgs.forEach(function (img) { io.observe(img); });
  }
  window.initLazy = initLazy;
  initLazy();

  // ---------- 播放历史（存在浏览器本地） ----------
  var KEY = 'play_history';
  function readHistory() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function writeHistory(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.initPlay = function (record) {
    var list = readHistory().filter(function (r) { return r.id !== record.id; });
    record.time = Date.now();
    list.unshift(record);
    writeHistory(list.slice(0, 60));

    if (window.initSources) window.initSources(record);
  };

  window.renderHistory = function () {
    var box = document.getElementById('history-list');
    function draw() {
      var list = readHistory();
      if (!list.length) {
        box.innerHTML = '<p class="text-muted empty">暂无播放记录</p>';
        return;
      }
      box.innerHTML = '<div class="row list-wp">' + list.map(function (m) {
        var base = document.body.dataset.staticBase || '/';
        return '<div class="col-xs-4 col-sm-3 col-md-2 item"><a class="item" href="' + base + 'play/' + esc(m.id) + (document.body.dataset.staticBase ? '/' : '') + '">' +
          '<div class="embed-responsive cover-wp"><img class="img-responsive" src="' + esc(m.cover) + '" alt="' + esc(m.title) + '"></div>' +
          '<p>' + esc(m.title) + '</p></a></div>';
      }).join('') + '</div>';
    }
    draw();
    if (document.body.dataset.staticBase) {
      fetch(document.body.dataset.staticBase + 'catalog.json').then(function (r) {
        if (!r.ok) throw new Error('目录加载失败');
        return r.json();
      }).then(function (catalog) {
        var covers = {};
        catalog.forEach(function (m) { covers[String(m.id)] = m.cover; });
        var list = readHistory().map(function (m) {
          if (covers[String(m.id)]) m.cover = covers[String(m.id)];
          return m;
        });
        writeHistory(list);
        draw();
      }).catch(function () {});
    }
    document.getElementById('clear-history').addEventListener('click', function () {
      if (confirm('确定清空播放历史吗？')) {
        writeHistory([]);
        draw();
      }
    });
  };

  // ---------- 榜单切换 ----------
  window.initBoardTabs = function () {
    var tabs = [].slice.call(document.querySelectorAll('.board-tabs a'));
    function show(id) {
      var tab = tabs.filter(function (a) { return a.hash === '#' + id; })[0] || tabs[0];
      tabs.forEach(function (a) {
        var on = a === tab;
        a.parentNode.classList.toggle('active', on);
        a.setAttribute('aria-selected', on);
        document.getElementById(a.getAttribute('aria-controls')).hidden = !on;
      });
      if (tab.scrollIntoView && tab.parentNode.parentNode.scrollWidth > tab.parentNode.parentNode.clientWidth) {
        tab.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    }
    tabs.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        history.replaceState(null, '', a.hash);
        show(a.hash.slice(1));
      });
    });
    window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
    show(location.hash.slice(1));
  };

  // ---------- 深浅色切换：手动选择存本地，否则跟随系统 ----------
  (function () {
    var root = document.documentElement;
    var media = window.matchMedia && matchMedia('(prefers-color-scheme: dark)');
    function saved() { try { return localStorage.getItem('theme'); } catch (e) { return null; } }
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('theme', next); } catch (e) {}
      });
    });
    if (media && media.addEventListener) media.addEventListener('change', function (e) {
      if (!saved()) root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    });
  })();

  window.fillSearch = function (q) {
    document.querySelectorAll('input[name=q]').forEach(function (i) { i.value = q; });
  };
})();
