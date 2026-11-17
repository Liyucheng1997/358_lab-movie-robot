// 访问豆瓣（接口和图片/视频）的出口
// 服务器 IP 被豆瓣封了：设置 DOUBAN_PROXY（如本机 Cloudflare WARP 代理模式 http://127.0.0.1:40000）后，
// 只有豆瓣的请求走这个代理换出口 IP，其他请求（电视直播、弹幕等）仍然直连
const https = require('node:https');

const PROXY = process.env.DOUBAN_PROXY || '';
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  ...(PROXY ? { proxyEnv: { HTTPS_PROXY: PROXY } } : {}),
});

// 返回 Node 的响应流；timeoutMs 只管到收到响应头为止，之后由 idleMs 限制数据长时间不动
function request(url, { headers = {}, timeoutMs = 10000, idleMs = 30000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers }, (res) => {
      clearTimeout(timer);
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        resolve(request(new URL(loc, url), { headers, timeoutMs, idleMs, redirects: redirects - 1 }));
        return;
      }
      res.setTimeout(idleMs, () => res.destroy(new Error('上游数据超时')));
      resolve(res);
    });
    const timer = setTimeout(() => {
      const err = new Error(`连接上游超时: ${new URL(url).hostname}`);
      err.code = 'UPSTREAM_TIMEOUT';
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function readJSON(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = { request, readJSON, PROXY };
