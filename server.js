const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const dotenv = require('dotenv');
const { Pool, types } = require('pg');

dotenv.config({ path: path.join(__dirname, '.env') });

// Hosting platforms (Render, etc.) provide PORT and need the server on 0.0.0.0.
const PORT = Number(process.env.PORT || process.env.TWW_PORT || 5001);
const HOST = process.env.TWW_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const FRONTEND_FILE = process.env.TWW_FRONTEND_FILE || path.join(__dirname, 'index.html');
const ADMIN_FILE = process.env.TWW_ADMIN_FILE || path.join(__dirname, 'admin.html');
const ALLOWED_ORIGIN = process.env.TWW_ALLOWED_ORIGIN || `http://localhost:${PORT}`;

const DEFAULT_POSTS = [
  { id: 6, t: 'JAMB', h: 'How to prepare for JAMB in 8 weeks', x: 'A simple weekly plan that balances your four subjects and leaves time for practice.', r: 6, d: 'Study guide', body: '<p>Eight weeks is enough time to improve your score if you follow a plan instead of reading randomly. Use the official JAMB syllabus and practise timed past questions every week.</p>', school: 'All schools', date: '2026-10-03' },
  { id: 5, t: 'Scholarships', h: 'Five signs a scholarship offer is genuine', x: 'Protect yourself from fake offers before you share any personal details.', r: 5, d: 'Safety', body: '<p>Check the provider\'s official website and criteria. Never pay to be considered or share bank PINs, card details, or passwords.</p>', school: 'All schools', date: '2026-10-03' },
  { id: 4, t: 'Admissions', h: 'Post-UTME checklist: what to prepare', x: 'Get your documents and details ready early so you are not rushing on the deadline.', r: 4, d: 'Checklist', body: '<p>Requirements differ by institution. Check the current notice on your university\'s official portal before applying.</p>', school: 'All schools', date: '2026-10-03' },
  { id: 3, t: 'WAEC', h: 'WAEC exam day: what to bring and what to avoid', x: 'A short list that helps you stay calm and avoid avoidable mistakes.', r: 3, d: 'Exam tips', body: '<p>Pack permitted materials in advance, arrive early, and follow the instructions on your examination slip.</p>', school: 'All schools', date: '2026-10-03' },
  { id: 2, t: 'Campus', h: 'Study smarter: five habits first-year students need', x: 'Habits that help you keep up from your very first semester.', r: 5, d: 'Campus life', body: '<p>Attend classes, review notes within a day, form a focused study group, practise with past questions, and plan your week.</p>', school: 'All schools', date: '2026-10-03' },
  { id: 1, t: 'Scholarships', h: 'Write a scholarship essay that stands out', x: 'A clear structure for a short personal statement you can adapt to any application.', r: 6, d: 'Writing guide', body: '<p>Use one real experience, explain your goal, give evidence, and finish with the impact you hope to make.</p>', school: 'All schools', date: '2026-10-03' }
];
const ANTHROPIC_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const NUC_PAGES = {
  Federal: 'https://www.nuc.edu.ng/wp-json/wp/v2/pages/165',
  State: 'https://www.nuc.edu.ng/wp-json/wp/v2/pages/163',
  Private: 'https://www.nuc.edu.ng/wp-json/wp/v2/pages/161'
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2_sha256$310000$${salt.toString('hex')}$${digest.toString('hex')}`;
}

function verifyPassword(password, hash) {
  try {
    const [scheme, rounds, saltHex, expectedHex] = hash.split('$');
    if (scheme !== 'pbkdf2_sha256' || !/^\d+$/.test(rounds)) return false;
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = crypto.pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), Number(rounds), expected.length, 'sha256');
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function jsonSafe(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) {
      copy[key] = jsonSafe(value[key]);
    }
    return copy;
  }
  return value;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(jsonSafe(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendHtml(res, status, content) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  });
  res.end(content);
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Invalid JSON');
  }
}

function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function getUserFromToken(req) {
  const token = getToken(req);
  if (!token) return null;
  const rows = await dbRows(
    'SELECT u.Id, u.FullName, u.Email, u.IsAdmin, u.UniversityId, u.Matric, u.Programme, u.Subjects, u.AiOutline, v.Name AS University '
    + 'FROM dbo.ApiSessions s JOIN dbo.StudentProfiles u ON u.Id = s.StudentId '
    + 'JOIN dbo.Universities v ON v.Id = u.UniversityId '
    + 'WHERE s.TokenHash = ? AND s.ExpiresAt > SYSUTCDATETIME()',
    [tokenHash(token)]
  );
  return rows[0] || null;
}

async function getPortalUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const rows = await dbRows(
    'SELECT s.UserType AS role, a.Id, a.Username, a.DisplayName AS FullName, a.Email '
    + 'FROM dbo.PortalSessions s JOIN dbo.PortalAdmins a ON s.UserType = N\'admin\' AND a.Id = s.UserId '
    + 'WHERE s.TokenHash = ? AND s.ExpiresAt > SYSUTCDATETIME() '
    + 'UNION ALL '
    + 'SELECT s.UserType AS role, r.Id, r.Username, r.FullName, r.Email '
    + 'FROM dbo.PortalSessions s JOIN dbo.Reporters r ON s.UserType = N\'reporter\' AND r.Id = s.UserId '
    + 'WHERE s.TokenHash = ? AND s.ExpiresAt > SYSUTCDATETIME()',
    [tokenHash(token), tokenHash(token)]
  );
  return rows[0] || null;
}

let pool;
let readyPromise;

// Postgres lowercases column names; map them back so r.FullName etc. keep working.
const COLUMN_NAMES = ('Id FullName Email IsAdmin UniversityId University Username DisplayName PasswordHash Name Category State '
  + 'SourceUrl SourceUpdatedAt Topic Headline Summary BodyHtml ReadingMinutes School PublishedAt SourceHost IsOfficialSource '
  + 'CreatedAt Title Body Status SubmittedAt Author AutoPublishOfficial Total LastSync SenderId RecipientId SentAt UsedBy '
  + 'SourceTitle Connected UserType UserId Matric Programme Subjects AiOutline').split(' ');
const CANONICAL = new Map(COLUMN_NAMES.map(name => [name.toLowerCase(), name]));
types.setTypeParser(20, value => Number(value)); // BIGINT / COUNT(*) as numbers

function restoreCase(row) {
  for (const key of Object.keys(row)) {
    const canonical = CANONICAL.get(key);
    if (canonical && canonical !== key && !(canonical in row)) {
      Object.defineProperty(row, canonical, { value: row[key], enumerable: false });
    }
  }
  return row;
}

// Translates the small T-SQL dialect used in the route code into PostgreSQL.
function toPostgres(query) {
  let q = query
    .replace(/\bdbo\./g, '')
    .replace(/\bN'/g, "'")
    .replace(/DATEADD\(day,\s*(\d+),\s*SYSUTCDATETIME\(\)\)/g, "(now() + interval '$1 days')")
    .replace(/SYSUTCDATETIME\(\)/g, 'now()')
    .replace(/(^|;\s*)DELETE\s+(?!FROM\b)/g, '$1DELETE FROM ')
    .replace(/^(\s*)INSERT\s+(?!INTO\b)/i, '$1INSERT INTO ');
  const output = q.match(/\sOUTPUT\s+((?:INSERTED\.\w+(?:,\s*)?)+)/i);
  if (output) {
    q = q.replace(output[0], '');
    q += ' RETURNING ' + output[1].replace(/INSERTED\./gi, '');
  }
  let n = 0;
  return q.replace(/\?/g, () => '$' + (++n));
}

function databaseUrl() {
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SQL_CONNECTION_STRING;
  if (!raw) throw new Error('Set DATABASE_URL to your PostgreSQL connection string before using database-backed routes');
  return raw;
}

function poolConfig() {
  const url = new URL(databaseUrl());
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const useSsl = process.env.DATABASE_SSL ? process.env.DATABASE_SSL !== 'false' : !(local || sslmode === 'disable');
  return {
    connectionString: url.toString(),
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  };
}

async function seedAdmin() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!username || password.length < 8) return;
  const existing = await pool.query('SELECT 1 FROM PortalAdmins WHERE Username = $1', [username]);
  if (existing.rowCount) return;
  await pool.query(
    'INSERT INTO PortalAdmins (Username, DisplayName, Email, PasswordHash) VALUES ($1, $2, $3, $4)',
    [username, process.env.ADMIN_NAME || username, process.env.ADMIN_EMAIL || null, hashPassword(password)]
  );
  console.log('Created portal admin:', username);
}

function connectDatabase() {
  if (!readyPromise) {
    const config = poolConfig();
    pool = new Pool(config);
    pool.on('error', error => console.error('Postgres pool error:', error.code || error.message));
    readyPromise = (async () => {
      await pool.query(fs.readFileSync(path.join(__dirname, 'api', 'schema.sql'), 'utf8'));
      await seedAdmin();
      return pool;
    })().catch(error => {
      readyPromise = undefined;
      const failed = pool;
      pool = undefined;
      if (failed) failed.end().catch(() => {});
      throw error;
    });
  }
  return readyPromise;
}

async function queryDatabase(query, params = []) {
  const db = await connectDatabase();
  const result = await db.query(toPostgres(query), params);
  result.rows.forEach(restoreCase);
  return result;
}

async function dbRows(query, params = []) {
  return (await queryDatabase(query, params)).rows;
}

async function dbWrite(query, params = []) {
  const result = await queryDatabase(query, params);
  return result.rows[0] ?? result.rowCount ?? 0;
}

// Runs fn(q) inside a transaction. q(query, params) accepts the same ? syntax as dbRows.
async function withTransaction(fn) {
  const db = await connectDatabase();
  const client = await db.connect();
  const q = async (query, params = []) => {
    const result = await client.query(toPostgres(query), params);
    result.rows.forEach(restoreCase);
    return result;
  };
  try {
    await client.query('BEGIN');
    const value = await fn(q);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  sendHtml(res, 200, content);
}

async function getStudentList(user) {
  if (!user) return [];
  return dbRows(
    'SELECT Id AS id, FullName AS name FROM dbo.StudentProfiles WHERE UniversityId = ? AND Id <> ? ORDER BY FullName',
    [user.UniversityId, user.Id]
  );
}

async function requireStudent(req) {
  return getUserFromToken(req);
}

async function issueSession(student) {
  const token = crypto.randomBytes(32).toString('base64url');
  await dbWrite(
    'INSERT dbo.ApiSessions (TokenHash, StudentId, ExpiresAt) VALUES (?, ?, DATEADD(day, 7, SYSUTCDATETIME()))',
    [tokenHash(token), student.Id]
  );
  return token;
}

async function issuePortalSession(account, type) {
  const token = crypto.randomBytes(32).toString('base64url');
  await dbWrite(
    'INSERT dbo.PortalSessions (TokenHash, UserType, UserId, ExpiresAt) VALUES (?, ?, ?, DATEADD(day, 7, SYSUTCDATETIME()))',
    [tokenHash(token), type, account.Id]
  );
  return token;
}

function isPublicAddress(address) {
  const version = require('net').isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [first, second, third] = octets;
    return !(first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168) && (second !== 0 || third === 0))
      || (first === 192 && second === 0 && third === 2)
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113));
  }
  if (version !== 6) return false;
  const firstHextet = Number.parseInt(address.split(':')[0] || '0', 16);
  return firstHextet >= 0x2000 && firstHextet < 0x4000;
}

async function validatePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Source must be a public HTTPS page');
  }
  const dns = require('dns').promises;
  const addresses = require('net').isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error('Source resolved to a non-public address');
  }
  return url;
}

async function fetchArticlePage(sourceUrl) {
  let url = sourceUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await validatePublicUrl(url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'TobiWorldWide/1.0 (news source verification)' },
      signal: AbortSignal.timeout(12000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Too many source redirects');
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error('Source page did not open successfully');
    const reader = response.body.getReader();
    const chunks = [];
    let byteCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > 1_500_000) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const page = Buffer.concat(chunks).toString('utf8');
    const titleMatch = page.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    const decode = text => text.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
    const title = decode((titleMatch ? titleMatch[1] : '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 300);
    const text = decode(page.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').toLowerCase();
    return { finalUrl: response.url || url, title, text };
  }
  throw new Error('Source page could not be verified');
}

function officialHost(host) {
  const configured = (process.env.TWW_OFFICIAL_DOMAINS || 'nuc.edu.ng').split(',').map(value => value.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  configured.push('edu.ng', 'gov.ng');
  return configured.some(domain => host === domain || host.endsWith(`.${domain}`));
}

async function discoverNews() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to enable verified news search');
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      messages: [{ role: 'user', content: 'Search for recent Nigerian university, admissions, scholarships, JAMB, WAEC, or campus announcements. Return JSON only in the shape {"items":[{"headline":string,"summary":string,"body":string,"topic":"Admissions|Scholarships|JAMB|WAEC|Campus","school":string,"source_url":string}]}. Use only pages found by web search, make the headline closely match the page title, and do not invent details. Keep summaries under 200 characters and include a concise factual body.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    }),
    signal: AbortSignal.timeout(75000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Anthropic news search failed');
  const searchedUrls = new Set();
  const textParts = [];
  for (const block of result.content || []) {
    if (block.type === 'text') {
      textParts.push(block.text || '');
      for (const citation of block.citations || []) if (citation.url) searchedUrls.add(citation.url);
    } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) if (item.type === 'web_search_result' && item.url) searchedUrls.add(item.url);
    }
  }
  const responseText = textParts.join('\n');
  const start = responseText.indexOf('{');
  const end = responseText.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI search did not return a usable news list');
  const items = JSON.parse(responseText.slice(start, end + 1)).items || [];
  const topics = new Set(['Admissions', 'Scholarships', 'JAMB', 'WAEC', 'Campus']);
  const verified = [];
  for (const item of items.slice(0, 10)) {
    const headline = String(item.headline || '').trim().slice(0, 140);
    const sourceUrl = String(item.source_url || '').trim();
    if (!headline || !searchedUrls.has(sourceUrl)) continue;
    try {
      const source = await fetchArticlePage(sourceUrl);
      const terms = headline.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      const matched = terms.filter(term => source.title.toLowerCase().includes(term)).length;
      const required = Math.max(1, Math.ceil(terms.length * 0.45));
      if (!source.title || (matched < required && !source.text.includes(headline.toLowerCase()))) continue;
      const finalUrl = new URL(source.finalUrl);
      const summary = String(item.summary || '').trim().slice(0, 200);
      const body = String(item.body || '').trim().slice(0, 5000);
      if (!summary || !body) continue;
      verified.push({
        topic: topics.has(item.topic) ? item.topic : 'Campus', headline, summary, body,
        school: String(item.school || 'All schools').trim().slice(0, 200) || 'All schools',
        sourceUrl: finalUrl.toString(), sourceTitle: source.title, sourceHost: finalUrl.hostname,
        official: officialHost(finalUrl.hostname)
      });
    } catch (error) {
      continue;
    }
  }
  return verified;
}

function articleHtml(body) {
  return body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('');
}

function readingMinutes(body) {
  return Math.max(1, Math.ceil(body.split(/\s+/).filter(Boolean).length / 200));
}

function decodeHtml(value) {
  return value.replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function universityRows(markup) {
  const rows = [];
  for (const rowMatch of markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)]
      .map(match => decodeHtml(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

let universitySyncPromise;

async function syncUniversities(force) {
  const stats = await dbRows('SELECT COUNT(*) AS Total, MAX(SourceUpdatedAt) AS LastSync FROM dbo.Universities WHERE IsActive = true');
  const current = Number(stats[0]?.Total || 0);
  const lastSync = stats[0]?.LastSync ? new Date(stats[0].LastSync).getTime() : 0;
  if (current >= 300 && !force && lastSync >= Date.now() - 7 * 24 * 60 * 60 * 1000) return current;

  const imported = [];
  for (const [category, sourceUrl] of Object.entries(NUC_PAGES)) {
    const response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'TobiWorldWide/1.0 (university directory sync)' },
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error(`NUC directory request failed with HTTP ${response.status}`);
    const payload = await response.json();
    const markup = payload?.content?.rendered || '';
    for (const row of universityRows(markup)) {
      const name = row[1].trim();
      if (!name || name.toUpperCase().includes('UNIVERSITIES') || /^\d+$/.test(name) || name.length < 5) continue;
      imported.push({ name, category, sourceUrl });
    }
  }
  if (imported.length < 300) {
    throw new Error(`NUC directory sync returned only ${imported.length} rows; refusing partial replacement`);
  }

  await withTransaction(async q => {
    await q('UPDATE dbo.Universities SET IsActive = false');
    for (const university of imported) {
      await q(
        'INSERT dbo.Universities (Name, Category, SourceUrl, SourceUpdatedAt, IsActive) VALUES (?, ?, ?, now(), true) '
        + 'ON CONFLICT (Name) DO UPDATE SET Category = EXCLUDED.Category, SourceUrl = EXCLUDED.SourceUrl, SourceUpdatedAt = EXCLUDED.SourceUpdatedAt, IsActive = true',
        [university.name, university.category, university.sourceUrl]
      );
    }
  });
  return imported.length;
}

function refreshUniversities(force = false) {
  if (!universitySyncPromise) {
    universitySyncPromise = syncUniversities(force).finally(() => {
      universitySyncPromise = undefined;
    });
  }
  return universitySyncPromise;
}

function parseSubjects(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

function cleanSubjects(input) {
  if (!Array.isArray(input) || input.length > 20) return null;
  const seen = new Set();
  const result = [];
  for (const item of input) {
    const title = String(item && item.t || '').trim().slice(0, 80);
    const id = String(item && item.id || '').trim().slice(0, 40);
    const units = Math.min(10, Math.max(1, Math.round(Number(item && item.u) || 2)));
    if (!title || !id || seen.has(title.toLowerCase())) return null;
    seen.add(title.toLowerCase());
    result.push({ id, t: title, u: units });
  }
  return result;
}

const rateBuckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= limit) {
    rateBuckets.set(key, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return false;
}

class FriendlyError extends Error {}

async function askClaude(system, messages, maxTokens, timeoutMs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new FriendlyError('The tutor has not been switched on yet.');
  let lastProblem = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    try {
      const response = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
        if (text) return text;
        lastProblem = 'empty answer';
        continue;
      }
      lastProblem = `HTTP ${response.status}: ${result.error?.message || 'no message'}`;
      if (![429, 500, 502, 503, 504, 529].includes(response.status)) break; // not worth retrying (bad key, no credit, etc.)
    } catch (error) {
      lastProblem = error.message || String(error);
    }
  }
  console.error('Tutor AI request failed:', lastProblem);
  throw new FriendlyError('The tutor could not answer just now. Please send your question again in a moment.');
}

function tutorMessages(history, question) {
  const turns = [];
  for (const item of Array.isArray(history) ? history.slice(-6) : []) {
    const role = item && item.role === 'assistant' ? 'assistant' : item && item.role === 'user' ? 'user' : null;
    const text = String(item && item.text || '').trim().slice(0, 2000);
    if (!role || !text) continue;
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += '\n' + text;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (turns.length && turns[turns.length - 1].role === 'user') turns[turns.length - 1].content += '\n' + question;
  else turns.push({ role: 'user', content: question });
  return turns;
}

const TUTOR_MODES = {
  explain: 'Explain the topic or question clearly, step by step, with one simple example. Keep it under 300 words.',
  quiz: 'Write a short quiz of 5 questions on the topic, with the answers listed at the end. Keep questions at university level.',
  plan: 'Give a practical reading plan for the topic across the coming days, with specific things to read and practise. Keep it under 300 words.'
};

function routeTable() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname, searchParams } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin'
      });
      res.end();
      return;
    }

    try {
      if (pathname === '/api/health') {
        await dbRows('SELECT 1 AS Connected');
        sendJson(res, 200, { ok: true, status: 'ok', database: 'postgres' });
        return;
      }

      if (pathname === '/api/posts' && req.method === 'GET') {
        const rows = await dbRows('SELECT * FROM dbo.NewsArticles ORDER BY PublishedAt DESC LIMIT 200');
        if (rows.length) {
          const posts = rows.map(r => ({
            id: r.Id,
            t: r.Topic,
            h: r.Headline,
            x: r.Summary,
            r: r.ReadingMinutes || 3,
            d: 'News',
            body: r.BodyHtml,
            school: r.School || 'All schools',
            date: new Date(r.PublishedAt).toISOString().slice(0, 10)
          }));
          sendJson(res, 200, posts.concat(DEFAULT_POSTS));
          return;
        }
        sendJson(res, 200, DEFAULT_POSTS);
        return;
      }

      if (pathname === '/api/universities') {
        try { await refreshUniversities(); } catch (syncError) { console.error('University sync failed:', syncError.message); }
        const rows = await dbRows('SELECT Id, Name, Category, State, SourceUrl, SourceUpdatedAt FROM dbo.Universities WHERE IsActive = true ORDER BY Name');
        sendJson(res, 200, rows.map(r => ({ Id: r.Id, Name: r.Name, Category: r.Category, State: r.State, SourceUrl: r.SourceUrl })));
        return;
      }

      if (pathname === '/api/me') {
        const user = await getUserFromToken(req);
        if (!user) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, {
          name: user.FullName, email: user.Email, school: user.University, admin: !!user.IsAdmin,
          matric: user.Matric || '', programme: user.Programme || '', subjects: parseSubjects(user.Subjects),
          aiOutline: user.AiOutline || '', tutor: !!process.env.ANTHROPIC_API_KEY
        });
        return;
      }

      if (pathname === '/api/auth/register') {
        const body = await parseBody(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const universityId = Number(body.universityId || 0);
        if (!name || name.length > 80 || !email.includes('@') || email.length > 120 || password.length < 8) {
          sendJson(res, 400, { error: 'invalid_registration' });
          return;
        }
        const university = await dbRows('SELECT Id FROM dbo.Universities WHERE Id = ? AND IsActive = true', [universityId]);
        if (!university.length) {
          sendJson(res, 400, { error: 'invalid_university' });
          return;
        }
        let student;
        try {
          student = await dbWrite(
            'INSERT dbo.StudentProfiles (FullName, Email, PasswordHash, UniversityId, IsAdmin) OUTPUT INSERTED.Id '
            + 'VALUES (?, ?, ?, ?, false)',
            [name, email, hashPassword(password), universityId]
          );
        } catch (err) {
          if (err.code === '23505') {
            sendJson(res, 409, { error: 'email_exists' });
            return;
          }
          throw err;
        }
        sendJson(res, 201, { id: student.Id, message: 'account_created' });
        return;
      }

      if (pathname === '/api/auth/login') {
        const body = await parseBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const rows = await dbRows(
          'SELECT Id, FullName, Email, PasswordHash, IsAdmin, UniversityId FROM dbo.StudentProfiles WHERE Email = ?',
          [email]
        );
        const student = rows[0];
        if (!student || !verifyPassword(password, student.PasswordHash)) {
          sendJson(res, 401, { error: 'invalid_credentials' });
          return;
        }
        const token = await issueSession(student);
        const universities = await dbRows('SELECT Name FROM dbo.Universities WHERE Id = ?', [student.UniversityId]);
        if (!universities.length) {
          sendJson(res, 401, { error: 'invalid_credentials' });
          return;
        }
        sendJson(res, 200, { token, user: { name: student.FullName, email: student.Email, school: universities[0].Name, admin: !!student.IsAdmin } });
        return;
      }

      if (pathname === '/api/auth/logout') {
        const token = getToken(req);
        if (token) await dbWrite('DELETE dbo.ApiSessions WHERE TokenHash = ?', [tokenHash(token)]);
        sendJson(res, 200, { message: 'logged_out' });
        return;
      }

      if (pathname === '/api/me/university' && req.method === 'POST') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await parseBody(req);
        const universityId = Number(body.universityId || 0);
        const university = await dbRows('SELECT Id FROM dbo.Universities WHERE Id = ? AND IsActive = true', [universityId]);
        if (!university.length) {
          sendJson(res, 400, { error: 'invalid_university' });
          return;
        }
        await dbWrite('UPDATE dbo.StudentProfiles SET UniversityId = ? WHERE Id = ?', [universityId, student.Id]);
        sendJson(res, 200, { message: 'university_updated' });
        return;
      }

      if (pathname === '/api/admin/sync-universities' && req.method === 'POST') {
        const student = await getUserFromToken(req);
        if (!student || !student.IsAdmin) {
          sendJson(res, student ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const count = await refreshUniversities(true);
        sendJson(res, 200, { count, source: 'https://www.nuc.edu.ng/nigerian-univerisities/' });
        return;
      }

      if (pathname === '/api/posts' && req.method === 'POST') {
        const student = await requireStudent(req);
        if (!student || !student.IsAdmin) {
          sendJson(res, student ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const body = await parseBody(req);
        const headline = String(body.title || '').trim();
        const summary = String(body.summary || '').trim();
        const article = String(body.body || '').trim();
        const topic = String(body.topic || '').trim();
        const school = String(body.school || 'All schools').trim();
        const sourceUrl = String(body.sourceUrl || '').trim() || null;
        if (!headline || headline.length > 140 || !summary || summary.length > 200 || !article
          || !['Admissions', 'Scholarships', 'JAMB', 'WAEC', 'Campus'].includes(topic)) {
          sendJson(res, 400, { error: 'invalid_post' });
          return;
        }
        if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
          sendJson(res, 400, { error: 'invalid_source_url' });
          return;
        }
        const post = await dbWrite(
          'INSERT dbo.NewsArticles (Topic, Headline, Summary, BodyHtml, ReadingMinutes, School, SourceUrl, AuthorId) OUTPUT INSERTED.Id '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [topic, headline, summary, article, readingMinutes(article), school, sourceUrl, student.Id]
        );
        sendJson(res, 201, { id: post.Id, message: 'published' });
        return;
      }

      if (pathname === '/api/profile' && req.method === 'PUT') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'Please log in again.' });
          return;
        }
        const body = await parseBody(req);
        const matric = String(body.matric || '').trim().slice(0, 60);
        const programme = String(body.programme || '').trim().slice(0, 160);
        const subjects = cleanSubjects(body.subjects || []);
        if (!subjects) {
          sendJson(res, 400, { error: 'Check your subjects: up to 20, each with a different name.' });
          return;
        }
        await dbWrite('UPDATE dbo.StudentProfiles SET Matric = ?, Programme = ?, Subjects = ? WHERE Id = ?', [matric, programme, JSON.stringify(subjects), student.Id]);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/tutor' && req.method === 'POST') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'Please log in again.' });
          return;
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          sendJson(res, 503, { error: 'The tutor has not been switched on yet.' });
          return;
        }
        const body = await parseBody(req);
        const subject = String(body.subject || '').trim();
        const mode = Object.prototype.hasOwnProperty.call(TUTOR_MODES, body.mode) ? body.mode : 'explain';
        const question = String(body.question || '').trim().slice(0, 600);
        if (!question) {
          sendJson(res, 400, { error: 'Type a topic or a question.' });
          return;
        }
        if (!parseSubjects(student.Subjects).some(item => item.t === subject)) {
          sendJson(res, 400, { error: 'Add that subject to your study guide first.' });
          return;
        }
        if (rateLimited(`tutor:${student.Id}`, 30, 60 * 60 * 1000)) {
          sendJson(res, 429, { error: 'You have asked many questions in the last hour. Please try again in a while.' });
          return;
        }
        const system = `You are a patient university tutor for a Nigerian student${student.Programme ? ` studying ${student.Programme}` : ''} at ${student.University}. `
          + `The current course is "${subject}". ${TUTOR_MODES[mode]} Use plain language and short paragraphs without markdown symbols. `
          + 'If you are not sure about a fact, say so and tell the student to confirm with their lecturer or course material. Stay on the course topic.';
        const text = await askClaude(system, tutorMessages(body.history, question), 900, 60000);
        sendJson(res, 200, { text });
        return;
      }

      if (pathname === '/api/outline/generate' && req.method === 'POST') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'Please log in again.' });
          return;
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          sendJson(res, 503, { error: 'The course outline has not been switched on yet.' });
          return;
        }
        const subjects = parseSubjects(student.Subjects);
        if (!subjects.length) {
          sendJson(res, 400, { error: 'Add your subjects first, then generate the outline.' });
          return;
        }
        if (rateLimited(`outline:${student.Id}`, 5, 60 * 60 * 1000)) {
          sendJson(res, 429, { error: 'You have generated several outlines in the last hour. Please try again later.' });
          return;
        }
        const list = subjects.map(item => `${item.t} (${item.u} unit${item.u > 1 ? 's' : ''})`).join('; ');
        const system = 'You write study outlines for Nigerian university students. For each course, list 6 to 8 key topics in the order a student should study them, '
          + 'then one short line on how to prepare. Use plain text with the course name on its own line, numbered topics, and no markdown symbols. '
          + 'Do not invent lecturer names or exam dates. End with one sentence reminding the student to confirm the real syllabus with their department.';
        const text = await askClaude(system, [{ role: 'user', content: `University: ${student.University}\nProgramme: ${student.Programme || 'not stated'}\nCourses: ${list}` }], 2400, 85000);
        await dbWrite('UPDATE dbo.StudentProfiles SET AiOutline = ? WHERE Id = ?', [text, student.Id]);
        sendJson(res, 200, { text });
        return;
      }

      if (pathname === '/api/portal/login') {
        const body = await parseBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const admins = await dbRows(
          'SELECT Id, Username, DisplayName AS FullName, Email, PasswordHash FROM dbo.PortalAdmins WHERE Username = ?',
          [username]
        );
        let account = admins[0];
        let role = 'admin';
        if (!account) {
          const reporters = await dbRows(
            'SELECT Id, Username, FullName, Email, PasswordHash FROM dbo.Reporters WHERE Username = ?',
            [username]
          );
          account = reporters[0];
          role = 'reporter';
        }
        if (!account || !verifyPassword(password, account.PasswordHash)) {
          sendJson(res, 401, { error: 'invalid_credentials' });
          return;
        }
        const token = await issuePortalSession(account, role);
        sendJson(res, 200, { token, user: { role, username: account.Username, name: account.FullName, email: account.Email } });
        return;
      }

      if (pathname === '/api/portal/signup') {
        const body = await parseBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!name || name.length > 120 || !email.includes('@') || email.length > 120
          || username.length < 3 || username.length > 80 || !/^[a-zA-Z0-9_.-]+$/.test(username) || password.length < 8) {
          sendJson(res, 400, { error: 'invalid_signup' });
          return;
        }
        let inviteOk = true;
        try {
          await withTransaction(async q => {
            const invites = await q('SELECT Id FROM dbo.ReporterInvites WHERE CodeHash = ? AND UsedByReporterId IS NULL FOR UPDATE', [tokenHash(code)]);
            if (!invites.rows.length) { inviteOk = false; return; }
            const created = await q('INSERT dbo.Reporters (Username, FullName, Email, PasswordHash) OUTPUT INSERTED.Id VALUES (?, ?, ?, ?)',
              [username, name, email, hashPassword(password)]);
            await q('UPDATE dbo.ReporterInvites SET UsedByReporterId = ?, UsedAt = SYSUTCDATETIME() WHERE Id = ? AND UsedByReporterId IS NULL',
              [created.rows[0].Id, invites.rows[0].Id]);
          });
        } catch (error) {
          if (error.code === '23505') {
            sendJson(res, 409, { error: 'account_exists' });
            return;
          }
          throw error;
        }
        if (!inviteOk) {
          sendJson(res, 400, { error: 'invalid_invite' });
          return;
        }
        sendJson(res, 201, { message: 'account_created' });
        return;
      }

      if (pathname === '/api/portal/me') {
        const current = await getPortalUser(req);
        if (!current) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, { role: current.role, username: current.Username, name: current.FullName, email: current.Email });
        return;
      }

      if (pathname === '/api/portal/logout') {
        const token = getToken(req);
        if (token) await dbWrite('DELETE dbo.PortalSessions WHERE TokenHash = ?', [tokenHash(token)]);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/admin/staff') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const pending = await dbRows(
          "SELECT Id, Headline, SourceUrl, SourceHost, IsOfficialSource, CreatedAt FROM dbo.PendingNewsArticles WHERE Status = N'pending' ORDER BY CreatedAt DESC"
        );
        const reporters = await dbRows('SELECT Username, FullName, Email, CreatedAt FROM dbo.Reporters ORDER BY CreatedAt DESC');
        const reports = await dbRows(
          'SELECT r.Id, r.Title, r.Body, r.Status, r.SubmittedAt, p.Username AS Author '
          + 'FROM dbo.SubmittedReports r JOIN dbo.Reporters p ON p.Id = r.ReporterId ORDER BY r.SubmittedAt DESC'
        );
        const settings = await dbRows('SELECT AutoPublishOfficial FROM dbo.NewsDeskSettings WHERE Id = 1');
        const totals = await dbRows('SELECT COUNT(*) AS Total FROM dbo.StudentProfiles');
        if (!settings.length || !totals.length) throw new Error('Database schema is not initialized; run api/schema.sql first');
        sendJson(res, 200, {
          ai: !!process.env.ANTHROPIC_API_KEY,
          students: totals[0].Total,
          settings: { autoPublish: !!settings[0].AutoPublishOfficial },
          pendingNews: pending.map(row => ({ id: row.Id, h: row.Headline, src: row.SourceUrl, host: row.SourceHost, official: !!row.IsOfficialSource, created: row.CreatedAt })),
          invites: [],
          staff: reporters.map(row => ({ name: row.FullName, username: row.Username, email: row.Email, created: row.CreatedAt })),
          reports: reports.map(row => ({ id: String(row.Id), title: row.Title, body: row.Body, status: row.Status, date: row.SubmittedAt, author: row.Author }))
        });
        return;
      }

      if (pathname === '/api/admin/settings') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const body = await parseBody(req);
        if (typeof body.autoPublish !== 'boolean') {
          sendJson(res, 400, { error: 'invalid_setting' });
          return;
        }
        await dbWrite('UPDATE dbo.NewsDeskSettings SET AutoPublishOfficial = ?, UpdatedAt = SYSUTCDATETIME() WHERE Id = 1', [body.autoPublish]);
        sendJson(res, 200, { autoPublish: body.autoPublish });
        return;
      }

      if (pathname === '/api/admin/news/run') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        if (!process.env.ANTHROPIC_API_KEY) {
          sendJson(res, 400, { error: 'Set ANTHROPIC_API_KEY to enable verified news search' });
          return;
        }
        const candidates = await discoverNews();
        const settings = await dbRows('SELECT AutoPublishOfficial FROM dbo.NewsDeskSettings WHERE Id = 1');
        if (!settings.length) throw new Error('News desk settings are missing; run api/schema.sql first');
        const counts = { published: 0, pending: 0, skipped: 0 };
        for (const item of candidates) {
          const duplicates = await dbRows(
            "(SELECT Id FROM dbo.NewsArticles WHERE SourceUrl = ? LIMIT 1) UNION ALL (SELECT Id FROM dbo.PendingNewsArticles WHERE SourceUrl = ? AND Status IN (N'pending', N'published') LIMIT 1)",
            [item.sourceUrl, item.sourceUrl]
          );
          if (duplicates.length) {
            counts.skipped += 1;
            continue;
          }
          const bodyHtml = articleHtml(item.body);
          if (item.official && settings[0].AutoPublishOfficial) {
            await dbWrite(
              'INSERT dbo.NewsArticles (Topic, Headline, Summary, BodyHtml, ReadingMinutes, School, SourceUrl, AuthorId) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
              [item.topic, item.headline, item.summary, bodyHtml, readingMinutes(item.body), item.school, item.sourceUrl]
            );
            counts.published += 1;
          } else {
            await dbWrite(
              'INSERT dbo.PendingNewsArticles (Topic, Headline, Summary, BodyHtml, School, SourceUrl, SourceTitle, SourceHost, IsOfficialSource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [item.topic, item.headline, item.summary, bodyHtml, item.school, item.sourceUrl, item.sourceTitle, item.sourceHost, item.official]
            );
            counts.pending += 1;
          }
        }
        sendJson(res, 200, { added: counts.published + counts.pending, ...counts });
        return;
      }

      if (pathname === '/api/chat/students') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const list = await getStudentList(student);
        sendJson(res, 200, list);
        return;
      }

      if (pathname === '/api/chat/messages' && req.method === 'GET') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const recipientId = Number(searchParams.get('with') || 0);
        if (!Number.isInteger(recipientId) || recipientId === student.Id) {
          sendJson(res, 400, { error: 'invalid_recipient' });
          return;
        }
        const recipient = await dbRows('SELECT Id FROM dbo.StudentProfiles WHERE Id = ? AND UniversityId = ?', [recipientId, student.UniversityId]);
        if (!recipient.length) {
          sendJson(res, 404, { error: 'student_not_found' });
          return;
        }
        const messages = await dbRows(
          'SELECT Id, SenderId, RecipientId, Body, SentAt FROM (SELECT Id, SenderId, RecipientId, Body, SentAt '
          + 'FROM dbo.StudentMessages WHERE (SenderId = ? AND RecipientId = ?) OR (SenderId = ? AND RecipientId = ?) '
          + 'ORDER BY Id DESC LIMIT 100) AS recent ORDER BY Id',
          [student.Id, recipientId, recipientId, student.Id]
        );
        sendJson(res, 200, messages.map(message => ({ id: message.Id, senderId: message.SenderId, recipientId: message.RecipientId, body: message.Body, sentAt: message.SentAt })));
        return;
      }

      if (pathname === '/api/portal/reports' && req.method === 'GET') {
        const portalUser = await getPortalUser(req);
        if (!portalUser) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const rows = portalUser.role === 'admin'
          ? await dbRows('SELECT r.Id, r.Title, r.Body, r.Status, r.SubmittedAt, p.Username AS Author FROM dbo.SubmittedReports r JOIN dbo.Reporters p ON p.Id = r.ReporterId ORDER BY r.SubmittedAt DESC')
          : await dbRows('SELECT r.Id, r.Title, r.Body, r.Status, r.SubmittedAt, p.Username AS Author FROM dbo.SubmittedReports r JOIN dbo.Reporters p ON p.Id = r.ReporterId WHERE r.ReporterId = ? ORDER BY r.SubmittedAt DESC', [portalUser.Id]);
        sendJson(res, 200, rows.map(row => ({ id: String(row.Id), title: row.Title, body: row.Body, status: row.Status, date: row.SubmittedAt, author: row.Author })));
        return;
      }

      if (pathname === '/api/portal/admin/invites' && req.method === 'GET') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const rows = await dbRows('SELECT i.Id, i.CreatedAt, r.Username AS UsedBy FROM dbo.ReporterInvites i LEFT JOIN dbo.Reporters r ON r.Id = i.UsedByReporterId ORDER BY i.CreatedAt DESC');
        sendJson(res, 200, rows.map(row => ({ id: row.Id, created: row.CreatedAt, usedBy: row.UsedBy })));
        return;
      }

      if (pathname === '/api/portal/admin/reporters' && req.method === 'GET') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const rows = await dbRows('SELECT Id, Username, FullName AS Name, Email, CreatedAt FROM dbo.Reporters ORDER BY CreatedAt DESC');
        sendJson(res, 200, rows.map(row => ({ id: row.Id, username: row.Username, name: row.Name, email: row.Email, created: row.CreatedAt })));
        return;
      }

      if (pathname.startsWith('/api/admin/posts/') && req.method === 'POST') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const match = pathname.match(/^\/api\/admin\/posts\/([0-9]+)\/(approve|reject)$/);
        if (!match) {
          sendJson(res, 400, { error: 'invalid_news_id' });
          return;
        }
        const [, rawId, action] = match;
        const id = Number(rawId);
        const outcome = await withTransaction(async q => {
          const found = await q("SELECT Id, Topic, Headline, Summary, BodyHtml, School, SourceUrl FROM dbo.PendingNewsArticles WHERE Id = ? AND Status = N'pending' FOR UPDATE", [id]);
          const item = found.rows[0];
          if (!item) return false;
          if (action === 'approve') {
            const published = await q(
              'INSERT dbo.NewsArticles (Topic, Headline, Summary, BodyHtml, ReadingMinutes, School, SourceUrl, AuthorId) '
              + 'OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
              [item.Topic, item.Headline, item.Summary, item.BodyHtml, readingMinutes(item.BodyHtml), item.School, item.SourceUrl]
            );
            await q("UPDATE dbo.PendingNewsArticles SET Status = N'published', ReviewedAt = SYSUTCDATETIME(), PublishedArticleId = ? WHERE Id = ?", [published.rows[0].Id, id]);
          } else {
            await q("UPDATE dbo.PendingNewsArticles SET Status = N'rejected', ReviewedAt = SYSUTCDATETIME() WHERE Id = ?", [id]);
          }
          return true;
        });
        if (!outcome) {
          sendJson(res, 404, { error: 'pending_news_not_found' });
          return;
        }
        sendJson(res, 200, { message: `news_${action === 'approve' ? 'published' : 'rejected'}` });
        return;
      }

      if (pathname === '/api/portal/admin/invites' && req.method === 'POST') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = crypto.randomBytes(8);
        const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
        await dbWrite('INSERT dbo.ReporterInvites (CodeHash) VALUES (?)', [tokenHash(code)]);
        sendJson(res, 201, { code });
        return;
      }

      if (pathname === '/api/portal/reports' && req.method === 'POST') {
        const current = await getPortalUser(req);
        if (!current) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (current.role !== 'reporter') {
          sendJson(res, 403, { error: 'reporter_required' });
          return;
        }
        const body = await parseBody(req);
        const title = String(body.title || '').trim();
        const reportBody = String(body.body || '').trim();
        if (!title || title.length > 150 || !reportBody) {
          sendJson(res, 400, { error: 'invalid_report' });
          return;
        }
        await dbWrite('INSERT dbo.SubmittedReports (ReporterId, Title, Body) VALUES (?, ?, ?)', [current.Id, title, reportBody]);
        sendJson(res, 201, { message: 'report_submitted' });
        return;
      }

      if (pathname.startsWith('/api/portal/admin/reports/') && req.method === 'PATCH') {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const reportId = pathname.slice('/api/portal/admin/reports/'.length);
        const body = await parseBody(req);
        if (!['approved', 'rejected'].includes(body.status)) {
          sendJson(res, 400, { error: 'invalid_status' });
          return;
        }
        await dbWrite('UPDATE dbo.SubmittedReports SET Status = ?, ReviewedAt = SYSUTCDATETIME() WHERE Id = ?', [body.status, reportId]);
        sendJson(res, 200, { message: 'report_reviewed' });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/portal/admin/invites/')) {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const inviteId = Number(pathname.slice('/api/portal/admin/invites/'.length));
        if (!Number.isInteger(inviteId) || inviteId < 1) {
          sendJson(res, 400, { error: 'invalid_invite_id' });
          return;
        }
        await dbWrite('DELETE dbo.ReporterInvites WHERE Id = ? AND UsedByReporterId IS NULL', [inviteId]);
        sendJson(res, 200, { message: 'invite_removed' });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/portal/admin/reporters/')) {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const reporterId = Number(pathname.slice('/api/portal/admin/reporters/'.length));
        if (!Number.isInteger(reporterId) || reporterId < 1) {
          sendJson(res, 400, { error: 'invalid_reporter_id' });
          return;
        }
        await withTransaction(async q => {
          await q("DELETE dbo.PortalSessions WHERE UserType = N'reporter' AND UserId = ?", [reporterId]);
          await q('DELETE dbo.SubmittedReports WHERE ReporterId = ?', [reporterId]);
          await q('UPDATE dbo.ReporterInvites SET UsedByReporterId = NULL WHERE UsedByReporterId = ?', [reporterId]);
          await q('DELETE dbo.Reporters WHERE Id = ?', [reporterId]);
        });
        sendJson(res, 200, { message: 'reporter_removed' });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/portal/admin/reports/')) {
        const current = await getPortalUser(req);
        if (!current || current.role !== 'admin') {
          sendJson(res, current ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const reportId = pathname.slice('/api/portal/admin/reports/'.length);
        await dbWrite('DELETE dbo.SubmittedReports WHERE Id = ?', [reportId]);
        sendJson(res, 200, { message: 'report_removed' });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/posts/')) {
        const student = await getUserFromToken(req);
        if (!student || !student.IsAdmin) {
          sendJson(res, student ? 403 : 401, { error: 'admin_required' });
          return;
        }
        const postId = Number(pathname.slice('/api/posts/'.length));
        if (!Number.isInteger(postId) || postId < 1) {
          sendJson(res, 400, { error: 'invalid_post_id' });
          return;
        }
        await dbWrite('DELETE dbo.NewsArticles WHERE Id = ?', [postId]);
        sendJson(res, 200, { message: 'deleted' });
        return;
      }

      if (pathname === '/api/chat/messages' && req.method === 'POST') {
        const student = await requireStudent(req);
        if (!student) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await parseBody(req);
        const recipientId = Number(body.recipientId || 0);
        const message = String(body.body || '').trim();
        if (!Number.isInteger(recipientId) || recipientId === student.Id || !message || message.length > 2000) {
          sendJson(res, 400, { error: 'invalid_message' });
          return;
        }
        const recipient = await dbRows('SELECT Id FROM dbo.StudentProfiles WHERE Id = ? AND UniversityId = ?', [recipientId, student.UniversityId]);
        if (!recipient.length) {
          sendJson(res, 404, { error: 'student_not_found' });
          return;
        }
        const row = await dbWrite(
          'INSERT dbo.StudentMessages (SenderId, RecipientId, Body) OUTPUT INSERTED.Id, INSERTED.SentAt VALUES (?, ?, ?)',
          [student.Id, recipientId, message]
        );
        sendJson(res, 201, { id: row.Id, sentAt: row.SentAt });
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        const file = fs.existsSync(FRONTEND_FILE) ? FRONTEND_FILE : path.join(__dirname, 'index.html');
        if (fs.existsSync(file)) {
          serveStaticFile(res, file);
        } else {
          sendHtml(res, 200, '<h1>Tobi World Wide API</h1><p>JS server is running.</p>');
        }
        return;
      }

      if (pathname === '/admin' || pathname === '/admin-login.html') {
        const file = fs.existsSync(ADMIN_FILE) ? ADMIN_FILE : path.join(__dirname, 'admin.html');
        if (fs.existsSync(file)) {
          serveStaticFile(res, file);
        } else {
          sendHtml(res, 200, '<h1>Admin Portal</h1><p>JS server is running.</p>');
        }
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof FriendlyError) {
        sendJson(res, 502, { error: err.message });
        return;
      }
      const message = err.message || String(err);
      const status = message === 'Invalid JSON' ? 400
        : message === 'Request body too large' ? 413
          : message.startsWith('Set DATABASE_URL') ? 503 : 500;
      sendJson(res, status, { error: status === 503 ? 'configuration_error' : status === 400 ? 'invalid_json' : status === 413 ? 'request_too_large' : 'server_error', message });
    }
  });
}

const server = routeTable();
server.on('close', async () => {
  if (pool) await pool.end().catch(() => {});
});
server.listen(PORT, HOST, () => {
  console.log(`TWW JS API listening on http://${HOST}:${PORT}`);
});
