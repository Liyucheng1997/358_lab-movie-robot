// 服务端渲染模板（结构与类名对照原站：Bootstrap 3 栅格 + v-list / result-info / line-res）
const douban = require('./douban');
const SITE_NAME = process.env.SITE_NAME || '看片机器人';

const BLANK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 11 14'%3E%3C/svg%3E";

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const img = (url) => (url ? `/img?u=${encodeURIComponent(url)}` : BLANK);
const hotUrl = (type, tag, page = 1) => `/hot/index-${type}-${encodeURIComponent(tag)}${page > 1 ? `-p-${page}` : ''}.html`;

function searchForm(isIndex) {
  return `
    <form action="/search" method="get">
      <div class="${isIndex ? 'index search' : ''}">
        <div class="green_window">
          <input name="q" type="text" maxlength="255" class="input_text" placeholder="请输入影片、剧集、演职人员" value="">
        </div>
        <button type="submit" class="btn_submit">搜索</button>
      </div>
    </form>`;
}

function topNav(active, isIndex) {
  const li = (key, href, text) => `<li${active === key ? ' class="active-nav"' : ''}><a href="${href}">${text}</a></li>`;
  return `
<div class="jumbotron hidden-xs hidden-sm top-nav${isIndex ? ' top-nav-index' : ''}">
  <div class="container" style="font-size: 15px;">
    <ul class="nav nav-pills">
      ${li('home', '/', '首页')}
      ${li('movie', hotUrl('movie', '热门'), '电影')}
      ${li('tv', hotUrl('tv', '热门'), '剧集')}
      ${li('billboard', '/billboard.html', '榜单')}
      <li class="pull-right history-link${active === 'history' ? ' active-nav' : ''}"><a href="/history.html">播放历史</a></li>
    </ul>
  </div>
</div>`;
}

function bottomNav(active) {
  const li = (key, href, icon, text) =>
    `<li${active === key ? ' class="active-nav"' : ''}><a href="${href}"${active === key ? ' aria-current="page"' : ''}><span class="glyphicon glyphicon-${icon}"></span><br><span>${text}</span></a></li>`;
  return `
<nav class="navbar navbar-default navbar-fixed-bottom visible-xs-block visible-sm-block">
  <div class="container bottom-nav">
    <ul class="nav nav-pills">
      ${li('home', '/', 'home', '首页')}
      ${li('movie', hotUrl('movie', '热门'), 'film', '电影')}
      ${li('tv', hotUrl('tv', '热门'), 'facetime-video', '剧集')}
      ${li('billboard', '/billboard.html', 'stats', '榜单')}
      ${li('history', '/history.html', 'time', '看过')}
    </ul>
  </div>
</nav>`;
}

function layout({ title, body, active, isIndex = false, description = '', scripts = '' }) {
  const header = isIndex
    ? `
<div class="jumbotron" style="background: none;padding: 0;margin: 0;">
  <div class="container">
    <div class="row">
      <div class="col-xs-12 col-md-6 col-md-offset-3">
        <div class="index-logo">
          <img src="/resources/logo.svg" width="65" height="65" alt="">
          <span>${esc(SITE_NAME)}</span>
        </div>
        ${searchForm(true)}
      </div>
    </div>
  </div>
</div>`
    : `
<div class="jumbotron site-header">
  <div class="container">
    <div class="nav-container">
      <div class="nav-left">
        <a href="/" title="回到首页"><img src="/resources/logo.svg" width="55" height="55" alt="${esc(SITE_NAME)}"></a>
      </div>
      <div class="nav-right">${searchForm(false)}</div>
    </div>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <title>${esc(title ? `${title}-${SITE_NAME}` : SITE_NAME)}</title>
  <meta name="description" content="${esc(description || title || SITE_NAME)}">
  <link rel="icon" href="/resources/logo.svg">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
  <link rel="stylesheet" href="/resources/common.css?v=5">
</head>
<body>
${header}
${topNav(active, isIndex)}
${body}
${bottomNav(active)}
<script src="/resources/common.js?v=4"></script>
${scripts}
</body>
</html>`;
}

// 海报网格
function grid(items) {
  if (!items.length) return '<p class="text-muted empty">暂无内容</p>';
  return `<div class="row list-wp">${items
    .map(
      (m) => `
    <div class="col-xs-4 col-sm-3 col-md-2 item">
      <a class="item" href="/play/${m.id}">
        <div class="embed-responsive cover-wp">
          <img class="img-responsive lazy" src="${BLANK}" data-src="${esc(img(m.cover))}" alt="${esc(m.title)}">
          ${m.rate ? `<span class="rate">${esc(m.rate)}</span>` : ''}
          ${m.isNew ? '<span class="new">新</span>' : ''}
        </div>
        <p>${esc(m.title)}</p>
      </a>
    </div>`
    )
    .join('')}</div>`;
}

