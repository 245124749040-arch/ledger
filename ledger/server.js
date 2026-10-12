'use strict';
/*
 * Ledger — school timetable server.
 *
 *  - Accounts: scrypt-hashed passwords, no built-in/default credentials. The first administrator is
 *    created through a one-time setup code printed in the server log.
 *  - Sessions: random id in an HttpOnly + Secure + SameSite=Strict cookie (only a hash is stored),
 *    CSRF token on every state-changing call, login throttling and lockout.
 *  - Storage: SQLite file on the server's disk — one shared copy for every teacher and device.
 *  - Privacy: each role only receives the data it needs; attendance location is verified here,
 *    and only the distance/accuracy is stored (never raw coordinates); old records are purged.
 */
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

/* ------------------------------------------------------------------ config */
const env = process.env;
function intEnv(name, def, min){ const n = parseInt(env[name], 10); return Number.isFinite(n) && n >= min ? n : def; }
const PROD = env.NODE_ENV === 'production';
const PORT = intEnv('PORT', 3000, 1);
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const SCHOOL_TZ = env.SCHOOL_TZ || 'Asia/Kolkata';
const ATTENDANCE_RETENTION_DAYS = intEnv('ATTENDANCE_RETENTION_DAYS', 730, 30);
const AUDIT_RETENTION_DAYS = intEnv('AUDIT_RETENTION_DAYS', 180, 30);
const SESSION_IDLE_MS = intEnv('SESSION_IDLE_HOURS', 12, 1) * 3600e3;
const SESSION_MAX_MS = intEnv('SESSION_MAX_DAYS', 7, 1) * 86400e3;
const COOKIE_NAME = PROD ? '__Host-ledger_sid' : 'ledger_sid';
const POLICY_VERSION = 1;               // bump when the location/privacy notice changes (re-asks teachers)

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SCHOOL_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const todayStr = (d = new Date()) => dateFmt.format(d);
const nowTime = (d = new Date()) => timeFmt.format(d);

