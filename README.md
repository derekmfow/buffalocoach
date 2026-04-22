# The Buffalo Method — Coaching Dashboard

Web app for managing 1:1 coaching clients: meal photo review, weekly check-ins, workout programs, meal suggestions.

- **Single Express server** — `server.js`
- **SQLite database** — one file on a persistent disk
- **React frontend** — single HTML file served as a static asset (no build step)
- **Two front-door paths:** `/` for the coach dashboard, `/client` for client login
- **Automated onboarding:** welcome email with login URL + PIN sent when a client is created (via Resend)
- **Public inquiry capture:** `/api/inquiries` receives leads from the HAM app CTA; coach works them in the LEADS tab

---

## Project structure

```
.
├── server.js           Express app — all API endpoints, auth, photo uploads
├── db.js               SQLite schema + first-run seeding of exercise library
├── email.js            Shared Resend wrapper (welcome emails + backup attachments)
├── backup.js           Nightly DB + photo backups, emailed via Resend
├── package.json
├── public/
│   └── index.html      React app (all-in-one, no build step)
├── .gitignore
└── README.md           this file
```

Runtime-created (not in Git):
```
data/                   local dev only; Render uses /data instead
├── app.db              SQLite database
├── uploads/            meal photos, organized by client/date
└── sessions/           session cookie storage
```

---

## First-time deploy on Render

These steps assume you already have a Render account (you mentioned HAM is already there).

### 1. Push this code to GitHub

```bash
cd /path/to/this/folder
git init
git add .
git commit -m "Initial coaching dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USER/buffalo-coach.git
git push -u origin main
```

### 2. Create the Render service

1. In Render dashboard: **New → Web Service**.
2. Connect your GitHub repo.
3. Fill in:
   - **Name:** `buffalo-coach` (or whatever you like — becomes part of the default URL)
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** Starter is fine (~$7/mo). Free tier will sleep after inactivity which is bad UX for clients.
4. Click **Create Web Service** but *don't* worry about the first deploy failing — we still need to add a disk and env vars.

### 3. Add a persistent disk

1. In the new service, go to **Disks → Add Disk**.
2. Fill in:
   - **Name:** `data`
   - **Mount path:** `/data`
   - **Size:** `10 GB` (plenty of headroom for photos; ~$1/mo)
3. Click **Save**. The service will restart automatically.

### 4. Set environment variables

Go to **Environment → Environment Variables** on the service. Add the required ones; the optional ones unlock email delivery and nightly backups.

**Required — won't boot without these:**

| Key              | Value                                                                                       |
|------------------|---------------------------------------------------------------------------------------------|
| `SESSION_SECRET` | A long random string. Generate with `openssl rand -hex 32` locally and paste the result. |
| `ADMIN_PIN`      | Your 4–8 digit coach login PIN. Pick something you'll remember but nobody else will guess. |
| `DB_PATH`        | `/data/app.db`                                                                              |
| `UPLOAD_ROOT`    | `/data/uploads`                                                                             |
| `SESSIONS_PATH`  | `/data/sessions`                                                                            |
| `NODE_ENV`       | `production`                                                                                |

**Optional — needed for automated welcome emails when you create a client:**

| Key              | Value                                                                                       |
|------------------|---------------------------------------------------------------------------------------------|
| `RESEND_API_KEY` | Your Resend API key (free tier = 3,000 emails/mo). Get one at resend.com. |
| `FROM_EMAIL`     | Sender address, e.g. `Derek <derek@thebuffalomethod.com>`. The domain must be verified in Resend. |
| `APP_URL`        | Base URL of this app (e.g. `https://buffalocoach.onrender.com` or your custom domain). Used to build the login link in the welcome email. Defaults to the Render URL if unset. |

**Optional — enables nightly DB + photo backups emailed to you:**

| Key                  | Value                                                                                       |
|----------------------|---------------------------------------------------------------------------------------------|
| `BACKUP_EMAIL`       | Where backups get sent (your personal email).                                               |
| `BACKUP_FROM_EMAIL`  | Sender address for backup emails. Can be the same as `FROM_EMAIL`. If `FROM_EMAIL` is unset, this value doubles as the welcome-email sender. |

Save. Render will redeploy automatically.

**Behavior without the optional vars:**
- No `RESEND_API_KEY` / no sender address → welcome emails silently skip; the Add Client modal surfaces an "email didn't send" warning so you know to fall back to manual PIN delivery.
- No `BACKUP_*` vars → nightly backup scheduler doesn't start (logged at boot).

### 5. Verify it's working

- Open the service's default Render URL (something like `https://buffalo-coach.onrender.com`)
- You should see the **COACH DASHBOARD** login screen
- Enter your `ADMIN_PIN` → should log you in and show an empty client list
- The exercise library, workout templates, and programs should all be pre-seeded

Done. You're live.

---

## Local development

```bash
# Install dependencies (requires Node 20+)
npm install

# Create a local .env file
cat > .env << EOF
SESSION_SECRET=local_dev_secret_not_for_production
ADMIN_PIN=0000
NODE_ENV=development
EOF

# Run
npm start
```

