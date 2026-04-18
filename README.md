# The Buffalo Method — Coaching Dashboard

Web app for managing 1:1 coaching clients: meal photo review, weekly check-ins, workout programs, meal suggestions.

- **Single Express server** — `server.js`
- **SQLite database** — one file on a persistent disk
- **React frontend** — single HTML file served as a static asset (no build step)
- **Coach-only authentication** for Phase 1; client auth wired in but UI comes in Phase 2

---

## Project structure

```
.
├── server.js           Express app — all API endpoints, auth, photo uploads
├── db.js               SQLite schema + first-run seeding of exercise library
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

Go to **Environment → Environment Variables** on the service. Add these three:

| Key              | Value                                                                                       |
|------------------|---------------------------------------------------------------------------------------------|
| `SESSION_SECRET` | A long random string. Generate one with `openssl rand -hex 32` locally and paste the result. |
| `ADMIN_PIN`      | Your 4–8 digit coach login PIN. Pick something you'll remember but nobody else will guess. |
| `DB_PATH`        | `/data/app.db`                                                                              |
| `UPLOAD_ROOT`    | `/data/uploads`                                                                             |
| `SESSIONS_PATH`  | `/data/sessions`                                                                            |
| `NODE_ENV`       | `production`                                                                                |

Save. Render will redeploy automatically.

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
2. Click **Add Client**.
3. Fill in name, email, start date, and a 4-digit PIN. Write the PIN down somewhere safe — after you create the client, you won't see it again (PINs are bcrypt-hashed in the database).
4. Send the client their email + PIN manually (text, DM, whatever). The client login flow is wired on the backend but the client-side UI comes in Phase 2.

### Resetting a client's PIN

If a client forgets their PIN, there's no built-in UI for this yet. Two options:

**Option 1 — SQL directly** (for now, via Render shell):
```bash
# In a Render shell for the service:
node -e "
const bcrypt = require('bcryptjs');
const db = require('./db');
const newPin = '1234';  // whatever you want
const hash = bcrypt.hashSync(newPin, 10);
db.prepare('UPDATE clients SET pin_hash = ? WHERE email = ?').run(hash, 'client@example.com');
console.log('PIN reset to', newPin);
"
```

**Option 2 — add to the UI later** (recommended for v1.1): a "Reset PIN" button in the client list that generates and shows a new PIN once.

---

## What's next (Phase 2 + 3)

The server already supports these — only the frontend UI is missing:

- **Client login screen** — `/client` route with email + PIN form
- **Client home** — shows their current week + upload button + recent logs
- **Client upload screen** — camera/gallery picker, multi-photo upload
- **Client weekly check-in form** — weight, steps, energy, hunger, wins, struggles
- **Client history view** — their own timeline, grouped by week

The backend handles all of this already (see `/api/meal-logs`, `/api/checkins`, `/api/questions`). A Phase 2 build would add a separate React component tree for `authState.role === 'client'` that renders the client-facing UI.

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
- `POST   /api/clients`     `{ name, email, pin, start_date, goals? }`
- `PATCH  /api/clients/:id` (any subset of fields)
- `DELETE /api/clients/:id` (cascades logs, checkins, notes, questions, photos)

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
