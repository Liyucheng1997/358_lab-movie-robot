// 手动更新电视直播源：npm run tv:update [-- --out 目录 --limit 数量 --concurrency 并发]
// 默认写到 DATA_DIR/tv（和服务端定时更新同一个目录）；静态版构建前写到 snapshots/tv
const path = require('path');
const tv = require('../src/tv');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg('out', path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'tv')));
tv.update({
  dir,
  limit: Number(arg('limit', 0)) || 0,
  concurrency: Number(arg('concurrency', 64)) || 64,
}).then((index) => {
  console.log(`写入 ${dir}：${index.countries.length} 个地区`);
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
