#!/usr/bin/env node
// 管理网站账号（存在 DATA_DIR/users.json，密码只存哈希）
//   node scripts/user.js add 用户名      添加账号，或给已有账号改密码（交互输入密码）
//   node scripts/user.js remove 用户名   删除账号（他已登录的设备立即退出）
//   node scripts/user.js list           列出账号
//   node scripts/user.js admin 用户名    设为管理员（能打开 /admin 发邀请码、删账号）；unadmin 取消
const readline = require('readline');
const auth = require('../src/auth');

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const users = auth.loadUsers();
  if (cmd === 'list') {
    const names = Object.keys(users);
    const admins = auth.loadAdmins();
    console.log(names.length ? names.map((n) => (admins.includes(n) ? n + '  [管理员]' : n)).join('\n') : '（还没有账号）');
    return;
  }
  if (!name || !['add', 'remove', 'admin', 'unadmin'].includes(cmd)) {
    console.log('用法: node scripts/user.js add|remove|admin|unadmin 用户名  /  node scripts/user.js list');
    process.exitCode = 1;
    return;
  }
  if (!/^[\w.@-]{1,40}$/.test(name)) throw new Error('用户名只能用字母、数字和 _ . @ -，最长 40 位');
  if (cmd === 'admin' || cmd === 'unadmin') {
    if (!users[name]) throw new Error(`没有账号 ${name}`);
    const admins = auth.loadAdmins().filter((n) => n !== name);
    if (cmd === 'admin') admins.push(name);
    auth.saveAdmins(admins);
    console.log(cmd === 'admin' ? `${name} 已是管理员` : `已取消 ${name} 的管理员`);
    return;
  }
  if (cmd === 'remove') {
    if (!users[name]) throw new Error(`没有账号 ${name}`);
    delete users[name];
    auth.saveUsers(users);
    auth.saveAdmins(auth.loadAdmins().filter((n) => n !== name));
    console.log(`已删除 ${name}`);
    return;
  }
  const password = process.env.NEW_PASSWORD || (await askHidden('密码: '));
  if (!process.env.NEW_PASSWORD && (await askHidden('再输一次: ')) !== password) throw new Error('两次输入不一致');
  if (password.length < 8) throw new Error('密码至少 8 位');
  const existed = !!users[name];
  users[name] = auth.hashPassword(password);
  auth.saveUsers(users);
  console.log(existed ? `已修改 ${name} 的密码` : `已添加 ${name}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
