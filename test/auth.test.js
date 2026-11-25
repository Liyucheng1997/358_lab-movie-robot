const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.AUTH_SECRET = 'test-secret';
const auth = require('../src/auth');

test('密码只存哈希，能验证对错', () => {
  const h = auth.hashPassword('correct horse');
  assert.match(h, /^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.ok(!h.includes('correct horse'));
  assert.ok(auth.verifyPassword('correct horse', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('x', 'garbage'));
});

test('登录凭证：有效、过期、篡改、删号、改密码', () => {
  const users = { me: auth.hashPassword('password1') };
  const now = 1_000_000;
  const token = auth.makeToken('me', users, now);
  assert.equal(auth.checkToken(token, users, now + 1000), 'me');
  assert.equal(auth.checkToken(token, users, now + 181 * 86400000), null, '过期');
  const [n, exp, sig] = token.split('.');
  assert.equal(auth.checkToken(`${n}.${Number(exp) + 1}.${sig}`, users, now), null, '改过期时间');
  assert.equal(auth.checkToken(`${Buffer.from('other').toString('base64url')}.${exp}.${sig}`, { ...users, other: users.me }, now), null, '换用户名');
  assert.equal(auth.checkToken(token, {}, now), null, '账号已删除');
  assert.equal(auth.checkToken(token, { me: auth.hashPassword('password1') }, now), null, '改过密码');
  assert.equal(auth.checkToken('', users, now), null);
  assert.equal(auth.checkToken('a.b', users, now), null);
});

test('登录后只跳回站内地址', () => {
  assert.equal(auth.safeNext('/play/1?x=1'), '/play/1?x=1');
  assert.equal(auth.safeNext('//evil.com'), '/');
  assert.equal(auth.safeNext('/\\evil.com'), '/');
  assert.equal(auth.safeNext('https://evil.com'), '/');
  assert.equal(auth.safeNext(''), '/');
});

test('只有登录页和它用到的资源不需要登录', () => {
  assert.ok(auth.isPublicPath('/login'));
  assert.ok(auth.isPublicPath('/resources/common.css'));
  assert.ok(!auth.isPublicPath('/'));
  assert.ok(!auth.isPublicPath('/play/1'));
  assert.ok(!auth.isPublicPath('/api/sources/1'));
  assert.ok(!auth.isPublicPath('/img'));
  assert.ok(!auth.isPublicPath('/resources/player.js'));
});

test('解析 Cookie', () => {
  assert.deepEqual(auth.parseCookies('a=1; pk_session=x.y.z; theme=dark'), { a: '1', pk_session: 'x.y.z', theme: 'dark' });
  assert.deepEqual(auth.parseCookies(undefined), {});
});
