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

// 线性图标（lucide 风格，1.75 线宽），颜色跟随文字
const ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 12h18M3 7.5h4M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  tv: '<rect x="2" y="7" width="20" height="15" rx="2"/><path d="m17 2-5 5-5-5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-4M13 17V8M18 17v-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M18 5l2 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const icon = (name, size = 18) =>
  `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function searchForm(isIndex) {
  return `
    <form action="/search" method="get" class="search-pill${isIndex ? ' search-hero' : ''}" role="search">
      ${icon('search', isIndex ? 20 : 17)}
      <input name="q" type="search" maxlength="255" class="search-input" placeholder="搜索影片、剧集、演职人员" value="" aria-label="搜索">
      <button type="submit" class="search-btn">搜索</button>
    </form>`;
}

const NAV = [
  ['home', '/', 'home', '首页'],
  ['movie', hotUrl('movie', '热门'), 'film', '电影'],
  ['tv', hotUrl('tv', '热门'), 'tv', '剧集'],
  ['billboard', '/billboard.html', 'chart', '榜单'],
  ['history', '/history.html', 'clock', '播放历史', '看过'],
];

// 顶栏：Logo + 导航 + 搜索 + 深浅色切换；首页的搜索放在大标题下面
function topbar(active, isIndex) {
  const links = NAV.map(
    ([key, href, , text]) => `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ''}>${text}</a>`
  ).join('');
  return `
<header class="topbar${isIndex ? ' topbar-index' : ''}">
  <div class="container topbar-inner">
    <a class="brand" href="/" title="回到首页"><img src="/resources/logo.svg" width="30" height="30" alt=""><span>${esc(SITE_NAME)}</span></a>
    <nav class="topnav" aria-label="主导航">${links}</nav>
    ${isIndex ? '<div class="topbar-spacer"></div>' : searchForm(false)}
    <button type="button" class="round-btn theme-toggle" aria-label="切换深色模式" title="切换深色模式">${icon('moon', 17)}${icon('sun', 17)}</button>
  </div>
</header>`;
}

function bottomNav(active) {
  const links = NAV.map(
    ([key, href, ico, text, short]) =>
      `<a href="${href}"${active === key ? ' class="active" aria-current="page"' : ''}>${icon(ico, 22)}<span>${short || text}</span></a>`
  ).join('');
  return `<nav class="tabbar" aria-label="底部导航">${links}</nav>`;
}

function hero() {
  return `
<section class="hero">
  <div class="container">
    <h1 class="hero-title">今晚想看点<em>什么</em>？</h1>
    <p class="hero-sub">豆瓣热门、口碑榜单与多线路播放，一处搞定。</p>
    ${searchForm(true)}
  </div>