function tagPills(type, tags, current) {
  return `<ul class="nav nav-pills tag-pills">${tags
    .map((t) => `<li${t === current ? ' class="disabled"' : ''}><a href="${hotUrl(type, t)}">${esc(t)}</a></li>`)
    .join('')}</ul>`;
}

function rankList(title, items, moreHref) {
  return `
<div class="article-list">
  <h4>${esc(title)}${moreHref ? `<span><a href="${moreHref}">更多榜单»</a></span>` : ''}</h4>
  <ul>${items
    .map((m, i) => `<li><span class="rank-no">${i + 1}</span><a href="/play/${m.id}">${esc(m.title)}</a></li>`)
    .join('')}</ul>
</div>`;
}

function homePage({ movies, tvs, weekly }) {
  const body = `
<div class="container main">
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <div class="v-list">
        <h4>最近热门电影<span><a href="${hotUrl('movie', '热门')}">更多»</a></span></h4>
        ${grid(movies)}
      </div>
      <div class="v-list">
        <h4>最近热门剧集<span><a href="${hotUrl('tv', '热门')}">更多»</a></span></h4>
        ${grid(tvs)}
      </div>
    </div>
    <div class="col-xs-12 col-md-4">
      ${weekly ? rankList('一周口碑榜', weekly.items, '/billboard.html') : ''}
    </div>
  </div>
</div>`;
  return layout({ title: '', body, active: 'home', isIndex: true, description: `${SITE_NAME}：热门电影、热门剧集、口碑榜单` });
}

function hotPage({ type, tag, tags, page, items, hasNext }) {
  const label = type === 'movie' ? '最近热门电影' : '最近热门剧集';
  const pills = `<h5>${label}</h5>${tagPills(type, tags, tag)}`;
  const pager = `
<div class="page-more">
  ${page > 1 ? `<a href="${hotUrl(type, tag, page - 1)}">上一页</a>` : ''}
  ${page > 1 && hasNext ? '<span class="sep">|</span>' : ''}
  ${hasNext ? `<a href="${hotUrl(type, tag, page + 1)}">下一页</a>` : ''}
</div>`;
  const body = `
<div class="container main" style="margin-top: 15px;">
  <div class="row visible-xs-block visible-sm-block"><div class="col-xs-12">${pills}</div></div>
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <div class="v-list">${grid(items)}</div>
      ${pager}
    </div>
    <div class="col-xs-12 col-md-4">
      <div class="hidden-xs hidden-sm">${pills}</div>
    </div>
  </div>
</div>`;
  const kind = type === 'movie' ? '电影' : '剧集';
  return layout({ title: `${tag}${kind}-第${page}页`, body, active: type });
}

function boardItems(b) {
  if (b.error) return '<p class="text-muted">榜单加载失败，请稍后刷新重试。</p>';
  if (!b.items.length) return '<p class="text-muted empty">暂无内容</p>';
  return `<div class="board-list">${b.items
    .map(
      (m) => `
    <a class="result-info board-item" href="/play/${m.id}">
      <div class="item-root">
        <span class="board-rank${m.rank <= 3 ? ' top' : ''}">${m.rank}</span>
        <img class="cover lazy" src="${BLANK}" data-src="${esc(img(m.cover))}" alt="${esc(m.title)}">
        <div class="detail">
          <h2 class="meta title">${esc(m.title)}${m.rate ? ` <span class="score">${esc(m.rate)}</span>` : ''}</h2>
          <h3 class="meta">${esc(m.year)}</h3>
          <h3 class="meta">${esc(m.region)}</h3>
          <h3 class="meta">${esc(m.people)}</h3>
        </div>
      </div>
    </a>`
    )
    .join('')}</div>`;
}

// 榜单页：顶部标签切换，一次只显示一个榜单；地址带 #榜单ID 可直接打开对应榜单
function billboardPage(boards) {
  const tabs = boards
    .map(
      (b, i) =>
        `<li role="presentation"${i === 0 ? ' class="active"' : ''}><a href="#${esc(b.id)}" role="tab" id="tab-${esc(b.id)}" aria-controls="board-${esc(b.id)}" aria-selected="${i === 0}">${esc(b.short || b.name)}</a></li>`
    )
    .join('');
  const panels = boards
    .map(
      (b, i) => `
  <section class="billboard" id="board-${esc(b.id)}" role="tabpanel" aria-labelledby="tab-${esc(b.id)}"${i === 0 ? '' : ' hidden'}>
    <h4>${esc(b.name)}${b.updatedAt ? ` <small>${esc(b.updatedAt)}更新</small>` : ''}</h4>
    ${b.description ? `<p class="text-muted small">${esc(b.description)}</p>` : ''}
    ${boardItems(b)}
  </section>`
    )
    .join('');
  const body = `
<div class="container main" style="margin-top: 15px;">
  <ul class="nav nav-pills board-tabs" role="tablist">${tabs}</ul>
  ${panels}
</div>`;
  return layout({ title: '影视排行榜', body, active: 'billboard', scripts: '<script>initBoardTabs();</script>' });
}