/* ---------------------------------------------------------------- database */
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const DB_PATH = path.join(DATA_DIR, 'ledger.db');
const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch (e) { /* not fatal (e.g. Windows) */ }
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher','receptionist')),
  teacher_id TEXT,
  pw_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login INTEGER,
  location_ack_at INTEGER,
  location_ack_version INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS attendance(
  date TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  in_time TEXT, out_time TEXT,
  in_dist INTEGER, in_acc INTEGER,
  out_dist INTEGER, out_acc INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY(date, teacher_id)
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT, username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_teacher ON attendance(teacher_id);
`);

const metaGet = db.prepare('SELECT value FROM meta WHERE key=?');
const metaSet = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
let coreVersion = parseInt((metaGet.get('v') || {}).value, 10) || 1;
function bumpVersion(){ coreVersion++; metaSet.run('v', String(coreVersion)); }

/* --------------------------------------------------------------- utilities */
class HttpError extends Error {
  constructor(status, code, message){ super(message || code); this.status = status; this.code = code; }
}
const rid = (p) => p + crypto.randomBytes(6).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400e3);

function haversine(lat1, lng1, lat2, lng2){
  const R = 6371000, r = (x) => x * Math.PI / 180, dl = r(lat2 - lat1), dn = r(lng2 - lng1);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------ passwords */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (pw, salt, len, opts) => new Promise((res, rej) => crypto.scrypt(pw, salt, len, opts, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw.normalize('NFKC'), salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(pw, stored){
  try {
    const [alg, N, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = await scryptAsync(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length,
      { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}
let DUMMY_HASH = null;      // verified against when a username doesn't exist, so timing doesn't reveal it
hashPassword(crypto.randomBytes(12).toString('hex')).then(h => { DUMMY_HASH = h; });

const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';   // no 0/O/1/l/I
function tempPassword(){
  let s = '';
  for (let i = 0; i < 12; i++) s += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678', '123456789', 'qwertyuiop', 'qwerty123',
  'admin123', 'admin1234', 'administrator', 'reception123', 'teacher123', 'school123', 'welcome123', 'letmein123', 'iloveyou1',
  'changeme123', 'ledger123', 'abcd1234', 'abc12345', '11111111', '00000000', 'passw0rd', 'p@ssw0rd', 'india123']);
const COMMON_BASES = new Set(['password', 'passw0rd', 'admin', 'administrator', 'welcome', 'letmein', 'qwerty', 'qwertyuiop', 'asdfghjkl',
  'school', 'teacher', 'teachers', 'reception', 'ledger', 'changeme', 'iloveyou', 'india', 'hyderabad', 'abcd', 'abcdefgh', 'timetable', 'secret', 'login']);
function checkPassword(pw, username, fullName){
  if (typeof pw !== 'string') return 'Enter a password.';
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  const low = pw.toLowerCase(), base = low.replace(/[\d!@#$%^&*._\-\s]+$/, '');
  if (COMMON.has(low) || COMMON_BASES.has(base)) return 'That password is too easy to guess. Use a few unrelated words, e.g. "violet tractor pencil monsoon".';
  if (/^\d+$/.test(pw) && pw.length < 16) return 'Use letters as well as numbers, or a longer phrase.';
  const bits = [username, ...String(fullName || '').split(/\s+/)].map(x => String(x || '').toLowerCase()).filter(x => x.length >= 4);
  if (bits.some(b => low.includes(b))) return 'The password must not contain your name or username.';
  if (/^(.)\1+$/.test(pw)) return 'Use a mix of characters, not one repeated.';
  return null;
}

/* ------------------------------------------------------------------ audit */
const auditIns = db.prepare('INSERT INTO audit(ts,user_id,username,action,detail,ip) VALUES(?,?,?,?,?,?)');
function audit(req, user, action, detail){
  try { auditIns.run(Date.now(), user ? user.id : null, user ? user.username : null, action, detail ? String(detail).slice(0, 300) : null, req ? req.ip : null); }
  catch (e) { console.error('audit failed', e.message); }
}

/* ------------------------------------------------------------ rate limits */
const buckets = new Map();
function hit(key, max, windowMs){
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n <= max;
}
const fails = new Map();     // username -> {count, first, lockedUntil}  (tracked for unknown usernames too)
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3, FAIL_WINDOW = 15 * 60e3;
function lockRemaining(username){ const f = fails.get(username); return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0; }
function noteFailure(username){
  const now = Date.now(); let f = fails.get(username);
  if (!f || now - f.first > FAIL_WINDOW) f = { count: 0, first: now, lockedUntil: 0 };
  f.count++; if (f.count >= LOCK_AFTER) f.lockedUntil = now + LOCK_MS;
  fails.set(username, f);
}
setInterval(() => {
  const n = Date.now();
  for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k);
  for (const [k, f] of fails) if (f.lockedUntil < n && n - f.first > FAIL_WINDOW) fails.delete(k);
}, 60e3).unref();

/* --------------------------------------------------------------- kv store */
const kvRow = db.prepare('SELECT value, rev FROM kv WHERE key=?');
const kvIns = db.prepare('INSERT INTO kv(key,value,rev,updated_at,updated_by) VALUES(?,?,1,?,?)');
const kvUpd = db.prepare('UPDATE kv SET value=?, rev=rev+1, updated_at=?, updated_by=? WHERE key=?');
function kvGet(key, def){ const r = kvRow.get(key); if (!r) return def; try { return JSON.parse(r.value); } catch (e) { return def; } }
function kvRev(key){ const r = kvRow.get(key); return r ? r.rev : 0; }
function kvSet(key, value, by){
  const s = JSON.stringify(value === undefined ? null : value), now = Date.now();
  if (kvRow.get(key)) kvUpd.run(s, now, by || null, key); else kvIns.run(key, s, now, by || null);
}

const ADMIN_KEYS = {          // keys only an administrator may write, with the JSON type expected
  teachers: 'array', classes: 'array', days: 'array', periods: 'array', timetable: 'object', absences: 'object',
  substitutions: 'object', leaveRequests: 'array', notifications: 'array', subjectCatalog: 'array', autoGen: 'boolean',
  genSig: 'string', genReport: 'any', workloadLog: 'object', campus: 'object', schoolEnd: 'string', classXEnd: 'string', periodsV2: 'boolean'
};
function typeOk(v, t){
  if (t === 'any') return true;
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}
function cleanCampus(c){
  if (!c || typeof c !== 'object') throw new HttpError(400, 'bad_campus', 'Invalid campus settings.');
  const lat = c.lat == null || c.lat === '' ? null : Number(c.lat), lng = c.lng == null || c.lng === '' ? null : Number(c.lng);
  if ((lat == null) !== (lng == null)) throw new HttpError(400, 'bad_campus', 'Enter both latitude and longitude.');
  if (lat != null && !(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new HttpError(400, 'bad_campus', 'Latitude/longitude out of range.');
  const radius = Math.round(Number(c.radius)), maxAccuracy = Math.round(Number(c.maxAccuracy));
  if (!(radius >= 20 && radius <= 2000)) throw new HttpError(400, 'bad_campus', 'Radius must be between 20 and 2000 metres.');
  if (!(maxAccuracy >= 10 && maxAccuracy <= 500)) throw new HttpError(400, 'bad_campus', 'Maximum GPS error must be between 10 and 500 metres.');
  return { lat: lat == null ? null : +lat.toFixed(6), lng: lng == null ? null : +lng.toFixed(6), radius, maxAccuracy };
}
const DEFAULT_CAMPUS = { lat: null, lng: null, radius: 150, maxAccuracy: 100 };

/* ------------------------------------------------------------------ users */
const userById = db.prepare('SELECT * FROM users WHERE id=?');
const userByName = db.prepare('SELECT * FROM users WHERE username=?');
function publicMe(u){
  return { id: u.id, username: u.username, name: u.name, role: u.role, teacherId: u.teacher_id || null,
    mustChange: !!u.must_change, locationAck: !!u.location_ack_at && u.location_ack_version === POLICY_VERSION };
}
function listUsers(){
  return db.prepare('SELECT * FROM users ORDER BY role, name').all().map(u => ({
    id: u.id, username: u.username, name: u.name, role: u.role, teacherId: u.teacher_id || null,
    mustChange: !!u.must_change, lastLogin: u.last_login || null, locked: lockRemaining(u.username) > 0 }));
}
function slug(name){
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 12);
  return s.length >= 3 ? s : (s + 'user').slice(0, 12);
}
function uniqueUsername(base){
  let n = base, i = 1;
  while (userByName.get(n)) n = base.slice(0, 28) + (++i);
  return n;
}
const insUser = db.prepare(`INSERT INTO users(id,username,name,role,teacher_id,pw_hash,must_change,created_at) VALUES(?,?,?,?,?,?,1,?)`);
function revokeSessions(userId, exceptHash){
  if (exceptHash) db.prepare('DELETE FROM sessions WHERE user_id=? AND id_hash<>?').run(userId, exceptHash);
  else db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}

/* Teacher logins follow the teacher list: add a teacher -> a login with a one-time password is created. */
async function planTeacherLogins(teachers){
  const have = new Set(db.prepare("SELECT teacher_id FROM users WHERE role='teacher'").all().map(r => r.teacher_id));
  const plan = [];
  for (const t of teachers) {
    if (!have.has(t.id)) { const temp = tempPassword(); plan.push({ t, temp, hash: await hashPassword(temp) }); }
  }
  return plan;
}
function applyTeacherLogins(req, actor, teachers, plan){
  const creds = [], ids = new Set(teachers.map(t => t.id));
  for (const p of plan) {
    if (db.prepare("SELECT 1 FROM users WHERE role='teacher' AND teacher_id=?").get(p.t.id)) continue;
    const username = uniqueUsername(slug(p.t.name));
    insUser.run(rid('u_'), username, cleanText(p.t.name, 60), 'teacher', p.t.id, p.hash, Date.now());
    creds.push({ teacherId: p.t.id, name: cleanText(p.t.name, 60), username, tempPassword: p.temp });
    audit(req, actor, 'user.create', `teacher login ${username}`);
  }
  for (const t of teachers) db.prepare("UPDATE users SET name=? WHERE role='teacher' AND teacher_id=?").run(cleanText(t.name, 60), t.id);
  for (const u of db.prepare("SELECT * FROM users WHERE role='teacher'").all()) {
    if (!ids.has(u.teacher_id)) { db.prepare('DELETE FROM users WHERE id=?').run(u.id); audit(req, actor, 'user.delete', `teacher login ${u.username} (teacher removed)`); }
  }
  return creds;
}
function teacherListOk(list){
  return list.every(t => t && typeof t === 'object' && typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id) && typeof t.name === 'string' && t.name.trim() && new Set(list.map(x => x.id)).size === list.length);
}

/* --------------------------------------------------------------- sessions */
function parseCookies(h){
  const out = {}; if (!h) return out;
  String(h).split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function cookieHeader(req, value, maxAgeSec){
  const secure = PROD || req.secure;
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
function startSession(req, res, user){
  const sid = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url'), now = Date.now();
  db.prepare('INSERT INTO sessions(id_hash,user_id,csrf,created_at,last_seen) VALUES(?,?,?,?,?)').run(sha256(sid), user.id, csrf, now, now);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT 8)').run(user.id, user.id);
  res.setHeader('Set-Cookie', cookieHeader(req, sid, Math.floor(SESSION_MAX_MS / 1000)));
  return { hash: sha256(sid), csrf };
}
function loadSession(req){
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sid || sid.length > 100) return null;
  const hash = sha256(sid), s = db.prepare('SELECT * FROM sessions WHERE id_hash=?').get(hash);
  if (!s) return null;
  const now = Date.now();
  if (now - s.created_at > SESSION_MAX_MS || now - s.last_seen > SESSION_IDLE_MS) { db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash); return null; }
  if (now - s.last_seen > 60e3) db.prepare('UPDATE sessions SET last_seen=? WHERE id_hash=?').run(now, hash);
  const user = userById.get(s.user_id);
  return user ? { user, csrf: s.csrf, hash } : null;
}

/* ------------------------------------------------------------------- app */
const app = express();
app.disable('x-powered-by');
const tp = env.TRUST_PROXY;
app.set('trust proxy', tp ? (/^\d+$/.test(tp) ? +tp : tp) : (PROD ? 1 : false));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "script-src-attr 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'"].join('; '));
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use((req, res, next) => {            // HTTPS only in production (geolocation also needs a secure context)
  if (PROD && !req.secure) {
    const host = env.PUBLIC_HOST || req.headers.host;
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `https://${host}${req.originalUrl}`);
    return res.status(426).json({ error: 'https_required', message: 'Use the https:// address of this site.' });
  }
  next();
});

