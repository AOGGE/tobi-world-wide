/* Tobi World Wide Educational Consult - backend
 * Zero dependencies. Needs Node 18+ (tested on Node 22).
 *
 *   node server.js
 *
 * Environment variables (all optional):
 *   PORT               default 3000
 *   DATA_DIR           where db.json is saved (default ./data). Point this at a persistent disk in production.
 *   ADMIN_USER         default "admin"
 *   ADMIN_PASSWORD     owner password. If not set, the same password as the one already built into index.html keeps working.
 *   AI_GATEWAY_API_KEY Vercel AI Gateway key (vck_...). Turns on the AI tutor, course outlines and AI news desk
 *   ANTHROPIC_API_KEY  alternative: a normal Anthropic key instead of the gateway key
 *   AI_BASE_URL        optional, override the AI endpoint
 *   ANTHROPIC_MODEL    default claude-sonnet-5-5
 *   COOKIE_SECURE=1    set when served over https (recommended in production)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const ADMIN_USER = String(process.env.ADMIN_USER || 'admin').toLowerCase();
// SHA-256 of the owner password that is already inside index.html, so the current password keeps working.
const LEGACY_ADMIN_HASH = 'a36aef5a11c4073fbe60314fc9df530a9d5f986533594d1f5190742ff9e0e408';
const ADMIN_HASH = process.env.ADMIN_PASSWORD
  ? crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest('hex')
  : LEGACY_ADMIN_HASH;
// AI key: works with a Vercel AI Gateway key (AI_GATEWAY_API_KEY, starts with vck_) or a normal Anthropic key (ANTHROPIC_API_KEY).
const AI_KEY = process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const USE_GATEWAY = !!process.env.AI_GATEWAY_API_KEY || /^vck_/.test(AI_KEY);
const AI_BASE = String(process.env.AI_BASE_URL || (USE_GATEWAY ? 'https://ai-gateway.vercel.sh' : 'https://api.anthropic.com')).replace(/\/+$/, '');
const AI_MODEL = process.env.ANTHROPIC_MODEL || (USE_GATEWAY ? 'anthropic/claude-sonnet-5.5' : 'claude-sonnet-5-5');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const ALL = 'All schools';
const SESSION_DAYS = 30;

/* ------------------------------------------------------------------ database */
fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return { users: [], staff: [], invites: [], reports: [], posts: [], pendingNews: [], schools: [], outlines: [], sessions: [], settings: { autoPublish: false }, nextId: 1000 };
}
function seedPostsFromIndex() {
  try {
    const html = fs.readFileSync(INDEX_FILE, 'utf8');
    const m = html.match(/<script type="application\/json" id="tobi-data">([\s\S]*?)<\/script>/);
    if (m) return JSON.parse(m[1]);
  } catch (e) { /* no seed */ }
  return { posts: [], schools: [], outlines: [] };
}
let db;
try {
  db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  if (fs.existsSync(DB_FILE)) { console.error('db.json is unreadable, refusing to start so no data is overwritten:', e.message); process.exit(1); }
  db = emptyDb();
  const seed = seedPostsFromIndex();
  db.posts = seed.posts || []; db.schools = seed.schools || []; db.outlines = seed.outlines || [];
}
let lastBackup = 0, saveTimer = null;
function writeNow() {
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  if (fs.existsSync(DB_FILE) && Date.now() - lastBackup > 10 * 60 * 1000) { try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); lastBackup = Date.now(); } catch (e) {} }
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(writeNow, 40); }
function flushAndExit() { try { if (saveTimer) clearTimeout(saveTimer); writeNow(); } catch (e) {} process.exit(0); }
process.on('SIGINT', flushAndExit); process.on('SIGTERM', flushAndExit);
writeNow();

