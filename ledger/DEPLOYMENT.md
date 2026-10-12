# Ledger deployment

This project is a Node.js/Express + SQLite application. It already includes a production Dockerfile,
HTTPS/proxy handling, `/healthz`, secure sessions, and persistent SQLite storage.

## Recommended deployment

Use a host that supports:
- Docker
- HTTPS
- a persistent disk/volume mounted at `/data`

The included `render.yaml` is a starting Blueprint configuration for Render.

### Render

1. Put the `ledger` folder into a GitHub repository.
2. In Render, create a Blueprint from that repository.
3. Set `SETUP_CODE` to a private first-run code.
4. Deploy.
5. Open the generated HTTPS URL.
6. The first screen will ask for the administrator account.
7. Copy the setup code from the server logs if you did not set one explicitly.
8. After login, configure the school campus location from the Attendance tab.

Important: keep the persistent disk mounted at `/data`. The SQLite database is stored there.
Do not deploy this app on a host where the filesystem is erased on every restart.

## Environment

NODE_ENV=production
DATA_DIR=/data
SCHOOL_TZ=Asia/Kolkata
TRUST_PROXY=1
SETUP_CODE=<private first-run code>

Optional:
ATTENDANCE_RETENTION_DAYS=730
AUDIT_RETENTION_DAYS=180
SESSION_IDLE_HOURS=12
SESSION_MAX_DAYS=7

## Local Docker test

Build:

    docker build -t ledger-school-timetable .

Run:

    docker run --rm -p 3000:3000 -v ledger-data:/data \
      -e NODE_ENV=production \
      -e DATA_DIR=/data \
      -e SETUP_CODE=CHANGE-THIS \
      ledger-school-timetable

Then open:

    http://localhost:3000

For real teacher GPS attendance, use the deployed HTTPS URL.

## What was checked

- `server.js`: 771 lines
- `public/app.js`: 2,755 lines
- `public/app.css`: 531 lines
- Frontend + backend are preserved; no code was shortened.
- Node syntax checks pass for `server.js` and `public/app.js`.