</section>`;
}

// 深浅色：先读本地选择，没有就跟随系统；放在 <head> 里避免首屏闪白
const THEME_SCRIPT = `<script>(function(){var d=document.documentElement,m=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)'),t;try{t=localStorage.getItem('theme')}catch(e){}d.setAttribute('data-theme',t||(m&&m.matches?'dark':'light'))})();</script>`;

function layout({ title, body, active, isIndex = false, description = '', scripts = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <title>${esc(title ? `${title}-${SITE_NAME}` : SITE_NAME)}</title>
  <meta name="description" content="${esc(description || title || SITE_NAME)}">
  <link rel="icon" href="/resources/logo.svg">
  ${THEME_SCRIPT}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css">
  <link rel="stylesheet" href="/resources/common.css?v=7">
</head>
<body>
${topbar(active, isIndex)}
${isIndex ? hero() : ''}
${body}
${bottomNav(active)}
<script src="/resources/common.js?v=5"></script>
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
  return `<ul class="chips tag-pills">${tags
    .map((t) => `<li><a href="${hotUrl(type, t)}"${t === current ? ' class="active" aria-current="page"' : ''}>${esc(t)}</a></li>`)
    .join('')}</ul>`;
}

// 分节标题：小号英文标签 + 中文标题，右侧放「更多」
function sectionHead(label, title, moreHref, moreText = '更多') {
  return `
<div class="section-head">
  <div><div class="eyebrow">${label}</div><h2 class="section-h">${title}</h2></div>
  ${moreHref ? `<a class="more-link" href="${moreHref}">${moreText}<span aria-hidden="true">›</span></a>` : ''}
</div>`;
}

function rankList(title, items, moreHref) {
  return `
<aside class="card article-list">
  <div class="card-head"><h2 class="card-title">${esc(title)}</h2>${moreHref ? `<a class="more-link" href="${moreHref}">全部榜单<span aria-hidden="true">›</span></a>` : ''}</div>
  <ol>${items
    .map((m, i) => `<li><a href="/play/${m.id}"><span class="rank-no${i < 3 ? ' top' : ''}">${i + 1}</span><span class="rank-title">${esc(m.title)}</span>${m.rate ? `<span class="rank-rate">${esc(m.rate)}</span>` : ''}</a></li>`)
    .join('')}</ol>
</aside>`;
}

// AI 选片：浏览器用访客自己的 API Key 直接调用 Claude，逻辑在 public/ai.js
const AI_EXAMPLES = ['下雨的周末，想看治愈系日本电影', '烧脑反转的悬疑片，像《消失的爱人》那种', '适合全家一起看的动画',
  '九十年代的港片经典', '节奏快、一晚上能追完一季的美剧'];

function aiPanel() {
  return `
<section class="card ai-panel" id="ai-panel" aria-labelledby="ai-title">
  <div class="card-head ai-head">
    <div>
      <div class="eyebrow">AI PICKS</div>
      <h2 class="section-h" id="ai-title">说说你想看什么</h2>
      <p class="card-desc">用一句话描述心情、场合或口味，Claude Opus 5.5 帮你挑片。</p>
    </div>
    <button type="button" class="pill-btn pill-btn-sm ai-key-btn" aria-haspopup="dialog">${icon('key', 15)}<span class="ai-key-label">API Key</span><span class="ai-key-dot" aria-hidden="true"></span></button>
  </div>
  <form class="ai-form" onsubmit="return false">
    <textarea class="ai-input" name="prompt" rows="2" maxlength="500" placeholder="比如：下班后想放空，来点轻松好笑、不费脑子的电影" aria-label="描述你想看的影片"></textarea>
    <button type="submit" class="pill-btn pill-btn-primary ai-submit">${icon('sparkles', 16)}<span>推荐</span></button>
  </form>
  <ul class="ai-examples">${AI_EXAMPLES.map((t) => `<li><button type="button">${esc(t)}</button></li>`).join('')}</ul>
  <p class="ai-status" role="status" aria-live="polite" hidden></p>
  <div class="ai-results" hidden></div>
</section>
<dialog class="ai-dialog" aria-labelledby="ai-dialog-title">
  <form method="dialog" class="ai-dialog-body">
    <div class="ai-dialog-icon">${icon('key', 22)}</div>
    <h2 class="ai-dialog-title" id="ai-dialog-title">设置 Claude API Key</h2>
    <p class="ai-dialog-desc">AI 选片从你的浏览器直接调用 Anthropic API，费用计入你自己的账号。Key 只保存在当前浏览器，不会发送到本站服务器。</p>
    <input class="ai-key-input" type="password" name="key" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" aria-label="Claude API Key">
    <p class="ai-dialog-hint"><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">在 Anthropic Console 创建 Key</a><span class="ai-dialog-error" role="alert"></span></p>
    <div class="ai-dialog-actions">
      <button type="button" class="pill-btn pill-btn-danger ai-key-clear">清除</button>
      <span class="topbar-spacer"></span>
      <button type="button" class="pill-btn ai-key-cancel">取消</button>
      <button type="submit" class="pill-btn pill-btn-primary" value="save">保存</button>
    </div>
  </form>
</dialog>`;
}

function homePage({ movies, tvs, weekly }) {
  const body = `
<div class="container main">
  ${aiPanel()}
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <section class="v-list">
        ${sectionHead('MOVIES', '最近热门电影', hotUrl('movie', '热门'))}
        ${grid(movies)}
      </section>
      <section class="v-list">
        ${sectionHead('SERIES', '最近热门剧集', hotUrl('tv', '热门'))}
        ${grid(tvs)}
      </section>
    </div>
    <div class="col-xs-12 col-md-4">
      ${weekly ? rankList('一周口碑榜', weekly.items, '/billboard.html') : ''}
    </div>
  </div>
</div>`;
  return layout({
    title: '', body, active: 'home', isIndex: true, description: `${SITE_NAME}：AI 选片、热门电影、热门剧集、口碑榜单`,
    scripts: '<script type="module" src="/resources/ai.js?v=1"></script>',
  });
}

function hotPage({ type, tag, tags, page, items, hasNext }) {
  const kind = type === 'movie' ? '电影' : '剧集';
  const pager =
    page > 1 || hasNext
      ? `
<div class="page-more">
  ${page > 1 ? `<a class="pill-btn" href="${hotUrl(type, tag, page - 1)}">上一页</a>` : ''}
  <span class="page-no">第 ${page} 页</span>
  ${hasNext ? `<a class="pill-btn" href="${hotUrl(type, tag, page + 1)}">下一页</a>` : ''}
</div>`
      : '';
  const body = `
<div class="container main">
  <div class="page-head">
    <div class="eyebrow">${type === 'movie' ? 'MOVIES' : 'SERIES'}</div>
    <h1 class="page-title">${esc(tag)}${kind}</h1>
  </div>
  ${tagPills(type, tags, tag)}
  <div class="v-list v-list-wide">${grid(items)}</div>
  ${pager}
</div>`;
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
        <span class="board-rank tabular${m.rank <= 3 ? ' top' : ''}">${m.rank}</span>
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
  <section class="card billboard" id="board-${esc(b.id)}" role="tabpanel" aria-labelledby="tab-${esc(b.id)}"${i === 0 ? '' : ' hidden'}>
    <div class="card-head">
      <div><h2 class="card-title">${esc(b.name)}</h2>${b.description ? `<p class="card-desc">${esc(b.description)}</p>` : ''}</div>
      ${b.updatedAt ? `<span class="card-note">${esc(b.updatedAt)} 更新</span>` : ''}
    </div>
    ${boardItems(b)}
  </section>`
    )
    .join('');
  const body = `
<div class="container main">
  <div class="page-head">
    <div class="eyebrow">CHARTS</div>
    <h1 class="page-title">影视排行榜</h1>
  </div>
  <ul class="seg board-tabs" role="tablist">${tabs}</ul>
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
  ${page > 1 ? `<a class="pill-btn" href="${esc(searchUrl(q, page - 1))}">上一页</a>` : ''}
  <span class="page-no">第 ${page}${total ? ` / ${pages}` : ''} 页</span>
  ${hasNext ? `<a class="pill-btn" href="${esc(searchUrl(q, page + 1))}">下一页</a>` : ''}
</div>`
      : '';
  const heading = q
    ? `「${esc(q)}」的搜索结果${total ? ` <small class="text-muted">共 ${total} 条</small>` : ''}`
    : '搜索';
  const body = `
<div class="container main">
  <div class="page-head">
    <div class="eyebrow">SEARCH</div>
    <h5 class="page-title">${heading}</h5>
  </div>
  <div class="card search-list">${list}</div>
  ${pager}
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
         <li class="line-res trailer-list">${trailers
           .map(
             (t, i) =>
               `<div data-src="/video?u=${esc(encodeURIComponent(t.url))}" data-poster="${esc(img(t.cover))}"${i === 0 ? ' class="active"' : ''}>${esc(t.title)}${t.runtime ? ` <small>${esc(t.runtime)}</small>` : ''}</div>`
           )
           .join('')}</li>
       </ul></li></ul>`
    : '<p class="text-muted">暂无预告片。</p>';

  const vendorBox = d.vendors.length
    ? `<section class="card play-card vendor-box">
        <div class="card-head"><h2 class="card-title section-title">正版播放平台</h2></div>
        <ul class="vendor-list">${d.vendors
          .map(
            (v) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">
              ${v.icon ? `<img src="${esc(img(v.icon))}" alt="">` : ''}<span>${esc(v.title)}</span>
              <small class="${v.paid ? 'paid' : 'free'}">${esc(v.payment)}</small>
              ${v.episodes ? `<small class="text-muted">${esc(v.episodes)}</small>` : ''}
            </a></li>`
          )
          .join('')}</ul>
      </section>`
    : `<p class="text-muted vendor-empty">暂未查到正版播放平台，可前往 <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">豆瓣页面</a> 查看。</p>`;

  const body = `
<div class="container main play-main">
  <div class="embed-responsive embed-responsive-16by9 player-wrap">${player}</div>
  <p id="player-status" class="text-muted" role="status" aria-live="polite"></p>
  <div class="row">
    <div class="col-xs-12 col-md-8">
      <div class="play-head">
        <h1 id="video_title">${esc(d.title)}</h1>
        ${mobileMeta.length ? `<p class="play-meta">${mobileMeta.join('<span class="dot">·</span>')}</p>` : ''}
      </div>
      <section class="card play-card">
        <div class="card-head source-heading">
          <h2 class="card-title section-title">播放线路</h2>
          <button id="retry-sources" type="button" class="pill-btn pill-btn-sm">${icon('refresh', 14)}重新检测</button>
        </div>
        <p id="source-status" class="text-muted" role="status" aria-live="polite">正在匹配影片并加载线路…</p>
        <div id="source-lines"></div>
      </section>
      <section class="card play-card">
        <div class="card-head">
          <div><h2 class="card-title section-title">预告片 <span class="line-count">${trailers.length}</span></h2><p class="card-desc line-tips">来自豆瓣官方</p></div>
        </div>
        ${trailerBox}
      </section>
      ${vendorBox}
      ${d.intro ? `<section class="card play-card intro"><div class="card-head"><h2 class="card-title section-title">剧情简介</h2></div><p>${esc(d.intro)}</p></section>` : ''}
    </div>
    <div class="col-xs-12 col-md-4">
      <aside class="card info-panel">
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
        <table class="info-table">
          ${d.rating ? `<tr><th>豆瓣评分</th><td><span class="score">${esc(d.rating)}</span> <small class="text-muted">${esc(d.ratingCount)}人评价</small></td></tr>` : ''}
          ${d.genres.length ? `<tr><th>类型</th><td>${esc(d.genres.join(' / '))}</td></tr>` : ''}
          ${d.episodes ? `<tr><th>集数</th><td>${esc(d.episodes)}</td></tr>` : ''}
          ${d.durations.length ? `<tr><th>片长</th><td>${esc(d.durations.join(' / '))}</td></tr>` : ''}
          ${d.pubdate.length ? `<tr><th>上映</th><td>${esc(d.pubdate.join(' / '))}</td></tr>` : ''}
          <tr><th>豆瓣</th><td><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">查看豆瓣页面</a></td></tr>
        </table>
      </aside>
    </div>
  </div>
</div>`;
  const record = { id: d.id, title: d.title, cover: img(d.cover), year: d.year };
  return layout({
    title: `${d.title}-在线播放`,
    description: d.intro.slice(0, 120),
    body,
    scripts: `<script src="/resources/vendor/hls.min.js"></script><script src="/resources/player.js?v=5"></script><script>initPlay(${JSON.stringify(record).replace(/</g, '\\u003c')});</script>`,
  });
}

function historyPage() {
  const body = `
<div class="container main">
  <div class="page-head page-head-row">
    <div><div class="eyebrow">HISTORY</div><h1 class="page-title">播放历史</h1></div>
    <button type="button" id="clear-history" class="pill-btn pill-btn-sm pill-btn-danger">清空</button>
  </div>
  <div class="v-list v-list-wide"><div id="history-list"></div></div>
</div>`;
  return layout({ title: '播放历史', body, active: 'history', scripts: '<script>renderHistory();</script>' });
}

function errorPage(status, message) {
  const body = `
<div class="container main">
  <div class="card empty-state">
    <div class="empty-code tabular">${status}</div>
    <h1 class="page-title">${status === 404 ? '页面不存在' : '出错了'}</h1>
    <p class="text-muted">${esc(message)}</p>
    <a class="pill-btn pill-btn-primary" href="/">返回首页</a>
  </div>
</div>`;
  return layout({ title: status === 404 ? '页面不存在' : '出错了', body });
}

module.exports = { homePage, hotPage, billboardPage, searchPage, playPage, historyPage, errorPage, hotUrl };