/* ------------------------------------------------------------------ helpers */
const id = () => db.nextId++;
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max || 500);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const readMins = (t) => Math.max(1, Math.ceil(String(t).split(/\s+/).length / 200));
function bodyHtml(text, link) {
  let out = '';
  String(text).replace(/\r/g, '').trim().split(/\n\s*\n/).forEach((b) => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    if (lines.every((l) => /^[-*•]\s+/.test(l))) out += '<ul>' + lines.map((l) => '<li>' + esc(l.replace(/^[-*•]\s+/, '')) + '</li>').join('') + '</ul>';
    else out += '<p>' + lines.map(esc).join('<br>') + '</p>';
  });
  if (link && /^https?:\/\//i.test(link)) out += '<div class="callout"><b>Official source:</b> <a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(link) + '</a></div>';
  return out;
}
function makePost(p) {
  const text = clean(p.text, 20000);
  return {
    id: id(), t: clean(p.t, 40), h: clean(p.h, 200), x: clean(p.x, 400) || text.replace(/\s+/g, ' ').slice(0, 160),
    r: readMins(text), d: 'News', school: clean(p.school, 150) || ALL, date: today(),
    dl: /^\d{4}-\d{2}-\d{2}$/.test(p.dl || '') ? p.dl : undefined, body: bodyHtml(text, p.link)
  };
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') }; }
function checkPw(pw, rec) { if (!rec || !rec.salt) return false; return safeEq(crypto.scryptSync(String(pw), rec.salt, 64).toString('hex'), rec.hash); }
const DUMMY = hashPw('dummy-password'); // keeps login time similar for unknown accounts

function pubUser(u) { const o = { name: u.name, email: u.email, school: u.school, matric: u.matric || '', programme: u.programme || '', subjects: u.subjects || [] }; if (u.aiOutline) o.aiOutline = u.aiOutline; return o; }
const OWNER = { name: 'Tobi', email: 'owner', school: ALL, matric: '', programme: '', subjects: [] };

/* ---- sessions (cookie "sid") ---- */
function parseCookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function getSession(req) {
  const sid = parseCookies(req).sid; if (!sid) return null;
  const hid = sha256(sid); const now = Date.now();
  const s = db.sessions.find((x) => x.hid === hid);
  if (!s) return null;
  if (s.exp < now) { db.sessions = db.sessions.filter((x) => x !== s); save(); return null; }
  return s;
}
function startSession(res, data, keep) {
  const sid = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + SESSION_DAYS * 86400000;
  db.sessions = db.sessions.filter((x) => x.exp > Date.now()).slice(-5000);
  db.sessions.push(Object.assign({ hid: sha256(sid), exp }, data)); save();
  const parts = ['sid=' + sid, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (keep) parts.push('Max-Age=' + SESSION_DAYS * 86400);
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function endSession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) { const h = sha256(sid); db.sessions = db.sessions.filter((x) => x.hid !== h); save(); }
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

/* ---- login throttling (memory only) ---- */
const tries = new Map();
function throttled(key) { const t = tries.get(key); return !!(t && t.until && Date.now() < t.until); }
function fail(key) { const t = tries.get(key) || { n: 0 }; t.n++; if (t.n >= 5) { t.until = Date.now() + 60000; t.n = 0; } tries.set(key, t); return t; }
function ok(key) { tries.delete(key); }
setInterval(() => { const n = Date.now(); for (const [k, t] of tries) if (t.until && t.until < n) tries.delete(k); }, 300000).unref();

/* ---- http plumbing ---- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status) => { throw new HttpError(status || 400, msg); };
function send(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Invalid request.')); } });
    req.on('error', reject);
  });
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }

/* ---- Anthropic helper (optional) ---- */
async function ai(messages, opts) {
  if (!AI_KEY) bad('The AI features are off. Ask the owner to set AI_GATEWAY_API_KEY on the server.', 503);
  const body = Object.assign({ model: AI_MODEL, max_tokens: 1500, messages }, opts || {});
  const headers = USE_GATEWAY
    ? { 'content-type': 'application/json', authorization: 'Bearer ' + AI_KEY, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' };
  let r;
  try { r = await fetch(AI_BASE + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }); }
  catch (e) { console.error('AI network error:', e && e.message); bad('Cannot reach the AI service right now. Please try again in a moment.', 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Anthropic error', r.status, j && j.error); bad('The AI is busy right now. Please try again.', 502); }
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

/* ------------------------------------------------------------------ API */
const routes = [];
function route(method, pattern, handler) { routes.push({ method, re: new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$'), handler }); }

const isAdmin = (s) => s && s.type === 'admin';
const needAdmin = (s) => { if (!isAdmin(s)) bad('Owner sign-in required.', 401); };
const needUser = (s) => { const u = s && s.type === 'user' && db.users.find((x) => x.email === s.email); if (!u) bad('Please log in again.', 401); return u; };
const needStaff = (s) => { const u = s && s.type === 'staff' && db.staff.find((x) => x.username === s.username); if (!u) bad('Please sign in again.', 401); return u; };

route('GET', '/api/health', async () => ({ ok: true }));

route('GET', '/api/init', async (req, res, body, s) => {
  const out = { user: null, admin: false, role: null, extras: db.schools.slice(), tutor: !!AI_KEY, posts: db.posts, outlines: db.outlines };
  if (isAdmin(s)) { out.user = OWNER; out.admin = true; }
  else if (s && s.type === 'user') { const u = db.users.find((x) => x.email === s.email); if (u) out.user = pubUser(u); }
  else if (s && s.type === 'staff') { if (db.staff.some((x) => x.username === s.username)) out.role = 'rep'; }
  return out;
});

/* --- students --- */
route('POST', '/api/register', async (req, res, b) => {
  const email = clean(b.email, 200).toLowerCase(), name = clean(b.name, 100), pw = String(b.password || '');
  const school = clean(b.school, 150);
  if (!name || !email || !school) bad('Fill in your name, email and school.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address.');
  if (pw.length < 8) bad('Password must be at least 8 characters.');
  if (pw.length > 200) bad('Password is too long.');
  if (db.users.some((u) => u.email === email)) bad('That email is already registered. Log in instead.', 409);
  const h = hashPw(pw);
  db.users.push({ id: id(), email, name, school, matric: clean(b.matric, 40), programme: clean(b.programme, 120), subjects: [], salt: h.salt, hash: h.hash, created: Date.now() });
  save();
  return { ok: true };
});
route('POST', '/api/login', async (req, res, b) => {
  const email = clean(b.email, 200).toLowerCase(), key = 'u:' + clientIp(req) + ':' + email;
  if (throttled(key)) bad('Too many attempts. Try again in a minute.', 429);
  const u = db.users.find((x) => x.email === email);
  const good = checkPw(b.password, u || DUMMY) && !!u;
  if (!good) { const t = fail(key); bad(t.until ? 'Too many attempts. Locked for 60 seconds.' : 'Incorrect email or password.', t.until ? 429 : 401); }
  ok(key);
  startSession(res, { type: 'user', email: u.email }, !!b.keep);
  return { ok: true, user: pubUser(u), admin: false };
});
route('POST', '/api/logout', async (req, res) => { endSession(req, res); return { ok: true }; });
route('POST', '/api/school', async (req, res, b, s) => { const u = needUser(s); const sc = clean(b.school, 150); if (sc) { u.school = sc; save(); } return { ok: true }; });
route('PUT', '/api/profile', async (req, res, b, s) => {
  const u = needUser(s);
  u.matric = clean(b.matric, 40); u.programme = clean(b.programme, 120);
  if (Array.isArray(b.subjects)) u.subjects = b.subjects.slice(0, 60).map((x) => ({ id: clean(x && x.id, 60) || String(id()), t: clean(x && x.t, 120), u: Math.min(10, Math.max(1, +(x && x.u) || 1)) })).filter((x) => x.t);
  save(); return { ok: true };
});
route('POST', '/api/tutor', async (req, res, b, s) => {
  needUser(s);
  const q = clean(b.question, 2000), sub = clean(b.subject, 120), mode = clean(b.mode, 40);
  if (!q || !sub) bad('Add a subject and a question.');
  const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clean(m.text, 2000) })).filter((m) => m.content);
  while (hist.length && hist[0].role !== 'user') hist.shift();
  const msgs = []; hist.forEach((m) => { if (!msgs.length || msgs[msgs.length - 1].role !== m.role) msgs.push(m); });
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  msgs.push({ role: 'user', content: q });
  const text = await ai(msgs, { system: 'You are a friendly, accurate tutor for a Nigerian university student studying "' + sub + '". Mode: ' + (mode || 'explain') + '. Keep answers short, clear and practical. Use simple English.', max_tokens: 900 });
  return { text };
});
route('POST', '/api/outline/generate', async (req, res, b, s) => {
  const u = needUser(s);
  if (!u.programme) bad('Add your course of study in your profile first.');
  const text = await ai([{ role: 'user', content: 'Write a typical course outline (course codes, titles and units, per level, first to final year) for a ' + u.programme + ' degree at ' + u.school + ' in Nigeria. Say clearly that it is a general guide and the student must confirm with their department. Keep it under 500 words.' }], { max_tokens: 1200 });
  u.aiOutline = text; save();
  return { text };
});

/* --- reporters --- */
route('POST', '/api/staff/login', async (req, res, b) => {
  const un = clean(b.username, 100).toLowerCase(), key = 's:' + clientIp(req) + ':' + un;
  if (throttled(key)) bad('Too many attempts. Try again in a minute.', 429);
  const pw = String(b.password || '');
  if (un === ADMIN_USER) {
    if (safeEq(sha256(pw), ADMIN_HASH)) { ok(key); startSession(res, { type: 'admin' }, true); return { ok: true, user: OWNER, admin: true }; }
  } else {
    const st = db.staff.find((x) => x.username === un);
    if (checkPw(pw, st || DUMMY) && st) { ok(key); startSession(res, { type: 'staff', username: st.username }, true); return { ok: true, role: 'reporter' }; }
  }
  const t = fail(key); bad(t.until ? 'Too many attempts. Locked for 60 seconds.' : 'Incorrect username or password.', t.until ? 429 : 401);
});
route('POST', '/api/staff/signup', async (req, res, b) => {
  const code = clean(b.code, 20).toUpperCase(), inv = db.invites.find((x) => x.code === code);
  if (!inv || inv.usedBy) bad('That invite code is not valid or was already used.');
  const un = clean(b.username, 40).toLowerCase(), nm = clean(b.name, 100), em = clean(b.email, 200);
  if (!nm || !em || !un) bad('Fill in every field.');
  if (!/^[a-z0-9._-]{3,40}$/.test(un)) bad('Username: 3 to 40 letters, numbers, dot, dash or underscore.');
  if (String(b.password || '').length < 8) bad('Password must be 8+ characters.');
  if (un === ADMIN_USER || db.staff.some((x) => x.username === un)) bad('That username is taken.', 409);
  const h = hashPw(String(b.password));
  db.staff.push({ name: nm, email: em, username: un, salt: h.salt, hash: h.hash, created: Date.now() });
  inv.usedBy = un; save();
  startSession(res, { type: 'staff', username: un }, true);
  return { ok: true };
});
route('GET', '/api/reports/mine', async (req, res, b, s) => { const st = needStaff(s); return db.reports.filter((r) => r.username === st.username).slice().reverse(); });
route('POST', '/api/reports', async (req, res, b, s) => {
  const st = needStaff(s);
  const t = clean(b.title, 200), body = clean(b.body, 20000);
  if (!t || !body) bad('Add a title and the report.');
  db.reports.push({ id: id(), username: st.username, author: st.name, title: t, body, topic: clean(b.topic, 40), school: clean(b.school, 150) || ALL, date: Date.now(), status: 'pending' });
  save(); return { ok: true };
});

/* --- owner dashboard --- */
route('GET', '/api/admin/staff', async (req, res, b, s) => {
  needAdmin(s);
  return {
    ai: !!AI_KEY, students: db.users.length, settings: db.settings, pendingNews: db.pendingNews, invites: db.invites,
    staff: db.staff.map((x) => ({ name: x.name, username: x.username, email: x.email, created: x.created })),
    reports: db.reports.slice().reverse()
  };
});
/* Registered students for the owner dashboard. Password salt/hash are never sent. */
route('GET', '/api/admin/students', async (req, res, b, s) => {
  needAdmin(s);
  return db.users.map((u) => ({
    name: u.name, email: u.email, school: u.school,
    matric: u.matric || '', programme: u.programme || '',
    subjects: Array.isArray(u.subjects) ? u.subjects.length : 0,
    created: u.created || 0
  })).sort((a, b2) => b2.created - a.created);
});
route('POST', '/api/admin/invites', async (req, res, b, s) => {
  needAdmin(s);
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
  do { c = ''; for (let i = 0; i < 8; i++) c += A[crypto.randomInt(A.length)]; } while (db.invites.some((x) => x.code === c));
  db.invites.push({ code: c, created: Date.now(), usedBy: '' }); save(); return { code: c };
});
route('DELETE', '/api/admin/invites/:code', async (req, res, b, s, m) => { needAdmin(s); db.invites = db.invites.filter((x) => x.code !== m[1]); save(); return { ok: true }; });
route('DELETE', '/api/admin/staff/:u', async (req, res, b, s, m) => {
  needAdmin(s); const un = decodeURIComponent(m[1]);
  db.staff = db.staff.filter((x) => x.username !== un);
  db.sessions = db.sessions.filter((x) => !(x.type === 'staff' && x.username === un)); save(); return { ok: true };
});
route('POST', '/api/admin/reports/:id/:act', async (req, res, b, s, m) => {
  needAdmin(s);
  const r = db.reports.find((x) => String(x.id) === m[1]); if (!r) bad('Report not found.', 404);
  if (m[2] === 'delete') db.reports = db.reports.filter((x) => x !== r);
  else if (m[2] === 'reject') r.status = 'rejected';
  else if (m[2] === 'approve') {
    if (r.status !== 'approved') { db.posts.push(makePost({ t: r.topic, h: r.title, text: r.body + '\n\nReported by ' + r.author, school: r.school })); r.status = 'approved'; }
  } else bad('Unknown action.', 404);
  save(); return { ok: true };
});
route('POST', '/api/admin/posts', async (req, res, b, s) => {
  needAdmin(s);
  if (!clean(b.h, 200) || !clean(b.text, 20000)) bad('Add a headline and the full story.');
  const p = makePost(b); db.posts.push(p); save(); return { ok: true, id: p.id };
});
route('DELETE', '/api/admin/posts/:id', async (req, res, b, s, m) => { needAdmin(s); db.posts = db.posts.filter((p) => String(p.id) !== m[1]); save(); return { ok: true }; });
route('POST', '/api/admin/posts/:id/:act', async (req, res, b, s, m) => {
  needAdmin(s);
  const p = db.pendingNews.find((x) => String(x.id) === m[1]); if (!p) bad('Not found.', 404);
  db.pendingNews = db.pendingNews.filter((x) => x !== p);
  if (m[2] === 'approve') { const { src, ...post } = p; db.posts.push(post); }
  save(); return { ok: true };
});
route('POST', '/api/admin/schools', async (req, res, b, s) => {
  needAdmin(s); const n = clean(b.name, 150); if (!n) bad('Enter a school name.');
  if (!db.schools.includes(n)) db.schools.push(n); save(); return { ok: true };
});
route('POST', '/api/admin/outlines', async (req, res, b, s) => {
  needAdmin(s);
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((x) => ({ t: clean(x && x.t, 160), u: Math.min(10, Math.max(0, +(x && x.u) || 0)) })).filter((x) => x.t);
  if (!clean(b.school, 150) || !clean(b.programme, 150) || !items.length) bad('Add a school, a programme and at least one course.');
  db.outlines.push({ id: id(), school: clean(b.school, 150), programme: clean(b.programme, 150), level: clean(b.level, 20), items }); save(); return { ok: true };
});
route('DELETE', '/api/admin/outlines/:id', async (req, res, b, s, m) => { needAdmin(s); db.outlines = db.outlines.filter((o) => String(o.id) !== m[1]); save(); return { ok: true }; });
route('POST', '/api/admin/settings', async (req, res, b, s) => { needAdmin(s); if (typeof b.autoPublish === 'boolean') db.settings.autoPublish = b.autoPublish; save(); return { ok: true }; });
route('GET', '/api/admin/export', async (req, res, b, s) => {
  needAdmin(s);
  const strip = (u) => { const { salt, hash, ...rest } = u; return rest; };
  return { exported: new Date().toISOString(), users: db.users.map(strip), staff: db.staff.map(strip), invites: db.invites, reports: db.reports, posts: db.posts, schools: db.schools, outlines: db.outlines };
});

/* AI news desk: asks Claude to search the web, then keeps only items whose link really opens. */
route('POST', '/api/admin/news/run', async (req, res, b, s) => {
  needAdmin(s);
  const txt = await ai([{ role: 'user', content: 'Search the web for 5 recent (last 14 days) news items useful to Nigerian students: admissions, JAMB, WAEC, scholarships, school calendars. Reply with ONLY a JSON array, no prose. Each item: {"t":"JAMB|WAEC|Scholarships|Admissions|Campus","h":"headline","x":"one-sentence summary","text":"2-3 short factual paragraphs","src":"https://exact-article-url"}.' }],
    { max_tokens: 4000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }] });
  let items = []; try { items = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1)); } catch (e) { bad('The news search returned something unreadable. Try again.', 502); }
  let added = 0, skipped = 0;
  for (const it of items.slice(0, 8)) {
    try {
      const src = String(it.src || ''); if (!/^https?:\/\//i.test(src) || !clean(it.h, 200) || !clean(it.text, 20000)) { skipped++; continue; }
      if (db.posts.concat(db.pendingNews).some((p) => p.h === clean(it.h, 200))) { skipped++; continue; }
      const r = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 TobiNewsDesk' } });
      if (!r.ok) { skipped++; continue; }
      const post = makePost({ t: it.t, h: it.h, x: it.x, text: it.text, link: src, school: ALL }); post.d = 'News'; post.src = src;
      if (db.settings.autoPublish) { delete post.src; db.posts.push(post); } else db.pendingNews.push(post);
      added++;
    } catch (e) { skipped++; }
  }
  save(); return { added, skipped };
});

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      const method = req.method;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = p.match(r.re); if (!m) continue;
        const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};
        const out = await r.handler(req, res, body, getSession(req), m);
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Not allowed.' });
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    // optional static files placed next to server.js in ./public
    const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
    if (file.startsWith(path.join(__dirname, 'public') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp' };
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(file));
    }
    send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'Something went wrong on the server.' });
  }
});
server.listen(PORT, () => {
  console.log('Tobi site running on http://localhost:' + PORT);
  console.log('Data is saved in ' + DB_FILE);
  if (!process.env.ADMIN_PASSWORD) console.log('Owner login uses the password already set in index.html (set ADMIN_PASSWORD to change it).');
  if (!AI_KEY) console.log('AI features are off (set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY).');
  else console.log('AI is on via ' + (USE_GATEWAY ? 'Vercel AI Gateway' : 'Anthropic') + ', model ' + AI_MODEL);
});
