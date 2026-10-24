'use strict';
// Extra portal features: help requests, announcements, post read counts, CBT practice,
// password reset, and the background scheduler. Wired into server.js via makeFeatures(deps).
const crypto = require('crypto');

const REQUEST_KINDS = ['Admission processing', 'Hostel accommodation', 'NELFUND', 'Scholarship form', 'Scam report', 'Password reset', 'Other'];
const REQUEST_STATUS = ['new', 'in_progress', 'done'];

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// Pulls the first JSON array out of an AI reply, even when it is wrapped in a code fence.
function extractJsonArray(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no_json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function cleanQuestion(raw, subject, source) {
  if (!raw || typeof raw !== 'object') return null;
  const options = raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options)
    ? raw.options
    : { A: raw.a ?? raw.A, B: raw.b ?? raw.B, C: raw.c ?? raw.C, D: raw.d ?? raw.D };
  const list = Array.isArray(raw.options) ? raw.options : null;
  const opt = letter => clip(list ? list['ABCD'.indexOf(letter)] : (options[letter] ?? options[letter.toLowerCase()]), 300);
  const question = clip(raw.question || raw.q, 700);
  const a = opt('A'), b = opt('B'), c = opt('C'), d = opt('D');
  const answer = clip(raw.answer, 1).toUpperCase();
  if (!question || !a || !b || !'ABCD'.includes(answer) || !answer) return null;
  if ((answer === 'C' && !c) || (answer === 'D' && !d)) return null;
  return { subject: clip(subject, 120), question, a, b, c: c || null, d: d || null, answer, explanation: clip(raw.explanation || raw.why, 700) || null, source };
}

const makeCampus = require('./campus');
const makeExtras = require('./extras');
const makeCafe = require('./cafe');