const PUB = path.join(__dirname, 'public');
app.use('/fonts', express.static(path.join(PUB, 'fonts'), { maxAge: '365d', immutable: true }));
app.use('/vendor', express.static(path.join(PUB, 'vendor'), { maxAge: '30d' }));
app.use(express.static(PUB, { index: 'index.html', maxAge: 0, etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!hit('api:' + req.ip, 600, 60e3)) return next(new HttpError(429, 'rate_limited', 'Too many requests. Slow down.'));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const o = req.headers.origin;
    if (o) {
      let ok = false;
      try { const h = new URL(o).host; ok = h === req.headers.host || h === String(req.headers['x-forwarded-host'] || '').split(',')[0].trim(); } catch (e) { /* bad origin */ }
      if (!ok) return next(new HttpError(403, 'bad_origin', 'Cross-site request blocked.'));
    }
  }
  next();
});
app.use('/api', express.json({ limit: '6mb' }));

/* auth wrapper: loads the session, enforces role, CSRF and forced password change */
function guard(roles, opts = {}){
  return (req, res, next) => {
    const s = loadSession(req);
    if (!s) return next(new HttpError(401, 'not_signed_in', 'Please sign in.'));
    req.user = s.user; req.csrf = s.csrf; req.sessionHash = s.hash;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const t = String(req.headers['x-csrf-token'] || '');
      if (t.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s.csrf))) return next(new HttpError(403, 'bad_csrf', 'Session check failed. Reload the page.'));
    }
    if (s.user.must_change && !opts.allowMustChange) return next(new HttpError(403, 'password_change_required', 'Change your temporary password first.'));
    if (roles && !roles.includes(s.user.role)) return next(new HttpError(403, 'forbidden', 'You do not have access to this.'));
    next();
  };
}

