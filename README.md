# Tobi World Wide Educational Consult: site + backend

Files: `server.js`, `index.html`, `package.json`. No `npm install` is needed (Node 18 or newer).

Run on your computer:   `node server.js`   then open http://localhost:3000

## Deploy on Render (steps)
1. Put these files in a GitHub repository (do NOT add any key to the files).
2. Render > New > Web Service > pick the repo. Runtime: Node. Build command: leave empty. Start command: `node server.js`.
3. Add a Disk (paid feature) mounted at `/var/data`. Without a disk, accounts and posts are erased on every restart.
4. Environment variables:

| Name | Value |
|---|---|
| `AI_GATEWAY_API_KEY` | your Vercel AI Gateway key (starts with vck_) |
| `ADMIN_PASSWORD` | a NEW strong owner password (login name is `admin`) |
| `DATA_DIR` | `/var/data` (the disk's mount path) |
| `COOKIE_SECURE` | `1` |

5. Open `https://YOUR-APP.onrender.com/api/health`. You should see `{"ok":true}`.
6. Test: register a student, add a subject, use the tutor and "Generate my course outline".

## Notes
- AI uses Vercel AI Gateway, model `anthropic/claude-sonnet-5.5` (change with `ANTHROPIC_MODEL`).
  A normal Anthropic key also works if you set `ANTHROPIC_API_KEY` instead.
- The "AI news desk" uses Anthropic's web-search tool. It may not work through the gateway; the tutor and outlines do not need it.
- Back up your data: sign in as owner and open `/api/admin/export`. A `db.json.bak` copy is also kept.
- Keep your key only in the host's environment variables. Never put it in index.html or GitHub.
