/**
 * db.js — SQLite database setup and helpers.
 *
 * On boot:
 *  - Opens (or creates) the SQLite file at DB_PATH
 *  - Runs CREATE TABLE IF NOT EXISTS for every table
 *  - If the exercises table is empty, seeds it with Derek's default library + programs
 *    so the dashboard has content to work with from day one.
 *
 * Everything here is synchronous because better-sqlite3 is synchronous.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');

// Ensure the directory exists (matters for local dev; on Render /data is pre-mounted)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// SCHEMA
// ============================================================
db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  pin_hash     TEXT NOT NULL,
  start_date   TEXT NOT NULL,        -- YYYY-MM-DD
  status       TEXT NOT NULL DEFAULT 'active',  -- active | completed | paused
  goals        TEXT DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_logs (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  log_date     TEXT NOT NULL,        -- YYYY-MM-DD
  photos       TEXT NOT NULL,        -- JSON array of filenames (served via /uploads/:client/:date/:file)
  note         TEXT DEFAULT '',
  created_at   TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meal_logs_client_date ON meal_logs(client_id, log_date);

CREATE TABLE IF NOT EXISTS weekly_checkins (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  week_number   INTEGER NOT NULL,    -- 0..6
  weight_lbs    REAL,
  steps_avg     INTEGER,
  energy_1_10   INTEGER,
  hunger_1_10   INTEGER,
  wins          TEXT DEFAULT '',
  struggles     TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE (client_id, week_number)
);

CREATE TABLE IF NOT EXISTS coach_notes (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS client_questions (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  message      TEXT NOT NULL,
  is_resolved  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exercises (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  muscle_group  TEXT NOT NULL,       -- Legs, Back, Chest, Shoulders, Arms, Core
  category      TEXT NOT NULL,       -- Compound | Isolation | Accessory
  notes         TEXT DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  exercises    TEXT NOT NULL,        -- JSON array: [{exercise_id,order,sets,reps,rest_seconds,rationale}]
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  days         TEXT NOT NULL,        -- JSON array: [{template_id, label}]
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meal_suggestions (
  id            TEXT PRIMARY KEY,
  meal_log_id   TEXT NOT NULL UNIQUE,
  meals         TEXT NOT NULL,       -- JSON array: [{name, protein, carb, fat}]
  message       TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (meal_log_id) REFERENCES meal_logs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leads (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  email                  TEXT NOT NULL,
  phone                  TEXT DEFAULT '',
  message                TEXT DEFAULT '',
  source                 TEXT DEFAULT 'ham_app',   -- ham_app | direct | other
  status                 TEXT NOT NULL DEFAULT 'new',  -- new | contacted | converted | archived
  coach_notes            TEXT DEFAULT '',          -- private notes from coach while working the lead
  converted_to_client_id TEXT,                     -- FK to clients if status='converted'
  created_at             TEXT NOT NULL,            -- full ISO timestamp, not just date — inquiries are time-sensitive
  FOREIGN KEY (converted_to_client_id) REFERENCES clients(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status_created ON leads(status, created_at DESC);
`);

// ============================================================
// FIRST-RUN SEEDING (exercises + programs only — never touches client data)
// ============================================================
const exerciseCount = db.prepare('SELECT COUNT(*) as n FROM exercises').get().n;

if (exerciseCount === 0) {
  console.log('[db] First run — seeding exercise library, templates, and programs.');
  const now = new Date().toISOString().slice(0, 10);

  const seedExercises = [
    { id:'e1',  name:'Leg Extension', muscle_group:'Legs', category:'Isolation', notes:"Direct quad work. Ideal warmup before squat variations — light to moderate load, feel the quad working, no flopping." },
    { id:'e2',  name:'Leg Curl', muscle_group:'Legs', category:'Isolation', notes:"Direct hamstring work. Warmup pair with leg extensions; also good as a finisher on lower days." },
    { id:'e3',  name:'Belt Squat', muscle_group:'Legs', category:'Compound', notes:"Loads the legs without taxing the lower back. Great main squat if the spine is a limiter." },
    { id:'e4',  name:'Leg Press', muscle_group:'Legs', category:'Compound', notes:"Heavy load, stable plane, no balance demand. Favorite main lift for volume and safety." },
    { id:'e5',  name:'Pendulum Squat', muscle_group:'Legs', category:'Compound', notes:"Guided squat pattern. Quads work hard, knees track clean. Excellent for building the quad sweep." },
    { id:'e6',  name:'Goblet Squat', muscle_group:'Legs', category:'Compound', notes:"Bodyweight-to-moderate load squat. Great form teacher; use when equipment is limited." },
    { id:'e7',  name:'Bulgarian Split Squat', muscle_group:'Legs', category:'Compound', notes:"Unilateral loading. Exposes left/right imbalances that bilateral squats hide. Brutal and honest." },
    { id:'e8',  name:'Dumbbell Straight Leg Deadlift', muscle_group:'Legs', category:'Compound', notes:"Posterior chain main lift. Slow eccentric, feel the stretch in the hamstrings. Don't chase weight here." },
    { id:'e9',  name:'Bench Supported Dumbbell Rows', muscle_group:'Back', category:'Compound', notes:"Chest supported kills the lower-back cheat. All the work stays in the lats and mid-back where it belongs." },
    { id:'e10', name:'Seated V-Grip Rows', muscle_group:'Back', category:'Compound', notes:"Neutral-grip pull lets the mid-back and lats share the work. Strong mind-muscle connection here." },
    { id:'e11', name:'Lat Pulldown (shoulder-width, palms facing you)', muscle_group:'Back', category:'Compound', notes:"Close supinated grip biases the lats and the biceps. Pull to the upper chest, not the chin." },
    { id:'e12', name:'Dumbbell or Cable Pullover', muscle_group:'Back', category:'Isolation', notes:"Lat stretch under load. Lightweight warmup for back day — sets the mind-muscle connection before rowing." },
    { id:'e13', name:'Incline Dumbbell Press', muscle_group:'Chest', category:'Compound', notes:"Low 15° / medium 30° / high 45° — rotate the angle across sessions. Covers the full chest without a flat press." },
    { id:'e14', name:'Dumbbell Flys (with supination)', muscle_group:'Chest', category:'Isolation', notes:"Supinate at the top — palms rotate up as you press together. Small tweak, huge tension in the pec." },
    { id:'e15', name:'Cable Flys (standing or seated, ladder)', muscle_group:'Chest', category:'Isolation', notes:"Ladder the weight up or down across sets. High / mid / low angle variations. Stretch and squeeze." },
    { id:'e16', name:'Rear Delt Hang and Swing', muscle_group:'Shoulders', category:'Isolation', notes:"Lean, swing, control the eccentric. Rear delts are stubborn — this is where you earn them." },
    { id:'e17', name:'Lateral Raises', muscle_group:'Shoulders', category:'Isolation', notes:"Side delts want volume. 3-4 sets is fine, higher reps work well here. Keep weight honest — no body english." },
    { id:'e18', name:'Shoulder Press', muscle_group:'Shoulders', category:'Compound', notes:"Main compound for shoulders. Dumbbell or machine, seated preferred for stability. Press the weight, don't just shove it." },
    { id:'e19', name:'Preacher Curls', muscle_group:'Arms', category:'Isolation', notes:"Pinned elbows, zero cheating. If the bicep isn't doing it, the weight doesn't move. Main bicep builder." },
    { id:'e20', name:'Rope Pushdowns', muscle_group:'Arms', category:'Isolation', notes:"Main tricep isolation. Split the rope at the bottom, squeeze hard. Vary the grip for variety." },
    { id:'e21', name:'Single-Arm Pushdowns', muscle_group:'Arms', category:'Isolation', notes:"With or without a handle. Unilateral tricep work — lets each arm work through its own range without compensation." },
    { id:'e22', name:'Low-Pull Single-Arm Curls', muscle_group:'Arms', category:'Isolation', notes:"Cable at the lowest setting. Long stretch, strong contraction. Great second bicep exercise or finisher." },
  ];

  const insertExercise = db.prepare(
    'INSERT INTO exercises (id, name, muscle_group, category, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertExercise.run(r.id, r.name, r.muscle_group, r.category, r.notes, now);
  });
  insertMany(seedExercises);

  const seedTemplates = [
    { id:'t_upper', name:'Upper Body', description:'Full upper: chest, back, shoulders, and arms work. Runs as part of an Upper/Lower split 4 days/week.',
      exercises:[
        { exercise_id:'e12', order:1, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Lat pullover as the warmup. Stretches the lats, sets the mind-muscle connection, and primes the chest for pressing." },
        { exercise_id:'e16', order:2, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Rear delts early while fresh. Stubborn group — they need the attention before everything else wears you out." },
        { exercise_id:'e13', order:3, sets:3, reps:'8-12',  rest_seconds:180, rationale:"Main chest compound in the middle of the workout. Rotate the angle — low, medium, or high incline — across sessions." },
        { exercise_id:'e9',  order:4, sets:3, reps:'8-12',  rest_seconds:180, rationale:"Main back compound. Bench support eliminates the lower-back cheat so the row stays honest." },
        { exercise_id:'e18', order:5, sets:3, reps:'8-12',  rest_seconds:180, rationale:"Main shoulder compound. Volume stays moderate since shoulders got hit in the warmup too." },
        { exercise_id:'e17', order:6, sets:3, reps:'12-15', rest_seconds:90,  rationale:"Optional side delt finisher. Lateral raises respond to volume — add a set or two if shoulders feel undertrained." },
        { exercise_id:'e19', order:7, sets:3, reps:'10-12', rest_seconds:75,  rationale:"Optional arm work. Skip if time is tight, or add rope pushdowns as a superset if arms need extra." },
      ]},
    { id:'t_lower', name:'Lower Body', description:'Full lower: quads, hamstrings, glutes, posterior chain. Runs as part of an Upper/Lower split 4 days/week.',
      exercises:[
        { exercise_id:'e1', order:1, sets:3, reps:'12-15',        rest_seconds:75,  rationale:"Quad isolation warmup. Light to moderate load, feel the muscle firing before loading the joint with a compound." },
        { exercise_id:'e2', order:2, sets:3, reps:'12-15',        rest_seconds:75,  rationale:"Hamstring warmup. Pairs with the leg extension — both knee-dominant isolations prime the legs cleanly." },
        { exercise_id:'e4', order:3, sets:3, reps:'8-12',         rest_seconds:180, rationale:"Main squat pattern. Leg press picked as a default — swap to belt squat, pendulum, goblet, or Bulgarian based on equipment and goals." },
        { exercise_id:'e7', order:4, sets:3, reps:'8-10 per leg', rest_seconds:120, rationale:"Unilateral main lift. Exposes side-to-side imbalances and builds real single-leg strength. Once a month, swap for 20-30 rep heavy sets on the main squat." },
        { exercise_id:'e8', order:5, sets:3, reps:'8-12',         rest_seconds:150, rationale:"Posterior chain finisher. Slow eccentric, feel the hamstring stretch — weight is secondary here." },
      ]},
    { id:'t_bro_chest', name:'Chest Day', description:'Bro Split — Chest. Isolation warmup, main incline press, isolation finisher.',
      exercises:[
        { exercise_id:'e14', order:1, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Flys with supination as the warmup. Pre-exhausts the chest just enough — when you hit the press, the chest is fully switched on." },
        { exercise_id:'e13', order:2, sets:4, reps:'8-12',  rest_seconds:180, rationale:"Main chest lift. Rotate the incline angle (15° / 30° / 45°) across sessions. Push yourself here while the CNS is fresh." },
        { exercise_id:'e15', order:3, sets:3, reps:'12-15', rest_seconds:90,  rationale:"Optional cable fly finisher. Ladder the weight up or down, vary the cable height. Skip if time is tight." },
      ]},
    { id:'t_bro_back', name:'Back Day', description:'Bro Split — Back. Pullover warmup, three compound row/pull variations for main work.',
      exercises:[
        { exercise_id:'e12', order:1, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Pullover as the warmup. Gets the lats long and loaded before heavy rowing. Sets the mind-muscle connection for the rest of the day." },
        { exercise_id:'e9',  order:2, sets:4, reps:'8-12',  rest_seconds:180, rationale:"First main row. Chest-supported DB rows keep the lower back out of it — all the work goes into the lats and mid-back." },
        { exercise_id:'e10', order:3, sets:3, reps:'8-12',  rest_seconds:180, rationale:"Second main row. V-grip biases the mid-back and lats differently than the DB row — both variations add real back thickness." },
        { exercise_id:'e11', order:4, sets:3, reps:'10-12', rest_seconds:120, rationale:"Vertical pull to finish. Close supinated grip hits lats and biceps. Pull to the upper chest, not the chin." },
      ]},
    { id:'t_bro_shoulders', name:'Shoulders Day', description:'Bro Split — Shoulders. Stubborn group gets isolation first, then main press.',
      exercises:[
        { exercise_id:'e16', order:1, sets:4, reps:'12-15', rest_seconds:75,  rationale:"Rear delts first. They're the most undertrained delt head on most lifters — attack them while fresh." },
        { exercise_id:'e17', order:2, sets:4, reps:'12-20', rest_seconds:75,  rationale:"Lateral raises for the side delts. Higher reps work well here. Keep weight honest — no swinging." },
        { exercise_id:'e18', order:3, sets:4, reps:'8-12',  rest_seconds:180, rationale:"Main shoulder compound. Press after the delts are already warmed and pre-fatigued — forces good form and targets the front delt." },
      ]},
    { id:'t_legs', name:'Legs Day', description:'Full legs — quads, hamstrings, glutes, posterior chain. Shared between Bro Split and PPL.',
      exercises:[
        { exercise_id:'e1', order:1, sets:3, reps:'12-15',        rest_seconds:75,  rationale:"Quad isolation warmup. Light to moderate, get the quads firing before loading them." },
        { exercise_id:'e2', order:2, sets:3, reps:'12-15',        rest_seconds:75,  rationale:"Hamstring warmup. Pairs with leg extensions to prime both sides of the knee joint." },
        { exercise_id:'e4', order:3, sets:4, reps:'8-12',         rest_seconds:180, rationale:"First squat variation. Leg press picked as default — client can swap for belt squat, pendulum, goblet, or Bulgarian depending on equipment and goals." },
        { exercise_id:'e7', order:4, sets:3, reps:'8-10 per leg', rest_seconds:120, rationale:"Second squat variation — Bulgarian split squat as a unilateral default. Once a month, swap one of the squat slots for 20-30 rep heavy sets." },
        { exercise_id:'e8', order:5, sets:3, reps:'8-12',         rest_seconds:150, rationale:"Posterior chain finisher. Don't chase weight — slow eccentric and hamstring stretch are the point." },
      ]},
    { id:'t_bro_arms', name:'Arms Day', description:'Bro Split — Arms. Flexible day. The template below is a solid default — client should pick 2-4 of these based on how stubborn the arms are that week.',
      exercises:[
        { exercise_id:'e19', order:1, sets:4, reps:'8-12',  rest_seconds:90, rationale:"Main biceps builder. Preacher position pins the elbows — if the bicep isn't doing it, the weight won't move." },
        { exercise_id:'e20', order:2, sets:4, reps:'10-12', rest_seconds:90, rationale:"Main triceps isolation. Split the rope at the bottom, squeeze for a full second." },
        { exercise_id:'e22', order:3, sets:3, reps:'10-12', rest_seconds:75, rationale:"Optional second biceps movement. Long stretch at the bottom, strong contraction at the top. Skip if biceps are cooked." },
        { exercise_id:'e21', order:4, sets:3, reps:'10-12', rest_seconds:75, rationale:"Optional unilateral tricep work. Lets each arm move through its own range without the stronger arm compensating." },
      ]},
    { id:'t_ppl_push', name:'Push Day', description:'PPL — Push. Chest, shoulders, triceps. Isolation warmup, two main compounds, then optional finishers.',
      exercises:[
        { exercise_id:'e14', order:1, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Chest fly warmup with supination. Primes the chest so the press feels switched on from rep one." },
        { exercise_id:'e13', order:2, sets:4, reps:'8-12',  rest_seconds:180, rationale:"Main chest compound. Rotate the incline angle across push days — covers the full chest without needing a flat press." },
        { exercise_id:'e18', order:3, sets:3, reps:'8-12',  rest_seconds:180, rationale:"Main shoulder compound. Still in the middle of the workout while there's gas left — press cleanly, don't just shove the weight up." },
        { exercise_id:'e17', order:4, sets:3, reps:'12-20', rest_seconds:75,  rationale:"Lateral raise finisher for side delts. Stubborn group — higher reps welcome." },
        { exercise_id:'e20', order:5, sets:3, reps:'10-12', rest_seconds:75,  rationale:"Main triceps work to close. Rope split at the bottom, full squeeze." },
      ]},
    { id:'t_ppl_pull', name:'Pull Day', description:'PPL — Pull. Back, biceps, rear delts. Two isolation warmups, then compound rows and pulls, biceps finisher.',
      exercises:[
        { exercise_id:'e12', order:1, sets:3, reps:'12-15', rest_seconds:75,  rationale:"Pullover warmup for the lats. Gets them long and loaded before any rowing." },
        { exercise_id:'e16', order:2, sets:4, reps:'12-15', rest_seconds:75,  rationale:"Rear delts while fresh. They're stubborn — don't let them be the afterthought." },
        { exercise_id:'e9',  order:3, sets:4, reps:'8-12',  rest_seconds:180, rationale:"Main row. Chest-supported kills the cheat — all the work stays in the back." },
        { exercise_id:'e11', order:4, sets:3, reps:'8-12',  rest_seconds:150, rationale:"Main vertical pull. Close supinated grip. Pull to upper chest, control the eccentric." },
        { exercise_id:'e19', order:5, sets:4, reps:'8-12',  rest_seconds:90,  rationale:"Main biceps work. Pinned elbows mean there's nowhere to hide — clean reps or no reps." },
      ]},
  ];
  const insertTemplate = db.prepare('INSERT INTO templates (id, name, description, exercises, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertAllTemplates = db.transaction((rows) => {
    for (const r of rows) insertTemplate.run(r.id, r.name, r.description, JSON.stringify(r.exercises), now);
  });
  insertAllTemplates(seedTemplates);

  const seedPrograms = [
    { id:'p_upper_lower', name:'Upper / Lower',
      description:'Two-day split rotated through the week. Balanced coverage with more rest per body part than a full split.',
      notes:'Typical run is 4 days/week: Upper → Lower → Upper → Lower. For higher frequency on specific muscle groups, move to Bro Split or PPL.',
      days:[{ template_id:'t_upper', label:'Upper Body' }, { template_id:'t_lower', label:'Lower Body' }] },
    { id:'p_bro', name:'Bro Split',
      description:'Five-day split with one muscle group per day. Maximum volume and focus per group.',
      notes:'Run 5 days/week. Arms Day is intentionally flexible — the client builds their own based on where they need volume.',
      days:[
        { template_id:'t_bro_chest', label:'Chest Day' },
        { template_id:'t_bro_back', label:'Back Day' },
        { template_id:'t_bro_shoulders', label:'Shoulders Day' },
        { template_id:'t_legs', label:'Legs Day' },
        { template_id:'t_bro_arms', label:'Arms Day' },
      ]},
    { id:'p_ppl', name:'Push / Pull / Legs',
      description:'Three-day rotation by movement pattern. Efficient coverage — hits every muscle group with compound overlap.',
      notes:'Run 3 days/week for recovery or 6 days/week for frequency (Push/Pull/Legs/Push/Pull/Legs/Off). Choose based on recovery capacity and goals.',
      days:[
        { template_id:'t_ppl_push', label:'Push Day' },
        { template_id:'t_ppl_pull', label:'Pull Day' },
        { template_id:'t_legs',     label:'Legs Day' },
      ]},
  ];
  const insertProgram = db.prepare('INSERT INTO programs (id, name, description, notes, days, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insertAllPrograms = db.transaction((rows) => {
    for (const r of rows) insertProgram.run(r.id, r.name, r.description, r.notes, JSON.stringify(r.days), now);
  });
  insertAllPrograms(seedPrograms);

  console.log(`[db] Seeded ${seedExercises.length} exercises, ${seedTemplates.length} workout days, ${seedPrograms.length} programs.`);
}

module.exports = db;