/* ----- bootstrap / setup / login */
let setupCode = null;
const needsSetup = () => db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
if (needsSetup()) {
  setupCode = env.SETUP_CODE || (() => { let s = ''; for (let i = 0; i < 8; i++) s += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]; return s.slice(0, 4) + '-' + s.slice(4); })();
}
const clock = () => ({ tz: SCHOOL_TZ, now: Date.now(), today: todayStr() });

app.get('/api/bootstrap', (req, res) => {
  const s = loadSession(req);
  res.json({ needsSetup: needsSetup(), user: s ? publicMe(s.user) : null, csrf: s ? s.csrf : null, ...clock() });
});

app.post('/api/setup', asyncH(async (req, res) => {
  if (!hit('setup:' + req.ip, 10, 15 * 60e3)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.');
  if (!needsSetup() || !setupCode) throw new HttpError(409, 'already_setup', 'Setup is already complete.');
  const code = String(req.body.code || '').trim().toUpperCase(), want = setupCode.toUpperCase();
  if (code.length !== want.length || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(want))) throw new HttpError(403, 'bad_code', 'That setup code is not correct. It is printed in the server log.');
  const name = cleanText(req.body.name, 60), username = String(req.body.username || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'bad_name', 'Enter your name.');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'bad_username', 'Username: 3–32 characters, lowercase letters, digits, dot, dash or underscore.');
  const bad = checkPassword(req.body.password, username, name); if (bad) throw new HttpError(400, 'weak_password', bad);
  const hash = await hashPassword(req.body.password);
  const id = rid('u_');
  const created = db.transaction(() => {
    if (!needsSetup()) return false;
    insUser.run(id, username, name, 'admin', null, hash, Date.now());
    db.prepare('UPDATE users SET must_change=0 WHERE id=?').run(id);
    return true;
  })();
  if (!created) throw new HttpError(409, 'already_setup', 'Setup is already complete.');
  setupCode = null;
  const user = userById.get(id);
  audit(req, user, 'setup.admin_created', username);
  const sess = startSession(req, res, user);
  res.json({ user: publicMe(user), csrf: sess.csrf, ...clock() });
}));

app.post('/api/login', asyncH(async (req, res) => {
  if (!hit('login:' + req.ip, 30, 10 * 60e3)) throw new HttpError(429, 'rate_limited', 'Too many sign-in attempts. Wait a few minutes and try again.');
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 64), password = String(req.body.password || '').slice(0, 200);
  const u = userByName.get(username);
  const wait = lockRemaining(username);
  const ok = await verifyPassword(password, u ? u.pw_hash : (DUMMY_HASH || 'x'));       // always do the work
  if (wait) { audit(req, u, 'login.locked', username); throw new HttpError(429, 'locked', `Too many wrong passwords. Try again in ${Math.ceil(wait / 60000)} minute(s), or ask your Admin to reset your password.`); }
  if (!u || !ok) {
    noteFailure(username); audit(req, u, 'login.fail', username);
    throw new HttpError(401, 'bad_login', 'Incorrect username or password.');
  }
  fails.delete(username);
  db.prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), u.id);
  const sess = startSession(req, res, u);
  audit(req, u, 'login.ok', null);
  res.json({ user: publicMe(u), csrf: sess.csrf, ...clock() });
}));

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (sid) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(sid));
  res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
  res.json({ ok: true });
});

