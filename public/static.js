(function () {
  var base = document.body.dataset.staticBase;
  if (!base || location.pathname !== base + 'search/') return;
  var q = (new URLSearchParams(location.search).get('q') || '').trim().slice(0, 100);
  fillSearch(q);
  var box = document.querySelector('.search-list');
  var heading = document.querySelector('.main h5');
  heading.textContent = q ? '「' + q + '」的搜索结果' : '搜索';
  if (!q) return;
  box.textContent = '正在搜索…';
  fetch(base + 'catalog.json').then(function (r) {
    if (!r.ok) throw new Error('目录加载失败');
    return r.json();
  }).then(function (catalog) {
    // 忽略大小写、空格和标点，「蝙蝠侠黑暗骑士」也能匹配「蝙蝠侠：黑暗骑士」
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); };
    var key = norm(q) || q.toLowerCase();
    var results = catalog.filter(function (d) {
      return [d.title, d.originalTitle].concat(d.aka || []).some(function (t) { return norm(t).includes(key); });
    });
    box.replaceChildren();
    if (!results.length) { box.textContent = '当前快照尚未收录相关影片，请换个关键词。'; return; }
    results.forEach(function (d) {
      var link = document.createElement('a');
      link.className = 'result-info board-item';
      link.href = base + 'play/' + d.id + '/';
      var row = document.createElement('div');
      row.className = 'item-root';
      var img = document.createElement('img');
      img.className = 'cover';
      img.src = d.cover || '';
      img.alt = d.title;
      var text = document.createElement('div');
      text.className = 'detail';
      var title = document.createElement('h2');
      title.className = 'meta title';
      title.textContent = d.title;
      var year = document.createElement('p');
      year.textContent = d.year || '';
      text.append(title, year);
      row.append(img, text);
      link.appendChild(row);
      box.appendChild(link);
    });
  }).catch(function () { box.textContent = '目录暂时不可用，请刷新重试。'; });
})();