module.exports = function makeFeatures(deps) {
  const {
    dbRows, dbWrite, withTransaction, sendJson, parseBody, requireStudent, getPortalUser, askClaude, aiEnabled,
    rateLimited, tokenHash, hashPassword, parseSubjects, runNewsDesk
  } = deps;

  const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  async function requireAdmin(req, res) {
    const current = await getPortalUser(req);
    if (!current || current.role !== 'admin') {
      sendJson(res, current ? 403 : 401, { error: 'admin_required' });
      return null;
    }
    return current;
  }

  // ---------- email (optional) ----------
  const emailEnabled = () => !!process.env.RESEND_API_KEY;
  async function sendEmail(to, subject, text) {
    const response = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM || 'Tobi World Wide <onboarding@resend.dev>', to: [to], subject, text }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Email service returned ${response.status}`);
  }

  async function createQuestions(items) {
    let added = 0;
    for (const q of items) {
      await dbWrite(
        'INSERT dbo.CbtQuestions (Subject, Question, OptA, OptB, OptC, OptD, Answer, Explanation, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [q.subject, q.question, q.a, q.b, q.c, q.d, q.answer, q.explanation, q.source]
      );
      added += 1;
    }
    return added;
  }

  async function generateQuestions(subject, programme, count) {
    const system = 'You write university-level multiple-choice practice questions for Nigerian students. '
      + 'Reply with ONLY a JSON array, no commentary and no markdown. Each item: {"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"answer":"A","explanation":"one or two sentences"}. '
      + 'Exactly one option is correct. Only include facts you are sure about.';
    const prompt = `Write ${count} multiple-choice questions for the course "${subject}"${programme ? ` (programme: ${programme})` : ''}. Mix easy and moderate difficulty.`;
    const text = await askClaude(system, [{ role: 'user', content: prompt }], 3500, 90000);
    let parsed;
    try { parsed = extractJsonArray(text); } catch { throw new Error('The AI reply could not be read. Please try again.'); }
    return parsed.map(item => cleanQuestion(item, subject, 'ai')).filter(Boolean);
  }

  function publicQuestion(r) {
    return { id: r.id, q: r.question, o: { A: r.opta, B: r.optb, C: r.optc || '', D: r.optd || '' }, a: String(r.answer).trim(), e: r.explanation || '' };
  }

  const campus = makeCampus(deps);
  const extras = makeExtras({ ...deps, sendEmail });
  const cafe = makeCafe(deps);

  async function handle(req, res, pathname, searchParams) {
    const method = req.method;
    if (await campus.handle(req, res, pathname, searchParams)) return true;
    if (await cafe.handle(req, res, pathname, searchParams)) return true;
    if (await extras.handle(req, res, pathname, searchParams)) return true;

    // ===== help requests (students) =====
    if (pathname === '/api/requests') {
      const student = await requireStudent(req);
      if (!student) { sendJson(res, 401, { error: 'Please log in again.' }); return true; }
      if (method === 'GET') {
        const rows = await dbRows('SELECT Id, Kind, Details, Status, AdminNote, CreatedAt FROM dbo.ServiceRequests WHERE StudentId = ? ORDER BY Id DESC LIMIT 30', [student.Id]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, details: r.details || '', status: r.status, note: r.adminnote || '', created: r.createdat })));
        return true;
      }
      if (method === 'POST') {
        const body = await parseBody(req);
        const kind = REQUEST_KINDS.includes(body.kind) && body.kind !== 'Password reset' ? body.kind : '';
        const details = clip(body.details, 1500);
        if (!kind) { sendJson(res, 400, { error: 'Choose what you need help with.' }); return true; }
        if (details.length < 5) { sendJson(res, 400, { error: 'Tell us a little about what you need.' }); return true; }
        if (rateLimited(`req:${student.Id}`, 5, 24 * 60 * 60 * 1000)) { sendJson(res, 429, { error: 'You have sent several requests today. Please wait for a reply first.' }); return true; }
        await dbWrite('INSERT dbo.ServiceRequests (StudentId, Kind, Details) VALUES (?, ?, ?)', [student.Id, kind, details]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }

    // ===== help requests (admin) =====
    if (pathname === '/api/admin/requests' && method === 'GET') {
      if (!await requireAdmin(req, res)) return true;
      const rows = await dbRows(
        'SELECT r.Id, r.StudentId, r.Kind, r.Details, r.Status, r.AdminNote, r.CreatedAt, u.FullName, u.Email, u.Phone, v.Name AS University '
        + 'FROM dbo.ServiceRequests r JOIN dbo.StudentProfiles u ON u.Id = r.StudentId JOIN dbo.Universities v ON v.Id = u.UniversityId '
        + "ORDER BY CASE r.Status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, r.Id DESC LIMIT 300"
      );
      sendJson(res, 200, rows.map(r => ({
        id: r.id, studentId: r.studentid, kind: r.kind, details: r.details || '', status: r.status, note: r.adminnote || '',
        created: r.createdat, name: r.fullname, email: r.email, phone: r.phone || '', school: r.university
      })));
      return true;
    }
    const reqAction = pathname.match(/^\/api\/admin\/requests\/(\d+)$/);
    if (reqAction) {
      if (!await requireAdmin(req, res)) return true;
      const id = Number(reqAction[1]);
      if (method === 'DELETE') {
        await dbWrite('DELETE FROM dbo.ServiceRequests WHERE Id = ?', [id]);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      if (method === 'POST') {
        const body = await parseBody(req);
        if (!REQUEST_STATUS.includes(body.status)) { sendJson(res, 400, { error: 'invalid_status' }); return true; }
        const changed = await dbWrite('UPDATE dbo.ServiceRequests SET Status = ?, AdminNote = COALESCE(?, AdminNote), UpdatedAt = now() WHERE Id = ?',
          [body.status, body.note == null ? null : clip(body.note, 500), id]);
        sendJson(res, changed ? 200 : 404, changed ? { status: body.status } : { error: 'Request not found.' });
        return true;
      }
    }

    // ===== announcements =====
    if (pathname === '/api/announcements' && method === 'GET') {
      const student = await requireStudent(req).catch(() => null);
      const rows = await dbRows(
        'SELECT Id, Message, CreatedAt FROM dbo.Announcements WHERE UniversityId IS NULL OR UniversityId = ? ORDER BY Id DESC LIMIT 3',
        [student ? student.UniversityId : 0]
      );
      sendJson(res, 200, rows.map(r => ({ id: r.id, message: r.message, created: r.createdat })));
      return true;
    }
    if (pathname === '/api/admin/announcements') {
      if (!await requireAdmin(req, res)) return true;
      if (method === 'GET') {
        const rows = await dbRows('SELECT a.Id, a.Message, a.CreatedAt, v.Name AS University FROM dbo.Announcements a LEFT JOIN dbo.Universities v ON v.Id = a.UniversityId ORDER BY a.Id DESC LIMIT 50');
        sendJson(res, 200, rows.map(r => ({ id: r.id, message: r.message, created: r.createdat, school: r.university || '' })));
        return true;
      }
      if (method === 'POST') {
        const body = await parseBody(req);
        const message = clip(body.message, 600);
        if (message.length < 3) { sendJson(res, 400, { error: 'Type the announcement first.' }); return true; }
        let universityId = null;
        const school = clip(body.school, 250);
        if (school) {
          const found = await dbRows('SELECT Id FROM dbo.Universities WHERE lower(Name) = lower(?) LIMIT 1', [school])
            .then(r => r.length ? r : dbRows('SELECT Id FROM dbo.Universities WHERE Name ILIKE ? ORDER BY length(Name) LIMIT 1', ['%' + school.replace(/[%_]/g, '') + '%']));
          if (!found.length) { sendJson(res, 400, { error: 'That university was not found. Pick it from the list, or leave it empty for all students.' }); return true; }
          universityId = found[0].id;
        }
        await dbWrite('INSERT dbo.Announcements (Message, UniversityId) VALUES (?, ?)', [message, universityId]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    const annDel = pathname.match(/^\/api\/admin\/announcements\/(\d+)$/);
    if (annDel && method === 'DELETE') {
      if (!await requireAdmin(req, res)) return true;
      await dbWrite('DELETE FROM dbo.Announcements WHERE Id = ?', [Number(annDel[1])]);
      sendJson(res, 200, { deleted: true });
      return true;
    }

    // ===== post read counts =====
    const postHit = pathname.match(/^\/api\/posts\/([A-Za-z0-9_-]{1,40})\/(view|share)$/);
    if (postHit && method === 'POST') {
      const column = postHit[2] === 'view' ? 'Views' : 'Shares';
      if (!rateLimited(`hit:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
        await dbWrite(`INSERT INTO dbo.PostStats (PostId, ${column}) VALUES (?, 1) ON CONFLICT (PostId) DO UPDATE SET ${column} = PostStats.${column} + 1`, [postHit[1]]);
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (pathname === '/api/admin/post-stats' && method === 'GET') {
      if (!await requireAdmin(req, res)) return true;
      const rows = await dbRows('SELECT PostId, Views, Shares FROM dbo.PostStats');
      const out = {};
      rows.forEach(r => { out[r.postid] = { views: r.views, shares: r.shares }; });
      sendJson(res, 200, out);
      return true;
    }

    // ===== CBT practice (students) =====
    if (pathname === '/api/cbt/subjects' && method === 'GET') {
      const student = await requireStudent(req);
      if (!student) { sendJson(res, 401, { error: 'Please log in again.' }); return true; }
      const rows = await dbRows('SELECT min(Subject) AS subject, COUNT(*) AS total FROM dbo.CbtQuestions GROUP BY lower(Subject) ORDER BY min(Subject)');
      sendJson(res, 200, { subjects: rows.map(r => ({ name: r.subject, total: r.total })), mine: parseSubjects(student.Subjects).map(s => s.t), ai: aiEnabled() });
      return true;
    }
    if (pathname === '/api/cbt/questions' && method === 'GET') {
      const student = await requireStudent(req);
      if (!student) { sendJson(res, 401, { error: 'Please log in again.' }); return true; }
      const subject = clip(searchParams.get('subject'), 120);
      const n = Math.min(Math.max(Number(searchParams.get('n')) || 10, 1), 40);
      const rows = await dbRows('SELECT Id, Question, OptA, OptB, OptC, OptD, Answer, Explanation FROM dbo.CbtQuestions WHERE lower(Subject) = lower(?) ORDER BY random() LIMIT ?', [subject, n]);
      sendJson(res, 200, rows.map(publicQuestion));
      return true;
    }
    if (pathname === '/api/cbt/generate' && method === 'POST') {
      const student = await requireStudent(req);
      if (!student) { sendJson(res, 401, { error: 'Please log in again.' }); return true; }
      if (!aiEnabled()) { sendJson(res, 503, { error: 'Practice questions from the tutor are not switched on yet.' }); return true; }
      const body = await parseBody(req);
      const subject = clip(body.subject, 120);
      if (!parseSubjects(student.Subjects).some(s => s.t === subject)) { sendJson(res, 400, { error: 'Add that course to your study guide first.' }); return true; }
      if (rateLimited(`cbtgen:${student.Id}`, 4, 60 * 60 * 1000)) { sendJson(res, 429, { error: 'You have generated many question sets this hour. Please try again later.' }); return true; }
      const made = await generateQuestions(subject, student.Programme, 10);
      if (!made.length) { sendJson(res, 502, { error: 'The tutor could not write usable questions. Please try again.' }); return true; }
      const added = await createQuestions(made);
      sendJson(res, 200, { added });
      return true;
    }

    // ===== CBT practice (admin) =====
    if (pathname === '/api/admin/cbt') {
      if (!await requireAdmin(req, res)) return true;
      if (method === 'GET') {
        const rows = await dbRows('SELECT Id, Subject, Question, Answer, Source FROM dbo.CbtQuestions ORDER BY Id DESC LIMIT 100');
        const subjects = await dbRows('SELECT min(Subject) AS subject, COUNT(*) AS total FROM dbo.CbtQuestions GROUP BY lower(Subject) ORDER BY min(Subject)');
        sendJson(res, 200, { subjects: subjects.map(r => ({ name: r.subject, total: r.total })), recent: rows.map(r => ({ id: r.id, subject: r.subject, q: r.question, a: String(r.answer).trim(), source: r.source })) });
        return true;
      }
      if (method === 'POST') {
        const body = await parseBody(req);
        const subject = clip(body.subject, 120);
        if (!subject) { sendJson(res, 400, { error: 'Type the course name first.' }); return true; }
        if (body.generate) {
          if (!aiEnabled()) { sendJson(res, 400, { error: 'Turn on the AI key first.' }); return true; }
          const made = await generateQuestions(subject, '', Math.min(Math.max(Number(body.count) || 10, 3), 15));
          if (!made.length) { sendJson(res, 502, { error: 'The AI did not return usable questions. Try again.' }); return true; }
          sendJson(res, 200, { added: await createQuestions(made) });
          return true;
        }
        const list = Array.isArray(body.questions) ? body.questions : [body];
        const clean = list.slice(0, 100).map(item => cleanQuestion(item, subject, 'admin')).filter(Boolean);
        if (!clean.length) { sendJson(res, 400, { error: 'No valid questions. Each needs a question, options A and B at least, and the correct letter.' }); return true; }
        sendJson(res, 201, { added: await createQuestions(clean), skipped: list.length - clean.length });
        return true;
      }
    }
    const cbtDel = pathname.match(/^\/api\/admin\/cbt\/(\d+)$/);
    if (cbtDel && method === 'DELETE') {
      if (!await requireAdmin(req, res)) return true;
      await dbWrite('DELETE FROM dbo.CbtQuestions WHERE Id = ?', [Number(cbtDel[1])]);
      sendJson(res, 200, { deleted: true });
      return true;
    }

    // ===== forgotten password =====
    if (pathname === '/api/auth/forgot' && method === 'POST') {
      const body = await parseBody(req);
      const email = clip(body.email, 120).toLowerCase();
      if (!email.includes('@')) { sendJson(res, 400, { error: 'Enter the email you registered with.' }); return true; }
      if (rateLimited(`forgot:${clientIp(req)}`, 8, 60 * 60 * 1000) || rateLimited(`forgot:${email}`, 3, 60 * 60 * 1000)) {
        sendJson(res, 429, { error: 'Too many attempts. Please try again in an hour.' });
        return true;
      }
      const mode = emailEnabled() ? 'email' : 'admin';
      const found = await dbRows('SELECT Id FROM dbo.StudentProfiles WHERE Email = ? AND IsSuspended = false', [email]);
      if (found.length) {
        const studentId = found[0].id;
        if (mode === 'email') {
          const code = String(crypto.randomInt(100000, 1000000));
          await dbWrite('DELETE FROM dbo.PasswordResets WHERE StudentId = ?', [studentId]);
          await dbWrite("INSERT dbo.PasswordResets (StudentId, CodeHash, ExpiresAt) VALUES (?, ?, now() + interval '15 minutes')", [studentId, tokenHash(code)]);
          try {
            await sendEmail(email, 'Your Tobi World Wide reset code', `Your password reset code is ${code}. It works for 15 minutes. If you did not ask for it, ignore this email.`);
          } catch (error) {
            console.error('Reset email failed:', error.message);
          }
        } else {
          const open = await dbRows("SELECT Id FROM dbo.ServiceRequests WHERE StudentId = ? AND Kind = 'Password reset' AND Status <> 'done' LIMIT 1", [studentId]);
          if (!open.length) await dbWrite("INSERT dbo.ServiceRequests (StudentId, Kind, Details) VALUES (?, 'Password reset', 'Forgot password. Please send me a new one.')", [studentId]);
        }
      }
      sendJson(res, 200, { mode, message: mode === 'email'
        ? 'If that email is registered, a 6-digit code has been sent to it. It works for 15 minutes.'
        : 'Request received. The admin will send you a new password on WhatsApp.' });
      return true;
    }
    if (pathname === '/api/auth/reset' && method === 'POST') {
      const body = await parseBody(req);
      const email = clip(body.email, 120).toLowerCase();
      const code = clip(body.code, 10);
      const password = String(body.password || '');
      if (password.length < 8) { sendJson(res, 400, { error: 'Use a password of at least 8 characters.' }); return true; }
      if (rateLimited(`reset:${clientIp(req)}`, 20, 60 * 60 * 1000)) { sendJson(res, 429, { error: 'Too many attempts. Please try again later.' }); return true; }
      const rows = await dbRows(
        'SELECT p.Id, p.StudentId, p.CodeHash, p.Attempts FROM dbo.PasswordResets p JOIN dbo.StudentProfiles u ON u.Id = p.StudentId WHERE u.Email = ? AND p.ExpiresAt > now() ORDER BY p.Id DESC LIMIT 1',
        [email]
      );
      const reset = rows[0];
      if (!reset || reset.attempts >= 5) { sendJson(res, 400, { error: 'That code is not valid any more. Ask for a new one.' }); return true; }
      if (tokenHash(code) !== reset.codehash) {
        await dbWrite('UPDATE dbo.PasswordResets SET Attempts = Attempts + 1 WHERE Id = ?', [reset.id]);
        sendJson(res, 400, { error: 'That code is not correct.' });
        return true;
      }
      await dbWrite('UPDATE dbo.StudentProfiles SET PasswordHash = ? WHERE Id = ?', [hashPassword(password), reset.studentid]);
      await dbWrite('DELETE FROM dbo.ApiSessions WHERE StudentId = ?', [reset.studentid]);
      await dbWrite('DELETE FROM dbo.PasswordResets WHERE StudentId = ?', [reset.studentid]);
      sendJson(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  // ---------- background jobs ----------
  function startScheduler(log = console) {
    const base = process.env.RENDER_EXTERNAL_URL || process.env.TWW_PUBLIC_URL;
    if (base && process.env.TWW_KEEP_AWAKE !== 'off') {
      setInterval(() => {
        fetch(base.replace(/\/$/, '') + '/api/health', { signal: AbortSignal.timeout(20000) }).catch(() => {});
      }, 10 * 60 * 1000).unref();
    }
    const autoNews = async () => {
      try {
        if (!aiEnabled() || process.env.TWW_AUTO_NEWS === 'off') return;
        // with the drip on, look again every 3 hours (only when the queue is running low); otherwise once a day
        const due = await dbRows(
          `SELECT 1 AS due FROM dbo.NewsDeskSettings WHERE Id = 1 AND AutoSearch = true AND (LastAutoRun IS NULL OR LastAutoRun < now() - (CASE WHEN DripMinutes > 0 AND (SELECT count(*) FROM dbo.PendingNewsArticles WHERE Status = 'queued') < 3 THEN interval '3 hours' ELSE interval '22 hours' END))`
        );
        if (!due.length) return;
        // claim the slot first so two instances do not both run
        await dbWrite('UPDATE dbo.NewsDeskSettings SET LastAutoRun = now() WHERE Id = 1');
        try {
          const counts = await runNewsDesk();
          log.log(`Daily news search: published ${counts.published}, pending ${counts.pending}, skipped ${counts.skipped}`);
        } catch (error) {
          log.error('Daily news search failed:', error.message);
          // retry in about 4 hours instead of waiting a full day
          await dbWrite("UPDATE dbo.NewsDeskSettings SET LastAutoRun = now() - interval '18 hours' WHERE Id = 1");
        }
      } catch (error) {
        log.error('Scheduler error:', error.message);
      }
    };
    // News drip: publish one queued official item every DripMinutes, preferring a different school from the last post
    const drip = async () => {
      try {
        const claimed = await dbRows(
          "UPDATE dbo.NewsDeskSettings SET DripLastRun = now() WHERE Id = 1 AND DripMinutes > 0 AND (DripLastRun IS NULL OR DripLastRun <= now() - (DripMinutes * interval '1 minute') + interval '5 seconds') RETURNING Id"
        );
        if (!claimed.length) return;
        const last = (await dbRows('SELECT School FROM dbo.NewsArticles ORDER BY PublishedAt DESC LIMIT 1'))[0];
        const lastSchool = last ? last.School || last.school || '' : '';
        const item = (await dbRows(
          "SELECT Id, Topic, Headline, Summary, BodyHtml, School, SourceUrl FROM dbo.PendingNewsArticles WHERE Status = 'queued' ORDER BY (COALESCE(School, '') = ?) , Id LIMIT 1", [lastSchool]
        ))[0];
        if (!item) return;
        const mins = Math.max(1, Math.ceil(String(item.bodyhtml || '').replace(/<[^>]+>/g, ' ').split(/\s+/).length / 200));
        const art = await dbWrite(
          'INSERT dbo.NewsArticles (Topic, Headline, Summary, BodyHtml, ReadingMinutes, School, SourceUrl, AuthorId, Verified) OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?, ?, ?, NULL, true)',
          [item.topic, item.headline, item.summary, item.bodyhtml, mins, item.school, item.sourceurl]
        );
        await dbWrite("UPDATE dbo.PendingNewsArticles SET Status = 'published', ReviewedAt = now(), PublishedArticleId = ? WHERE Id = ?", [art.Id, item.id]);
        log.log(`News drip published: ${item.headline} (${item.school || 'All schools'})`);
      } catch (error) {
        log.error('News drip error:', error.message);
      }
    };
    setTimeout(autoNews, 2 * 60 * 1000).unref();
    setInterval(autoNews, 30 * 60 * 1000).unref();
    setInterval(drip, 30 * 1000).unref();
  }

  return { handle, startScheduler, afterRegister: extras.afterRegister };
};
