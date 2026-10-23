'use strict';
// Cyber cafe space, public enquiries and premium helpers. Wired in from features.js.
const crypto = require('crypto');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const iso = d => (d ? new Date(d).toISOString() : '');
const CATEGORIES = ['printing', 'jamb', 'caps', 'nin', 'scanning', 'registration', 'other'];
const LEAD_KINDS = ['service', 'sponsor', 'cafe'];
const cleanPhone = v => clip(v, 30).replace(/[^\d+]/g, '');

module.exports = function makeCafe(deps) {
  const { dbRows, dbWrite, sendJson, parseBody, requireStudent, getPortalUser, rateLimited, tokenHash, hashPassword, verifyPassword } = deps;
  const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const getToken = req => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? a.slice(7) : ''; };

  async function adminOnly(req, res) {
    const cur = await getPortalUser(req);
    if (!cur || cur.role !== 'admin') { sendJson(res, cur ? 403 : 401, { error: 'admin_required' }); return null; }
    return cur;
  }
  async function studentOnly(req, res) {
    const s = await requireStudent(req);
    if (!s) sendJson(res, 401, { error: 'Please log in again.' });
    return s;
  }
  async function cafeOnly(req, res) {
    const token = getToken(req);
    const row = token ? (await dbRows('SELECT c.* FROM dbo.CafeSessions s JOIN dbo.Cafes c ON c.Id = s.CafeId WHERE s.TokenHash = ? AND s.ExpiresAt > now() AND c.IsActive = true', [tokenHash(token)]))[0] : null;
    if (!row) sendJson(res, 401, { error: 'Please log in again.' });
    return row || null;
  }
  const cafeOut = r => ({ id: r.id, name: r.name, area: r.area || '', address: r.address || '', phone: r.phone || '', services: r.services || '', hours: r.hours || '', school: r.school || '' });

  async function handle(req, res, pathname, searchParams) {
    const method = req.method;
    let m;

    // ---------- public: services and enquiries ----------
    if (pathname === '/api/x/public/services' && method === 'GET') {
      const rows = await dbRows('SELECT Id, Name, Description, AmountNaira, PremiumDays FROM dbo.Products WHERE IsActive = true ORDER BY PremiumDays DESC, Id');
      sendJson(res, 200, rows.map(r => ({ id: r.id, name: r.name, desc: r.description || '', amount: r.amountnaira, premiumDays: r.premiumdays })));
      return true;
    }
    if (pathname === '/api/x/public/lead' && method === 'POST') {
      const b = await parseBody(req);
      const kind = LEAD_KINDS.includes(b.kind) ? b.kind : 'service';
      const name = clip(b.name, 80), phone = cleanPhone(b.phone), message = clip(b.message, 800);
      if (name.length < 2 || phone.length < 10) { sendJson(res, 400, { error: 'Please write your name and WhatsApp number.' }); return true; }
      if (rateLimited(`lead:${clientIp(req)}`, 5, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You have sent several requests today. We will reply soon.' }); return true; }
      await dbWrite('INSERT dbo.PublicLeads (Kind, Name, Phone, Message, ProductId) VALUES (?, ?, ?, ?, ?)', [kind, name, phone, message, Number(b.productId) || null]);
      sendJson(res, 201, { ok: true, message: 'Thank you. We will contact you on WhatsApp.' });
      return true;
    }

    // ---------- student: cafes and questions ----------
    if (pathname === '/api/x/cafes' && method === 'GET') {
      const s = await studentOnly(req, res); if (!s) return true;
      const rows = await dbRows('SELECT c.*, u.Name AS school FROM dbo.Cafes c LEFT JOIN dbo.Universities u ON u.Id = c.UniversityId WHERE c.IsActive = true ORDER BY (c.UniversityId = ?) DESC NULLS LAST, c.Name', [s.UniversityId]);
      sendJson(res, 200, rows.map(cafeOut));
      return true;
    }
    if (pathname === '/api/x/cq') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const qs = await dbRows('SELECT Id, Category, Title, Body, CafeId, CreatedAt FROM dbo.CafeQuestions WHERE StudentId = ? ORDER BY Id DESC LIMIT 30', [s.Id]);
        const ids = qs.map(q => q.id);
        const ans = ids.length ? await dbRows('SELECT a.QuestionId, a.Body, a.CreatedAt, c.Name, c.Phone FROM dbo.CafeAnswers a JOIN dbo.Cafes c ON c.Id = a.CafeId WHERE a.QuestionId = ANY(?::bigint[]) ORDER BY a.Id', ['{' + ids.join(',') + '}']) : [];
        sendJson(res, 200, qs.map(q => ({ id: q.id, cat: q.category, title: q.title, body: q.body || '', at: iso(q.createdat), answers: ans.filter(a => Number(a.questionid) === Number(q.id)).map(a => ({ cafe: a.name, phone: a.phone || '', body: a.body, at: iso(a.createdat) })) })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const title = clip(b.title, 160);
        if (title.length < 5) { sendJson(res, 400, { error: 'Write your question (at least a few words).' }); return true; }
        if (rateLimited(`cq:${s.Id}`, 8, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You asked several questions today. Wait for the answers first.' }); return true; }
        const cafeId = Number(b.cafeId) || null;
        await dbWrite('INSERT dbo.CafeQuestions (StudentId, UniversityId, CafeId, Category, Title, Body) VALUES (?, ?, ?, ?, ?, ?)', [s.Id, s.UniversityId, cafeId, CATEGORIES.includes(b.category) ? b.category : 'other', title, clip(b.body, 1000)]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/x\/cq\/(\d+)$/)) && method === 'DELETE') {
      const s = await studentOnly(req, res); if (!s) return true;
      await dbWrite('DELETE FROM dbo.CafeQuestions WHERE Id = ? AND StudentId = ?', [Number(m[1]), s.Id]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ---------- cafe portal ----------
    if (pathname === '/api/cafe/login' && method === 'POST') {
      const b = await parseBody(req);
      const email = clip(b.email, 120).toLowerCase();
      if (rateLimited(`cafelogin:${clientIp(req)}`, 15, 3600 * 1000) || rateLimited(`cafelogin:${email}`, 8, 3600 * 1000)) { sendJson(res, 429, { error: 'Too many attempts. Try again later.' }); return true; }
      const c = (await dbRows('SELECT Id, PasswordHash, IsActive FROM dbo.Cafes WHERE lower(Email) = ?', [email]))[0];
      if (!c || !c.isactive || !verifyPassword(String(b.password || ''), c.passwordhash)) { sendJson(res, 401, { error: 'Wrong email or password.' }); return true; }
      const token = crypto.randomBytes(32).toString('base64url');
      await dbWrite("INSERT dbo.CafeSessions (TokenHash, CafeId, ExpiresAt) VALUES (?, ?, now() + interval '7 days')", [tokenHash(token), c.id]);
      sendJson(res, 200, { token });
      return true;
    }
    if (pathname === '/api/cafe/me') {
      const c = await cafeOnly(req, res); if (!c) return true;
      if (method === 'PUT') {
        const b = await parseBody(req);
        await dbWrite('UPDATE dbo.Cafes SET Phone = ?, Address = ?, Area = ?, Services = ?, Hours = ? WHERE Id = ?', [cleanPhone(b.phone) || c.phone, clip(b.address, 240), clip(b.area, 120), clip(b.services, 800), clip(b.hours, 120), c.id]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 200, cafeOut(c));
      return true;
    }
    if (pathname === '/api/cafe/questions' && method === 'GET') {
      const c = await cafeOnly(req, res); if (!c) return true;
      const qs = await dbRows(
        `SELECT q.Id, q.Category, q.Title, q.Body, q.CreatedAt, q.CafeId, s.FullName,
                (SELECT count(*) FROM dbo.CafeAnswers a WHERE a.QuestionId = q.Id) AS answers,
                (SELECT count(*) FROM dbo.CafeAnswers a WHERE a.QuestionId = q.Id AND a.CafeId = ?) AS mine
           FROM dbo.CafeQuestions q JOIN dbo.StudentProfiles s ON s.Id = q.StudentId
          WHERE q.CreatedAt > now() - interval '30 days'
            AND (q.CafeId = ? OR (q.CafeId IS NULL AND (?::bigint IS NULL OR q.UniversityId = ?::bigint)))
          ORDER BY q.Id DESC LIMIT 60`, [c.id, c.id, c.universityid, c.universityid]);
      sendJson(res, 200, qs.map(q => ({ id: q.id, cat: q.category, title: q.title, body: q.body || '', at: iso(q.createdat), student: String(q.fullname).split(/\s+/)[0], direct: Number(q.cafeid) === Number(c.id), answers: Number(q.answers), mine: Number(q.mine) > 0 })));
      return true;
    }
    if ((m = pathname.match(/^\/api\/cafe\/questions\/(\d+)\/answer$/)) && method === 'POST') {
      const c = await cafeOnly(req, res); if (!c) return true;
      const b = await parseBody(req);
      const body = clip(b.body, 1500);
      if (body.length < 3) { sendJson(res, 400, { error: 'Write your answer.' }); return true; }
      if (rateLimited(`cafeans:${c.id}`, 60, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'Daily answer limit reached.' }); return true; }
      const q = (await dbRows('SELECT Id FROM dbo.CafeQuestions WHERE Id = ? AND (CafeId = ? OR CafeId IS NULL)', [Number(m[1]), c.id]))[0];
      if (!q) { sendJson(res, 404, { error: 'Question not found.' }); return true; }
      await dbWrite('INSERT dbo.CafeAnswers (QuestionId, CafeId, Body) VALUES (?, ?, ?)', [q.id, c.id, body]);
      sendJson(res, 201, { ok: true });
      return true;
    }

    // ---------- admin ----------
    if (pathname === '/api/admin/x/cafes') {
      const admin = await adminOnly(req, res); if (!admin) return true;
      if (method === 'GET') {
        const rows = await dbRows('SELECT c.*, u.Name AS school, (SELECT count(*) FROM dbo.CafeAnswers a WHERE a.CafeId = c.Id) AS answers FROM dbo.Cafes c LEFT JOIN dbo.Universities u ON u.Id = c.UniversityId ORDER BY c.Id DESC');
        sendJson(res, 200, rows.map(r => ({ ...cafeOut(r), email: r.email, active: !!r.isactive, answers: Number(r.answers) })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const email = clip(b.email, 120).toLowerCase(), name = clip(b.name, 120), password = String(b.password || '');
        if (name.length < 3 || !email.includes('@') || password.length < 8) { sendJson(res, 400, { error: 'Give the cafe name, an email and a password of at least 8 characters.' }); return true; }
        try {
          await dbWrite('INSERT dbo.Cafes (Name, UniversityId, Area, Address, Phone, Services, Hours, Email, PasswordHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, Number(b.universityId) || null, clip(b.area, 120), clip(b.address, 240), cleanPhone(b.phone), clip(b.services, 800), clip(b.hours, 120), email, hashPassword(password)]);
        } catch (e) { if (e.code === '23505') { sendJson(res, 409, { error: 'A cafe with that email already exists.' }); return true; } throw e; }
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/admin\/x\/cafes\/(\d+)(\/toggle|\/password)?$/))) {
      const admin = await adminOnly(req, res); if (!admin) return true;
      const id = Number(m[1]);
      if (method === 'DELETE' && !m[2]) { await dbWrite('DELETE FROM dbo.Cafes WHERE Id = ?', [id]); sendJson(res, 200, { ok: true }); return true; }
      if (method === 'POST' && m[2] === '/toggle') { await dbWrite('UPDATE dbo.Cafes SET IsActive = NOT IsActive WHERE Id = ?', [id]); sendJson(res, 200, { ok: true }); return true; }
      if (method === 'POST' && m[2] === '/password') {
        const b = await parseBody(req);
        if (String(b.password || '').length < 8) { sendJson(res, 400, { error: 'Password must be at least 8 characters.' }); return true; }
        await dbWrite('UPDATE dbo.Cafes SET PasswordHash = ? WHERE Id = ?', [hashPassword(String(b.password)), id]);
        await dbWrite('DELETE FROM dbo.CafeSessions WHERE CafeId = ?', [id]);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }
    if (pathname === '/api/admin/x/leads' && method === 'GET') {
      const admin = await adminOnly(req, res); if (!admin) return true;
      const rows = await dbRows('SELECT l.Id, l.Kind, l.Name, l.Phone, l.Message, l.Status, l.CreatedAt, p.Name AS product FROM dbo.PublicLeads l LEFT JOIN dbo.Products p ON p.Id = l.ProductId ORDER BY (l.Status = \'new\') DESC, l.Id DESC LIMIT 100');
      sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, phone: r.phone, message: r.message || '', status: r.status, product: r.product || '', at: iso(r.createdat) })));
      return true;
    }
    if ((m = pathname.match(/^\/api\/admin\/x\/leads\/(\d+)(\/done)?$/))) {
      const admin = await adminOnly(req, res); if (!admin) return true;
      if (method === 'POST' && m[2]) await dbWrite("UPDATE dbo.PublicLeads SET Status = 'done' WHERE Id = ?", [Number(m[1])]);
      else if (method === 'DELETE' && !m[2]) await dbWrite('DELETE FROM dbo.PublicLeads WHERE Id = ?', [Number(m[1])]);
      else return false;
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }
  return { handle };
};
