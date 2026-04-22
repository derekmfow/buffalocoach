/**
 * email.js — Shared Resend wrapper.
 *
 * Two senders (`to` + optional attachments) used by:
 *   - backup.js for nightly DB + photo emails (plain text, with attachments)
 *   - server.js for client welcome emails (HTML body, no attachment)
 *
 * Resolves the "from" address with sensible fallbacks so existing
 * backup-only deployments don't break when FROM_EMAIL is absent:
 *   FROM_EMAIL → BACKUP_FROM_EMAIL → throw
 *
 * Delivery via Resend (https://resend.com). Free tier = 3,000/mo.
 * Required: RESEND_API_KEY. Required-ish: FROM_EMAIL or BACKUP_FROM_EMAIL.
 */

const fs = require('fs');
const path = require('path');

function resolveFrom(explicit) {
  if (explicit) return explicit;
  if (process.env.FROM_EMAIL) return process.env.FROM_EMAIL;
  if (process.env.BACKUP_FROM_EMAIL) return process.env.BACKUP_FROM_EMAIL;
  throw new Error('No sender address: set FROM_EMAIL or BACKUP_FROM_EMAIL');
}

/**
 * Send an email via Resend's HTTP API.
 *
 * Options:
 *   to              — recipient address (string)
 *   from            — optional; falls back to FROM_EMAIL / BACKUP_FROM_EMAIL
 *   subject         — subject line
 *   text            — plain-text body (at least one of text|html required)
 *   html            — HTML body (optional)
 *   attachmentPath  — optional local file to attach
 *   attachmentName  — optional filename override for the attachment
 */
async function sendEmail({ to, from, subject, text, html, attachmentPath, attachmentName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!to)      throw new Error('email "to" required');
  if (!subject) throw new Error('email "subject" required');
  if (!text && !html) throw new Error('email "text" or "html" required');

  const body = {
    from: resolveFrom(from),
    to: [to],
    subject,
  };
  if (text) body.text = text;
  if (html) body.html = html;

  if (attachmentPath) {
    const content = fs.readFileSync(attachmentPath);
    body.attachments = [{
      filename: attachmentName || path.basename(attachmentPath),
      content: content.toString('base64'),
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * True if the environment has everything needed to send email.
 * Callers can gate on this to skip email silently in dev / missing-config.
 */
function isEmailConfigured() {
  if (!process.env.RESEND_API_KEY) return false;
  if (!process.env.FROM_EMAIL && !process.env.BACKUP_FROM_EMAIL) return false;
  return true;
}

module.exports = { sendEmail, isEmailConfigured };
