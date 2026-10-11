# 看片机器人（仿 ikanbot 布局）

零依赖的 Node.js 影视聚合站，页面结构、URL 规则与 ikanbot 一致，数据实时取自豆瓣公开接口。

[在线访问 GitHub Pages](https://Liyucheng1997.github.io/movie-robot/) · [v1.0.0 版本](https://github.com/Liyucheng1997/movie-robot/releases/tag/v1.0.0)

## GitHub Pages 静态版

Pages 只托管静态文件，因此线上版本读取构建快照；本地 Node.js 版本仍实时查询接口。静态版包含每个电影/剧集分类的前 12 部影片、口碑榜、影片详情、M3U8 线路与选集、收录影片搜索和本地播放历史。页面顶部显示快照日期。数据和播放链接可能随上游变更而失效，重新加载按钮只重读快照，不会实时向上游查询。

更新数据并部署：

```bash
npm run snapshot       # 本地联网抓取影片资料和线路，写入 snapshots/site.json
npm run build:pages    # 从快照生成 dist/，不依赖外部接口
npm run preview:pages  # http://localhost:4173/movie-robot/ 验证静态版
git add snapshots/site.json
git commit -m "Refresh movie snapshot"
git push               # main 分支推送触发 Pages 自动部署
```

使用已提交快照进行 CI 构建，避免 GitHub runner 无法访问数据源导致站点空白。也可以在 Actions 中手动运行 `Deploy GitHub Pages`。`PAGES_BASE_PATH` 指定项目路径，默认 `movie-robot`；更改仓库名时 workflow 自动使用新名称。

静态版海报和视频直接向源站请求，图片使用无 Referer 策略。视频能否播放仍取决于源站可用性、CORS 和浏览器编码支持。动态版使用服务端豆瓣图片/预告代理。

## 运行

```bash
npm start            # 或 node server.js，默认 http://localhost:3000
npm run dev          # 修改代码后自动重启
```

环境变量：`PORT`（端口）、`SITE_NAME`（站点名称，默认「看片机器人」）。需要 Node 18+。

## 页面

| URL | 说明 |
| --- | --- |
| `/` | 首页：搜索框 + 热门电影 / 热门剧集 + 一周口碑榜 |
| `/hot/index-movie-{标签}.html`、`-p-{页}.html` | 电影分类（热门、最新、经典、豆瓣高分…豆瓣top250），每页 24 部 |
| `/hot/index-tv-{标签}.html` | 剧集分类（热门、美剧、英剧、韩剧、日剧、国产剧…） |
| `/billboard.html` | 豆瓣五大口碑榜 |
| `/search?q=` | 搜索 |
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

返回的每组有效 HTTPS M3U8 线路和选集都会展示；线路标识来自接口的 `flag`（例如 `xlm3u8`、`gsm3u8`、`lzm3u8`），并非已核实的运营商名称。线路随影片与上游更新而变化，不是固定清单。使用 `JSON.parse` 解析，不执行第三方返回的代码。

播放源异步加载，不阻塞影片详情和预告片；结果缓存 5 分钟。同一影片并发查询合并。接口失败时可重新加载，播放器失败时可切换线路或预告片。

播放器使用浏览器原生 HLS 或本地托管的 [hls.js](https://github.com/video-dev/hls.js) 1.6.13，库文件与许可证保存在 `public/vendor/`。媒体由浏览器直接请求，播放依赖源站可用性、CORS、编码支持及当前网络。未建立开放媒体代理；上游页面格式、接口或域名变化时需要更新适配器。

`src/sources.js` 是第三方源适配器，`public/player.js` 负责切换与错误提示。运行 `npm test` 验证匹配、线路解析和参数生成逻辑。
