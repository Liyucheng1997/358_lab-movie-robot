const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invites-'));
process.env.AUTH_SECRET = 'test-secret';
process.env.AUTH_USERS_FILE = path.join(dir, 'users.json');
process.env.INVITES_FILE = path.join(dir, 'invites.json');
process.env.AUTH_ADMINS_FILE = path.join(dir, 'admins.json');
const auth = require('../src/auth');
const invites = require('../src/invites');
const guard = require('../src/guard');

test('邀请码：格式、大小写和横线不敏感', () => {
  const code = invites.create({ note: '小明' });
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(invites.normalize(code.toLowerCase().replace('-', ' ')), code);
  assert.equal(invites.check(code), '');
  assert.equal(invites.check('AAAAA-AAAAA'), '邀请码不对');
  assert.equal(invites.check(''), '邀请码不对');
});

test('邀请码：用完、过期、作废后都不能再用', () => {
  const file = path.join(dir, 'a.json');
  const once = invites.create({ max: 1 }, file, 1000);
  invites.redeem(once, 'a', file, 2000);
  assert.equal(invites.check(once, file, 3000), '邀请码已用完');
  assert.throws(() => invites.redeem(once, 'b', file, 3000), /已用完/);

  const short = invites.create({ max: 5, days: 1 }, file, 1000);
  assert.equal(invites.check(short, file, 1000 + 86400000 - 1), '');
  assert.equal(invites.check(short, file, 1000 + 86400000), '邀请码已过期');

  const forever = invites.create({ max: 2, days: 0 }, file, 1000);
  assert.equal(invites.check(forever, file, 1000 + 4000 * 86400000), '');
  assert.ok(invites.revoke(forever, file));
  assert.equal(invites.check(forever, file, 2000), '邀请码已作废');
  assert.equal(invites.revoke('NOPE', file), false);
  assert.deepEqual(invites.list(file, 3000).find((i) => i.code === once).uses, [{ name: 'a', at: 2000 }]);
});

test('注册：要有效邀请码，建好账号后能登录，码被记为已用', () => {
  const code = invites.create({ note: '朋友', max: 1 });
  assert.equal(auth.register('newbie', 'password1', 'WRONG-CODE0').error, '邀请码不对');
  assert.match(auth.register('a b', 'password1', code).error, /账号只能用/);
  assert.equal(auth.register('newbie', 'short', code).error, '密码至少 8 位');
  assert.equal(invites.check(code), '', '失败的注册不消耗邀请码');

  const ok = auth.register('newbie', 'password1', code.toLowerCase());
  assert.equal(auth.checkToken(ok.token), 'newbie');
  assert.ok(auth.login('newbie', 'password1'));
  assert.equal(auth.register('other', 'password1', code).error, '邀请码已用完');
  assert.equal(invites.list().find((i) => i.code === code).uses[0].name, 'newbie');

  const second = invites.create({ max: 3 });
  assert.match(auth.register('Newbie', 'password2', second).error, /已经有人用了/);
  assert.equal(invites.check(second), '', '重名不消耗邀请码');
});

test('管理员邀请码：用它注册的人直接是管理员，普通码不是', () => {
  const code = invites.create({ note: '站长', admin: true });
  assert.ok(auth.register('owner', 'password1', code).token);
  assert.ok(auth.register('guest', 'password1', invites.create({})).token);
  const admins = JSON.parse(fs.readFileSync(path.join(dir, 'admins.json'), 'utf8'));
  assert.deepEqual(admins, ['owner']);
});

test('没有邀请码也没有账号的人只能看到登录页和注册页', () => {
  assert.ok(auth.isPublicPath('/register'));
  assert.ok(!auth.isPublicPath('/admin'));
});

test('按账号限流：换 IP 也躲不掉，每天能打开的影片数有上限', () => {
  const now = 10_000_000;
  let last;
  for (let i = 0; i < 61; i++) last = guard.checkUser('fast', '1.1.1.' + i, '/search', now + i);
  assert.equal(last, 'rate');
  assert.equal(guard.checkUser('fast', '1.1.1.1', '/resources/common.css', now + 100), '');

  for (let id = 1; id <= 5; id++) assert.equal(guard.checkUser('binge', '2.2.2.2', '/play/' + id, now + id * 2000, 5), '');
  assert.equal(guard.checkUser('binge', '2.2.2.2', '/play/3', now + 20000, 5), '', '重看同一部不算新的');
  assert.equal(guard.checkUser('binge', '2.2.2.2', '/api/sources/3', now + 20001, 5), '');
  assert.equal(guard.checkUser('binge', '2.2.2.3', '/play/6', now + 22000, 5), 'quota');
  assert.equal(guard.checkUser('binge', '2.2.2.3', '/api/sources/7', now + 24000, 5), 'quota');
  const u = guard.usage(now + 25000).binge;
  assert.equal(u.plays, 5);
  assert.equal(u.ips, 2);
  assert.equal(u.blocked, 2);
  assert.equal(guard.checkUser('binge', '2.2.2.2', '/play/6', now + 25 * 3600000, 5), '', '24 小时后恢复');
});
