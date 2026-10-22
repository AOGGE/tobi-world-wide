'use strict';
// Student life tools, trust features and owner tools. Wired in from features.js.
const crypto = require('crypto');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
const safeLink = v => { const s = clip(v, 500); return /^https?:\/\//i.test(s) ? s : ''; };
const tagOf = v => clip(v, 60).toUpperCase().replace(/\s+/g, ' ');
const NOTICE_KINDS = ['notice', 'test', 'assignment', 'cancel', 'event'];
const TASK_KINDS = ['assignment', 'test', 'project', 'other'];
const CONTACT_CATS = ['emergency', 'support'];
const LANGS = { pcm: 'Nigerian Pidgin English', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' };
const todayLagos = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const iso = d => (d ? new Date(d).toISOString() : '');

async function readRaw(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new Error('too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

module.exports = function makeExtras(deps) {
  const { dbRows, dbWrite, sendJson, parseBody, requireStudent, getPortalUser, askClaude, aiEnabled, rateLimited, sendEmail } = deps;
  const transCache = new Map();

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
  async function myExtra(student) {
    const r = (await dbRows('SELECT IsRep, ClassTag, RefCode FROM dbo.StudentProfiles WHERE Id = ?', [student.Id]))[0] || {};
    let code = r.refcode;
    if (!code) {
      code = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
      await dbWrite('UPDATE dbo.StudentProfiles SET RefCode = ? WHERE Id = ?', [code, student.Id]);
    }
    return { isRep: !!r.isrep, classTag: r.classtag || '', refCode: code };
  }
  function needAi(res) {
    if (!aiEnabled()) { sendJson(res, 503, { error: 'The AI helper has not been switched on yet.' }); return false; }
    return true;
  }
  async function ai(res, system, user, max, ms) {
    try { return await askClaude(system, [{ role: 'user', content: user }], max, ms); }
    catch (e) { sendJson(res, 502, { error: e.message || 'The AI helper could not answer just now. Try again in a moment.' }); return null; }
  }

  const paystackKey = () => process.env.PAYSTACK_SECRET_KEY || '';
  const paystackUrl = () => (process.env.PAYSTACK_URL || 'https://api.paystack.co').replace(/\/$/, '');
  async function markPaid(reference, amountKobo) {
    const p = (await dbRows('SELECT Id, AmountNaira, Status FROM dbo.Payments WHERE Reference = ?', [reference]))[0];
    if (!p) return false;
    if (p.status === 'paid') return true;
    if (amountKobo != null && Number(amountKobo) < p.amountnaira * 100) return false;
    await dbWrite("UPDATE dbo.Payments SET Status = 'paid', PaidAt = now() WHERE Id = ?", [p.id]);
    return true;
  }

  async function afterRegister(studentId, refCode) {
    const code = clip(refCode, 12).toUpperCase();
    if (!code) return;
    const r = (await dbRows('SELECT Id FROM dbo.StudentProfiles WHERE RefCode = ? AND Id <> ?', [code, studentId]))[0];
    if (r) await dbWrite('UPDATE dbo.StudentProfiles SET ReferredBy = ? WHERE Id = ?', [r.id, studentId]);
  }

  async function handle(req, res, pathname, searchParams) {
    const method = req.method;
    let m;
    if (!pathname.startsWith('/api/x/') && !pathname.startsWith('/api/admin/x/')) return false;

    // ============ me / class / referral ============
    if (pathname === '/api/x/me') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'PUT') {
        const b = await parseBody(req);
        await dbWrite('UPDATE dbo.StudentProfiles SET ClassTag = ? WHERE Id = ?', [tagOf(b.classTag) || null, s.Id]);
      }
      const x = await myExtra(s);
      const c = (await dbRows('SELECT count(*) AS n FROM dbo.StudentProfiles WHERE ReferredBy = ?', [s.Id]))[0];
      sendJson(res, 200, { ...x, classTag: (await dbRows('SELECT ClassTag FROM dbo.StudentProfiles WHERE Id = ?', [s.Id]))[0].classtag || '', referrals: Number(c.n) });
      return true;
    }

    // ============ class notices ============
    if (pathname === '/api/x/notices') {
      const s = await studentOnly(req, res); if (!s) return true;
      const x = await myExtra(s);
      const tag = tagOf((await dbRows('SELECT ClassTag FROM dbo.StudentProfiles WHERE Id = ?', [s.Id]))[0].classtag);
      if (method === 'GET') {
        if (!tag) { sendJson(res, 200, []); return true; }
        const rows = await dbRows(
          "SELECT Id, Kind, Title, Body, to_char(DueDate, 'YYYY-MM-DD') AS due, AuthorId, AuthorName, CreatedAt FROM dbo.ClassNotices WHERE UniversityId = ? AND ClassTag = ? AND (DueDate IS NULL OR DueDate >= current_date - 7) ORDER BY Id DESC LIMIT 60",
          [s.UniversityId, tag]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body || '', due: r.due || '', by: r.authorname || '', mine: Number(r.authorid) === Number(s.Id), at: iso(r.createdat) })));
        return true;
      }
      if (method === 'POST') {
        if (!x.isRep) { sendJson(res, 403, { error: 'Only class reps can post notices. Ask the admin to make you a class rep.' }); return true; }
        if (!tag) { sendJson(res, 400, { error: 'Set your class first, for example SWK 100L.' }); return true; }
        const b = await parseBody(req);
        const title = clip(b.title, 160);
        if (title.length < 3) { sendJson(res, 400, { error: 'Give the notice a title.' }); return true; }
        if (rateLimited(`notice:${s.Id}`, 20, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'Too many notices today.' }); return true; }
        await dbWrite('INSERT dbo.ClassNotices (UniversityId, ClassTag, Kind, Title, Body, DueDate, AuthorId, AuthorName) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [s.UniversityId, tag, NOTICE_KINDS.includes(b.kind) ? b.kind : 'notice', title, clip(b.body, 1500), isDate(b.due) ? b.due : null, s.Id, clip(s.FullName, 80)]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/x\/notices\/(\d+)$/)) && method === 'DELETE') {
      const s = await studentOnly(req, res); if (!s) return true;
      await dbWrite('DELETE FROM dbo.ClassNotices WHERE Id = ? AND AuthorId = ?', [Number(m[1]), s.Id]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============ assignment / test tracker ============
    if (pathname === '/api/x/tasks') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT Id, Course, Title, Kind, to_char(DueDate, 'YYYY-MM-DD') AS due, Done FROM dbo.StudentTasks WHERE StudentId = ? ORDER BY Done, DueDate NULLS LAST, Id DESC LIMIT 200", [s.Id]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, course: r.course || '', title: r.title, kind: r.kind, due: r.due || '', done: !!r.done })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const title = clip(b.title, 160);
        if (title.length < 2) { sendJson(res, 400, { error: 'Write what the task is.' }); return true; }
        const n = (await dbRows('SELECT count(*) AS n FROM dbo.StudentTasks WHERE StudentId = ?', [s.Id]))[0];
        if (Number(n.n) >= 200) { sendJson(res, 400, { error: 'You have too many tasks. Delete finished ones first.' }); return true; }
        await dbWrite('INSERT dbo.StudentTasks (StudentId, Course, Title, Kind, DueDate) VALUES (?, ?, ?, ?, ?)',
          [s.Id, clip(b.course, 80), title, TASK_KINDS.includes(b.kind) ? b.kind : 'assignment', isDate(b.due) ? b.due : null]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/x\/tasks\/(\d+)$/))) {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'POST') await dbWrite('UPDATE dbo.StudentTasks SET Done = NOT Done WHERE Id = ? AND StudentId = ?', [Number(m[1]), s.Id]);
      else if (method === 'DELETE') await dbWrite('DELETE FROM dbo.StudentTasks WHERE Id = ? AND StudentId = ?', [Number(m[1]), s.Id]);
      else return false;
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============ money tracker ============
    if (pathname === '/api/x/money') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT Id, Kind, Amount, Label, to_char(OnDate, 'YYYY-MM-DD') AS d FROM dbo.StudentMoney WHERE StudentId = ? AND OnDate >= current_date - 90 ORDER BY OnDate DESC, Id DESC LIMIT 300", [s.Id]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, amount: r.amount, label: r.label || '', date: r.d })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const amount = Math.round(Number(b.amount));
        if (!(amount > 0) || amount > 100000000) { sendJson(res, 400, { error: 'Enter an amount in naira.' }); return true; }
        await dbWrite('INSERT dbo.StudentMoney (StudentId, Kind, Amount, Label, OnDate) VALUES (?, ?, ?, ?, ?)',
          [s.Id, b.kind === 'in' ? 'in' : 'out', amount, clip(b.label, 80), isDate(b.date) ? b.date : todayLagos()]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/x\/money\/(\d+)$/)) && method === 'DELETE') {
      const s = await studentOnly(req, res); if (!s) return true;
      await dbWrite('DELETE FROM dbo.StudentMoney WHERE Id = ? AND StudentId = ?', [Number(m[1]), s.Id]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============ AI study planner ============
    if (pathname === '/api/x/planner') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const r = (await dbRows('SELECT PlanText, CreatedAt FROM dbo.StudentPlans WHERE StudentId = ?', [s.Id]))[0];
        sendJson(res, 200, r ? { text: r.plantext, at: iso(r.createdat) } : { text: '', at: '' });
        return true;
      }
      if (method === 'POST') {
        if (!needAi(res)) return true;
        if (rateLimited(`plan:${s.Id}`, 5, 3600 * 1000)) { sendJson(res, 429, { error: 'You made several plans this hour. Try again later.' }); return true; }
        const b = await parseBody(req);
        const hours = Math.min(12, Math.max(1, Number(b.hours) || 3));
        const exams = await dbRows("SELECT Title, to_char(ExamDate, 'YYYY-MM-DD') AS d FROM dbo.StudentSchedule WHERE StudentId = ? AND Kind = 'exam' AND ExamDate >= current_date ORDER BY ExamDate LIMIT 20", [s.Id]);
        const tasks = await dbRows("SELECT Course, Title, to_char(DueDate, 'YYYY-MM-DD') AS d FROM dbo.StudentTasks WHERE StudentId = ? AND Done = false ORDER BY DueDate NULLS LAST LIMIT 20", [s.Id]);
        const classes = await dbRows('SELECT Title, DayNo, StartTime FROM dbo.StudentSchedule WHERE StudentId = ? AND Kind = ? ORDER BY DayNo, StartTime LIMIT 40', [s.Id, 'class']);
        const weak = clip(b.weak, 300);
        const user = `Today: ${todayLagos()}\nStudy hours per day: ${hours}\nWeak or hard courses: ${weak || 'not stated'}\n`
          + `Exams: ${exams.length ? exams.map(e => `${e.title} on ${e.d}`).join('; ') : 'none saved'}\n`
          + `Pending tasks: ${tasks.length ? tasks.map(t => `${t.title}${t.course ? ' (' + t.course + ')' : ''}${t.d ? ' due ' + t.d : ''}`).join('; ') : 'none'}\n`
          + `Weekly classes (day 1 = Monday): ${classes.length ? classes.map(c => `${c.title} day ${c.dayno} ${c.starttime || ''}`).join('; ') : 'not saved'}`;
        const system = 'You make realistic day-by-day study plans for Nigerian university students. Plan from today until the last exam, at most 14 days. '
          + 'Give each day a line like "Mon 20 Oct: Course A (2h) then Course B (1h)". Give more time to weak courses and to exams that are closer. Leave a rest break and one lighter day each week. '
          + 'Put assignment deadlines on the days before they are due. Use plain text without markdown symbols. If there are no exams saved, make a general 7-day plan from the courses and tasks given and say so in one line. '
          + 'Do not invent dates, courses or lecturers that were not provided.';
        const text = await ai(res, system, user, 2000, 80000); if (text == null) return true;
        await dbWrite('INSERT dbo.StudentPlans (StudentId, PlanText) VALUES (?, ?) ON CONFLICT (StudentId) DO UPDATE SET PlanText = EXCLUDED.PlanText, CreatedAt = now()', [s.Id, text]);
        sendJson(res, 200, { text, at: new Date().toISOString() });
        return true;
      }
    }

    // ============ support + emergency contacts ============
    if (pathname === '/api/x/contacts' && method === 'GET') {
      const s = await studentOnly(req, res); if (!s) return true;
      const rows = await dbRows('SELECT Id, Category, Name, Phone, Note, UniversityId FROM dbo.SupportContacts WHERE UniversityId IS NULL OR UniversityId = ? ORDER BY Category, UniversityId NULLS LAST, Name', [s.UniversityId]);
      sendJson(res, 200, rows.map(r => ({ id: r.id, cat: r.category, name: r.name, phone: r.phone || '', note: r.note || '', school: !!r.universityid })));
      return true;
    }

    // ============ study groups + mentors ============
    if (pathname === '/api/x/groups') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT Id, Course, Title, Link, Details, Status, SubmittedBy FROM dbo.StudyGroups WHERE (Status = 'approved' OR SubmittedBy = ?) AND (UniversityId IS NULL OR UniversityId = ?) ORDER BY Id DESC LIMIT 100", [s.Id, s.UniversityId]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, course: r.course, title: r.title, link: r.link, details: r.details || '', status: r.status, mine: Number(r.submittedby) === Number(s.Id) })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const link = safeLink(b.link), title = clip(b.title, 160), course = clip(b.course, 80);
        if (!/^https:\/\/(chat\.whatsapp\.com|wa\.me|t\.me)\//i.test(link)) { sendJson(res, 400, { error: 'Paste your WhatsApp group invite link (it starts with https://chat.whatsapp.com/).' }); return true; }
        if (title.length < 3 || course.length < 2) { sendJson(res, 400, { error: 'Fill the course and a group name.' }); return true; }
        if (rateLimited(`grp:${s.Id}`, 3, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You have suggested several groups today.' }); return true; }
        await dbWrite("INSERT dbo.StudyGroups (UniversityId, Course, Title, Link, Details, Status, SubmittedBy) VALUES (?, ?, ?, ?, ?, 'pending', ?)", [s.UniversityId, course, title, link, clip(b.details, 400), s.Id]);
        sendJson(res, 201, { ok: true, message: 'Thanks. It will show after the admin checks it.' });
        return true;
      }
    }
    if (pathname === '/api/x/mentors') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT m.Id, m.Name, m.Programme, m.LevelText, m.Bio, m.Phone, m.Status, m.SubmittedBy, u.Name AS school FROM dbo.Mentors m LEFT JOIN dbo.Universities u ON u.Id = m.UniversityId WHERE m.Status = 'approved' OR m.SubmittedBy = ? ORDER BY (m.UniversityId = ?) DESC NULLS LAST, m.Id DESC LIMIT 100", [s.Id, s.UniversityId]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, name: r.name, programme: r.programme || '', level: r.leveltext || '', bio: r.bio || '', phone: r.status === 'approved' ? (r.phone || '') : '', school: r.school || '', status: r.status, mine: Number(r.submittedby) === Number(s.Id) })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const bio = clip(b.bio, 500);
        const phone = clip(b.phone, 30).replace(/[^\d+]/g, '');
        if (bio.length < 10 || phone.length < 10) { sendJson(res, 400, { error: 'Write a short bio and your WhatsApp number.' }); return true; }
        if (rateLimited(`mentor:${s.Id}`, 2, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You already applied today.' }); return true; }
        await dbWrite("INSERT dbo.Mentors (Name, UniversityId, Programme, LevelText, Bio, Phone, Status, SubmittedBy) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
          [clip(s.FullName, 80), s.UniversityId, clip(b.programme || s.Programme, 120), clip(b.level, 40), bio, phone, s.Id]);
        sendJson(res, 201, { ok: true, message: 'Thanks. You will show as a mentor after the admin approves you.' });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/x\/(groups|mentors)\/(\d+)$/)) && method === 'DELETE') {
      const s = await studentOnly(req, res); if (!s) return true;
      await dbWrite(`DELETE FROM dbo.${m[1] === 'groups' ? 'StudyGroups' : 'Mentors'} WHERE Id = ? AND SubmittedBy = ?`, [Number(m[2]), s.Id]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============ AI: CV, essay, translate ============
    if (pathname === '/api/x/cv' && method === 'POST') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (!needAi(res)) return true;
      if (rateLimited(`cv:${s.Id}`, 6, 3600 * 1000)) { sendJson(res, 429, { error: 'You used the CV helper several times this hour. Try again later.' }); return true; }
      const b = await parseBody(req);
      const data = ['name', 'email', 'phone', 'school', 'programme', 'objective', 'education', 'skills', 'experience', 'extra'].map(k => `${k}: ${clip(b[k], 900) || '-'}`).join('\n');
      const kind = b.kind === 'cover' ? 'cover' : 'cv';
      const system = kind === 'cover'
        ? 'You write short, honest cover letters (under 250 words) for Nigerian students applying for internships, SIWES or jobs. Use only the facts provided. Plain text, no markdown, with a greeting and sign-off. Do not invent employers, grades or achievements.'
        : 'You turn a student\'s details into a clean one-page CV in plain text. Use these headings in capitals on their own line: PROFILE, EDUCATION, SKILLS, EXPERIENCE AND ACTIVITIES. Use short bullet lines starting with a dash. Improve the wording but use only the facts provided. Do not invent employers, grades or achievements. No markdown symbols other than the dash.';
      const target = clip(b.target, 200);
      const text = await ai(res, system, `${target ? 'Applying for: ' + target + '\n' : ''}${data}`, 1500, 70000); if (text == null) return true;
      sendJson(res, 200, { text });
      return true;
    }
    if (pathname === '/api/x/essay' && method === 'POST') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (!needAi(res)) return true;
      if (rateLimited(`essay:${s.Id}`, 6, 3600 * 1000)) { sendJson(res, 429, { error: 'You used the essay helper several times this hour. Try again later.' }); return true; }
      const b = await parseBody(req);
      const text = clip(b.text, 6000);
      if (text.length < 80) { sendJson(res, 400, { error: 'Paste your essay first (at least a few sentences).' }); return true; }
      const system = 'You review scholarship essays and personal statements written by Nigerian students. Give feedback in plain text without markdown: first two short lines on what works, then up to six numbered suggestions on structure, clarity, specific details and grammar, with a short example fix for the most important ones. '
        + 'End with a one-line verdict. Do not rewrite the whole essay and do not invent facts about the student. Tell them to keep it in their own voice.';
      const out = await ai(res, system, `Essay question or purpose: ${clip(b.prompt, 400) || 'not stated'}\n\nEssay:\n${text}`, 1600, 70000); if (out == null) return true;
      sendJson(res, 200, { text: out });
      return true;
    }
    if (pathname === '/api/x/translate' && method === 'POST') {
      const s = await studentOnly(req, res); if (!s) return true;
      const b = await parseBody(req);
      const lang = LANGS[b.lang];
      const text = clip(b.text, 3500);
      if (!lang || text.length < 5) { sendJson(res, 400, { error: 'Choose a language and give the text.' }); return true; }
      if (!needAi(res)) return true;
      const key = b.lang + ':' + crypto.createHash('sha1').update(text).digest('hex');
      if (transCache.has(key)) { sendJson(res, 200, { text: transCache.get(key) }); return true; }
      if (rateLimited(`tr:${s.Id}`, 25, 3600 * 1000)) { sendJson(res, 429, { error: 'You translated many times this hour. Try again later.' }); return true; }
      const out = await ai(res, `You rewrite news for Nigerian students in simple ${lang}. Keep every date, amount, name, number and website exactly as written. Plain text, no markdown. If you are unsure of a word, keep it in English. Do not add facts.`, text, 1400, 60000); if (out == null) return true;
      if (transCache.size > 300) transCache.clear();
      transCache.set(key, out);
      sendJson(res, 200, { text: out });
      return true;
    }

    // ============ report a post ============
    if (pathname === '/api/x/report' && method === 'POST') {
      const s = await studentOnly(req, res); if (!s) return true;
      const b = await parseBody(req);
      const id = clip(b.postId, 40);
      if (!id) { sendJson(res, 400, { error: 'Missing post.' }); return true; }
      if (rateLimited(`rep:${s.Id}`, 10, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'Too many reports today.' }); return true; }
      await dbWrite('INSERT dbo.PostReports (PostId, StudentId, Reason) VALUES (?, ?, ?)', [id, s.Id, clip(b.reason, 300)]);
      sendJson(res, 201, { ok: true, message: 'Thanks. The admin will check this post.' });
      return true;
    }

    // ============ sponsors ============
    if (pathname === '/api/x/sponsors' && method === 'GET') {
      const rows = await dbRows('SELECT Id, Title, Body, Link FROM dbo.Sponsors WHERE (StartsOn IS NULL OR StartsOn <= current_date) AND (EndsOn IS NULL OR EndsOn >= current_date) ORDER BY Id DESC LIMIT 5');
      if (rows.length) await dbWrite('UPDATE dbo.Sponsors SET Views = Views + 1 WHERE Id = ?', [rows[0].id]);
      sendJson(res, 200, rows.map(r => ({ id: r.id, title: r.title, body: r.body || '', link: r.link || '' })));
      return true;
    }
    if ((m = pathname.match(/^\/api\/x\/sponsors\/(\d+)\/click$/)) && method === 'POST') {
      await dbWrite('UPDATE dbo.Sponsors SET Clicks = Clicks + 1 WHERE Id = ?', [Number(m[1])]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============ payments ============
    if (pathname === '/api/x/products' && method === 'GET') {
      const s = await studentOnly(req, res); if (!s) return true;
      const rows = await dbRows('SELECT Id, Name, Description, AmountNaira FROM dbo.Products WHERE IsActive = true ORDER BY Id');
      const mine = await dbRows('SELECT Reference, ProductName, AmountNaira, Status, CreatedAt FROM dbo.Payments WHERE StudentId = ? ORDER BY Id DESC LIMIT 20', [s.Id]);
      sendJson(res, 200, {
        enabled: !!paystackKey(),
        products: rows.map(r => ({ id: r.id, name: r.name, desc: r.description || '', amount: r.amountnaira })),
        payments: mine.map(r => ({ ref: r.reference, name: r.productname, amount: r.amountnaira, status: r.status, at: iso(r.createdat) }))
      });
      return true;
    }
    if (pathname === '/api/x/pay' && method === 'POST') {
      const s = await studentOnly(req, res); if (!s) return true;
      if (!paystackKey()) { sendJson(res, 503, { error: 'Online payment is not switched on yet. Please contact the admin on WhatsApp to pay.' }); return true; }
      const b = await parseBody(req);
      const p = (await dbRows('SELECT Id, Name, AmountNaira FROM dbo.Products WHERE Id = ? AND IsActive = true', [Number(b.productId) || 0]))[0];
      if (!p) { sendJson(res, 404, { error: 'That service is not available.' }); return true; }
      if (rateLimited(`pay:${s.Id}`, 10, 3600 * 1000)) { sendJson(res, 429, { error: 'Too many payment attempts. Try again later.' }); return true; }
      const ref = `TWW-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const origin = process.env.RENDER_EXTERNAL_URL || `https://${req.headers.host}`;
      let data;
      try {
        const r = await fetch(`${paystackUrl()}/transaction/initialize`, {
          method: 'POST', headers: { Authorization: `Bearer ${paystackKey()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: s.Email, amount: p.amountnaira * 100, reference: ref, callback_url: `${origin}/?paid=${ref}`, metadata: { student: s.Id, product: p.id } }),
          signal: AbortSignal.timeout(20000)
        });
        data = await r.json();
        if (!r.ok || !data.status) throw new Error(data.message || 'Paystack refused');
      } catch (e) {
        console.error('Paystack init failed:', e.message);
        sendJson(res, 502, { error: 'Could not start the payment. Try again, or contact the admin.' });
        return true;
      }
      await dbWrite('INSERT dbo.Payments (Reference, StudentId, ProductId, ProductName, AmountNaira) VALUES (?, ?, ?, ?, ?)', [ref, s.Id, p.id, p.name, p.amountnaira]);
      sendJson(res, 200, { url: data.data.authorization_url, ref });
      return true;
    }
    if (pathname === '/api/x/pay/verify' && method === 'GET') {
      const s = await studentOnly(req, res); if (!s) return true;
      const ref = clip(searchParams.get('ref'), 60);
      const own = (await dbRows('SELECT Id, Status FROM dbo.Payments WHERE Reference = ? AND StudentId = ?', [ref, s.Id]))[0];
      if (!own) { sendJson(res, 404, { error: 'Payment not found.' }); return true; }
      if (own.status !== 'paid' && paystackKey()) {
        try {
          const r = await fetch(`${paystackUrl()}/transaction/verify/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${paystackKey()}` }, signal: AbortSignal.timeout(20000) });
          const d = await r.json();
          if (d.status && d.data && d.data.status === 'success') await markPaid(ref, d.data.amount);
        } catch (e) { console.error('Paystack verify failed:', e.message); }
      }
      const now = (await dbRows('SELECT Status FROM dbo.Payments WHERE Reference = ?', [ref]))[0];
      sendJson(res, 200, { status: now.status });
      return true;
    }
    if (pathname === '/api/x/pay/webhook' && method === 'POST') {
      const raw = await readRaw(req, 100000);
      const sig = String(req.headers['x-paystack-signature'] || '');
      const want = crypto.createHmac('sha512', paystackKey() || 'x').update(raw).digest('hex');
      if (!paystackKey() || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) { sendJson(res, 401, { error: 'bad signature' }); return true; }
      try {
        const ev = JSON.parse(raw.toString('utf8'));
        if (ev.event === 'charge.success' && ev.data && ev.data.reference) await markPaid(ev.data.reference, ev.data.amount);
      } catch { /* ignore */ }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // ============================== ADMIN ==============================
    if (pathname.startsWith('/api/admin/x/')) {
      const admin = await adminOnly(req, res); if (!admin) return true;

      if (pathname === '/api/admin/x/all' && method === 'GET') {
        const [reps, contacts, groups, mentors, reports, sponsors, products, payments, broadcasts] = await Promise.all([
          dbRows('SELECT Id, FullName, Email, ClassTag FROM dbo.StudentProfiles WHERE IsRep = true ORDER BY FullName'),
          dbRows('SELECT c.Id, c.Category, c.Name, c.Phone, c.Note, u.Name AS school FROM dbo.SupportContacts c LEFT JOIN dbo.Universities u ON u.Id = c.UniversityId ORDER BY c.Category, c.Id'),
          dbRows('SELECT g.Id, g.Course, g.Title, g.Link, g.Status, u.Name AS school FROM dbo.StudyGroups g LEFT JOIN dbo.Universities u ON u.Id = g.UniversityId ORDER BY (g.Status = \'pending\') DESC, g.Id DESC LIMIT 100'),
          dbRows('SELECT m.Id, m.Name, m.Programme, m.LevelText, m.Bio, m.Phone, m.Status, u.Name AS school FROM dbo.Mentors m LEFT JOIN dbo.Universities u ON u.Id = m.UniversityId ORDER BY (m.Status = \'pending\') DESC, m.Id DESC LIMIT 100'),
          dbRows('SELECT r.Id, r.PostId, r.Reason, r.CreatedAt, (SELECT Headline FROM dbo.NewsArticles n WHERE n.Id::text = r.PostId) AS headline FROM dbo.PostReports r ORDER BY r.Id DESC LIMIT 100'),
          dbRows("SELECT Id, Title, Body, Link, to_char(StartsOn, 'YYYY-MM-DD') AS s, to_char(EndsOn, 'YYYY-MM-DD') AS e, Clicks, Views FROM dbo.Sponsors ORDER BY Id DESC LIMIT 50"),
          dbRows('SELECT Id, Name, Description, AmountNaira, IsActive FROM dbo.Products ORDER BY Id'),
          dbRows('SELECT p.Id, p.Reference, p.ProductName, p.AmountNaira, p.Status, p.CreatedAt, s.FullName, s.Phone FROM dbo.Payments p JOIN dbo.StudentProfiles s ON s.Id = p.StudentId ORDER BY p.Id DESC LIMIT 100'),
          dbRows('SELECT Id, Subject, Audience, Sent, Failed, Total, CreatedAt FROM dbo.Broadcasts ORDER BY Id DESC LIMIT 10')
        ]);
        sendJson(res, 200, {
          reps: reps.map(r => ({ id: r.id, name: r.fullname, email: r.email, tag: r.classtag || '' })),
          contacts: contacts.map(r => ({ id: r.id, cat: r.category, name: r.name, phone: r.phone || '', note: r.note || '', school: r.school || 'All schools' })),
          groups: groups.map(r => ({ id: r.id, course: r.course, title: r.title, link: r.link, status: r.status, school: r.school || 'All schools' })),
          mentors: mentors.map(r => ({ id: r.id, name: r.name, programme: r.programme || '', level: r.leveltext || '', bio: r.bio || '', phone: r.phone || '', status: r.status, school: r.school || '' })),
          reports: reports.map(r => ({ id: r.id, postId: r.postid, reason: r.reason || '', at: iso(r.createdat), headline: r.headline || '' })),
          sponsors: sponsors.map(r => ({ id: r.id, title: r.title, body: r.body || '', link: r.link || '', starts: r.s || '', ends: r.e || '', clicks: r.clicks, views: r.views })),
          products: products.map(r => ({ id: r.id, name: r.name, desc: r.description || '', amount: r.amountnaira, active: !!r.isactive })),
          payments: payments.map(r => ({ id: r.id, ref: r.reference, name: r.productname, amount: r.amountnaira, status: r.status, at: iso(r.createdat), student: r.fullname, phone: r.phone || '' })),
          broadcasts: broadcasts.map(r => ({ id: r.id, subject: r.subject, audience: r.audience, sent: r.sent, failed: r.failed, total: r.total, at: iso(r.createdat) })),
          payEnabled: !!paystackKey(), emailEnabled: !!process.env.RESEND_API_KEY
        });
        return true;
      }

      if (pathname === '/api/admin/x/reps' && method === 'POST') {
        const b = await parseBody(req);
        const email = clip(b.email, 120).toLowerCase();
        const r = await dbRows('UPDATE dbo.StudentProfiles SET IsRep = ?, ClassTag = COALESCE(?, ClassTag) WHERE lower(Email) = ? RETURNING Id', [b.on !== false, tagOf(b.tag) || null, email]);
        if (!r.length) { sendJson(res, 404, { error: 'No student has that email.' }); return true; }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (pathname === '/api/admin/x/contacts' && method === 'POST') {
        const b = await parseBody(req);
        const name = clip(b.name, 120);
        if (name.length < 2) { sendJson(res, 400, { error: 'Give a name.' }); return true; }
        await dbWrite('INSERT dbo.SupportContacts (Category, UniversityId, Name, Phone, Note) VALUES (?, ?, ?, ?, ?)',
          [CONTACT_CATS.includes(b.cat) ? b.cat : 'emergency', Number(b.universityId) || null, name, clip(b.phone, 40), clip(b.note, 300)]);
        sendJson(res, 201, { ok: true });
        return true;
      }
      if (pathname === '/api/admin/x/groups' && method === 'POST') {
        const b = await parseBody(req);
        const link = safeLink(b.link);
        if (!link || clip(b.title, 160).length < 3) { sendJson(res, 400, { error: 'Give a group name and a link.' }); return true; }
        await dbWrite("INSERT dbo.StudyGroups (UniversityId, Course, Title, Link, Details, Status) VALUES (?, ?, ?, ?, ?, 'approved')", [Number(b.universityId) || null, clip(b.course, 80) || 'General', clip(b.title, 160), link, clip(b.details, 400)]);
        sendJson(res, 201, { ok: true });
        return true;
      }
      if (pathname === '/api/admin/x/mentors' && method === 'POST') {
        const b = await parseBody(req);
        if (clip(b.name, 80).length < 2 || clip(b.phone, 30).length < 10) { sendJson(res, 400, { error: 'Give a name and WhatsApp number.' }); return true; }
        await dbWrite("INSERT dbo.Mentors (Name, UniversityId, Programme, LevelText, Bio, Phone, Status) VALUES (?, ?, ?, ?, ?, ?, 'approved')", [clip(b.name, 80), Number(b.universityId) || null, clip(b.programme, 120), clip(b.level, 40), clip(b.bio, 500), clip(b.phone, 30).replace(/[^\d+]/g, '')]);
        sendJson(res, 201, { ok: true });
        return true;
      }
      if (pathname === '/api/admin/x/sponsors' && method === 'POST') {
        const b = await parseBody(req);
        const title = clip(b.title, 120);
        if (title.length < 3) { sendJson(res, 400, { error: 'Give the advert a title.' }); return true; }
        await dbWrite('INSERT dbo.Sponsors (Title, Body, Link, StartsOn, EndsOn) VALUES (?, ?, ?, ?, ?)', [title, clip(b.body, 300), safeLink(b.link), isDate(b.starts) ? b.starts : null, isDate(b.ends) ? b.ends : null]);
        sendJson(res, 201, { ok: true });
        return true;
      }
      if (pathname === '/api/admin/x/products' && method === 'POST') {
        const b = await parseBody(req);
        const amount = Math.round(Number(b.amount));
        if (clip(b.name, 120).length < 3 || !(amount >= 100) || amount > 10000000) { sendJson(res, 400, { error: 'Give a name and an amount of at least 100 naira.' }); return true; }
        await dbWrite('INSERT dbo.Products (Name, Description, AmountNaira) VALUES (?, ?, ?)', [clip(b.name, 120), clip(b.desc, 400), amount]);
        sendJson(res, 201, { ok: true });
        return true;
      }
      if ((m = pathname.match(/^\/api\/admin\/x\/(groups|mentors)\/(\d+)\/approve$/)) && method === 'POST') {
        await dbWrite(`UPDATE dbo.${m[1] === 'groups' ? 'StudyGroups' : 'Mentors'} SET Status = 'approved' WHERE Id = ?`, [Number(m[2])]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if ((m = pathname.match(/^\/api\/admin\/x\/payments\/(\d+)\/paid$/)) && method === 'POST') {
        await dbWrite("UPDATE dbo.Payments SET Status = 'paid', PaidAt = now() WHERE Id = ?", [Number(m[1])]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if ((m = pathname.match(/^\/api\/admin\/x\/(contacts|groups|mentors|sponsors|products|reports)\/(\d+)$/)) && method === 'DELETE') {
        const table = { contacts: 'SupportContacts', groups: 'StudyGroups', mentors: 'Mentors', sponsors: 'Sponsors', products: 'Products', reports: 'PostReports' }[m[1]];
        await dbWrite(`DELETE FROM dbo.${table} WHERE Id = ?`, [Number(m[2])]);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if ((m = pathname.match(/^\/api\/admin\/x\/posts\/(\d+)\/verify$/)) && method === 'POST') {
        const b = await parseBody(req);
        await dbWrite('UPDATE dbo.NewsArticles SET Verified = ? WHERE Id = ?', [b.on !== false, Number(m[1])]);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ----- statistics -----
      if (pathname === '/api/admin/x/stats' && method === 'GET') {
        const one = async (sql, p) => Number((await dbRows(sql, p || []))[0].n);
        const byUni = await dbRows('SELECT v.Name AS name, count(*) AS n FROM dbo.StudentProfiles s JOIN dbo.Universities v ON v.Id = s.UniversityId GROUP BY v.Name ORDER BY n DESC LIMIT 10');
        const daily = await dbRows("SELECT to_char(d::date, 'YYYY-MM-DD') AS day, (SELECT count(*) FROM dbo.StudentProfiles s WHERE s.CreatedAt::date = d::date) AS n FROM generate_series(current_date - 13, current_date, interval '1 day') d ORDER BY d");
        const top = await dbRows('SELECT PostId, Views, Shares FROM dbo.PostStats ORDER BY Views DESC LIMIT 5');
        const heads = {};
        for (const t of top) { const h = (await dbRows('SELECT Headline FROM dbo.NewsArticles WHERE Id::text = ?', [t.postid]))[0]; heads[t.postid] = h ? h.headline : 'Post ' + t.postid; }
        const reqs = await dbRows('SELECT Status, count(*) AS n FROM dbo.ServiceRequests GROUP BY Status');
        const paid = (await dbRows("SELECT COALESCE(sum(AmountNaira), 0) AS n FROM dbo.Payments WHERE Status = 'paid'"))[0];
        sendJson(res, 200, {
          students: await one('SELECT count(*) AS n FROM dbo.StudentProfiles'),
          week: await one("SELECT count(*) AS n FROM dbo.StudentProfiles WHERE CreatedAt > now() - interval '7 days'"),
          signedUpToday: await one('SELECT count(*) AS n FROM dbo.StudentProfiles WHERE CreatedAt::date = current_date'),
          withPhone: await one("SELECT count(*) AS n FROM dbo.StudentProfiles WHERE COALESCE(Phone, '') <> ''"),
          referred: await one('SELECT count(*) AS n FROM dbo.StudentProfiles WHERE ReferredBy IS NOT NULL'),
          posts: await one('SELECT count(*) AS n FROM dbo.NewsArticles'),
          notes: await one('SELECT count(*) AS n FROM dbo.Materials'),
          openRequests: reqs.filter(r => r.status !== 'done').reduce((a, r) => a + Number(r.n), 0),
          paidNaira: Number(paid.n),
          byUni: byUni.map(r => ({ name: r.name, n: Number(r.n) })),
          daily: daily.map(r => ({ day: r.day, n: Number(r.n) })),
          top: top.map(t => ({ title: heads[t.postid], views: t.views, shares: t.shares }))
        });
        return true;
      }

      // ----- broadcast (email) and phone list -----
      if (pathname === '/api/admin/x/audience' && method === 'GET') {
        const uni = Number(searchParams.get('universityId')) || null;
        const rows = await dbRows("SELECT FullName, Phone, Email FROM dbo.StudentProfiles WHERE IsSuspended = false AND (?::bigint IS NULL OR UniversityId = ?::bigint) ORDER BY Id DESC LIMIT 2000", [uni, uni]);
        sendJson(res, 200, rows.map(r => ({ name: r.fullname, phone: r.phone || '', email: r.email })));
        return true;
      }
      if (pathname === '/api/admin/x/broadcast' && method === 'POST') {
        if (!process.env.RESEND_API_KEY) { sendJson(res, 503, { error: 'Email sending is not switched on. Add RESEND_API_KEY in Render, or use the WhatsApp list below.' }); return true; }
        const b = await parseBody(req);
        const subject = clip(b.subject, 160), text = clip(b.text, 4000);
        if (subject.length < 3 || text.length < 10) { sendJson(res, 400, { error: 'Write a subject and a message.' }); return true; }
        const uni = Number(b.universityId) || null;
        const rows = await dbRows('SELECT FullName, Email FROM dbo.StudentProfiles WHERE IsSuspended = false AND (?::bigint IS NULL OR UniversityId = ?::bigint) ORDER BY Id LIMIT 500', [uni, uni]);
        const rec = await dbWrite('INSERT dbo.Broadcasts (Subject, Audience, Total) OUTPUT INSERTED.Id VALUES (?, ?, ?)', [subject, uni ? 'One university' : 'All students', rows.length]);
        (async () => {
          let sent = 0, failed = 0;
          for (const r of rows) {
            try { await sendEmail(r.email, subject, `Hello ${String(r.fullname).split(' ')[0]},\n\n${text}\n\n- TOBI WORLD WIDE EDU CONSULTANT`); sent += 1; } catch { failed += 1; }
            await new Promise(ok => setTimeout(ok, 250));
          }
          await dbWrite('UPDATE dbo.Broadcasts SET Sent = ?, Failed = ? WHERE Id = ?', [sent, failed, rec.Id]).catch(() => {});
        })();
        sendJson(res, 202, { ok: true, total: rows.length, message: `Sending to ${rows.length} students in the background. Check the list below in a few minutes.` });
        return true;
      }
    }
    return false;
  }

  return { handle, afterRegister };
};
