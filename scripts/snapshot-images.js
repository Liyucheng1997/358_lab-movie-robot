const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { UA } = require('../src/douban');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'snapshots/images');

function imageURLs(value, urls = new Set()) {
  if (typeof value === 'string') {
    try {
      const u = new URL(value);
      if (u.protocol === 'https:' && /(^|\.)doubanio\.com$/.test(u.hostname) && /\.(jpg|jpeg|png|webp)$/i.test(u.pathname)) urls.add(value);
    } catch { /* 普通文本 */ }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) imageURLs(child, urls);
  }
  return urls;
}

async function main() {
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'snapshots/site.json'), 'utf8'));
  await fs.mkdir(directory, { recursive: true });
  let manifest = {};
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); } catch { /* 首次下载 */ }
  const urls = [...imageURLs(snapshot)];
  let next = 0;
  const failed = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      if (manifest[url]) {
        try { await fs.access(path.join(directory, manifest[url])); continue; } catch { /* 缓存丢失 */ }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(url, {
            headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/' },
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg'
            : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
              : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
          if (!type) throw new Error('响应不是有效图片');
          const filename = createHash('sha256').update(url).digest('hex').slice(0, 24) + '.' + type;
          await fs.writeFile(path.join(directory, filename), bytes);
          manifest[url] = filename;
          break;
        } catch (e) {
          if (attempt === 1) { failed.push(url); console.error(`图片下载失败: ${url}: ${e.message}`); }
        }
      }
    }
  }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`图片快照: ${urls.length - failed.length}/${urls.length} 成功`);
  if (failed.length) throw new Error(`${failed.length} 张图片未能下载，暂不发布不完整的构建`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { imageURLs };
