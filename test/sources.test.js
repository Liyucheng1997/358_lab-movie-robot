const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candidates, tokenFor, parseLines } = require('../src/sources');

test('影片匹配要求片名和年份相同，排除同名翻拍和近似片名', () => {
  const html = '<a href="/play/1" class="title-text">影片  1994</a>' +
    '<a href="/play/2" class="title-text">影片  2020</a>' +
    '<a href="/play/3" class="title-text">影片4k  1994</a>';
  assert.deepEqual(candidates(html, '影片', '1994'), ['1']);
  assert.deepEqual(candidates(html, '不存在', '1994'), []);
});

test('线路解析保留全部有效选集，拒绝脚本地址及非 JSON 响应', () => {
  const list = [
    { id: 1, resData: JSON.stringify([{ flag: 'sample', url: '第1集$https://example.com/1.m3u8?token=a#第2集$https://example.com/2.m3u8#错误$javascript:alert(1)#不安全$http://example.com/3.m3u8' }]) },
    { id: 2, resData: 'globalThis.executed = true' },
    { id: 3, resData: 'null' },
    { id: 4, resData: '[null]' },
    null,
  ];
  const lines = parseLines(list, '1234');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].episodes.length, 2);
  assert.equal(lines[0].episodes[0].title, '第1集');
  assert.equal(lines[0].episodes[0].url, 'https://example.com/1.m3u8?token=a');
  assert.equal(globalThis.executed, undefined);
});

test('页面 token 按站点公开客户端算法生成', () => {
  assert.equal(tokenFor('482774', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN'), 'defghijknopqrstuxyz01234789ABCDE');
});
