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
  // 每部影片一条：{ id, title, cover, year, time, line, flag, index, epTitle, epCount, pos, dur }
  // line/flag 是上次的线路，index 是选集序号，pos/dur 是播放进度（秒）
  var KEY = 'play_history';
  var MAX = 100;
  function readHistory() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function writeHistory(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) {}
  }
  function finished(r) { return !!(r && r.dur && r.pos >= r.dur - 30); }
  window.WatchHistory = {
    read: readHistory,
    get: function (id) {
      return readHistory().filter(function (r) { return String(r.id) === String(id); })[0] || null;
    },
    // 合并写入并移到最前；进度高频更新，不改动列表顺序以外的其他影片
    update: function (id, patch) {
      var list = readHistory();
      var old = list.filter(function (r) { return String(r.id) === String(id); })[0] || { id: id };
      var rest = list.filter(function (r) { return r !== old; });
      rest.unshift(Object.assign({}, old, patch, { time: Date.now() }));
      writeHistory(rest);
    },
    remove: function (id) {
      writeHistory(readHistory().filter(function (r) { return String(r.id) !== String(id); }));
    },
    finished: finished,
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + two(m) : m) + ':' + two(s);
  }
  window.formatClock = clock;

  function when(ts) {
    var d = new Date(ts), now = new Date();
    var day = 864e5;
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var hm = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    if (ts >= start) return '今天 ' + hm;
    if (ts >= start - day) return '昨天 ' + hm;
    if (ts >= start - 6 * day) return Math.ceil((start - ts) / day) + ' 天前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 「第3集 · 看到 12:34」「已看完」等进度说明
  function progressText(r) {
    var ep = r.epCount > 1 && r.epTitle ? r.epTitle + ' · ' : '';
    if (r.pos == null) return '';
    if (finished(r)) return ep + '已看完';
    return ep + '看到 ' + clock(r.pos) + (r.dur ? ' / ' + clock(r.dur) : '');
  }

  function playHref(id) {
    var base = document.body.dataset.staticBase || '/';
    return base + 'play/' + esc(id) + (document.body.dataset.staticBase ? '/' : '');
  }

  function card(m, withMeta) {
    var pct = m.dur ? Math.min(100, Math.round(m.pos / m.dur * 100)) : 0;
    var text = progressText(m);
    return '<div class="col-xs-4 col-sm-3 col-md-2 item history-item" data-id="' + esc(m.id) + '"><a class="item" href="' + playHref(m.id) + '">' +
      '<div class="embed-responsive cover-wp"><img class="img-responsive" src="' + esc(m.cover) + '" alt="' + esc(m.title) + '">' +
      (pct ? '<span class="watch-progress" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' : '') + '</div>' +
      '<p>' + esc(m.title) + '</p>' +
      (text ? '<small class="history-meta">' + esc(text) + '</small>' : '') +
      (withMeta ? '<small class="history-meta history-sub">' + esc([m.line, when(m.time)].filter(Boolean).join(' · ')) + '</small>' : '') +
      '</a>' + (withMeta ? '<button type="button" class="rec-dislike history-remove" aria-label="删除这条记录" title="删除这条记录">×</button>' : '') + '</div>';
  }

  window.initPlay = function (record) {
    if (window.Rec) window.Rec.onPlayPage(record);
    // 保留上次的线路和进度，只更新影片信息和时间
    window.WatchHistory.update(record.id, { title: record.title, cover: record.cover, year: record.year });

    // 弹幕、AI 陪看先初始化，才能收到线路自动选中时的选集事件
    if (window.initDanmaku) window.initDanmaku(record);
    if (window.initCompanion) window.initCompanion(record);
    if (window.initSources) window.initSources(record);
  };

  // 首页「继续观看」：只列没看完的
  window.renderContinue = function () {
    var box = document.getElementById('continue-watch');
    if (!box) return;
    var list = readHistory().filter(function (r) { return r.pos > 30 && !finished(r); }).slice(0, 6);
    if (!list.length) return;
    box.querySelector('.list-wp').innerHTML = list.map(function (m) { return card(m, false); }).join('');
    box.hidden = false;
  };

  window.renderHistory = function () {
    var box = document.getElementById('history-list');
    function draw() {
      var list = readHistory();
      if (!list.length) {
        box.innerHTML = '<p class="text-muted empty">暂无播放记录</p>';
        return;
      }
      box.innerHTML = '<div class="row list-wp">' + list.map(function (m) { return card(m, true); }).join('') + '</div>';
    }
    draw();
    box.addEventListener('click', function (e) {
      var btn = e.target.closest('.history-remove');
      if (!btn) return;
      window.WatchHistory.remove(btn.parentNode.dataset.id);
      draw();
    });
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
