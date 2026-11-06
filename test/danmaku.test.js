const { test } = require('node:test');
const assert = require('node:assert/strict');
const dm = require('../src/danmaku');

test('从豆瓣正版平台信息里取出 B 站、腾讯、爱奇艺的节目 ID', () => {
  const ids = dm.vendorIds([
    { id: 'bilibili', url: 'https://m.bilibili.com/bangumi/play/ss44847?bsource=doubanh5', uri: '' },
    { id: 'qq', url: 'douban://x', uri: 'txvideo://v.qq.com/VideoDetailActivity?universalStyle=true&cid=mzc002008v8rka3&from=x' },
    { id: 'iqiyi', url: 'http://www.iqiyi.com/v_1.html', uri: 'iqiyi://mobile/player?aid=1856713125345801&tvid=7948360575217900&ftype=27' },
    { id: 'youku', url: 'youku://play?showid=abc' },
  ]);
  assert.deepEqual(ids, { bili: '44847', qq: 'mzc002008v8rka3', iqiyi: { aid: '1856713125345801', tvid: '7948360575217900' } });
  assert.deepEqual(dm.vendorIds([]), {});
});

test('解析 B 站 XML：模式、颜色、转义字符，跳过高级弹幕', () => {
  const xml = '<i><d p="12.5,1,25,16777215,0,0,a,1,10">前方高能 &amp; &lt;注意&gt;</d>'
    + '<d p="3,5,25,16711680,0,0,a,2,10">顶部</d><d p="4,4,25,255,0,0,a,3,10">底部</d><d p="5,7,25,0,0,0,a,4,10">[高级]</d></i>';
  assert.deepEqual(dm.parseBili(xml), [
    [12.5, 0, 'ffffff', '前方高能 & <注意>', 'bili', 0],
    [3, 1, 'ff0000', '顶部', 'bili', 0],
    [4, 2, '0000ff', '底部', 'bili', 0],
  ]);
});

test('解析爱奇艺和腾讯视频弹幕', () => {
  const xml = '<danmu><bulletInfo><content>好看</content><showTime>61</showTime><color>FF0000</color><position>8</position><likeCount>40</likeCount></bulletInfo>'
    + '<bulletInfo><content>  </content><showTime>62</showTime></bulletInfo></danmu>';
  assert.deepEqual(dm.parseIqiyi(xml), [[61, 0, 'ff0000', '好看', 'iqiyi', 40]]);
  const qq = { barrage_list: [
    { time_offset: '60500', content: '全体起立', up_count: '698', content_style: '{"color":"ffffff","position":1}' },
    { time_offset: '61000', content: '无样式', up_count: '3', content_style: '' },
  ] };
  assert.deepEqual(dm.parseQQ(qq), [[60.5, 0, 'ffffff', '全体起立', 'qq', 698], [61, 0, 'ffffff', '无样式', 'qq', 3]]);
});

test('每段只保留点赞最多的弹幕', () => {
  const list = Array.from({ length: 10 }, (_, i) => [i, 0, 'ffffff', String(i), 'qq', i % 3]);
  const kept = dm.top(list, 4);
  assert.equal(kept.length, 4);
  assert.ok(kept.every((d) => d[5] === 2 || d[5] === 1));
});

test('校验本站弹幕：长度、集数、时间、颜色，清理控制字符', () => {
  assert.deepEqual(dm.validate({ ep: 2, t: 61.27, text: ' 你好\n世界 ', color: 'FE0302', mode: 1 }),
    { ep: 2, t: 61.3, mode: 1, color: 'fe0302', text: '你好 世界' });
  assert.equal(dm.validate({ ep: 1, t: 0, text: '   ' }), '弹幕不能为空');
  assert.equal(dm.validate({ ep: 1, t: 0, text: '字'.repeat(51) }), '弹幕最多 50 个字');
  assert.equal(dm.validate({ ep: 0, t: 0, text: 'a' }), '集数不正确');
  assert.equal(dm.validate({ ep: 1, t: -1, text: 'a' }), '时间不正确');
  assert.equal(dm.validate({ ep: 1, t: 1, text: 'a', color: 'red' }), '颜色不正确');
  assert.equal(dm.validate({ ep: 1, t: 1, text: 'a', mode: 3 }), '位置不正确');
});

test('同一 IP 发送限频', () => {
  const ip = 'test-' + Math.random();
  assert.equal(dm.allowSend(ip, 1000), true);
  assert.match(dm.allowSend(ip, 2000), /歇 3 秒/);
  assert.equal(dm.allowSend(ip, 4500), true);
});
