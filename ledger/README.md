# Ledger — school timetable server (secure edition)

One small Node.js server holds **all** school data in a single SQLite file, so every teacher, school computer and phone sees the same information. Nothing sensitive lives in the browser.

## What changed

| Problem | Fix |
|---|---|
| `admin/admin123` and `reception/reception123` in the source | **No built-in accounts at all.** On first start the server prints a one-time *setup code* in its log; whoever has it creates the first administrator in the browser. Teacher/receptionist logins get a random one-time password that must be changed at first sign-in. Passwords are stored only as salted **scrypt** hashes. Common/guessable passwords (e.g. `admin123`, or anything containing the person's name) are refused. |
| Data in `localStorage` | Data lives on the **server** (SQLite). Browsers keep nothing (the app even deletes the old `ledger_state` copy, which contained plain-text passwords). Changes by other people appear within ~15 s; two admins editing at once are detected instead of overwriting each other. |
| Location | The phone supplies a position, but the **server** decides (distance + accuracy checks), using the server clock and school time zone. Works only on HTTPS. Teachers see a plain-language explanation *before* the browser prompt. Only distance/accuracy are stored — never coordinates. |

Also added: HttpOnly/Secure/SameSite cookies, CSRF tokens, login throttling + lockout, role-based data (teachers don't receive other teachers' phone numbers or leave reasons; the front desk sees times only), a security log, automatic deletion of old records, 30-minute idle sign-out, security headers (CSP, HSTS, Permissions-Policy), self-hosted fonts and libraries (no third-party requests), and a manual-attendance fallback for phones that can't give a location.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000 (localhost counts as a secure context, so location works)
```
Copy the **Setup code** printed in the terminal, open the site, create the administrator.

## Deploy (HTTPS is required for location)

Any host that gives you HTTPS + a **persistent disk** works (Render, Railway, Fly.io, a VPS with Caddy/nginx, …).

1. Run `npm ci --omit=dev && npm start` (or build the included `Dockerfile`).
2. Mount a persistent volume and set `DATA_DIR` to it (Docker image uses `/data`). **Back up that folder** (it contains `ledger.db`); a nightly copy is enough.
3. Put it behind HTTPS. The app redirects plain HTTP to HTTPS and sends HSTS when `NODE_ENV=production` (set by `npm start`). Behind one proxy, keep `TRUST_PROXY=1` (default in production); the proxy must send `X-Forwarded-Proto`.
4. Read the setup code from the host's log, open `https://your-site`, create the admin.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `DATA_DIR` | `./data` | where `ledger.db` lives |
| `SCHOOL_TZ` | `Asia/Kolkata` | school time zone (dates/times for attendance) |
| `SETUP_CODE` | random | choose your own first-run code |
| `ATTENDANCE_RETENTION_DAYS` | 730 | attendance older than this is deleted |
| `AUDIT_RETENTION_DAYS` | 180 | security-log retention |
| `SESSION_IDLE_HOURS` / `SESSION_MAX_DAYS` | 12 / 7 | server-side session limits |
| `TRUST_PROXY` | 1 in production | number of proxies in front |
| `TLS_KEY` / `TLS_CERT` | – | serve HTTPS directly (no proxy) |

Lost the only admin password? `npm run reset-password -- <username>` on the server prints a new temporary one.

## Moving from the old single-file version
Open the new site in the **same browser** the old one was used in, sign in as admin. A banner offers **Import to the server** (timetable, staff, classes, attendance). Logins are *not* copied; new one-time passwords are generated and shown once (copy/CSV).

## Setting up location (do this once, on the real site)
1. Admin → *Attendance* → stand in the middle of campus, outdoors → **Use my current location** → Save.
2. Radius: campus size + ~50 m (150 m default). Under ~50 m will reject people who are really there.
3. Have 2–3 teachers on **their own phones** (Android + iPhone) press **Test my location** from the gate, a classroom and the far corner. It reports HTTPS, permission, accuracy, distance and whether check-in would pass, and saves nothing. Adjust radius / “reject GPS worse than” if needed.

## Honest limits
- Browser GPS can be faked by determined people (mock-location apps). This stops accidental/casual off-site check-ins, not deliberate fraud. For stronger proof add a gate QR code or supervisor confirmation.
- Five wrong passwords lock an account for 15 minutes (so someone could annoy a teacher by trying); an admin reset clears it.
- Single server + SQLite suits one school comfortably; it is not built for several server instances.
- Timetable text (names, subjects) is entered by trusted admins; teachers' free text (leave reason) is sanitised.

## Tests
`npm test` runs 61 API security/permission checks. `test/e2e.py`, `test/e2e2.py` (Python + Playwright) drive a real browser, incl. emulated GPS over HTTPS.
