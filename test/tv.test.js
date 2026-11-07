const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const tv = require('../src/tv');

test('整理频道：排除屏蔽名单、成人、停播和需要特殊请求头的地址，地址去重并挑台标', () => {
  const channels = [
    { id: 'CCTV1.cn', name: 'CCTV-1', alt_names: ['中央一台'], country: 'CN', categories: ['general'], is_nsfw: false, closed: null },
    { id: 'Adult.us', name: 'Adult', country: 'US', categories: ['xxx'], is_nsfw: true, closed: null },
    { id: 'Gone.fr', name: 'Gone', country: 'FR', categories: ['news'], is_nsfw: false, closed: '2020-01-01' },
    { id: 'Takedown.uk', name: 'Takedown', country: 'UK', categories: ['movies'], is_nsfw: false, closed: null },
  ];
  const streams = [
    { channel: 'CCTV1.cn', url: 'https://a.example/cctv1.m3u8', quality: '1080p' },
    { channel: 'CCTV1.cn', url: 'https://a.example/cctv1.m3u8' }, // 重复
    { channel: 'CCTV1.cn', url: 'https://b.example/cctv1.m3u8', referrer: 'https://x.example/' }, // 要 Referer
    { channel: 'Adult.us', url: 'https://c.example/a.m3u8' },
    { channel: 'Gone.fr', url: 'https://c.example/g.m3u8' },
    { channel: 'Takedown.uk', url: 'https://c.example/t.m3u8' },
    { channel: null, title: '福州新闻综合', url: 'https://d.example/fz.m3u8' },
    { channel: null, title: 'テレ東', url: 'https://d.example/nhk.m3u8' },
    { channel: 'CCTV1.cn', url: 'rtmp://e.example/live' }, // 不是 http(s)
  ];
  const logos = [
    { channel: 'CCTV1.cn', feed: 'HD', in_use: true, url: 'https://logo/feed.png' },
    { channel: 'CCTV1.cn', feed: null, in_use: true, url: 'https://logo/main.png' },
  ];
  const blocklist = [{ channel: 'Takedown.uk', reason: 'dmca' }];
  const list = tv.collect({ channels, streams, logos, blocklist });
  const ids = list.map((c) => c.id).sort();
  assert.deepEqual(ids, ['CCTV1.cn', 't:テレ東', 't:福州新闻综合']);
  const cctv = list.find((c) => c.id === 'CCTV1.cn');
  assert.equal(cctv.streams.length, 1);
  assert.equal(cctv.logo, 'https://logo/main.png');
  assert.deepEqual(cctv.alt, ['中央一台']);
  assert.equal(list.find((c) => c.id === 't:福州新闻综合').country, 'CN');
  assert.equal(list.find((c) => c.id === 't:テレ東').country, 'JP');
});

test('解析 M3U 并合并：tvg-id 对上 iptv-org 的归到同一频道', () => {
  const items = tv.parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="CCTV1.cn" tvg-logo="https://l/1.png" group-title="央视",CCTV-1 综合',
    'https://x.example/1.m3u8',
    '#EXTINF:-1 group-title="地方",某某新闻',
    'http://x.example/2.m3u8',
    '#EXTINF:-1,坏的',
    'rtmp://x.example/3',
  ].join('\n'));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { tvgId: 'CCTV1.cn', logo: 'https://l/1.png', group: '央视', name: 'CCTV-1 综合', url: 'https://x.example/1.m3u8' });
  const list = tv.collect({
    channels: [{ id: 'CCTV1.cn', name: 'CCTV-1', country: 'CN', categories: ['general'] }],
    streams: [{ channel: 'CCTV1.cn', url: 'https://a.example/1.m3u8' }],
    extra: items,
  });
  assert.equal(list.find((c) => c.id === 'CCTV1.cn').streams.length, 2);
  assert.equal(list.find((c) => c.id === 'x:某某新闻').country, 'CN');
});

test('导出 TXT（分组,#genre#）和 M3U，网页数据只含浏览器能播的地址并按速度排序', () => {
  const countries = { CN: { code: 'CN', name: 'China', flag: '🇨🇳' }, US: { code: 'US', name: 'United States', flag: '🇺🇸' } };
  const list = [
    { id: 'CCTV1.cn', name: 'CCTV-1', alt: [], country: 'CN', categories: ['general'], logo: 'https://l/1.png', streams: [
      { url: 'http://a/1.m3u8', ok: true, web: false, ms: 100, height: 1080 },
      { url: 'https://b/1.m3u8', ok: true, web: true, ms: 900, height: 720 },
      { url: 'https://c/1.m3u8', ok: true, web: true, ms: 300, height: 0, quality: '480p' },
    ] },
    { id: 'ABC.us', name: 'ABC, News', alt: [], country: 'US', categories: ['news'], logo: '', streams: [
      { url: 'http://d/1.m3u8', ok: true, web: false, ms: 200, height: 0 },
    ] },
  ];
  const txt = tv.toTXT(list, countries);
  assert.match(txt, /^🇨🇳 中国,#genre#\nCCTV-1,http:\/\/a\/1\.m3u8\n/);
  assert.ok(txt.includes('ABC  News,http://d/1.m3u8'), '频道名里的逗号会破坏 TXT 格式');
  const m3u = tv.toM3U(list, countries);
  assert.ok(m3u.startsWith('#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1.cn" tvg-logo="https://l/1.png" group-title="🇨🇳 中国",CCTV-1 (1080p)\nhttp://a/1.m3u8\n'));
  const { index, files } = tv.buildWeb(list, countries, { updatedAt: '2026-11-07T00:00:00Z', checked: 4 });
  assert.deepEqual(Object.keys(files), ['CN']);
  assert.deepEqual(files.CN[0].s.map((s) => s.u), ['https://c/1.m3u8', 'https://b/1.m3u8']);
  assert.equal(files.CN[0].s[0].q, '480p');
  assert.deepEqual(index.stats, { channels: 2, streams: 4, web: 1, checked: 4 });
  assert.equal(index.countries[0].name, '中国');
});

test('检测直播地址：主播放列表 → 子播放列表 → 第一个分片；失效的报错', async () => {
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/master.m3u8') {
      res.writeHead(200, cors);
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080\nhigh/index.m3u8\n');
    }
    if (req.url === '/low/index.m3u8') { res.writeHead(200, cors); return res.end('#EXTM3U\n#EXTINF:6,\nseg1.ts\n'); }
    if (req.url === '/low/seg1.ts') { res.writeHead(206, cors); return res.end(Buffer.alloc(4096)); }
    if (req.url === '/broken.m3u8') { res.writeHead(200, cors); return res.end('#EXTM3U\n#EXTINF:6,\nmissing.ts\n'); }
    if (req.url === '/html.m3u8') { res.writeHead(200); return res.end('<html>not found</html>'); }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await tv.checkStream(root + '/master.m3u8', { timeout: 3000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.height, 1080);
    assert.equal(ok.web, false, 'http 地址在 https 网页里会被浏览器拦截');
    assert.equal((await tv.checkStream(root + '/broken.m3u8', { timeout: 3000 })).ok, false);
    assert.equal((await tv.checkStream(root + '/html.m3u8', { timeout: 3000 })).reason, '不是播放列表');
    assert.equal((await tv.checkStream(root + '/nope.m3u8', { timeout: 3000 })).reason, '返回 404');
  } finally {
    server.close();
  }
});
