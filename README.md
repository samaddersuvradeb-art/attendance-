# Team Suvradeb — Leave & Attendance Tracker

A single-page attendance, leave, roster, org-chart, and performance-reconciliation
tracker, packaged as a production-ready Netlify site.

## Architecture

- **Frontend** — `index.html`. Same UI, layout, and features as the original
  file, unchanged. It no longer talks to the browser's local/session storage
  or a hardcoded password; instead it calls two serverless functions.
- **`netlify/functions/store.js`** — a small key/value API backed by
  [Netlify Blobs](https://docs.netlify.com/blobs/overview/), Netlify's
  built-in persistent storage. This replaces `localStorage` with real,
  shared, server-side storage that survives redeploys and is visible to
  everyone using the site (exactly like the original shared in-browser
  tracker, but durable and centralized instead of per-browser).
- **`netlify/functions/admin.js`** — verifies the admin password against the
  `ADMIN_PASSWORD` environment variable **on the server only**, and on
  success issues a signed, `httpOnly`, `Secure`, `SameSite=Strict` session
  cookie. The password is never sent to, stored in, or checkable from the
  browser's JavaScript. Sensitive writes (roster upload/clear, reconciliation
  report upload, editing/deleting leave or attendance history) are re-checked
  against that session cookie inside `store.js`, so the protection can't be
  bypassed by calling the API directly.

No other backend, database, or account is required — Netlify Blobs and
Netlify Functions are provisioned automatically when you deploy.

## What's preserved from the original file

Every feature works exactly as before:

- Daily attendance marking (Present / Absent / Roster Off / Weekend /
  1st Half Leave / Late Join / On Leave), with the 8:30 AM Dhaka-time
  business-day rollover.
- Attendance history, with admin-gated edit/delete per record.
- Leave record tracking with screenshots, admin-gated edit/delete.
- Roster upload/clear from an Excel/CSV grid (admin-gated).
- Reconciliation report upload (XLSX/CSV) per period, feeding the
  Daily/Weekly/Monthly performance tables (admin-gated).
- Organization chart, themes (light/dark/warm), and all existing
  calculations (points, IR/Reco/FR, gaps, averages).
- XLSX/CSV import via `xlsx.full.min.js` (unchanged, loaded from cdnjs).

## Deploying

1. Push this project to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub**, and
   pick the repo. Netlify will read `netlify.toml` automatically — no build
   command changes are needed.
3. Under **Site settings → Environment variables**, add exactly one variable:

   | Key             | Value                        |
   |-----------------|-------------------------------|
   | `ADMIN_PASSWORD`| the password admins should use |

4. Click **Deploy site**. That's it — Netlify Blobs and Netlify Functions
   are provisioned automatically; there's nothing else to configure.

## Local development

```bash
npm install
netlify dev
```

`netlify dev` runs the static site and both functions together. Set
`ADMIN_PASSWORD` in a local `.env` file (not committed) before running it:

```
ADMIN_PASSWORD=choose-a-local-password
```

## Notes on security

- The admin password lives only in the `ADMIN_PASSWORD` environment
  variable. It is never embedded in `index.html`, never returned by any
  function response, and never logged.
- Session cookies are signed with HMAC-SHA256 (keyed by `ADMIN_PASSWORD`),
  `httpOnly` (unreadable by page JavaScript), `SameSite=Strict`, and expire
  automatically after 12 hours.
- Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy) are set for every response in
  `netlify.toml`.
- The Content-Security-Policy allows `https://cdnjs.cloudflare.com` (for the
  XLSX parsing library) and Google Fonts, and permits inline `<script>`/
  `<style>` since the app is a single self-contained HTML file with no build
  step. If you later split the inline script into an external file, you can
  tighten the CSP by removing `'unsafe-inline'` from `script-src`.