Open http://localhost:3000, log in with PIN `0000`.

Local data lives in `./data/` (ignored by Git). Delete that folder to start fresh.

---

## Adding your first client

1. Log in as coach.
2. Click **Add Client** (or convert a Lead — same flow).
3. Fill in name, email, start date, and a 4-digit PIN.
4. Submit. Two things happen:
   - Client record is created.
   - A welcome email goes out to them with the login URL (`/client`), their email, and their PIN.
5. If the email fails (misconfigured Resend, bad sender domain, etc.), you'll get a dialog telling you why — fall back to texting the PIN manually.

### Resetting a client's PIN (or resending a lost welcome email)

Open the client's detail page. In the header next to their start date, click **RESEND LOGIN**. This:
- Generates a brand-new 4-digit PIN (invalidating the old one).
- Emails a fresh welcome message to the client with the new PIN.
- Shows you the new PIN inline so you can text it as a fallback if the email didn't deliver.

No SQL or shell access required. The endpoint is `POST /api/clients/:id/resend-welcome`.

---

## What's next (Phase 3)

Phase 2 ships: client login at `/client`, automated welcome email, and a minimal post-login landing that shows program week, start date, status, and goals.

**Still to build (Phase 3):**
- Client meal photo upload — camera/gallery picker, up to 5 photos/day, optional note. API already live (`POST /api/meal-logs`).
- Client weekly check-in form — weight, steps, energy, hunger, wins, struggles. API live (`POST /api/checkins`).
- Client question posting — async capture, resolves on the coach side. API live (`POST /api/questions`).
- Client personal timeline — their own 6-week journey grouped by week.

These are all pure frontend additions — extend the `ClientApp` component in `public/index.html`.

---

## API reference (quick)

All JSON unless noted. Cookie-based session auth — client sends credentials with every request (browser handles this automatically with `credentials: 'same-origin'`).

### Auth
- `POST /api/coach-login`    `{ pin }` → `{ ok, role }`
- `POST /api/client-login`   `{ email, pin }` → `{ ok, role, client }`
- `POST /api/logout`
- `GET  /api/me` → `{ role, client? }`

### Clients (coach only)
- `GET    /api/clients`
- `POST   /api/clients`     `{ name, email, pin, start_date, goals? }` → `{ client, email_sent, email_error }`
- `PATCH  /api/clients/:id` (any subset of fields)
- `DELETE /api/clients/:id` (cascades logs, checkins, notes, questions, photos)
- `POST   /api/clients/:id/resend-welcome` → `{ ok, new_pin, email_sent, email_error }` — regenerates PIN, emails new welcome

### Inquiries & leads
- `POST   /api/inquiries`  *(public, CORS-open, rate-limited 5/hour/IP, honeypot-protected)* — `{ name, email, phone?, message?, website?/* honeypot */, source? }` → `{ ok }`
- `GET    /api/leads` — coach only
- `PATCH  /api/leads/:id`  `{ status?, coach_notes?, converted_to_client_id? }` — coach only
- `DELETE /api/leads/:id` — coach only

### Meal logs (coach or self-client)
- `GET  /api/meal-logs?client_id=…`
- `POST /api/meal-logs` — **multipart/form-data**: `client_id`, `log_date`, `note`, `photos[]` (up to 5, 15MB each)
- `DELETE /api/meal-logs/:id` (coach only)
- `GET  /uploads/:clientId/:logDate/:filename` — authenticated photo serving

### Check-ins (coach or self-client)
- `GET  /api/checkins?client_id=…`
- `POST /api/checkins` — upserts on (client_id, week_number)

### Coach notes (coach only)
- `GET /POST /PATCH /DELETE` `/api/notes`

### Client questions
- `GET  /api/questions` — client sees own, coach sees all
- `POST /api/questions`  `{ client_id, message }` (coach can specify client_id, client uses own)
- `PATCH /api/questions/:id` `{ is_resolved }` (coach only)

### Exercises / Templates / Programs (read: any auth; write: coach only)
- `GET /POST /PATCH /DELETE` for each

### Meal suggestions
- `GET  /api/meal-suggestions?client_id=…`
- `POST /api/meal-suggestions`  `{ meal_log_id, meals, message }` (coach only; upserts on meal_log_id)
- `DELETE /api/meal-suggestions/:id` (coach only)

---

## Backups

**Important:** Render's persistent disks are NOT automatically backed up. You should manually back up `/data/app.db` periodically.

Easiest approach: add a cron job that copies the file to an S3 bucket or downloads it via Render's shell. For v1, a weekly manual download is fine — the DB is small and client data is small.

Future improvement: scheduled `sqlite3 .backup` script that pushes to S3 or Dropbox.

---

## Custom domain

When you're ready to use `coach.thebuffalomethod.com` instead of the Render default:

1. In Render: **Settings → Custom Domains → Add Custom Domain**.
2. Add a CNAME record at your DNS provider: `coach` → `your-service.onrender.com`.
3. Wait for SSL to provision (~5 minutes).

Done. The cookie-based session will continue to work on the new domain without changes.