app.post('/api/change-password', guard(null, { allowMustChange: true }), asyncH(async (req, res) => {
  if (!hit('chpw:' + req.user.id, 10, 15 * 60e3)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.');
  const { current, next } = req.body || {};
  if (!(await verifyPassword(String(current || ''), req.user.pw_hash))) throw new HttpError(400, 'bad_current', 'Your current password is not correct.');
  const bad = checkPassword(next, req.user.username, req.user.name); if (bad) throw new HttpError(400, 'weak_password', bad);
  if (next === current) throw new HttpError(400, 'same_password', 'Choose a new password that is different from the current one.');
  const hash = await hashPassword(next);
  db.prepare('UPDATE users SET pw_hash=?, must_change=0 WHERE id=?').run(hash, req.user.id);
  revokeSessions(req.user.id, req.sessionHash);           // other devices must sign in again
  audit(req, req.user, 'password.change', null);
  res.json({ ok: true, user: publicMe(userById.get(req.user.id)) });
}));

app.post('/api/location-ack', guard(['teacher']), (req, res) => {
  db.prepare('UPDATE users SET location_ack_at=?, location_ack_version=? WHERE id=?').run(Date.now(), POLICY_VERSION, req.user.id);
  audit(req, req.user, 'location.ack', `policy v${POLICY_VERSION}`);
  bumpVersion();
  res.json({ ok: true });
});

/* ----- role-filtered state */
function buildState(user){
  const base = { v: coreVersion, me: publicMe(user), ...clock(), policy: { retentionDays: ATTENDANCE_RETENTION_DAYS, version: POLICY_VERSION } };
  const campus = { ...DEFAULT_CAMPUS, ...kvGet('campus', {}) };
  const campusPublic = { configured: campus.lat != null && campus.lng != null, radius: campus.radius, maxAccuracy: campus.maxAccuracy };
  const teachers = kvGet('teachers', []);
  if (user.role === 'admin') {
    const data = {}, revs = {};
    for (const k of Object.keys(ADMIN_KEYS)) { const r = kvRow.get(k); revs[k] = r ? r.rev : 0; if (r) data[k] = JSON.parse(r.value); }
    data.campus = campus;
    return { ...base, data, revs, users: listUsers(), legacyDone: !!(metaGet.get('legacy_imported')) };
  }
  const shared = {};
  if (user.role === 'teacher') {
    for (const k of ['classes', 'days', 'periods', 'timetable', 'absences', 'substitutions', 'subjectCatalog', 'schoolEnd', 'classXEnd', 'periodsV2', 'notifications']) {
      const r = kvRow.get(k); if (r) shared[k] = JSON.parse(r.value);
    }
    shared.teachers = teachers.map(t => ({ id: t.id, name: t.name, subjects: t.subjects || [], classIds: t.classIds || [], assignments: t.assignments || [] }));  // no phone numbers
    shared.leaveRequests = kvGet('leaveRequests', []).filter(l => l.teacherId === user.teacher_id);
  } else {   // receptionist: names, working days, announcements and approved-leave dates only
    shared.teachers = teachers.map(t => ({ id: t.id, name: t.name }));
    shared.days = kvGet('days', []);
    shared.notifications = kvGet('notifications', []);
    shared.leaveRequests = kvGet('leaveRequests', []).filter(l => l.status === 'approved').map(l => ({ id: l.id, teacherId: l.teacherId, from: l.from, to: l.to, status: l.status }));
  }
  shared.campus = campusPublic;
  return { ...base, data: shared };
}
app.get('/api/state', guard(null), (req, res) => {
  if (String(req.query.v) === String(coreVersion)) return res.json({ unchanged: true, v: coreVersion, ...clock() });
  res.json(buildState(req.user));
});

app.put('/api/state', guard(['admin']), asyncH(async (req, res) => {
  const changes = req.body && req.body.changes;
  if (!changes || typeof changes !== 'object') throw new HttpError(400, 'bad_request', 'Nothing to save.');
  const keys = Object.keys(changes);
  const cleaned = {};
  for (const k of keys) {
    if (!(k in ADMIN_KEYS)) throw new HttpError(400, 'bad_key', `Unknown field: ${k}`);
    const c = changes[k], v = c && c.value;
    if (!typeOk(v, ADMIN_KEYS[k])) throw new HttpError(400, 'bad_type', `Invalid data for ${k}.`);
    if (JSON.stringify(v).length > 4e6) throw new HttpError(413, 'too_large', `${k} is too large.`);
    cleaned[k] = k === 'campus' ? cleanCampus(v) : v;
  }
  let plan = [];
  if ('teachers' in cleaned) {
    if (!teacherListOk(cleaned.teachers)) throw new HttpError(400, 'bad_teachers', 'Teacher list is invalid (every teacher needs a unique id and a name).');
    plan = await planTeacherLogins(cleaned.teachers);
  }
  const result = db.transaction(() => {
    const conflicts = keys.filter(k => kvRev(k) !== (Number(changes[k].baseRev) || 0));
    if (conflicts.length) return { conflicts };
    for (const k of keys) {
      if (k === 'campus') { const old = kvGet('campus', DEFAULT_CAMPUS); if (JSON.stringify(old) !== JSON.stringify(cleaned.campus)) audit(req, req.user, 'campus.change', `radius ${cleaned.campus.radius} m, max error ${cleaned.campus.maxAccuracy} m`); }
      kvSet(k, cleaned[k], req.user.username);
    }
    const creds = 'teachers' in cleaned ? applyTeacherLogins(req, req.user, cleaned.teachers, plan) : [];
    bumpVersion();
    return { creds };
  })();
  if (result.conflicts) throw Object.assign(new HttpError(409, 'conflict', 'Someone else changed this at the same time.'), { keys: result.conflicts });
  const revs = {}; for (const k of Object.keys(ADMIN_KEYS)) revs[k] = kvRev(k);
  res.json({ ok: true, v: coreVersion, revs, creds: result.creds, users: listUsers() });
}));

/* ----- leave requests & substitutions (teacher actions, validated here) */
app.post('/api/leave', guard(['teacher']), (req, res) => {
  const u = req.user; if (!u.teacher_id) throw new HttpError(400, 'no_teacher', 'No teacher profile on this login.');
  const from = req.body.from, to = req.body.to, reason = cleanText(req.body.reason, 300), today = todayStr();
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, 'bad_dates', 'Choose both dates.');
  if (to < from) throw new HttpError(400, 'bad_dates', 'The end date is before the start date.');
  if (dayDiff(today, from) > 30 || dayDiff(to, today) > 366 || dayDiff(to, from) > 90) throw new HttpError(400, 'bad_dates', 'Those dates are outside the allowed range.');
  db.transaction(() => {
    const list = kvGet('leaveRequests', []);
    list.push({ id: rid('lv_'), teacherId: u.teacher_id, from, to, reason, status: 'pending' });
    kvSet('leaveRequests', list, u.username); bumpVersion();
  })();
  audit(req, u, 'leave.apply', `${from} → ${to}`);
  res.json({ ok: true });
});

app.post('/api/subs/respond', guard(['teacher']), (req, res) => {
  const { day, classId, periodId, decision } = req.body || {};
  if (!['accepted', 'rejected'].includes(decision)) throw new HttpError(400, 'bad_decision', 'Invalid choice.');
  db.transaction(() => {
    const subs = kvGet('substitutions', {});
    const s = subs[day] && subs[day][classId] && subs[day][classId][periodId];
    if (!s || s.subTeacherId !== req.user.teacher_id) throw new HttpError(403, 'not_yours', 'That substitution is not assigned to you.');
    if (s.status !== 'pending') throw new HttpError(409, 'already_answered', 'You already answered this request.');
    s.status = decision; kvSet('substitutions', subs, req.user.username); bumpVersion();
  })();
  audit(req, req.user, 'sub.' + decision, `${day} ${classId}`);
  res.json({ ok: true });
});