const searchUrl = (q, page = 1) => `/search?q=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;

function searchPage(q, result = { items: [], total: 0, hasNext: false }, error = false, page = 1) {
  const { items, total, hasNext } = result;
  const list = error
    ? '<p class="text-muted">搜索服务暂时不可用，请稍后再试。</p>'
    : items.length
      ? items
          .map(
            (m) => `
    <a class="result-info board-item" href="/play/${m.id}">
      <div class="item-root">
        <img class="cover lazy" src="${BLANK}" data-src="${esc(img(m.cover))}" alt="${esc(m.title)}">
        <div class="detail">
          <h2 class="meta title">${esc(m.title)}${m.rate ? ` <span class="score">${esc(m.rate)}</span>` : ''}</h2>
          <h3 class="meta">${esc([m.year, m.typeName].filter(Boolean).join(' · '))}</h3>
          ${m.subTitle && m.subTitle !== m.title ? `<h3 class="meta">${esc(m.subTitle)}</h3>` : ''}
        </div>
      </div>
    </a>`
          )
          .join('')
      : q
        ? `<p class="text-muted">${page > 1 ? '没有更多结果了。' : `没有找到与「${esc(q)}」相关的影片，换个关键词试试。`}</p>`
        : '<p class="text-muted">请输入关键词搜索。</p>';
  const pages = total ? Math.ceil(total / douban.SEARCH_PAGE_SIZE) : page;
  const pager =
    page > 1 || hasNext
      ? `
<div class="page-more">
  ${page > 1 ? `<a href="${esc(searchUrl(q, page - 1))}">上一页</a>` : ''}
  <span class="page-no">第 ${page}${total ? ` / ${pages}` : ''} 页</span>
  ${hasNext ? `<a href="${esc(searchUrl(q, page + 1))}">下一页</a>` : ''}
</div>`
      : '';
  const heading = q
    ? `「${esc(q)}」的搜索结果${total ? ` <small class="text-muted">共 ${total} 条</small>` : ''}`
    : '搜索';
  const body = `
<div class="container main" style="margin-top: 15px;">
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <h5>${heading}</h5>
      <div class="search-list">${list}</div>
      ${pager}
    </div>
  </div>
