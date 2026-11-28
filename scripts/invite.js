#!/usr/bin/env node
// 管理邀请码（存在 DATA_DIR/invites.json），也可以登录管理员账号后在网页 /admin 里操作
//   node scripts/invite.js new [备注] [次数] [天数]   生成邀请码，默认用 1 次、30 天内有效（天数 0 = 不过期）
//   node scripts/invite.js new 备注 1 7 --admin       用这个码注册的人直接是管理员（给站长自己用）
//   node scripts/invite.js list                      列出邀请码和用它注册的账号
//   node scripts/invite.js revoke 邀请码              作废
const invites = require('../src/invites');

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [cmd, a, b, c] = args.filter((x) => x !== '--admin');
const day = (at) => new Date(at).toISOString().slice(0, 10);

if (cmd === 'new') {
  const code = invites.create({ note: a || '', max: b || 1, days: c === undefined ? 30 : c, by: 'cli', admin });
  console.log(code);
} else if (cmd === 'list') {
  const all = invites.list();
  if (!all.length) console.log('（还没有邀请码）');
  for (const inv of all) {
    const state = inv.problem ? inv.problem.replace('邀请码', '') : inv.expiresAt ? `${day(inv.expiresAt)} 到期` : '不过期';
    console.log(`${inv.code}  ${inv.uses.length}/${inv.max}  ${state}  ${inv.admin ? '[管理员码] ' : ''}${inv.note}  ${inv.uses.map((u) => u.name).join(',')}`);
  }
} else if (cmd === 'revoke' && a) {
  console.log(invites.revoke(a) ? '已作废' : '没有这个邀请码');
} else {
  console.log('用法: node scripts/invite.js new [备注] [次数] [天数]  |  list  |  revoke 邀请码');
  process.exitCode = 1;
}
