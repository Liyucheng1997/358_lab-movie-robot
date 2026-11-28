// 登录：整站只给有账号的人用
// 账号存在 DATA_DIR/users.json（密码只存 scrypt 哈希），用 scripts/user.js 增删改；
// 登录后发一个 HMAC 签名的 Cookie，服务端不用存会话。改密码或删账号后旧 Cookie 立即失效。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = process.env.AUTH_USERS_FILE || path.join(DATA_DIR, 'users.json');
const ADMINS_FILE = process.env.AUTH_ADMINS_FILE || path.join(DATA_DIR, 'admins.json');
const SECRET_FILE = path.join(DATA_DIR, 'auth-secret');
const NAME_RE = /^[\w.@-]{2,40}$/;
const COOKIE = 'pk_session';
const SESSION_DAYS = 180;
const KEYLEN = 32;

// 本地开发可以用 AUTH=off 关掉登录；服务器上默认开启，没有账号时谁都进不去
const enabled = () => process.env.AUTH !== 'off';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(password), salt, KEYLEN);
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

// 账号文件改了（加人、改密码）不用重启：按修改时间重新读
let usersCache = { mtime: -1, users: {} };
function loadUsers(file = USERS_FILE) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== usersCache.mtime) usersCache = { mtime: st.mtimeMs, users: JSON.parse(fs.readFileSync(file, 'utf8')) || {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取账号文件失败:', e.message);
    usersCache = { mtime: -1, users: {} };
  }
  return usersCache.users;
}

function saveUsers(users, file = USERS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 管理员（能在 /admin 发邀请码、删账号）：DATA_DIR/admins.json 里的用户名数组，用 scripts/user.js admin 设置
function loadAdmins(file = ADMINS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

function saveAdmins(list, file = ADMINS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...new Set(list)], null, 2) + '\n', { mode: 0o600 });
}

const isAdmin = (name) => !!name && loadAdmins().includes(name);

// 凭邀请码注册。成功返回 { token }，失败返回 { error }
function register(name, password, code, invites = require('./invites')) {
  const n = String(name || '').trim();
  const why = invites.check(code);
  if (why) return { error: why };
  if (!NAME_RE.test(n)) return { error: '账号只能用字母、数字和 _ . @ -，2 到 40 位' };
  if (String(password || '').length < 8) return { error: '密码至少 8 位' };
  const users = { ...loadUsers() };
  const taken = Object.keys(users).some((u) => u.toLowerCase() === n.toLowerCase());
  if (taken) return { error: '这个账号名已经有人用了，换一个' };
  let invite;
  try {
    invite = invites.redeem(code, n);
  } catch (e) {
    return { error: e.message };
  }
  users[n] = hashPassword(password);
  saveUsers(users);
  if (invite.admin) saveAdmins([...loadAdmins(), n]);
  return { token: makeToken(n, users) };
}

let secret;
function getSecret() {
  if (secret) return secret;
  if (process.env.AUTH_SECRET) return (secret = process.env.AUTH_SECRET);
  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  }
  return secret;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();
// 签名里带上密码哈希的一部分：改密码后旧登录全部作废
const sign = (payload, pwHash) => crypto.createHmac('sha256', getSecret()).update(payload + '|' + pwHash).digest('base64url');

function makeToken(name, users = loadUsers(), now = Date.now()) {
  const payload = `${b64(name)}.${now + SESSION_DAYS * 86400000}`;
  return `${payload}.${sign(payload, users[name])}`;
}

function checkToken(token, users = loadUsers(), now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [nameB64, exp, sig] = parts;
  let name;
  try {
    name = unb64(nameB64);
  } catch {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(users, name) || !(Number(exp) > now)) return null;
  const want = Buffer.from(sign(`${nameB64}.${exp}`, users[name]));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? name : null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 当前请求的登录用户，没登录返回 null
function currentUser(req) {
  return checkToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}

function sessionCookie(req, token) {
  const secure = isHttps(req) ? '; Secure' : '';
  if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

function login(name, password) {
  const users = loadUsers();
  const n = String(name || '').trim();
  const ok = Object.prototype.hasOwnProperty.call(users, n) && verifyPassword(password, users[n]);
  if (!ok) {
    verifyPassword(password, hashPassword('x')); // 用户名不存在也算一次哈希，响应时间不暴露账号是否存在
    return null;
  }
  return makeToken(n, users);
}

// 登录后跳回原页面：只允许站内路径
function safeNext(next) {
  const s = String(next || '');
  return /^\/(?![\/\\])/.test(s) ? s : '/';
}

// 不用登录就能访问的地址：登录页和注册页、它用到的样式和图标、robots.txt
const PUBLIC_PATHS = new Set(['/login', '/register', '/logout', '/robots.txt', '/favicon.ico', '/resources/common.css', '/resources/logo.svg']);
const isPublicPath = (pathname) => PUBLIC_PATHS.has(pathname);

module.exports = {
  COOKIE, USERS_FILE, enabled, hashPassword, verifyPassword, loadUsers, saveUsers,
  makeToken, checkToken, parseCookies, currentUser, sessionCookie, login, safeNext, isPublicPath,
  NAME_RE, loadAdmins, saveAdmins, isAdmin, register,
};
