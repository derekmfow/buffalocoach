/**
 * backup.js — Nightly backup of the database and that day's new photos.
 *
 * Runs on a schedule from server.js. Sends two emails to BACKUP_EMAIL:
 *   1. "[Buffalo Method] DB backup YYYY-MM-DD" — always sent, attaches app.db
 *   2. "[Buffalo Method] Photos YYYY-MM-DD" — only if new photos exist, attaches a tarball
 *
 * Uses SQLite's online backup API (via better-sqlite3) so the file is safe
 * to copy even if the server is writing to it at the same time.
 *
 * Email delivery via Resend (https://resend.com) — free tier covers 3,000/mo.
 * Required env vars: RESEND_API_KEY, BACKUP_EMAIL, BACKUP_FROM_EMAIL.
 *
 * Safe: this module never deletes production data. Temp files only.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const db = require('./db');
const { sendEmail } = require('./email');

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, 'data', 'uploads');
const DB_PATH     = process.env.DB_PATH     || path.join(__dirname, 'data', 'app.db');
const TMP_DIR     = '/tmp';

/**
 * Make a consistent copy of the SQLite file to a temp path.
 * Uses better-sqlite3's backup API so it's safe against concurrent writes.
 */
async function snapshotDb(dstPath) {
  // better-sqlite3.backup returns a promise that resolves when done
  await db.backup(dstPath);
  return dstPath;
}

/**
 * Make a tar.gz of all photo folders whose date segment matches `dateStr` (YYYY-MM-DD).
 * Directory structure: /uploads/{clientId}/{logDate}/{filename}
 * We search every client folder and include only the matching date subfolders.
 * Returns the path to the created archive, or null if no photos exist for that date.
 */
function archiveTodayPhotos(dateStr, dstPath) {
  if (!fs.existsSync(UPLOAD_ROOT)) return null;

  const clientDirs = fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  // Collect relative paths (relative to UPLOAD_ROOT) for any {client}/{dateStr} folder that exists
  const toArchive = [];
  for (const clientId of clientDirs) {
    const dateDir = path.join(UPLOAD_ROOT, clientId, dateStr);
    if (fs.existsSync(dateDir) && fs.statSync(dateDir).isDirectory()) {
      const files = fs.readdirSync(dateDir);
      if (files.length > 0) {
        toArchive.push(`${clientId}/${dateStr}`);
      }
    }
  }

  if (toArchive.length === 0) return null;

  // tar the selected paths — relative to UPLOAD_ROOT so extraction is clean
  // -C changes directory before archiving; keeps paths relative
  const args = toArchive.map(p => `"${p}"`).join(' ');
  execSync(`tar -czf "${dstPath}" -C "${UPLOAD_ROOT}" ${args}`);
  return dstPath;
}

/**
 * Run the full backup routine. Returns a summary object for logging.
 * Throws on catastrophic failure so the caller can alert.
 */
async function runBackup() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const to      = process.env.BACKUP_EMAIL;
  const from    = process.env.BACKUP_FROM_EMAIL;

  if (!to)   throw new Error('BACKUP_EMAIL not set');
  if (!from) throw new Error('BACKUP_FROM_EMAIL not set');

  const summary = { dateStr, dbSent: false, photosSent: false, photoCount: 0, errors: [] };

  // --- 1. DB backup ---
  const dbSnapshotPath = path.join(TMP_DIR, `app-${dateStr}.db`);
  try {
    await snapshotDb(dbSnapshotPath);
    const stat = fs.statSync(dbSnapshotPath);
    await sendEmail({
      to, from,
      subject: `[Buffalo Method] DB backup ${dateStr}`,
      text: `Nightly database backup for ${dateStr}.\n\nFile size: ${(stat.size / 1024).toFixed(1)} KB\n\nTo restore: replace /data/app.db on the server with this file and restart the service.`,
      attachmentPath: dbSnapshotPath,
      attachmentName: `buffalo-db-${dateStr}.db`,
    });
    summary.dbSent = true;
  } catch (e) {
    summary.errors.push(`DB backup failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(dbSnapshotPath); } catch {}
  }

  // --- 2. Today's photos (only if any exist) ---
  const photoArchivePath = path.join(TMP_DIR, `photos-${dateStr}.tar.gz`);
  try {
    const archived = archiveTodayPhotos(dateStr, photoArchivePath);
    if (archived) {
      const stat = fs.statSync(archived);
      summary.photoCount = countFilesInTarball(archived);
      await sendEmail({
        to, from,
        subject: `[Buffalo Method] Photos ${dateStr}`,
        text: `Photo archive for ${dateStr}.\n\n${summary.photoCount} photo(s) uploaded today.\nFile size: ${(stat.size / 1024 / 1024).toFixed(1)} MB\n\nTo restore: extract this archive into /data/uploads/ on the server. Existing files won't be overwritten.`,
        attachmentPath: archived,
        attachmentName: `buffalo-photos-${dateStr}.tar.gz`,
      });
      summary.photosSent = true;
    }
  } catch (e) {
    summary.errors.push(`Photo backup failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(photoArchivePath); } catch {}
  }

  return summary;
}

function countFilesInTarball(tarPath) {
  try {
    const out = execSync(`tar -tzf "${tarPath}" | grep -v "/$" | wc -l`).toString().trim();
    return parseInt(out, 10) || 0;
  } catch { return 0; }
}

/**
 * Start a daily scheduler. Runs `runBackup` at the next 03:00 local time,
 * then every 24 hours after.
 */
function startScheduler() {
  const hour = 3; // 3am
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const msUntil = next - now;
    console.log(`[backup] Next run scheduled for ${next.toISOString()} (in ${Math.round(msUntil/1000/60)} min)`);

    setTimeout(async () => {
      try {
        console.log('[backup] Running scheduled backup…');
        const summary = await runBackup();
        console.log('[backup] Done:', JSON.stringify(summary));
      } catch (e) {
        console.error('[backup] FAILED:', e.message);
      }
      scheduleNext(); // schedule the one after
    }, msUntil);
  };
  scheduleNext();
}

module.exports = { runBackup, startScheduler };
