// 邀请码：没有账号的人凭邀请码在 /register 自己注册
// 存在 DATA_DIR/invites.json；每个码可以限制使用次数和有效期，记录是谁用它注册的
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const INVITES_FILE = process.env.INVITES_FILE || path.join(DATA_DIR, 'invites.json');
const DAY = 86400000;
// 去掉容易看错的 0/O、1/I/L
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function load(file = INVITES_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取邀请码文件失败:', e.message);
    return {};
  }
}

function save(invites, file = INVITES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(invites, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 输入时不区分大小写，空格和横线可有可无
function normalize(code) {
  const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 10 ? s.slice(0, 5) + '-' + s.slice(5) : s;
}

function newCode() {
  let s = '';
  for (const b of crypto.randomBytes(10)) s += ALPHABET[b % ALPHABET.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}

// 这个码现在不能用的原因；能用返回 ''
function problem(invite, now = Date.now()) {
  if (!invite) return '邀请码不对';
  if (invite.revoked) return '邀请码已作废';
  if (invite.expiresAt && invite.expiresAt <= now) return '邀请码已过期';
  if ((invite.uses || []).length >= invite.max) return '邀请码已用完';
  return '';
}

function create({ note = '', max = 1, days = 30, by = '', admin = false } = {}, file = INVITES_FILE, now = Date.now()) {
  const invites = load(file);
  let code = newCode();
  while (invites[code]) code = newCode();
  const m = Math.min(100, Math.max(1, Math.floor(Number(max)) || 1));
  const d = Math.min(3650, Math.max(0, Math.floor(Number(days)) || 0));
  invites[code] = {
    note: String(note).trim().slice(0, 60), max: m, uses: [], createdAt: now, createdBy: by,
    expiresAt: d ? now + d * DAY : null,
  };
  if (admin) invites[code].admin = true; // 用这个码注册的人直接是管理员（只能在命令行生成，给站长自己用）
  save(invites, file);
  return code;
}

function revoke(code, file = INVITES_FILE) {
  const invites = load(file);
  const key = normalize(code);
  if (!invites[key]) return false;
  invites[key].revoked = true;
  save(invites, file);
  return true;
}

function check(code, file = INVITES_FILE, now = Date.now()) {
  return problem(load(file)[normalize(code)], now);
}

// 记一次使用，返回这个邀请码。码失效时抛错
function redeem(code, name, file = INVITES_FILE, now = Date.now()) {
  const invites = load(file);
  const key = normalize(code);
  const why = problem(invites[key], now);
  if (why) throw new Error(why);
  invites[key].uses.push({ name, at: now });
  save(invites, file);
  return invites[key];
}

function list(file = INVITES_FILE, now = Date.now()) {
  return Object.entries(load(file))
    .map(([code, v]) => ({ code, ...v, uses: v.uses || [], problem: problem(v, now) }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = { INVITES_FILE, normalize, newCode, problem, create, revoke, check, redeem, list };
