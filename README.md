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
| `/` | 首页：搜索框 + AI 选片 + 为你推荐 + 热门电影 / 热门剧集 + 一周口碑榜 |
| `/foryou.html` | 个性化推荐流：无限下拉、「我的口味」兴趣画像、类型偏好、重置 |
| `/hot/index-movie-{标签}.html`、`-p-{页}.html` | 电影分类（热门、最新、经典、豆瓣高分…豆瓣top250），每页 24 部 |
| `/hot/index-tv-{标签}.html` | 剧集分类（热门、美剧、英剧、韩剧、日剧、国产剧…） |
| `/billboard.html` | 榜单：五大口碑榜 + 豆瓣电影 Top250，标签切换，`#榜单ID` 直达（如 `#movie_top250`） |
| `/search?q=&page=` | 搜索（豆瓣移动版搜索接口，每页 20 条，支持片名和演职人员） |
| `/play/{豆瓣ID}` | 详情页：第三方 M3U8 多线路播放、选集、豆瓣官方预告、正版平台、影片信息 |
| `/api/search?q=` | 豆瓣搜索的 JSON 版，供 AI 选片把推荐片名对应到站内条目 |
| `/api/sources/{豆瓣ID}` | 按片名和年份匹配 ikanbot 条目，返回全部有效线路和选集 |
| `/api/rec/pool` | 推荐候选池：全部分类第一页 + 全部榜单，带类型/地区/主创/年代特征，缓存 30 分钟 |
| `/api/rec/related/{豆瓣ID}` | 豆瓣「看过这部的人也喜欢」相关影片，缓存 6 小时 |
| `/api/danmaku/{豆瓣ID}?ep=&seg=` | 弹幕：第 ep 集（从 1 开始）的第 seg 个 5 分钟分段，合并哔哩哔哩、爱奇艺、腾讯视频和本站弹幕；POST 发送本站弹幕 |
| `/history.html` | 播放历史（存在浏览器 localStorage） |

## 结构

- `server.js`：路由、静态文件、豆瓣图片/视频代理（仅允许 `*.doubanio.com`，支持 Range 拖动进度）
- `src/douban.js`：豆瓣接口封装，带内存缓存（列表 30 分钟、榜单 1 小时）
- `src/views.js`：服务端渲染模板（Bootstrap 3）
- `public/`：样式、脚本（懒加载、播放历史、预告片切换）、logo

## AI 选片

首页可以用自然语言描述想看的内容（如「下雨的周末，想看治愈系日本电影」），由 Claude Opus 5.5（`claude-opus-5-5`）推荐 6 部影片并说明理由，「换一批」会排除已推荐过的片子。

