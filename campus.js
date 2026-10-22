'use strict';
// Campus hub: opportunities, personal deadlines, registration checklist, timetable and exams,
// notes and handouts, hostel and market listings, scam alerts. Wired in from features.js.

const OPP_KINDS = ['Scholarship', 'SIWES', 'Internship', 'Job', 'Other'];
const DEADLINE_KINDS = ['fees', 'nelfund', 'scholarship', 'exam', 'other'];
const LISTING_KINDS = ['hostel', 'roommate', 'sale', 'lost', 'found', 'other'];
const FILE_TYPES = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};
const MAX_FILE = 5 * 1024 * 1024;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(Date.parse(v));
const safeLink = v => { const s = clip(v, 500); return /^https?:\/\//i.test(s) ? s : ''; };

async function readRaw(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('File is too large. The limit is 5 MB.'), { tooLarge: true });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = function makeCampus(deps) {
  const { dbRows, dbWrite, sendJson, parseBody, requireStudent, getPortalUser, rateLimited } = deps;

  async function adminOnly(req, res) {
    const current = await getPortalUser(req);
    if (!current || current.role !== 'admin') {
      sendJson(res, current ? 403 : 401, { error: 'admin_required' });
      return null;
    }
    return current;
  }
  async function studentOnly(req, res) {
    const student = await requireStudent(req);
    if (!student) sendJson(res, 401, { error: 'Please log in again.' });
    return student;
  }

  const oppRow = r => ({ id: r.id, kind: r.kind, title: r.title, org: r.org || '', location: r.location || '', deadline: r.deadline || '', link: r.link || '', details: r.details || '', status: r.status });
  const OPP_COLS = "Id, Kind, Title, Org, Location, to_char(Deadline, 'YYYY-MM-DD') AS deadline, Link, Details, Status";

  async function handle(req, res, pathname, searchParams) {
    const method = req.method;
    let m;

    // ---------- opportunities ----------
    if (pathname === '/api/opportunities' && method === 'GET') {
      const kind = clip(searchParams.get('kind'), 20);
      const rows = await dbRows(
        `SELECT ${OPP_COLS} FROM dbo.Opportunities WHERE Status = 'approved' AND (Deadline IS NULL OR Deadline >= current_date) AND (? = '' OR Kind = ?) ORDER BY Deadline NULLS LAST, Id DESC LIMIT 100`,
        [kind, kind]
      );
      sendJson(res, 200, rows.map(oppRow));
      return true;
    }
    if (pathname === '/api/opportunities' && method === 'POST') {
      const student = await studentOnly(req, res); if (!student) return true;
      const b = await parseBody(req);
      const kind = OPP_KINDS.includes(b.kind) ? b.kind : '';
      const title = clip(b.title, 200);
      if (!kind || title.length < 4) { sendJson(res, 400, { error: 'Choose a type and give it a title.' }); return true; }
      if (rateLimited(`opp:${student.Id}`, 5, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You have suggested several already today. Try again tomorrow.' }); return true; }
      await dbWrite('INSERT dbo.Opportunities (Kind, Title, Org, Location, Deadline, Link, Details, Status, SubmittedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [kind, title, clip(b.org, 160), clip(b.location, 120), isDate(b.deadline) ? b.deadline : null, safeLink(b.link), clip(b.details, 1500), 'pending', student.Id]);
      sendJson(res, 201, { ok: true, message: 'Thanks. It will show after the admin checks it.' });
      return true;
    }

    // ---------- personal deadlines ----------
    if (pathname === '/api/deadlines') {
      const student = await studentOnly(req, res); if (!student) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT Id, Title, Kind, to_char(DueDate, 'YYYY-MM-DD') AS due, Done FROM dbo.StudentDeadlines WHERE StudentId = ? ORDER BY Done, DueDate LIMIT 100", [student.Id]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, title: r.title, kind: r.kind, due: r.due, done: !!r.done })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const title = clip(b.title, 160);
        if (!title || !isDate(b.due)) { sendJson(res, 400, { error: 'Give it a name and a date.' }); return true; }
        const count = await dbRows('SELECT COUNT(*) AS n FROM dbo.StudentDeadlines WHERE StudentId = ?', [student.Id]);
        if (count[0].n >= 100) { sendJson(res, 400, { error: 'You have 100 saved deadlines. Delete some first.' }); return true; }
        await dbWrite('INSERT dbo.StudentDeadlines (StudentId, Title, Kind, DueDate) VALUES (?, ?, ?, ?)', [student.Id, title, DEADLINE_KINDS.includes(b.kind) ? b.kind : 'other', b.due]);
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/deadlines\/(\d+)$/))) {
      const student = await studentOnly(req, res); if (!student) return true;
      if (method === 'DELETE') {
        await dbWrite('DELETE FROM dbo.StudentDeadlines WHERE Id = ? AND StudentId = ?', [Number(m[1]), student.Id]);
        sendJson(res, 200, { deleted: true });
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        await dbWrite('UPDATE dbo.StudentDeadlines SET Done = ? WHERE Id = ? AND StudentId = ?', [!!b.done, Number(m[1]), student.Id]);
        sendJson(res, 200, { done: !!b.done });
        return true;
      }
    }

    // ---------- registration checklist ----------
    if (pathname === '/api/checklist' && method === 'GET') {
      const student = await studentOnly(req, res); if (!student) return true;
      const rows = await dbRows(
        'SELECT c.Id, c.Title, c.Details, (d.ItemId IS NOT NULL) AS done, (c.UniversityId IS NOT NULL) AS mine FROM dbo.ChecklistItems c '
        + 'LEFT JOIN dbo.ChecklistDone d ON d.ItemId = c.Id AND d.StudentId = ? WHERE c.UniversityId IS NULL OR c.UniversityId = ? ORDER BY c.Pos, c.Id',
        [student.Id, student.UniversityId]
      );
      sendJson(res, 200, rows.map(r => ({ id: r.id, title: r.title, details: r.details || '', done: !!r.done, school: !!r.mine })));
      return true;
    }
    if ((m = pathname.match(/^\/api\/checklist\/(\d+)$/)) && method === 'POST') {
      const student = await studentOnly(req, res); if (!student) return true;
      const b = await parseBody(req);
      const item = await dbRows('SELECT Id FROM dbo.ChecklistItems WHERE Id = ? AND (UniversityId IS NULL OR UniversityId = ?)', [Number(m[1]), student.UniversityId]);
      if (!item.length) { sendJson(res, 404, { error: 'Step not found.' }); return true; }
      if (b.done) await dbWrite('INSERT INTO dbo.ChecklistDone (StudentId, ItemId) VALUES (?, ?) ON CONFLICT DO NOTHING', [student.Id, Number(m[1])]);
      else await dbWrite('DELETE FROM dbo.ChecklistDone WHERE StudentId = ? AND ItemId = ?', [student.Id, Number(m[1])]);
      sendJson(res, 200, { done: !!b.done });
      return true;
    }

    // ---------- timetable and exams ----------
    if (pathname === '/api/schedule') {
      const student = await studentOnly(req, res); if (!student) return true;
      if (method === 'GET') {
        const rows = await dbRows("SELECT Id, Kind, Title, DayNo, StartTime, Venue, to_char(ExamDate, 'YYYY-MM-DD') AS examdate FROM dbo.StudentSchedule WHERE StudentId = ? ORDER BY DayNo, StartTime, ExamDate LIMIT 200", [student.Id]);
        sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, day: r.dayno, time: r.starttime || '', venue: r.venue || '', date: r.examdate || '' })));
        return true;
      }
      if (method === 'POST') {
        const b = await parseBody(req);
        const title = clip(b.title, 160);
        const time = /^\d{1,2}:\d{2}$/.test(clip(b.time, 8)) ? clip(b.time, 8) : '';
        if (!title) { sendJson(res, 400, { error: 'Type the course name.' }); return true; }
        if (b.kind === 'exam') {
          if (!isDate(b.date)) { sendJson(res, 400, { error: 'Pick the exam date.' }); return true; }
          await dbWrite("INSERT dbo.StudentSchedule (StudentId, Kind, Title, StartTime, Venue, ExamDate) VALUES (?, 'exam', ?, ?, ?, ?)", [student.Id, title, time, clip(b.venue, 80), b.date]);
        } else {
          const day = Number(b.day);
          if (!Number.isInteger(day) || day < 0 || day > 6) { sendJson(res, 400, { error: 'Pick the day of the week.' }); return true; }
          await dbWrite("INSERT dbo.StudentSchedule (StudentId, Kind, Title, DayNo, StartTime, Venue) VALUES (?, 'class', ?, ?, ?, ?)", [student.Id, title, day, time, clip(b.venue, 80)]);
        }
        sendJson(res, 201, { ok: true });
        return true;
      }
    }
    if ((m = pathname.match(/^\/api\/schedule\/(\d+)$/)) && method === 'DELETE') {
      const student = await studentOnly(req, res); if (!student) return true;
      await dbWrite('DELETE FROM dbo.StudentSchedule WHERE Id = ? AND StudentId = ?', [Number(m[1]), student.Id]);
      sendJson(res, 200, { deleted: true });
      return true;
    }

    // ---------- notes and handouts ----------
    if (pathname === '/api/materials' && method === 'GET') {
      const student = await studentOnly(req, res); if (!student) return true;
      const rows = await dbRows(
        "SELECT Id, Subject, Title, Description, FileName, MimeType, SizeBytes, CreatedAt, (UploaderId = ?) AS mine, Status FROM dbo.Materials WHERE Status = 'approved' OR UploaderId = ? ORDER BY Id DESC LIMIT 200",
        [student.Id, student.Id]
      );
      sendJson(res, 200, rows.map(r => ({ id: r.id, subject: r.subject, title: r.title, desc: r.description || '', name: r.filename, type: r.mimetype, size: r.sizebytes, created: r.createdat, mine: !!r.mine, status: r.status })));
      return true;
    }
    if (pathname === '/api/materials' && method === 'POST') {
      const student = await requireStudent(req);
      const admin = student ? null : await getPortalUser(req);
      if (!student && !(admin && admin.role === 'admin')) { sendJson(res, 401, { error: 'Please log in again.' }); return true; }
      const type = clip(req.headers['content-type'], 100).split(';')[0];
      const dec = h => { try { return decodeURIComponent(String(req.headers[h] || '')); } catch { return ''; } };
      const title = clip(dec('x-title'), 160), subject = clip(dec('x-subject'), 120), desc = clip(dec('x-desc'), 400);
      const fileName = clip(dec('x-filename'), 200).replace(/[\r\n"\\/]/g, '_') || 'file';
      if (!FILE_TYPES[type]) { sendJson(res, 400, { error: 'Upload a PDF, Word, PowerPoint, image or text file.' }); return true; }
      if (!title || !subject) { sendJson(res, 400, { error: 'Add a title and the course name.' }); return true; }
      if (student && rateLimited(`mat:${student.Id}`, 5, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You uploaded several files today. Try again tomorrow.' }); return true; }
      let data;
      try { data = await readRaw(req, MAX_FILE); } catch (error) {
        sendJson(res, error.tooLarge ? 413 : 400, { error: error.message });
        return true;
      }
      if (!data.length) { sendJson(res, 400, { error: 'The file is empty.' }); return true; }
      await dbWrite('INSERT dbo.Materials (Subject, Title, Description, FileName, MimeType, SizeBytes, Data, Status, UploaderId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [subject, title, desc, fileName, type, data.length, data, admin ? 'approved' : 'pending', student ? student.Id : null]);
      sendJson(res, 201, { ok: true, message: admin ? 'Added.' : 'Thanks. It will show after the admin checks it.' });
      return true;
    }
    if ((m = pathname.match(/^\/api\/materials\/(\d+)\/file$/)) && method === 'GET') {
      const student = await studentOnly(req, res); if (!student) return true;
      const rows = await dbRows("SELECT FileName, MimeType, Data FROM dbo.Materials WHERE Id = ? AND (Status = 'approved' OR UploaderId = ?)", [Number(m[1]), student.Id]);
      if (!rows.length) { sendJson(res, 404, { error: 'File not found.' }); return true; }
      const r = rows[0];
      res.writeHead(200, {
        'Content-Type': r.mimetype, 'Content-Length': r.data.length, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${r.filename.replace(/[^\x20-\x7E]/g, '_')}"`
      });
      res.end(r.data);
      return true;
    }

    // ---------- hostel and market ----------
    if (pathname === '/api/listings' && method === 'GET') {
      const student = await studentOnly(req, res); if (!student) return true;
      const rows = await dbRows(
        "SELECT l.Id, l.Kind, l.Title, l.Details, l.Price, l.Status, l.CreatedAt, (l.StudentId = ?) AS mine, u.FullName, u.Phone FROM dbo.Listings l JOIN dbo.StudentProfiles u ON u.Id = l.StudentId "
        + "WHERE l.UniversityId = ? AND (l.Status = 'approved' OR l.StudentId = ?) ORDER BY l.Id DESC LIMIT 100",
        [student.Id, student.UniversityId, student.Id]
      );
      sendJson(res, 200, rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, details: r.details || '', price: r.price || '', status: r.status, created: r.createdat, mine: !!r.mine, by: String(r.fullname).split(' ')[0], phone: r.status === 'approved' ? (r.phone || '') : '' })));
      return true;
    }
    if (pathname === '/api/listings' && method === 'POST') {
      const student = await studentOnly(req, res); if (!student) return true;
      const b = await parseBody(req);
      const kind = LISTING_KINDS.includes(b.kind) ? b.kind : '';
      const title = clip(b.title, 160);
      if (!kind || title.length < 4) { sendJson(res, 400, { error: 'Choose a type and write a clear title.' }); return true; }
      if (rateLimited(`lst:${student.Id}`, 6, 24 * 3600 * 1000)) { sendJson(res, 429, { error: 'You posted several today. Try again tomorrow.' }); return true; }
      await dbWrite('INSERT dbo.Listings (StudentId, UniversityId, Kind, Title, Details, Price) VALUES (?, ?, ?, ?, ?, ?)', [student.Id, student.UniversityId, kind, title, clip(b.details, 800), clip(b.price, 40)]);
      sendJson(res, 201, { ok: true, message: 'Posted. It shows to students of your school after the admin checks it.' });
      return true;
    }
    if ((m = pathname.match(/^\/api\/listings\/(\d+)$/)) && method === 'DELETE') {
      const student = await studentOnly(req, res); if (!student) return true;
      await dbWrite('DELETE FROM dbo.Listings WHERE Id = ? AND StudentId = ?', [Number(m[1]), student.Id]);
      sendJson(res, 200, { deleted: true });
      return true;
    }

    // ---------- scam alerts ----------
    if (pathname === '/api/scam-alerts' && method === 'GET') {
      const rows = await dbRows('SELECT Id, Title, Details, CreatedAt FROM dbo.ScamAlerts ORDER BY Id DESC LIMIT 50');
      sendJson(res, 200, rows.map(r => ({ id: r.id, title: r.title, details: r.details || '', created: r.createdat })));
      return true;
    }

    // ---------- admin ----------
    if (pathname === '/api/admin/campus' && method === 'GET') {
      if (!await adminOnly(req, res)) return true;
      const opps = await dbRows(`SELECT ${OPP_COLS} FROM dbo.Opportunities ORDER BY CASE Status WHEN 'pending' THEN 0 ELSE 1 END, Id DESC LIMIT 100`);
      const mats = await dbRows("SELECT m.Id, m.Subject, m.Title, m.FileName, m.SizeBytes, m.Status, u.FullName FROM dbo.Materials m LEFT JOIN dbo.StudentProfiles u ON u.Id = m.UploaderId ORDER BY CASE m.Status WHEN 'pending' THEN 0 ELSE 1 END, m.Id DESC LIMIT 100");
      const lsts = await dbRows("SELECT l.Id, l.Kind, l.Title, l.Details, l.Price, l.Status, u.FullName, v.Name AS University FROM dbo.Listings l JOIN dbo.StudentProfiles u ON u.Id = l.StudentId JOIN dbo.Universities v ON v.Id = l.UniversityId ORDER BY CASE l.Status WHEN 'pending' THEN 0 ELSE 1 END, l.Id DESC LIMIT 100");
      const steps = await dbRows('SELECT c.Id, c.Title, v.Name AS University FROM dbo.ChecklistItems c LEFT JOIN dbo.Universities v ON v.Id = c.UniversityId ORDER BY c.Pos, c.Id');
      const scams = await dbRows('SELECT Id, Title, Details FROM dbo.ScamAlerts ORDER BY Id DESC LIMIT 50');
      sendJson(res, 200, {
        opportunities: opps.map(oppRow),
        materials: mats.map(r => ({ id: r.id, subject: r.subject, title: r.title, name: r.filename, size: r.sizebytes, status: r.status, by: r.fullname || 'Admin' })),
        listings: lsts.map(r => ({ id: r.id, kind: r.kind, title: r.title, details: r.details || '', price: r.price || '', status: r.status, by: r.fullname, school: r.university })),
        steps: steps.map(r => ({ id: r.id, title: r.title, school: r.university || 'All schools' })),
        scams: scams.map(r => ({ id: r.id, title: r.title, details: r.details || '' }))
      });
      return true;
    }
    if (pathname === '/api/admin/opportunities' && method === 'POST') {
      if (!await adminOnly(req, res)) return true;
      const b = await parseBody(req);
      const kind = OPP_KINDS.includes(b.kind) ? b.kind : '';
      const title = clip(b.title, 200);
      if (!kind || !title) { sendJson(res, 400, { error: 'Choose a type and a title.' }); return true; }
      await dbWrite('INSERT dbo.Opportunities (Kind, Title, Org, Location, Deadline, Link, Details, Status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [kind, title, clip(b.org, 160), clip(b.location, 120), isDate(b.deadline) ? b.deadline : null, safeLink(b.link), clip(b.details, 1500), 'approved']);
      sendJson(res, 201, { ok: true });
      return true;
    }
    if (pathname === '/api/admin/checklist' && method === 'POST') {
      if (!await adminOnly(req, res)) return true;
      const b = await parseBody(req);
      const title = clip(b.title, 200);
      if (!title) { sendJson(res, 400, { error: 'Type the step first.' }); return true; }
      let universityId = null;
      const school = clip(b.school, 250);
      if (school) {
        const f = await dbRows('SELECT Id FROM dbo.Universities WHERE lower(Name) = lower(?) LIMIT 1', [school]);
        if (!f.length) { sendJson(res, 400, { error: 'That university was not found. Pick it from the list or leave it empty.' }); return true; }
        universityId = f[0].id;
      }
      await dbWrite('INSERT dbo.ChecklistItems (UniversityId, Title, Details, Pos) VALUES (?, ?, ?, ?)', [universityId, title, clip(b.details, 600), universityId ? 50 : 100]);
      sendJson(res, 201, { ok: true });
      return true;
    }
    if (pathname === '/api/admin/scam-alerts' && method === 'POST') {
      if (!await adminOnly(req, res)) return true;
      const b = await parseBody(req);
      const title = clip(b.title, 160);
      if (!title) { sendJson(res, 400, { error: 'Type the alert title.' }); return true; }
      await dbWrite('INSERT dbo.ScamAlerts (Title, Details) VALUES (?, ?)', [title, clip(b.details, 1000)]);
      sendJson(res, 201, { ok: true });
      return true;
    }
    if ((m = pathname.match(/^\/api\/admin\/(opportunities|materials|listings|checklist|scam-alerts)\/(\d+)(?:\/(approve))?$/))) {
      if (!await adminOnly(req, res)) return true;
      const table = { opportunities: 'Opportunities', materials: 'Materials', listings: 'Listings', checklist: 'ChecklistItems', 'scam-alerts': 'ScamAlerts' }[m[1]];
      const id = Number(m[2]);
      if (m[3] === 'approve' && method === 'POST') {
        if (!['Opportunities', 'Materials', 'Listings'].includes(table)) { sendJson(res, 400, { error: 'invalid_action' }); return true; }
        await dbWrite(`UPDATE dbo.${table} SET Status = 'approved' WHERE Id = ?`, [id]);
        sendJson(res, 200, { status: 'approved' });
        return true;
      }
      if (method === 'DELETE' && !m[3]) {
        await dbWrite(`DELETE FROM dbo.${table} WHERE Id = ?`, [id]);
        sendJson(res, 200, { deleted: true });
        return true;
      }
    }
    return false;
  }

  return { handle };
};