/* ----- attendance (location verified on the server) */
function attendanceShape(rows, role){
  const out = {};
  for (const r of rows) {
    const rec = { inTime: r.in_time || '', outTime: r.out_time || '' };
    if (role !== 'receptionist') {
      if (r.in_dist != null) rec.inLoc = { dist: r.in_dist, acc: r.in_acc };
      if (r.out_dist != null) rec.outLoc = { dist: r.out_dist, acc: r.out_acc };
    }
    if (r.manual) { rec.manual = true; if (role === 'admin' && r.note) rec.note = r.note; }
    (out[r.date] = out[r.date] || {})[r.teacher_id] = rec;
  }
  return out;
}
app.get('/api/attendance', guard(null), (req, res) => {
  const from = req.query.from, to = req.query.to;
  if (!isDate(from) || !isDate(to) || to < from || dayDiff(to, from) > 62) throw new HttpError(400, 'bad_range', 'Invalid date range.');
  const u = req.user;
  if (u.role === 'teacher' && !u.teacher_id) return res.json({ checkins: {} });
  const rows = u.role === 'teacher'
    ? db.prepare('SELECT * FROM attendance WHERE date BETWEEN ? AND ? AND teacher_id=?').all(from, to, u.teacher_id)
    : db.prepare('SELECT * FROM attendance WHERE date BETWEEN ? AND ?').all(from, to);
  res.json({ checkins: attendanceShape(rows, u.role), ...clock() });
});

app.post('/api/attendance', guard(['teacher']), (req, res) => {
  const u = req.user;
  if (!u.teacher_id || !kvGet('teachers', []).some(t => t.id === u.teacher_id)) throw new HttpError(400, 'no_teacher', 'No teacher profile on this login.');
  if (!hit('att:' + u.id, 20, 10 * 60e3)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
  if (!(u.location_ack_at && u.location_ack_version === POLICY_VERSION)) throw new HttpError(428, 'ack_required', 'Please read and accept the location notice first.');
  const kind = req.body.kind;
  if (kind !== 'in' && kind !== 'out') throw new HttpError(400, 'bad_kind', 'Invalid request.');
  const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Number(req.body.accuracy);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || !(acc >= 0 && acc <= 100000) || req.body.lat === null || req.body.lng === null || req.body.accuracy == null)
    throw new HttpError(400, 'bad_position', 'Your device did not send a valid location.');
  const campus = { ...DEFAULT_CAMPUS, ...kvGet('campus', {}) };
  if (campus.lat == null || campus.lng == null) throw new HttpError(409, 'campus_not_set', 'The Admin has not set the campus location yet.');
  const dist = Math.round(haversine(lat, lng, campus.lat, campus.lng)), accR = Math.round(acc);
  const reject = (code, message) => { audit(req, u, 'attendance.reject', `${kind}: ${code}, ${dist} m away, ±${accR} m`); throw new HttpError(422, code, message); };
  if (accR > campus.maxAccuracy) reject('poor_accuracy', `Your GPS is only accurate to ±${accR} m (needs ±${campus.maxAccuracy} m or better). Move outdoors or next to a window, make sure Precise/High-accuracy location is on, and try again.`);
  if (dist > campus.radius) {
    const maybe = dist - accR <= campus.radius;
    reject(maybe ? 'uncertain' : 'outside', maybe
      ? `You appear to be about ${dist} m from the campus point (GPS error ±${accR} m) — just outside the ${campus.radius} m limit. Move closer to the campus centre and try again.`
      : `You are about ${dist} m from the campus point. You must be within ${campus.radius} m to check ${kind}.`);
  }
  const today = todayStr(), time = nowTime();
  let msg, already = false;
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM attendance WHERE date=? AND teacher_id=?').get(today, u.teacher_id);
    if (kind === 'in') {
      if (row && row.in_time) { already = true; msg = `You already checked in today at ${row.in_time}.`; return; }
      if (row) db.prepare('UPDATE attendance SET in_time=?, in_dist=?, in_acc=? WHERE date=? AND teacher_id=?').run(time, dist, accR, today, u.teacher_id);
      else db.prepare('INSERT INTO attendance(date,teacher_id,in_time,in_dist,in_acc) VALUES(?,?,?,?,?)').run(today, u.teacher_id, time, dist, accR);
    } else {
      if (row) db.prepare('UPDATE attendance SET out_time=?, out_dist=?, out_acc=? WHERE date=? AND teacher_id=?').run(time, dist, accR, today, u.teacher_id);
      else db.prepare('INSERT INTO attendance(date,teacher_id,out_time,out_dist,out_acc) VALUES(?,?,?,?,?)').run(today, u.teacher_id, time, dist, accR);
    }
    msg = `Checked ${kind} at ${time} — ${dist} m from the campus point (GPS accuracy ±${accR} m).`;
  })();
  if (!already) audit(req, u, 'attendance.' + kind, `${dist} m, ±${accR} m`);
  res.json({ ok: true, already, message: msg, today });
});

