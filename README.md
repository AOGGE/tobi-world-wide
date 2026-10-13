# Tobi World Wide — repaired deployment bundle

## What was repaired
- Server now binds to `0.0.0.0`, as required by most hosting platforms.
- Added authenticated `/api/tutor` endpoint for the AI study tutor.
- Added authenticated `/api/outline/generate` endpoint for AI-generated study outlines.
- AI errors return actionable messages and appropriate HTTP statuses.
- Added `.env.example` and a valid `package.json` for deployment.

## Deploy
1. Upload these files to your Node.js hosting service.
2. Set the environment variables from `.env.example` in the host dashboard. Do not commit a real `.env` or API keys.
3. Configure the SQL Server database and apply the project's database schema (the original upload does not include `schema.sql`).
4. Run `npm install`, then `npm start`.
5. Test `https://YOUR-DOMAIN/api/health`. It should return `ok: true` and a connected database.
6. Sign up a student account on the live domain, then sign in and test the tutor.

## Important
This bundle cannot be made live or signed into without the actual website URL, hosting access, SQL Server credentials/schema, and a valid Anthropic API key. No secrets or production account details were included in the uploaded files. AI outline generation is explicitly a draft and should be checked against official course materials.
