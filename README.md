# 看片机器人（仿 ikanbot 布局）

零依赖的 Node.js 影视聚合站，页面结构、URL 规则与 ikanbot 一致，数据实时取自豆瓣公开接口。

[在线访问 GitHub Pages](https://Liyucheng1997.github.io/358_lab-movie-robot/) · [v1.0.0 版本](https://github.com/Liyucheng1997/358_lab-movie-robot/releases/tag/v1.0.0)

## GitHub Pages 静态版

Pages 只托管静态文件，因此线上版本读取构建快照；本地 Node.js 版本仍实时查询接口。静态版包含每个电影/剧集分类的前 12 部影片、口碑榜、豆瓣电影 Top250 前 50 部、影片详情、M3U8 线路与选集、收录影片搜索和本地播放历史。页面顶部显示快照日期。数据和播放链接可能随上游变更而失效，「重新检测」按钮只重读快照并重新检测线路，不会实时向上游查询线路列表。

更新数据并部署：

```bash
npm run snapshot       # 本地联网抓取影片资料和线路，写入 snapshots/site.json
npm run snapshot:images # 下载豆瓣海报、预告封面和平台图标，避免防盗链
npm run build:pages    # 从快照生成 dist/，不依赖外部接口
npm run preview:pages  # http://localhost:4173/358_lab-movie-robot/ 验证静态版
git add snapshots/
git commit -m "Refresh movie snapshot"
git push               # main 分支推送触发 Pages 自动部署
```

使用已提交快照进行 CI 构建，避免 GitHub runner 无法访问数据源导致站点空白。也可以在 Actions 中手动运行 `Deploy GitHub Pages`。`PAGES_BASE_PATH` 指定项目路径，默认 `358_lab-movie-robot`；更改仓库名时 workflow 自动使用新名称。

静态版的豆瓣图片在构建前使用豆瓣 Referer 下载至 `snapshots/images/`，随 Pages 同站部署；首页、详情、搜索及播放历史使用这些图片快照，避免跨站防盗链。视频直接向源站请求，能否播放仍取决于源站可用性、CORS 和浏览器编码支持。动态版使用服务端豆瓣图片/预告代理。

## 服务器实时版

[movie.liyucheng.me](https://movie.liyucheng.me) 运行 Node.js 实时版，不使用快照，搜索和线路直接查询上游。

- 服务器目录 `/opt/apps/movie`，systemd 服务 `app-movie`，监听 `127.0.0.1:4358`，由 nginx 反向代理并提供 HTTPS。
- 推送 `main` 且改动 `server.js`、`src/`、`public/` 或 `package.json` 时，`Deploy Server` workflow 先运行测试，再通过受限 SSH 钥匙调用服务器上的 `/usr/local/bin/deploy-movie`（拉取代码、重启服务、健康检查）。也可在 Actions 中手动运行。
- 所需 secrets：`MOVIE_DEPLOY_SSH_KEY`、`MOVIE_DEPLOY_KNOWN_HOSTS`。

## 运行

```bash
npm start            # 或 node server.js，默认 http://localhost:3000
npm run dev          # 修改代码后自动重启
```

环境变量：`PORT`（端口）、`HOST`（监听地址，默认所有网卡）、`SITE_NAME`（站点名称，默认「看片机器人」）。需要 Node 18+。

## 页面

| URL | 说明 |
| --- | --- |
| `/` | 首页：搜索框 + 热门电影 / 热门剧集 + 一周口碑榜 |
| `/hot/index-movie-{标签}.html`、`-p-{页}.html` | 电影分类（热门、最新、经典、豆瓣高分…豆瓣top250），每页 24 部 |
| `/hot/index-tv-{标签}.html` | 剧集分类（热门、美剧、英剧、韩剧、日剧、国产剧…） |
| `/billboard.html` | 榜单：五大口碑榜 + 豆瓣电影 Top250，标签切换，`#榜单ID` 直达（如 `#movie_top250`） |
| `/search?q=&page=` | 搜索（豆瓣移动版搜索接口，每页 20 条，支持片名和演职人员） |
| `/play/{豆瓣ID}` | 详情页：第三方 M3U8 多线路播放、选集、豆瓣官方预告、正版平台、影片信息 |
| `/api/sources/{豆瓣ID}` | 按片名和年份匹配 ikanbot 条目，返回全部有效线路和选集 |
| `/history.html` | 播放历史（存在浏览器 localStorage） |

## 结构

- `server.js`：路由、静态文件、豆瓣图片/视频代理（仅允许 `*.doubanio.com`，支持 Range 拖动进度）
- `src/douban.js`：豆瓣接口封装，带内存缓存（列表 30 分钟、榜单 1 小时）
- `src/views.js`：服务端渲染模板（Bootstrap 3）
- `public/`：样式、脚本（懒加载、播放历史、预告片切换）、logo

## 与原站的区别

已接入 `https://www1.ikanbot.com` 的动态播放线路：服务端搜索同名、同年份条目，读取播放页参数，再请求其 `/api/getResN` 接口。站点 ID 与豆瓣 ID 不同，不能直接互换。影片匹配不唯一时不自动选取，避免播放错误版本。

返回的每组有效 HTTPS M3U8 线路和选集都会展示；线路标识来自接口的 `flag`（例如 `xlm3u8`、`gsm3u8`、`lzm3u8`），页面按采集站的常见命名显示为中文名（如「新浪资源」「光速资源」「量子资源」），这些名称并非已核实的运营商；未收录的代号显示为「XXX线路」。线路随影片与上游更新而变化，不是固定清单。使用 `JSON.parse` 解析，不执行第三方返回的代码。

详情页加载线路后，浏览器会并发（6 路）请求每条线路第一集的播放列表和第一个视频分片（只读取响应头，不下载整段视频），10 秒内成功即标记为可播放并显示响应时间和分辨率（主播放列表提供时）。检测在用户自己的浏览器里进行，跨域、防盗链和网络环境与实际播放一致；可播放线路按速度排在前面，用户还没开始播放时自动选中最快的一条。检测只是一次采样，网络波动时可能误判，失效的线路仍可手动点选。

播放源异步加载，不阻塞影片详情和预告片；结果缓存 5 分钟。同一影片并发查询合并。接口失败时可重新加载，播放器失败时可切换线路或预告片。

播放器使用浏览器原生 HLS 或本地托管的 [hls.js](https://github.com/video-dev/hls.js) 1.6.13，库文件与许可证保存在 `public/vendor/`。媒体由浏览器直接请求，播放依赖源站可用性、CORS、编码支持及当前网络。未建立开放媒体代理；上游页面格式、接口或域名变化时需要更新适配器。

`src/sources.js` 是第三方源适配器，`public/player.js` 负责切换与错误提示。运行 `npm test` 验证匹配、线路解析和参数生成逻辑。