</div>`;
  return layout({
    title: q ? `${q}-搜索结果${page > 1 ? `-第${page}页` : ''}` : '搜索',
    body,
    scripts: `<script>fillSearch(${JSON.stringify(q).replace(/</g, '\\u003c')});</script>`,
  });
}

function playPage(d) {
  const trailers = d.trailers;
  const first = trailers[0];
  // 手机端信息面板排在页面底部，标题下先给出评分、年份、类型等关键信息
  const mobileMeta = [
    d.rating ? `<span class="score">${esc(d.rating)}分</span>` : '',
    esc(d.year),
    esc(d.genres.slice(0, 3).join(' / ')),
    esc(d.countries.slice(0, 2).join(',')),
    esc(d.episodes),
  ].filter(Boolean);
  const people = [d.directors.join(','), d.actors.slice(0, 5).join(',')].filter(Boolean).join('/');
  const player = first
    ? `<video id="player" class="embed-responsive-item" controls preload="metadata" playsinline
         poster="${esc(img(first.cover || d.cover))}" src="/video?u=${encodeURIComponent(first.url)}"></video>`
    : `<video id="player" class="embed-responsive-item" controls preload="metadata" playsinline poster="${esc(img(d.cover))}"></video>`;

  const trailerBox = trailers.length
    ? `<ul class="line-box"><li><ul>
         <li class="line-name">豆瓣官方预告</li>
         <li class="line-res clearfix">${trailers
           .map(
             (t, i) =>
               `<div data-src="/video?u=${esc(encodeURIComponent(t.url))}" data-poster="${esc(img(t.cover))}"${i === 0 ? ' class="active"' : ''}>${esc(t.title)}${t.runtime ? ` <small>${esc(t.runtime)}</small>` : ''}</div>`
           )
           .join('')}</li>
       </ul></li></ul>`
    : '';

  const vendorBox = d.vendors.length
    ? `<div class="vendor-box">
        <span class="section-title">正版播放平台</span>
        <ul class="vendor-list">${d.vendors
          .map(
            (v) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">
              ${v.icon ? `<img src="${esc(img(v.icon))}" alt="">` : ''}<span>${esc(v.title)}</span>
              <small class="${v.paid ? 'paid' : 'free'}">${esc(v.payment)}</small>
              ${v.episodes ? `<small class="text-muted">${esc(v.episodes)}</small>` : ''}
            </a></li>`
          )
          .join('')}</ul>
      </div>`
    : `<p class="text-muted vendor-empty">暂未查到正版播放平台，可前往 <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">豆瓣页面</a> 查看。</p>`;

  const body = `
<div class="container main play-main">
  <div class="row">
    <div class="col-xs-12 col-md-12">
      <div class="embed-responsive embed-responsive-16by9 player-wrap">${player}</div>
      <p id="player-status" class="text-muted" role="status" aria-live="polite"></p>
    </div>
  </div>
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <h1 id="video_title">${esc(d.title)}</h1>
      ${mobileMeta.length ? `<p class="play-meta visible-xs-block visible-sm-block">${mobileMeta.join('<span class="dot">·</span>')}</p>` : ''}
      <div class="source-heading"><span class="section-title">第三方播放线路</span><button id="retry-sources" type="button" class="btn btn-default btn-xs">重新检测</button></div>
      <p id="source-status" class="text-muted" role="status" aria-live="polite">正在匹配影片并加载线路…</p>
      <div id="source-lines"></div>
      <span class="section-title">预告片选择</span>
      <span class="line-count">（共${trailers.length}条）</span><br>
      <span class="line-tips">预告片来自豆瓣官方。</span>
      ${trailerBox}
      ${vendorBox}
      ${d.intro ? `<div class="intro"><span class="section-title">剧情简介</span><p>${esc(d.intro)}</p></div>` : ''}
    </div>
    <div class="col-xs-12 col-md-4">
      <div class="info-panel">
        <div class="item result-info active">
          <div class="item-root">
            <img class="cover" src="${esc(img(d.cover))}" alt="${esc(d.title)}">
            <div class="detail">
              <h2 class="meta title">${esc(d.title)}</h2>
              ${d.aka.length || d.originalTitle ? `<h3 class="meta">${esc([...d.aka, d.originalTitle].filter((x, i, a) => x && x !== d.title && a.indexOf(x) === i).join(','))}</h3>` : ''}
              <h3 class="meta">${esc(d.year)}</h3>
              <h3 class="meta">${esc(d.countries.join(','))}</h3>
              <h3 class="meta">${esc(people)}</h3>
            </div>
          </div>
        </div>
        <table class="table table-condensed info-table">
          ${d.rating ? `<tr><th>豆瓣评分</th><td><span class="score">${esc(d.rating)}</span> <small class="text-muted">${esc(d.ratingCount)}人评价</small></td></tr>` : ''}
          ${d.genres.length ? `<tr><th>类型</th><td>${esc(d.genres.join(' / '))}</td></tr>` : ''}
          ${d.episodes ? `<tr><th>集数</th><td>${esc(d.episodes)}</td></tr>` : ''}
          ${d.durations.length ? `<tr><th>片长</th><td>${esc(d.durations.join(' / '))}</td></tr>` : ''}
          ${d.pubdate.length ? `<tr><th>上映</th><td>${esc(d.pubdate.join(' / '))}</td></tr>` : ''}
          <tr><th>豆瓣</th><td><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">查看豆瓣页面</a></td></tr>
        </table>
      </div>
    </div>
  </div>
</div>`;
  const record = { id: d.id, title: d.title, cover: img(d.cover), year: d.year };
  return layout({
    title: `${d.title}-在线播放`,
    description: d.intro.slice(0, 120),
    body,
    scripts: `<script src="/resources/vendor/hls.min.js"></script><script src="/resources/player.js?v=4"></script><script>initPlay(${JSON.stringify(record).replace(/</g, '\\u003c')});</script>`,
  });
}

function historyPage() {
  const body = `
<div class="container main" style="margin-top: 15px;">
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <h5>播放历史 <a href="javascript:void(0)" id="clear-history" class="pull-right small">清空</a></h5>
      <div class="v-list"><div id="history-list"></div></div>
    </div>
  </div>
</div>`;
  return layout({ title: '播放历史', body, active: 'history', scripts: '<script>renderHistory();</script>' });
}

function errorPage(status, message) {
  const body = `
<div class="container main" style="margin-top: 40px;text-align:center">
  <h3>${status === 404 ? '页面不存在' : '出错了'}</h3>
  <p class="text-muted">${esc(message)}</p>
  <p><a href="/">返回首页</a></p>
</div>`;
  return layout({ title: status === 404 ? '页面不存在' : '出错了', body });
}

module.exports = { homePage, hotPage, billboardPage, searchPage, playPage, historyPage, errorPage, hotUrl };