app.post('/api/location-test', guard(['teacher', 'admin']), (req, res) => {      // dry run: nothing is stored or logged
  if (!hit('loctest:' + req.user.id, 30, 10 * 60e3)) throw new HttpError(429, 'rate_limited', 'Too many tests. Wait a few minutes.');
  const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Number(req.body.accuracy);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || !(acc >= 0) || req.body.accuracy == null) throw new HttpError(400, 'bad_position', 'Your device did not send a valid location.');
  const campus = { ...DEFAULT_CAMPUS, ...kvGet('campus', {}) };
  if (campus.lat == null || campus.lng == null) return res.json({ configured: false });
  const dist = Math.round(haversine(lat, lng, campus.lat, campus.lng)), accR = Math.round(acc);
  let reason = null;
  if (accR > campus.maxAccuracy) reason = `GPS is only accurate to ±${accR} m (needs ±${campus.maxAccuracy} m or better).`;
  else if (dist > campus.radius) reason = `outside the ${campus.radius} m radius.`;
  res.json({ configured: true, dist, radius: campus.radius, accuracy: accR, maxAccuracy: campus.maxAccuracy, wouldPass: !reason, reason });
});

app.post('/api/attendance/manual', guard(['admin']), (req, res) => {          // fallback when a phone's GPS can't be used
  const { teacherId, date } = req.body || {}, inTime = req.body.inTime || '', outTime = req.body.outTime || '', note = cleanText(req.body.note, 200);
  if (!kvGet('teachers', []).some(t => t.id === teacherId)) throw new HttpError(400, 'bad_teacher', 'Choose a teacher.');
  if (!isDate(date) || date > todayStr()) throw new HttpError(400, 'bad_date', 'Choose a date that is today or earlier.');
  if ((inTime && !isTime(inTime)) || (outTime && !isTime(outTime)) || (!inTime && !outTime)) throw new HttpError(400, 'bad_time', 'Enter a valid check-in and/or check-out time.');
  if (!note) throw new HttpError(400, 'note_required', 'Add a short reason (it is kept in the security log).');
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM attendance WHERE date=? AND teacher_id=?').get(date, teacherId);
    if (row) db.prepare('UPDATE attendance SET in_time=COALESCE(?,in_time), out_time=COALESCE(?,out_time), manual=1, note=? WHERE date=? AND teacher_id=?').run(inTime || null, outTime || null, note, date, teacherId);
    else db.prepare('INSERT INTO attendance(date,teacher_id,in_time,out_time,manual,note) VALUES(?,?,?,?,1,?)').run(date, teacherId, inTime || null, outTime || null, note);
  })();
  audit(req, req.user, 'attendance.manual', `${teacherId} ${date} in=${inTime || '-'} out=${outTime || '-'}: ${note}`);
  res.json({ ok: true });
});

/* ----- user management (admin) */
app.get('/api/audit', guard(['admin']), (req, res) => {
  res.json({ rows: db.prepare('SELECT ts, username, action, detail, ip FROM audit ORDER BY id DESC LIMIT 60').all() });
});
app.post('/api/users', guard(['admin']), asyncH(async (req, res) => {
  const name = cleanText(req.body.name, 60), role = req.body.role;
  if (!name) throw new HttpError(400, 'bad_name', 'Enter a name.');
  if (!['admin', 'receptionist'].includes(role)) throw new HttpError(400, 'bad_role', 'Teacher logins are created from the Staff & Classes tab.');
  const temp = tempPassword(), hash = await hashPassword(temp);
  const out = db.transaction(() => { const username = uniqueUsername(slug(name)); insUser.run(rid('u_'), username, name, role, null, hash, Date.now()); return username; })();
  audit(req, req.user, 'user.create', `${role} ${out}`);
  bumpVersion();
  res.json({ ok: true, cred: { name, username: out, tempPassword: temp }, users: listUsers() });
}));
app.post('/api/users/:id/reset', guard(['admin']), asyncH(async (req, res) => {
  const u = userById.get(req.params.id); if (!u) throw new HttpError(404, 'no_user', 'No such user.');
  const temp = tempPassword(), hash = await hashPassword(temp);
  db.prepare('UPDATE users SET pw_hash=?, must_change=1 WHERE id=?').run(hash, u.id);
  revokeSessions(u.id); fails.delete(u.username);
  audit(req, req.user, 'password.reset', u.username);
  res.json({ ok: true, cred: { name: u.name, username: u.username, tempPassword: temp }, users: listUsers() });
}));
app.delete('/api/users/:id', guard(['admin']), (req, res) => {
  const u = userById.get(req.params.id); if (!u) throw new HttpError(404, 'no_user', 'No such user.');
  if (u.id === req.user.id) throw new HttpError(400, 'self', 'You cannot delete your own login.');
  if (u.role === 'teacher') throw new HttpError(400, 'teacher_user', 'Remove the teacher from Staff & Classes to remove their login.');
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1) throw new HttpError(400, 'last_admin', 'You cannot remove the last administrator.');
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  audit(req, req.user, 'user.delete', u.username); bumpVersion();
  res.json({ ok: true, users: listUsers() });
});

