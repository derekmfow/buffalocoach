/**
 * server.js — The Buffalo Method coaching dashboard.
 *
 * Exposes a REST API for the React frontend in public/index.html.
 * Two kinds of authenticated sessions:
 *   - coach: full read/write access to everything (via admin PIN)
 *   - client: read-only self access + upload own meal logs + submit own check-ins (via email + 4-digit PIN)
 *
 * Data: SQLite at DB_PATH (defaults to ./data/app.db; production uses /data/app.db on Render disk).
 * Photos: saved under UPLOAD_ROOT/{client_id}/{log_date}/{filename}. Served only via authenticated route.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { runBackup, startScheduler } = require('./backup');
const { sendEmail, isEmailConfigured } = require('./email');

// ============================================================
// CONFIG
// ============================================================
const PORT           = process.env.PORT || 3000;
const NODE_ENV       = process.env.NODE_ENV || 'development';
const UPLOAD_ROOT    = process.env.UPLOAD_ROOT || path.join(__dirname, 'data', 'uploads');
const SESSIONS_PATH  = process.env.SESSIONS_PATH || path.join(__dirname, 'data', 'sessions');
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PIN      = process.env.ADMIN_PIN;

// Public base URL — used to build the client login link in welcome emails.
// Defaults to the Render URL, but override via APP_URL env var for custom domains.
const APP_URL        = (process.env.APP_URL || 'https://buffalocoach.onrender.com').replace(/\/$/, '');

if (!SESSION_SECRET) {
  console.error('[fatal] SESSION_SECRET env var not set. Refusing to start.');
  process.exit(1);
}
if (!ADMIN_PIN) {
  console.error('[fatal] ADMIN_PIN env var not set. Refusing to start.');
  process.exit(1);
}
if (!/^\d{4,8}$/.test(ADMIN_PIN)) {
  console.error('[fatal] ADMIN_PIN must be 4-8 digits.');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
fs.mkdirSync(SESSIONS_PATH, { recursive: true });

// Pre-hash the admin PIN once at boot so every login isn't a fresh bcrypt
const ADMIN_PIN_HASH = bcrypt.hashSync(ADMIN_PIN, 10);

// ============================================================
// APP SETUP
// ============================================================
const app = express();

app.set('trust proxy', 1); // Render sits behind a proxy — required for secure cookies
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(session({
  store: new FileStore({ path: SESSIONS_PATH, retries: 1, ttl: 60 * 60 * 24 * 30 }), // 30 days
  name: 'bm.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
}));

// ============================================================
// HELPERS
// ============================================================
const uid   = (prefix) => prefix + '_' + crypto.randomBytes(8).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);

const parseJSONField = (row, ...fields) => {
  if (!row) return row;
  for (const f of fields) {
    if (row[f]) { try { row[f] = JSON.parse(row[f]); } catch { row[f] = []; } }
    else row[f] = [];
  }
  return row;
};
const parseJSONRows = (rows, ...fields) => rows.map(r => parseJSONField(r, ...fields));

const stripPinHash = (row) => {
  if (!row) return row;
  const { pin_hash, ...rest } = row;
  return { ...rest, has_pin: !!pin_hash };
};
const stripPinHashMany = (rows) => rows.map(stripPinHash);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireCoach(req, res, next) {
  if (req.session?.role === 'coach') return next();
  return res.status(401).json({ error: 'coach authentication required' });
}

function requireClientSelf(req, res, next) {
  // Allows coach OR the specific client themselves.
  const paramClientId = req.params.clientId || req.body.client_id;
  if (req.session?.role === 'coach') return next();
  if (req.session?.role === 'client' && req.session.client_id === paramClientId) return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAnyAuth(req, res, next) {
  if (req.session?.role) return next();
  return res.status(401).json({ error: 'authentication required' });
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/coach-login', (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== 'string') return res.status(400).json({ error: 'pin required' });
  if (!bcrypt.compareSync(pin, ADMIN_PIN_HASH)) return res.status(401).json({ error: 'invalid pin' });
  req.session.role = 'coach';
  res.json({ ok: true, role: 'coach' });
});

app.post('/api/client-login', (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin) return res.status(400).json({ error: 'email and pin required' });
  const client = db.prepare('SELECT * FROM clients WHERE email = ? COLLATE NOCASE').get(email);
  if (!client || !bcrypt.compareSync(pin, client.pin_hash)) {
    return res.status(401).json({ error: 'invalid email or pin' });
  }
  req.session.role = 'client';
  req.session.client_id = client.id;
  res.json({ ok: true, role: 'client', client: stripPinHash(client) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session?.role) return res.json({ role: null });
  if (req.session.role === 'coach') return res.json({ role: 'coach' });
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.session.client_id);
  res.json({ role: 'client', client: stripPinHash(client) });
});

// ============================================================
// WELCOME EMAIL HELPER
//
// Built as a helper so POST /api/clients and the "resend welcome"
// endpoint share one source of truth for the email content.
//
// Returns { sent: bool, error: string|null }. Never throws — callers
// should treat email as best-effort: if it fails, the client record
// still exists and the coach can fall back to manual delivery.
// ============================================================
async function sendWelcomeEmail(client, plainPin) {
  if (!isEmailConfigured()) {
    return { sent: false, error: 'email not configured on this server' };
  }

  const loginUrl = `${APP_URL}/client`;
  const firstName = client.name.split(/\s+/)[0] || 'there';

  const text = [
    `Hey ${firstName},`,
    ``,
    `You're set up in the Buffalo Method coaching app. Here's how to log in:`,
    ``,
    `  ${loginUrl}`,
    `  Email: ${client.email}`,
    `  PIN:   ${plainPin}`,
    ``,
    `Your 6-week program starts ${client.start_date}.`,
    ``,
    `Right now the app is set up so you can log in and see your start date and program week. Meal photo uploads and weekly check-ins are rolling out next — I'll let you know the minute they're live. Until then, keep doing what we talked about.`,
    ``,
    `Save that PIN somewhere. If you lose it, text me and I'll reset it.`,
    ``,
    `— Derek`,
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1A1A1A; line-height: 1.6;">
      <div style="border-left: 4px solid #E8611A; padding-left: 16px; margin-bottom: 24px;">
        <div style="font-size: 11px; letter-spacing: 0.25em; font-weight: 700; color: #E8611A; text-transform: uppercase;">The Buffalo Method</div>
        <div style="font-size: 22px; font-weight: 700; margin-top: 4px;">You're in.</div>
      </div>

      <p>Hey ${escapeHtml(firstName)},</p>
      <p>You're set up in the coaching app. Here's how to log in:</p>

      <div style="background: #F5F1EA; border: 1px solid #E5DFD4; border-radius: 6px; padding: 16px; margin: 20px 0;">
        <div style="font-size: 11px; letter-spacing: 0.15em; font-weight: 700; color: #6b6b6b; text-transform: uppercase; margin-bottom: 10px;">Your login</div>
        <div style="margin-bottom: 6px;"><strong>URL:</strong> <a href="${loginUrl}" style="color: #E8611A; text-decoration: none;">${loginUrl}</a></div>
        <div style="margin-bottom: 6px;"><strong>Email:</strong> ${escapeHtml(client.email)}</div>
        <div><strong>PIN:</strong> <span style="font-family: monospace; font-size: 18px; letter-spacing: 4px; font-weight: 700;">${escapeHtml(plainPin)}</span></div>
      </div>

      <p>Your 6-week program starts <strong>${escapeHtml(client.start_date)}</strong>.</p>

      <p>Right now the app is set up so you can log in and see your start date and program week. Meal photo uploads and weekly check-ins are rolling out next — I'll let you know the minute they're live. Until then, keep doing what we talked about.</p>

      <p style="color: #6b6b6b; font-size: 14px;">Save that PIN somewhere. If you lose it, text me and I'll reset it.</p>

      <p style="margin-top: 32px;">— Derek</p>
    </div>
  `;

  try {
    await sendEmail({
      to: client.email,
      subject: `Welcome to coaching — your login details`,
      text,
      html,
    });
    return { sent: true, error: null };
  } catch (e) {
    console.error('[welcome-email] failed for', client.email, ':', e.message);
    return { sent: false, error: e.message };
  }
}

// Minimal HTML-entity escape so user-supplied fields (name, email) can't
// break out into markup in the welcome email body.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// CLIENTS (coach only for list/create; client can read own)
// ============================================================
app.get('/api/clients', requireCoach, (req, res) => {
  const rows = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  res.json(stripPinHashMany(rows));
});

app.post('/api/clients', requireCoach, async (req, res) => {
  const { name, email, pin, start_date, goals } = req.body;
  if (!name || !email || !pin || !start_date) return res.status(400).json({ error: 'name, email, pin, start_date required' });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'pin must be 4 digits' });

  const existing = db.prepare('SELECT id FROM clients WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) return res.status(409).json({ error: 'email already in use' });

  const id = uid('c');
  const pin_hash = bcrypt.hashSync(pin, 10);
  db.prepare(
    'INSERT INTO clients (id, name, email, pin_hash, start_date, status, goals, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name.trim(), email.trim(), pin_hash, start_date, 'active', (goals || '').trim(), today());

  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

  // Best-effort welcome email. Always returns, even on failure.
  const emailResult = await sendWelcomeEmail(row, pin);

  res.json({
    client:      stripPinHash(row),
    email_sent:  emailResult.sent,
    email_error: emailResult.error,
  });
});

// Resend welcome email. Generates a NEW PIN (invalidating the previous one)
// so this also works as "reset PIN" — useful if the first email never arrived
// or the client lost their PIN. Returns the new PIN to the coach so there's
// a fallback if the email fails.
app.post('/api/clients/:id/resend-welcome', requireCoach, async (req, res) => {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const newPin = String(Math.floor(1000 + Math.random() * 9000));
  const newHash = bcrypt.hashSync(newPin, 10);
  db.prepare('UPDATE clients SET pin_hash = ? WHERE id = ?').run(newHash, req.params.id);

  const emailResult = await sendWelcomeEmail(existing, newPin);

  res.json({
    ok:          true,
    new_pin:     newPin,               // surface to coach for manual fallback
    email_sent:  emailResult.sent,
    email_error: emailResult.error,
  });
});

app.patch('/api/clients/:id', requireCoach, (req, res) => {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { name, email, start_date, status, goals, pin } = req.body;
  const fields = [];
  const values = [];
  if (name       !== undefined) { fields.push('name = ?');       values.push(name.trim()); }
  if (email      !== undefined) { fields.push('email = ?');      values.push(email.trim()); }
  if (start_date !== undefined) { fields.push('start_date = ?'); values.push(start_date); }
  if (status     !== undefined) { fields.push('status = ?');     values.push(status); }
  if (goals      !== undefined) { fields.push('goals = ?');      values.push((goals || '').trim()); }
  if (pin        !== undefined) {
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'pin must be 4 digits' });
    fields.push('pin_hash = ?'); values.push(bcrypt.hashSync(pin, 10));
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(stripPinHash(row));
});

app.delete('/api/clients/:id', requireCoach, (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  // Also clean up their photos
  const clientDir = path.join(UPLOAD_ROOT, req.params.id);
  fs.rmSync(clientDir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ============================================================
// MEAL LOGS
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const clientId = req.body.client_id || req.session.client_id;
    const logDate = req.body.log_date || today();
    const dir = path.join(UPLOAD_ROOT, clientId, logDate);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${ts}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // 5 photos, 15MB each
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('only image uploads allowed'));
  },
});

app.get('/api/meal-logs', requireAnyAuth, (req, res) => {
  const { client_id } = req.query;
  if (req.session.role === 'client') {
    const rows = db.prepare('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY log_date DESC').all(req.session.client_id);
    return res.json(parseJSONRows(rows, 'photos'));
  }
  // coach
  if (client_id) {
    const rows = db.prepare('SELECT * FROM meal_logs WHERE client_id = ? ORDER BY log_date DESC').all(client_id);
    return res.json(parseJSONRows(rows, 'photos'));
  }
  const rows = db.prepare('SELECT * FROM meal_logs ORDER BY log_date DESC').all();
  res.json(parseJSONRows(rows, 'photos'));
});

app.post('/api/meal-logs', requireAnyAuth, upload.array('photos', 5), (req, res) => {
  const clientId = req.session.role === 'coach' ? req.body.client_id : req.session.client_id;
  const { log_date, note } = req.body;
  if (!clientId || !log_date) return res.status(400).json({ error: 'client_id and log_date required' });
  if (!req.files?.length) return res.status(400).json({ error: 'at least one photo required' });

  const photos = req.files.map(f => path.basename(f.path));
  const id = uid('m');
  db.prepare(
    'INSERT INTO meal_logs (id, client_id, log_date, photos, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, clientId, log_date, JSON.stringify(photos), (note || '').trim(), today());

  const row = db.prepare('SELECT * FROM meal_logs WHERE id = ?').get(id);
  res.json(parseJSONField(row, 'photos'));
});

app.delete('/api/meal-logs/:id', requireCoach, (req, res) => {
  const row = db.prepare('SELECT * FROM meal_logs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const photos = JSON.parse(row.photos);
  const dir = path.join(UPLOAD_ROOT, row.client_id, row.log_date);
  for (const p of photos) { try { fs.unlinkSync(path.join(dir, p)); } catch {} }
  db.prepare('DELETE FROM meal_logs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Authenticated photo serving
app.get('/uploads/:clientId/:logDate/:filename', requireAnyAuth, (req, res) => {
  const { clientId, logDate, filename } = req.params;
  if (req.session.role === 'client' && req.session.client_id !== clientId) {
    return res.status(403).send('forbidden');
  }
  // Guard against traversal
  if (filename.includes('/') || filename.includes('..') || clientId.includes('..') || logDate.includes('..')) {
    return res.status(400).send('bad path');
  }
  const filepath = path.join(UPLOAD_ROOT, clientId, logDate, filename);
  if (!filepath.startsWith(UPLOAD_ROOT + path.sep)) return res.status(400).send('bad path');
  if (!fs.existsSync(filepath)) return res.status(404).send('not found');
  res.sendFile(filepath);
});

// ============================================================
// WEEKLY CHECK-INS
// ============================================================
app.get('/api/checkins', requireAnyAuth, (req, res) => {
  const { client_id } = req.query;
  if (req.session.role === 'client') {
    const rows = db.prepare('SELECT * FROM weekly_checkins WHERE client_id = ? ORDER BY week_number').all(req.session.client_id);
    return res.json(rows);
  }
  if (client_id) {
    const rows = db.prepare('SELECT * FROM weekly_checkins WHERE client_id = ? ORDER BY week_number').all(client_id);
    return res.json(rows);
  }
  res.json(db.prepare('SELECT * FROM weekly_checkins ORDER BY client_id, week_number').all());
});

app.post('/api/checkins', requireAnyAuth, (req, res) => {
  const clientId = req.session.role === 'coach' ? req.body.client_id : req.session.client_id;
  const { week_number, weight_lbs, steps_avg, energy_1_10, hunger_1_10, wins, struggles } = req.body;
  if (!clientId || week_number === undefined) return res.status(400).json({ error: 'client_id and week_number required' });

  const id = uid('ci');
  db.prepare(
    `INSERT INTO weekly_checkins (id, client_id, week_number, weight_lbs, steps_avg, energy_1_10, hunger_1_10, wins, struggles, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_id, week_number) DO UPDATE SET
       weight_lbs = excluded.weight_lbs,
       steps_avg = excluded.steps_avg,
       energy_1_10 = excluded.energy_1_10,
       hunger_1_10 = excluded.hunger_1_10,
       wins = excluded.wins,
       struggles = excluded.struggles`
  ).run(id, clientId, week_number, weight_lbs || null, steps_avg || null,
        energy_1_10 || null, hunger_1_10 || null, (wins || '').trim(), (struggles || '').trim(), today());

  const row = db.prepare('SELECT * FROM weekly_checkins WHERE client_id = ? AND week_number = ?').get(clientId, week_number);
  res.json(row);
});

// ============================================================
// COACH NOTES (coach-only, private)
// ============================================================
app.get('/api/notes', requireCoach, (req, res) => {
  const { client_id } = req.query;
  if (client_id) return res.json(db.prepare('SELECT * FROM coach_notes WHERE client_id = ? ORDER BY created_at DESC').all(client_id));
  res.json(db.prepare('SELECT * FROM coach_notes ORDER BY created_at DESC').all());
});

app.post('/api/notes', requireCoach, (req, res) => {
  const { client_id, note } = req.body;
  if (!client_id || !note?.trim()) return res.status(400).json({ error: 'client_id and note required' });
  const id = uid('n');
  db.prepare('INSERT INTO coach_notes (id, client_id, note, created_at) VALUES (?, ?, ?, ?)')
    .run(id, client_id, note.trim(), today());
  res.json(db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(id));
});

app.patch('/api/notes/:id', requireCoach, (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'note required' });
  db.prepare('UPDATE coach_notes SET note = ? WHERE id = ?').run(note.trim(), req.params.id);
  res.json(db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(req.params.id));
});

app.delete('/api/notes/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM coach_notes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// CLIENT QUESTIONS
// ============================================================
app.get('/api/questions', requireAnyAuth, (req, res) => {
  const { client_id } = req.query;
  if (req.session.role === 'client') {
    return res.json(db.prepare('SELECT * FROM client_questions WHERE client_id = ? ORDER BY is_resolved, created_at DESC').all(req.session.client_id));
  }
  if (client_id) return res.json(db.prepare('SELECT * FROM client_questions WHERE client_id = ? ORDER BY is_resolved, created_at DESC').all(client_id));
  res.json(db.prepare('SELECT * FROM client_questions ORDER BY is_resolved, created_at DESC').all());
});

app.post('/api/questions', requireAnyAuth, (req, res) => {
  const clientId = req.session.role === 'coach' ? req.body.client_id : req.session.client_id;
  const { message } = req.body;
  if (!clientId || !message?.trim()) return res.status(400).json({ error: 'client_id and message required' });
  const id = uid('q');
  db.prepare('INSERT INTO client_questions (id, client_id, message, is_resolved, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(id, clientId, message.trim(), today());
  res.json(db.prepare('SELECT * FROM client_questions WHERE id = ?').get(id));
});

app.patch('/api/questions/:id', requireCoach, (req, res) => {
  const { is_resolved } = req.body;
  db.prepare('UPDATE client_questions SET is_resolved = ? WHERE id = ?').run(is_resolved ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM client_questions WHERE id = ?').get(req.params.id));
});

// ============================================================
// EXERCISES (coach-only writes, both can read)
// ============================================================
app.get('/api/exercises', requireAnyAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM exercises ORDER BY muscle_group, name').all());
});
app.post('/api/exercises', requireCoach, (req, res) => {
  const { name, muscle_group, category, notes } = req.body;
  if (!name || !muscle_group || !category) return res.status(400).json({ error: 'name, muscle_group, category required' });
  const id = uid('e');
  db.prepare('INSERT INTO exercises (id, name, muscle_group, category, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name.trim(), muscle_group, category, (notes || '').trim(), today());
  res.json(db.prepare('SELECT * FROM exercises WHERE id = ?').get(id));
});
app.patch('/api/exercises/:id', requireCoach, (req, res) => {
  const { name, muscle_group, category, notes } = req.body;
  const fields = [], values = [];
  if (name         !== undefined) { fields.push('name = ?');         values.push(name.trim()); }
  if (muscle_group !== undefined) { fields.push('muscle_group = ?'); values.push(muscle_group); }
  if (category     !== undefined) { fields.push('category = ?');     values.push(category); }
  if (notes        !== undefined) { fields.push('notes = ?');        values.push((notes || '').trim()); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE exercises SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM exercises WHERE id = ?').get(req.params.id));
});
app.delete('/api/exercises/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM exercises WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// TEMPLATES + PROGRAMS (coach-only writes, both can read)
// ============================================================
app.get('/api/templates', requireAnyAuth, (req, res) => {
  res.json(parseJSONRows(db.prepare('SELECT * FROM templates ORDER BY name').all(), 'exercises'));
});
app.post('/api/templates', requireCoach, (req, res) => {
  const { name, description, exercises } = req.body;
  if (!name || !Array.isArray(exercises)) return res.status(400).json({ error: 'name and exercises[] required' });
  const id = uid('t');
  db.prepare('INSERT INTO templates (id, name, description, exercises, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), (description || '').trim(), JSON.stringify(exercises), today());
  res.json(parseJSONField(db.prepare('SELECT * FROM templates WHERE id = ?').get(id), 'exercises'));
});
app.patch('/api/templates/:id', requireCoach, (req, res) => {
  const { name, description, exercises } = req.body;
  const fields = [], values = [];
  if (name        !== undefined) { fields.push('name = ?');        values.push(name.trim()); }
  if (description !== undefined) { fields.push('description = ?'); values.push((description || '').trim()); }
  if (exercises   !== undefined) { fields.push('exercises = ?');   values.push(JSON.stringify(exercises)); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE templates SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json(parseJSONField(db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id), 'exercises'));
});
app.delete('/api/templates/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/programs', requireAnyAuth, (req, res) => {
  res.json(parseJSONRows(db.prepare('SELECT * FROM programs ORDER BY name').all(), 'days'));
});
app.post('/api/programs', requireCoach, (req, res) => {
  const { name, description, notes, days } = req.body;
  if (!name || !Array.isArray(days)) return res.status(400).json({ error: 'name and days[] required' });
  const id = uid('p');
  db.prepare('INSERT INTO programs (id, name, description, notes, days, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name.trim(), (description || '').trim(), (notes || '').trim(), JSON.stringify(days), today());
  res.json(parseJSONField(db.prepare('SELECT * FROM programs WHERE id = ?').get(id), 'days'));
});
app.patch('/api/programs/:id', requireCoach, (req, res) => {
  const { name, description, notes, days } = req.body;
  const fields = [], values = [];
  if (name        !== undefined) { fields.push('name = ?');        values.push(name.trim()); }
  if (description !== undefined) { fields.push('description = ?'); values.push((description || '').trim()); }
  if (notes       !== undefined) { fields.push('notes = ?');       values.push((notes || '').trim()); }
  if (days        !== undefined) { fields.push('days = ?');        values.push(JSON.stringify(days)); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE programs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json(parseJSONField(db.prepare('SELECT * FROM programs WHERE id = ?').get(req.params.id), 'days'));
});
app.delete('/api/programs/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM programs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// MEAL SUGGESTIONS (coach writes; both can read their own scope)
// ============================================================
app.get('/api/meal-suggestions', requireAnyAuth, (req, res) => {
  const { client_id } = req.query;
  if (req.session.role === 'client') {
    // Join to only this client's logs
    const rows = db.prepare(`
      SELECT s.* FROM meal_suggestions s
      JOIN meal_logs l ON l.id = s.meal_log_id
      WHERE l.client_id = ?`).all(req.session.client_id);
    return res.json(parseJSONRows(rows, 'meals'));
  }
  if (client_id) {
    const rows = db.prepare(`
      SELECT s.* FROM meal_suggestions s
      JOIN meal_logs l ON l.id = s.meal_log_id
      WHERE l.client_id = ?`).all(client_id);
    return res.json(parseJSONRows(rows, 'meals'));
  }
  res.json(parseJSONRows(db.prepare('SELECT * FROM meal_suggestions').all(), 'meals'));
});

app.post('/api/meal-suggestions', requireCoach, (req, res) => {
  const { meal_log_id, meals, message } = req.body;
  if (!meal_log_id || !Array.isArray(meals) || !meals.length) {
    return res.status(400).json({ error: 'meal_log_id and meals[] required' });
  }
  const existing = db.prepare('SELECT id FROM meal_suggestions WHERE meal_log_id = ?').get(meal_log_id);
  if (existing) {
    db.prepare('UPDATE meal_suggestions SET meals = ?, message = ? WHERE id = ?')
      .run(JSON.stringify(meals), (message || '').trim(), existing.id);
    return res.json(parseJSONField(db.prepare('SELECT * FROM meal_suggestions WHERE id = ?').get(existing.id), 'meals'));
  }
  const id = uid('s');
  db.prepare('INSERT INTO meal_suggestions (id, meal_log_id, meals, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, meal_log_id, JSON.stringify(meals), (message || '').trim(), today());
  res.json(parseJSONField(db.prepare('SELECT * FROM meal_suggestions WHERE id = ?').get(id), 'meals'));
});

app.delete('/api/meal-suggestions/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM meal_suggestions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// LEADS / INQUIRIES
//
// POST /api/inquiries is the one genuinely public write endpoint in this app.
// It receives submissions from the CoachingCTA component embedded in the free
// HAM app (different origin), so it needs CORS. Everything else stays same-origin.
//
// Three layers of spam defense:
//   1. CORS allowlist below — currently set to "any origin" because the HAM
//      app's domain isn't finalized. Tighten to a specific domain when known.
//   2. Honeypot field "website" — bots fill hidden inputs, humans don't. If
//      present and non-empty, we return success but silently drop the payload.
//   3. In-memory per-IP rate limit: 5 inquiries / hour. Resets on server
//      restart which is fine for Render's infrequent redeploys.
// ============================================================

// Simple in-memory rate limiter. Map<ip, { count, resetAt }>.
const inquiryRateLimit = new Map();
const INQUIRY_LIMIT = 5;
const INQUIRY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
function checkInquiryRateLimit(ip) {
  const now = Date.now();
  const entry = inquiryRateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    inquiryRateLimit.set(ip, { count: 1, resetAt: now + INQUIRY_WINDOW_MS });
    return true;
  }
  if (entry.count >= INQUIRY_LIMIT) return false;
  entry.count++;
  return true;
}
// Periodic cleanup so the map doesn't grow forever on a long-lived process
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of inquiryRateLimit) {
    if (entry.resetAt < now) inquiryRateLimit.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// CORS — only on the inquiry endpoint. Everything else is same-origin.
function inquiryCORS(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

app.options('/api/inquiries', inquiryCORS);
app.post('/api/inquiries', inquiryCORS, (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkInquiryRateLimit(ip)) {
    return res.status(429).json({ error: 'too many inquiries from this address, please try again later' });
  }

  const { name, email, phone, message, website, source } = req.body || {};

  // Honeypot — real users don't fill this. Fake a success so bots don't retry.
  if (website && String(website).trim()) {
    return res.json({ ok: true });
  }

  const cleanName    = (name    || '').trim().slice(0, 100);
  const cleanEmail   = (email   || '').trim().slice(0, 200);
  const cleanPhone   = (phone   || '').trim().slice(0, 50);
  const cleanMessage = (message || '').trim().slice(0, 2000);
  const cleanSource  = ['ham_app', 'direct', 'other'].includes(source) ? source : 'ham_app';

  if (!cleanName)  return res.status(400).json({ error: 'name required' });
  if (!cleanEmail) return res.status(400).json({ error: 'email required' });
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ error: 'invalid email' });

  const id = uid('ld');
  db.prepare(
    'INSERT INTO leads (id, name, email, phone, message, source, status, coach_notes, converted_to_client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, cleanName, cleanEmail, cleanPhone, cleanMessage, cleanSource, 'new', '', null, new Date().toISOString());

  res.json({ ok: true });
});

app.get('/api/leads', requireCoach, (req, res) => {
  // Sort: active statuses first (new, contacted), then converted/archived. Within a group, newest first.
  const rows = db.prepare(`
    SELECT * FROM leads
    ORDER BY
      CASE status
        WHEN 'new' THEN 0
        WHEN 'contacted' THEN 1
        WHEN 'converted' THEN 2
        WHEN 'archived' THEN 3
        ELSE 4
      END,
      created_at DESC
  `).all();
  res.json(rows);
});

app.patch('/api/leads/:id', requireCoach, (req, res) => {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { status, coach_notes, converted_to_client_id } = req.body;
  const fields = [], values = [];
  if (status !== undefined) {
    if (!['new', 'contacted', 'converted', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    fields.push('status = ?'); values.push(status);
  }
  if (coach_notes !== undefined) { fields.push('coach_notes = ?'); values.push((coach_notes || '').trim()); }
  if (converted_to_client_id !== undefined) { fields.push('converted_to_client_id = ?'); values.push(converted_to_client_id || null); }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id));
});

app.delete('/api/leads/:id', requireCoach, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// HEALTH + STATIC
// ============================================================
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Manual backup trigger — coach only. Useful for testing or ad-hoc backups.
app.post('/api/backup/run', requireCoach, async (req, res) => {
  try {
    const summary = await runBackup();
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('[backup] manual run failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve the React app and its static assets
app.use(express.static(path.join(__dirname, 'public')));

app.get(/^(?!\/api\/|\/uploads\/).+/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large (max 15MB)' });
  if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: 'too many files (max 5)' });
  if (err.message === 'only image uploads allowed') return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`[server] The Buffalo Method — listening on :${PORT} (${NODE_ENV})`);

  // Start nightly backup scheduler — only if configured, doesn't crash boot if not
  if (process.env.RESEND_API_KEY && process.env.BACKUP_EMAIL && process.env.BACKUP_FROM_EMAIL) {
    startScheduler();
  } else {
    console.log('[backup] Scheduler disabled (missing RESEND_API_KEY / BACKUP_EMAIL / BACKUP_FROM_EMAIL env vars)');
  }
});