- 访客点「API Key」填入自己的 Anthropic API Key（[在 Console 创建](https://console.anthropic.com/settings/keys)）。Key 只存在该浏览器的 localStorage，由浏览器直接请求 `api.anthropic.com`，不经过本站服务器，费用计入访客自己的账号。部分地区需要代理才能连上。
- 使用官方 [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) 1.3.0，以 esbuild 打包为单文件 `public/vendor/anthropic-sdk.mjs`（许可证同目录），点推荐时才按需加载。请求使用结构化输出（JSON Schema）、`effort: low` 以缩短等待，并开启服务端拒答回退（`fallbacks: "default"`）。
- 推荐结果按片名、原名和年份（容差 1 年）回查：实时版查豆瓣搜索，命中后显示海报、评分并直达播放页，未命中转站内搜索；静态版把已收录片单交给 Claude 优先挑选，只在快照里匹配，未收录的链接到豆瓣。
- 逻辑在 `public/ai.js`；更新 SDK 时重新打包：`npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof`，其中 `entry.mjs` 为 `export { default } from "@anthropic-ai/sdk";`。

## 个性化推荐

参照短视频/视频站的推荐流程，排序在浏览器里完成，行为数据只存在本机 localStorage（`rec_state_v1`），服务端不保存任何用户数据。

1. **行为信号**：打开详情页 +1（重复打开最多 +3）、开始播放 +2、实际观看时长最多 +4（只算正常播放推进的秒数，满 20 分钟记满分）、喜欢 +5、不感兴趣 −6。推荐卡片露出 60% 以上记一次曝光，曝光不点开的每次降权 18%。
2. **兴趣画像**：每部影片的行为权重按 21 天半衰期衰减，累加到它的特征上：类型 `g:`、地区 `r:`（华语/欧美/日本/韩国）、主创 `p:`（导演 + 前 3 位主演）、片种 `t:`、年代 `d:`。不感兴趣只按一半权重扣减，避免一次误点封掉整个类型。新访客可以先选几个喜欢的类型作为种子兴趣。
3. **多路召回**：① 相关召回：取近期权重最高的 4 部影片，请求豆瓣「看过这部的人也喜欢」（物品协同过滤）；② 候选池：各分类第一页和全部榜单，列表项从所在分类推断特征（如「日本动画」→ 动画 + 日本）。看过的和不感兴趣的影片不再推荐。
4. **排序**：`置信度 × (0.65 × 兴趣匹配 + 0.5 × 相关度) + 0.28 × 豆瓣评分 + 热度新鲜度 + 少量随机扰动`。置信度随行为增多从 0 升到 1，新访客主要看评分和热度。
5. **打散和探索**：MMR 重排，相邻影片尽量不同类型和地区；同一主类型最多连续 2 部，电影/剧集最多连续 3 部，同一部影片带来的相关推荐最近 6 部里最多 2 部。画像成形后每 7 部插入一部兴趣以外的高分影片（「探索新口味」）。
6. **推荐理由**：「因为你喜欢《X》」「你常看科幻」「你关注的周星驰」「豆瓣高分」「探索新口味」等。

静态版没有实时接口，候选池在构建时由快照生成（`rec/pool.json`，特征取自完整详情），相关召回改用类型、地区、主创的内容相似度。

算法在 `public/rec-core.js`（纯函数，Node 测试和浏览器共用），行为采集和界面在 `public/rec.js`，候选池构建在 `src/recommend.js`，测试在 `test/recommend.test.js`。

## 弹幕

详情页播放器上方显示弹幕，下方是发送框和设置（开关、不透明度、字号、速度、显示区域、来源筛选、时间校准、发送颜色和位置）。弹幕跟随视频时间，暂停、缓冲时一起停住，拖动进度后从新位置开始；播放器右上角的全屏按钮让播放器连同弹幕一起全屏（iPhone 只能用系统全屏，不显示弹幕）。预告片不显示弹幕。

- **外部弹幕**：豆瓣详情的「正版播放平台」里带有各平台的节目 ID（B 站番剧 season、腾讯视频 cid、爱奇艺 aid/tvid），服务端直接按 ID 取弹幕，不靠片名模糊匹配，没有正版平台信息的影片只有本站弹幕。剧集按选集标题里的「第 N 集」对应各平台第 N 集正片（排除预告、花絮）。
  - 哔哩哔哩：`api.bilibili.com/x/v1/dm/list.so`，一次取整集（几千条）后按时间切段；跳过高级弹幕。
  - 爱奇艺：`cmts.iqiyi.com/bullet/…_300_{n}.z`，每 5 分钟一个 zlib 压缩的 XML。
  - 腾讯视频：`dm.video.qq.com/barrage/segment/{vid}/t/v1/{start}/{end}`，每 30 秒一段；选集来自 `pbaccess.video.qq.com` 的剧集列表接口。
  - 每个来源每 5 分钟最多保留 300 条，按点赞数优先；结果缓存 1 小时，选集列表缓存 6 小时。某个平台失败时其余来源照常显示。
  - 这些都是平台网页使用的非公开接口，格式或权限变化时需要更新 `src/danmaku.js`。片源版本不同可能有几秒偏差，可在设置里校准（只影响外部弹幕）。
- **本站弹幕**：最多 50 字，按影片追加写入 `data/danmaku/{豆瓣ID}.jsonl`（`DATA_DIR` 环境变量可改目录，`data/` 不进 Git），服务器上需要保证运行服务的用户对该目录有写权限。每个 IP 3 秒一条、10 分钟最多 30 条；经 nginx 代理时读取 `X-Real-IP` / `X-Forwarded-For`。弹幕只用 `textContent` 渲染。
- **静态版**：没有服务端，只显示和保存本机发送的弹幕（localStorage `danmaku_local_v1`）。

服务端在 `src/danmaku.js`，界面在 `public/danmaku.js`，`public/player.js` 选集时发出 `player:select` 事件告诉弹幕当前是第几集，测试在 `test/danmaku.test.js`。

## 与原站的区别

已接入 `https://www1.ikanbot.com` 的动态播放线路：服务端搜索同名、同年份条目，读取播放页参数，再请求其 `/api/getResN` 接口。站点 ID 与豆瓣 ID 不同，不能直接互换。影片匹配不唯一时不自动选取，避免播放错误版本。

返回的每组有效 HTTPS M3U8 线路和选集都会展示；线路标识来自接口的 `flag`（例如 `xlm3u8`、`gsm3u8`、`lzm3u8`），页面按采集站的常见命名显示为中文名（如「新浪资源」「光速资源」「量子资源」），这些名称并非已核实的运营商；未收录的代号显示为「XXX线路」。线路随影片与上游更新而变化，不是固定清单。使用 `JSON.parse` 解析，不执行第三方返回的代码。

详情页加载线路后，浏览器会并发（6 路）请求每条线路第一集的播放列表和第一个视频分片（只读取响应头，不下载整段视频），10 秒内成功即标记为可播放并显示响应时间和分辨率（主播放列表提供时）。检测在用户自己的浏览器里进行，跨域、防盗链和网络环境与实际播放一致；可播放线路按速度排在前面，用户还没开始播放时自动选中最快的一条。检测只是一次采样，网络波动时可能误判，失效的线路仍可手动点选。

播放源异步加载，不阻塞影片详情和预告片；结果缓存 5 分钟。同一影片并发查询合并。接口失败时可重新加载，播放器失败时可切换线路或预告片。

播放器使用浏览器原生 HLS 或本地托管的 [hls.js](https://github.com/video-dev/hls.js) 1.6.13，库文件与许可证保存在 `public/vendor/`。媒体由浏览器直接请求，播放依赖源站可用性、CORS、编码支持及当前网络。未建立开放媒体代理；上游页面格式、接口或域名变化时需要更新适配器。

`src/sources.js` 是第三方源适配器，`public/player.js` 负责切换与错误提示。运行 `npm test` 验证匹配、线路解析和参数生成逻辑。