/* ----- one-time import of data saved by the old browser-only version */
app.post('/api/import-legacy', guard(['admin']), asyncH(async (req, res) => {
  if (metaGet.get('legacy_imported')) throw new HttpError(409, 'already_imported', 'Old data was already imported.');
  if (kvGet('teachers', []).length || kvGet('classes', []).length) throw new HttpError(409, 'server_not_empty', 'The server already has timetable data; refusing to overwrite it.');
  const s = req.body && req.body.state; if (!s || typeof s !== 'object') throw new HttpError(400, 'bad_request', 'Nothing to import.');
  const cleaned = {};
  for (const k of Object.keys(ADMIN_KEYS)) {
    if (!(k in s) || k === 'leaveRequests' && !Array.isArray(s[k])) continue;
    if (!typeOk(s[k], ADMIN_KEYS[k])) throw new HttpError(400, 'bad_type', `Invalid data for ${k}.`);
    if (JSON.stringify(s[k]).length > 4e6) throw new HttpError(413, 'too_large', `${k} is too large.`);
    cleaned[k] = s[k];
  }
  const old = cleaned.campus || {};
  cleaned.campus = cleanCampus({ lat: old.lat, lng: old.lng, radius: Math.max(DEFAULT_CAMPUS.radius, Number(old.radius) || 0), maxAccuracy: DEFAULT_CAMPUS.maxAccuracy });
  const teachers = cleaned.teachers || [];
  if (!teacherListOk(teachers)) throw new HttpError(400, 'bad_teachers', 'Teacher list in the old data is invalid.');
  const plan = await planTeacherLogins(teachers);
  const out = db.transaction(() => {
    for (const k of Object.keys(cleaned)) kvSet(k, cleaned[k], req.user.username);
    const creds = applyTeacherLogins(req, req.user, teachers, plan);
    const ids = new Set(teachers.map(t => t.id)); let n = 0;
    const ins = db.prepare('INSERT OR IGNORE INTO attendance(date,teacher_id,in_time,out_time,in_dist,in_acc,out_dist,out_acc,manual,note) VALUES(?,?,?,?,?,?,?,?,1,?)');
    for (const [date, per] of Object.entries(s.checkins || {})) {
      if (!isDate(date) || !per || typeof per !== 'object') continue;
      for (const [tid, r] of Object.entries(per)) {
        if (!ids.has(tid) || !r) continue;
        const i = isTime(r.inTime) ? r.inTime : null, o = isTime(r.outTime) ? r.outTime : null; if (!i && !o) continue;
        const iL = r.inLoc || {}, oL = r.outLoc || {};
        ins.run(date, tid, i, o, Number.isFinite(iL.dist) ? Math.round(iL.dist) : null, Number.isFinite(iL.acc) ? Math.round(iL.acc) : null,
          Number.isFinite(oL.dist) ? Math.round(oL.dist) : null, Number.isFinite(oL.acc) ? Math.round(oL.acc) : null, 'imported from old version'); n++;
      }
    }
    metaSet.run('legacy_imported', String(Date.now())); bumpVersion();
    return { creds, attendanceRows: n };
  })();
  audit(req, req.user, 'legacy.import', `${out.attendanceRows} attendance rows, ${out.creds.length} logins`);
  res.json({ ok: true, ...out });
}));

/* ----- errors */
app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found', 'Not found.')));
app.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'Malformed request.');
  if (err.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'Request is too large.');
  if (!(err instanceof HttpError)) { console.error(err); err = new HttpError(500, 'server_error', 'Something went wrong on the server.'); }
  if (res.headersSent) return;
  res.status(err.status).json({ error: err.code, message: err.message, ...(err.keys ? { keys: err.keys } : {}) });
});

/* -------------------------------------------------------------- retention */
function purge(){
  try {
    const cutoff = todayStr(new Date(Date.now() - ATTENDANCE_RETENTION_DAYS * 86400e3));
    const a = db.prepare('DELETE FROM attendance WHERE date < ?').run(cutoff).changes;
    const l = db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - AUDIT_RETENTION_DAYS * 86400e3).changes;
    const s = db.prepare('DELETE FROM sessions WHERE created_at < ? OR last_seen < ?').run(Date.now() - SESSION_MAX_MS, Date.now() - SESSION_IDLE_MS).changes;
    if (a || l || s) console.log(`[purge] attendance rows: ${a}, audit rows: ${l}, expired sessions: ${s}`);
  } catch (e) { console.error('purge failed', e.message); }
}

/* ------------------------------------------------------------------- CLI */
if (process.argv[2] === 'reset-password') {
  (async () => {
    const name = String(process.argv[3] || '').toLowerCase(), u = name && userByName.get(name);
    if (!u) { console.error('Usage: node server.js reset-password <username>\nNo such user: ' + (name || '(none given)')); process.exit(1); }
    const temp = tempPassword();
    db.prepare('UPDATE users SET pw_hash=?, must_change=1 WHERE id=?').run(await hashPassword(temp), u.id);
    revokeSessions(u.id); audit(null, u, 'password.reset', 'via server command line');
    console.log(`Temporary password for "${u.username}": ${temp}\nThey must choose a new password at next sign-in.`);
    process.exit(0);
  })();
} else {
  purge(); setInterval(purge, 6 * 3600e3).unref();
  const server = env.TLS_KEY && env.TLS_CERT
    ? https.createServer({ key: fs.readFileSync(env.TLS_KEY), cert: fs.readFileSync(env.TLS_CERT) }, app)
    : require('http').createServer(app);
  server.listen(PORT, () => {
    console.log(`Ledger listening on port ${PORT} (${PROD ? 'production' : 'development'}), school time zone ${SCHOOL_TZ}`);
    if (PROD && !(env.TLS_KEY && env.TLS_CERT)) console.log('Running behind an HTTPS proxy: plain-HTTP requests are redirected to https://.');
    if (setupCode) {
      console.log('\n==============================================================');
      console.log(' FIRST-RUN SETUP — no accounts exist yet.');
      console.log(' Open the site and create the administrator account.');
      console.log(` Setup code: ${setupCode}`);
      console.log('==============================================================\n');
    }
  });
  const stop = () => { server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
