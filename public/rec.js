/* 个性化推荐：行为采集 + 推荐流渲染。算法在 rec-core.js；行为数据只存在本机 localStorage
 * 采集的信号：打开详情页、开始播放、实际观看秒数、喜欢、不感兴趣、推荐卡片曝光（曝光不点会逐次降权） */
(function () {
  var Core = window.RecCore;
  if (!Core) return;
  var KEY = 'rec_state_v1';
  var base = document.body.dataset.staticBase || '';
  var BLANK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 11 14'%3E%3C/svg%3E";

  // ---------- 本地行为数据 ----------
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.items) return { items: s.items, seeds: s.seeds || [], imp: s.imp || {} };
    } catch (e) {}
    return { items: {}, seeds: [], imp: {} };
  }
  var state = load();
  function save() {
    // 控制体积：最多保留 300 部影片的行为和 1500 条曝光记录
    var ids = Object.keys(state.items);
    if (ids.length > 300) {
      ids.sort(function (a, b) { return (state.items[b].t || 0) - (state.items[a].t || 0); })
        .slice(300).forEach(function (id) { delete state.items[id]; });
    }
    var imps = Object.keys(state.imp);
    if (imps.length > 1500) {
      imps.sort(function (a, b) { return state.imp[b][1] - state.imp[a][1]; })
        .slice(1500).forEach(function (id) { delete state.imp[id]; });
    }
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  // 其他标签页更新了行为数据时同步过来
  window.addEventListener('storage', function (e) { if (e.key === KEY) state = load(); });

  function touch(id, item) {
    var rec = state.items[id] || (state.items[id] = {});
    if (item) {
      if (item.f && item.f.length) rec.f = item.f;
      if (item.title) rec.title = item.title;
    }
    rec.t = Date.now();
    return rec;
  }

  function setDislike(id, item, on) {
    var rec = touch(id, item);
    if (on) { rec.dislike = 1; delete rec.like; } else delete rec.dislike;
    save();
  }

  // ---------- 数据 ----------
  function playHref(id) { return base ? base + 'play/' + id + '/' : '/play/' + id; }

  var poolPromise = null;
  function getPool() {
    if (!poolPromise) {
      poolPromise = fetch(base ? base + 'rec/pool.json' : '/api/rec/pool').then(function (r) {
        if (!r.ok) throw new Error('候选池加载失败');
        return r.json();
      }).then(function (d) { return d.items || []; });
      poolPromise.catch(function () { poolPromise = null; });
    }
    return poolPromise;
  }

  // 相关影片：实时版用豆瓣「喜欢这部的人也喜欢」（协同过滤），失败或静态版退回内容相似
  function getRelated(id, f) {
    function fallback() {
      return getPool().then(function (pool) {
        var target = pool.filter(function (x) { return x.id === String(id); })[0];
        return Core.similar({ id: id, f: (target && target.f) || f || [] }, pool, 16);
      });
    }
    if (base) return fallback();
    return fetch('/api/rec/related/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error('相关推荐加载失败');
      return r.json();
    }).then(function (d) {
      return d.items && d.items.length ? d.items : fallback();
    }).catch(fallback);
  }

  function relatedGroups() {
    var seeds = Core.seedItems(state, 4);
    return Promise.all(seeds.map(function (s) {
      var rec = state.items[s.id] || {};
      return getRelated(s.id, rec.f).then(function (items) { return { via: s, items: items }; }, function () { return null; });
    })).then(function (groups) { return groups.filter(Boolean); });
  }

  // ---------- 卡片 ----------
  function card(item, onDislike) {
    var col = document.createElement('div');
    col.className = 'col-xs-4 col-sm-3 col-md-2 item rec-item';
    col.dataset.id = item.id;
    var a = document.createElement('a');
    a.className = 'item';
    a.href = playHref(item.id);
    var wp = document.createElement('div');
    wp.className = 'embed-responsive cover-wp';
    var img = document.createElement('img');
    img.className = 'img-responsive lazy';
    img.src = BLANK;
    if (item.cover) img.dataset.src = item.cover;
    img.alt = item.title;
    wp.appendChild(img);
    if (item.rate) {
      var rate = document.createElement('span');
      rate.className = 'rate';
      rate.textContent = Number(item.rate).toFixed(1);
      wp.appendChild(rate);
    }
    var title = document.createElement('p');
    title.textContent = item.title;
    a.append(wp, title);
    col.appendChild(a);
    if (item.reason) {
      var reason = document.createElement('span');
      reason.className = 'rec-reason' + (item.explore ? ' is-explore' : item.via ? ' is-related' : '');
      reason.textContent = item.reason;
      col.appendChild(reason);
    }
    if (onDislike) {
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'rec-dislike';
      x.title = '不感兴趣';
      x.setAttribute('aria-label', '不感兴趣：' + item.title);
      x.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      x.addEventListener('click', function (e) { e.preventDefault(); onDislike(item, col); });
      col.appendChild(x);
    }
    return col;
  }

  // 曝光：卡片露出 60% 以上记一次
  var impTimer = null;
  var impObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      impObserver.unobserve(e.target);
      var id = e.target.dataset.id;
      var cur = state.imp[id] || [0, 0];
      state.imp[id] = [cur[0] + 1, Date.now()];
    });
    clearTimeout(impTimer);
    impTimer = setTimeout(save, 800);
  }, { threshold: 0.6 }) : null;

  // ---------- 推荐流（首页预览和推荐页共用） ----------
  function Feed(section, opts) {
    var size = Number(section.dataset.size) || 12;
    var grid = section.querySelector('.rec-grid');
    var status = section.querySelector('.rec-status');
    var refresh = section.querySelector('.rec-refresh');
    var sentinel = section.querySelector('.rec-sentinel');
    var list = [], pos = 0, lookup = {}, shown = {}, loading = null;

    function setStatus(text, undo) {
      status.replaceChildren();
      status.hidden = !text;
      if (!text) return;
      status.append(text);
      if (undo) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rec-undo';
        b.textContent = '撤销';
        b.addEventListener('click', undo);
        status.append(' ', b);
      }
    }

    function build() {
      loading = Promise.all([getPool(), relatedGroups()]).then(function (res) {
        var pool = res[0], groups = res[1];
        lookup = {};
        pool.forEach(function (x) { lookup[x.id] = x; });
        groups.forEach(function (g) { g.items.forEach(function (x) { if (!lookup[x.id] || !lookup[x.id].f.length) lookup[x.id] = x; }); });
        var opt = { seed: Math.floor(Math.random() * 1e9), exclude: shown };
        list = Core.recommend(pool, groups, state, opt);
        // 本轮都看过了就从头再来
        if (list.length < size && Object.keys(shown).length) {
          shown = {};
          opt.exclude = shown;
          list = Core.recommend(pool, groups, state, opt);
        }
        pos = 0;
        loading = null;
        return list;
      });
      loading.catch(function () { loading = null; });
      return loading;
    }

    function dislike(item, col) {
      setDislike(item.id, lookup[item.id] || item, true);
      var next = list[pos++];
      col.classList.add('is-removing');
      setTimeout(function () {
        if (next) {
          var c = card(next, dislike);
          grid.replaceChild(c, col);
          shown[next.id] = true;
          if (window.initLazy) initLazy(c);
          if (impObserver) impObserver.observe(c);
        } else col.remove();
      }, 220);
      setStatus('将减少类似推荐。', function () {
        setDislike(item.id, null, false);
        setStatus('');
      });
      if (opts.onChange) opts.onChange();
    }

    function render(n) {
      var frag = document.createDocumentFragment();
      list.slice(pos, pos + n).forEach(function (item) {
        shown[item.id] = true;
        frag.appendChild(card(item, dislike));
      });
      pos = Math.min(list.length, pos + n);
      var nodes = [].slice.call(frag.children);
      grid.appendChild(frag);
      if (window.initLazy) initLazy(grid);
      if (impObserver) nodes.forEach(function (c) { impObserver.observe(c); });
      if (sentinel) sentinel.hidden = pos >= list.length;
      if (sentinel && pos >= list.length && list.length) setStatus('这一轮的推荐看完了，点「换一批」再来一些。');
    }

    function reload() {
      if (refresh) refresh.disabled = true;
      return build().then(function () {
        grid.replaceChildren();
        setStatus(list.length ? '' : '暂时没有可推荐的影片。');
        render(size);
        section.hidden = false;
      }).catch(function () {
        setStatus('推荐暂时加载失败，请稍后刷新重试。');
        if (opts.hideOnError) section.hidden = true;
      }).finally(function () { if (refresh) refresh.disabled = false; });
    }

    if (refresh) refresh.addEventListener('click', function () {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      reload();
    });
    // 无限下拉：哨兵元素接近视口时加载下一页；滚动事件兜底（部分浏览器后台页面不触发 IntersectionObserver）
    function more() {
      if (!sentinel || loading || pos >= list.length || section.hidden) return;
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) render(size);
    }
    if (sentinel) {
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) more(); }, { rootMargin: '400px' }).observe(sentinel);
      }
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        setTimeout(function () { ticking = false; more(); }, 150);
      }, { passive: true });
    }
    return { reload: reload };
  }

  // 冷启动的类型选择，选中后写入种子兴趣
  function genreChips(ul, onChange) {
    var timer = null;
    ul.replaceChildren();
    Core.STARTER_GENRES.forEach(function (g) {
      var li = document.createElement('li');
      var b = document.createElement('a');
      b.href = '#';
      b.setAttribute('role', 'button');
      b.textContent = g;
      function sync() {
        var on = state.seeds.indexOf(g) >= 0;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      }
      sync();
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var i = state.seeds.indexOf(g);
        if (i >= 0) state.seeds.splice(i, 1); else state.seeds.push(g);
        save();
        sync();
        clearTimeout(timer);
        timer = setTimeout(onChange, 500);
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  function renderTaste(box) {
    var ul = box.querySelector('.rec-interests');
    var top = Core.topInterests(Core.buildProfile(state), 12);
    ul.replaceChildren();
    if (!top.length) {
      var p = document.createElement('li');
      p.className = 'rec-taste-empty';
      p.textContent = '还没有足够的观看记录。多看几部，或在下面选几个喜欢的类型。';
      ul.appendChild(p);
      return;
    }
    top.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'rec-interest';
      var name = document.createElement('span');
      name.className = 'rec-interest-name';
      name.textContent = t.name;
      var fam = document.createElement('small');
      fam.textContent = t.familyName;
      var bar = document.createElement('span');
      bar.className = 'rec-interest-bar';
      var fill = document.createElement('i');
      fill.style.width = Math.round(Math.max(0.08, t.weight) * 100) + '%';
      bar.appendChild(fill);
      li.append(name, fam, bar);
      ul.appendChild(li);
    });
  }

  // ---------- 首页 ----------
  function mountHome(section) {
    var starter = section.querySelector('.rec-starter');
    var feed = Feed(section, { hideOnError: true });
    function syncStarter() {
      // 冷启动阶段（画像置信度低）显示类型选择
      starter.hidden = Core.buildProfile(state).confidence >= 0.35 && !state.seeds.length;
    }
    genreChips(section.querySelector('.rec-genres'), function () { feed.reload(); syncStarter(); });
    syncStarter();
    feed.reload();
  }

  // ---------- 推荐页 ----------
  function mountFeed(section) {
    var taste = document.getElementById('rec-taste');
    var feed = Feed(section, { onChange: function () { renderTaste(taste); } });
    function refreshAll() { renderTaste(taste); feed.reload(); }
    genreChips(taste.querySelector('.rec-genres'), refreshAll);
    taste.querySelector('.rec-reset').addEventListener('click', function () {
      if (!confirm('确定重置推荐吗？观看偏好、喜欢和不感兴趣记录都会清空（播放历史保留）。')) return;
      state = { items: {}, seeds: [], imp: {} };
      save();
      genreChips(taste.querySelector('.rec-genres'), refreshAll);
      refreshAll();
    });
    refreshAll();
  }

  // ---------- 详情页：记录浏览、播放、观看时长，提供喜欢/不感兴趣和相关推荐 ----------
  function onPlayPage(record) {
    var id = String(record.id);
    var item = { f: Core.featuresOf(record.meta), title: record.title };
    var rec = state.items[id] || {};
    // 30 分钟内重复打开（刷新）不重复计数
    if (!rec.t || Date.now() - rec.t > 30 * 60 * 1000 || !rec.view) rec.view = (rec.view || 0) + 1;
    state.items[id] = rec;
    touch(id, item);
    delete state.imp[id];
    save();

    var like = document.querySelector('.like-btn');
    var dis = document.querySelector('.dislike-btn');
    function sync() {
      var r = state.items[id] || {};
      if (like) { like.setAttribute('aria-pressed', !!r.like); like.classList.toggle('is-on', !!r.like); like.lastChild.textContent = r.like ? '已喜欢' : '喜欢'; }
      if (dis) { dis.setAttribute('aria-pressed', !!r.dislike); dis.classList.toggle('is-on', !!r.dislike); dis.lastChild.textContent = r.dislike ? '已标记不感兴趣' : '不感兴趣'; }
    }
    if (like) like.addEventListener('click', function () {
      var r = touch(id, item);
      if (r.like) delete r.like; else { r.like = 1; delete r.dislike; }
      save();
      sync();
    });
    if (dis) dis.addEventListener('click', function () {
      setDislike(id, item, !(state.items[id] || {}).dislike);
      sync();
    });
    sync();

    // 观看时长：只累计正常播放推进的秒数，拖动进度条不算
    var video = document.getElementById('player');
    if (video) {
      var last = null, pending = 0;
      function flush() {
        if (pending < 1) return;
        var r = touch(id, item);
        r.watch = Math.round((r.watch || 0) + pending);
        pending = 0;
        save();
      }
      video.addEventListener('playing', function () {
        var r = state.items[id];
        if (r && !r.play) { r.play = 1; save(); }
        last = video.currentTime;
      });
      video.addEventListener('timeupdate', function () {
        if (video.paused || video.seeking) { last = video.currentTime; return; }
        var d = video.currentTime - (last == null ? video.currentTime : last);
        last = video.currentTime;
        if (d > 0 && d < 3) pending += d;
        if (pending >= 15) flush();
      });
      video.addEventListener('seeking', function () { last = null; });
      video.addEventListener('pause', flush);
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    }

    var section = document.getElementById('rec-related');
    if (section) {
      getRelated(id, item.f).then(function (items) {
        var list = items.filter(function (x) {
          var r = state.items[x.id];
          return x.id !== id && !(r && r.dislike);
        }).slice(0, 12);
        if (!list.length) return;
        var grid = section.querySelector('.rec-grid');
        list.forEach(function (x) { grid.appendChild(card({ id: x.id, title: x.title, cover: x.cover, rate: x.rate })); });
        if (window.initLazy) initLazy(grid);
        section.hidden = false;
      }).catch(function () {});
    }
  }

  window.Rec = { onPlayPage: onPlayPage, state: function () { return state; } };

  var home = document.getElementById('rec-home');
  if (home) mountHome(home);
  var feed = document.getElementById('rec-feed');
  if (feed) mountFeed(feed);
})();
