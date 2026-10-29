/**
 * Correu per la API HTTPS de Brevo (Railway bloqueja l'SMTP als plans Free/Hobby).
 * Sense BREVO_API_KEY no s'envia res: el correu només queda al registre (email_log).
 */
'use strict';

function parseAddress(value) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: String(value || '').trim() };
}

function createMailer(db, { fetchImpl = globalThis.fetch, apiKey = process.env.BREVO_API_KEY } = {}) {
  const from = process.env.MAIL_FROM || 'Calendari CH Ripollet <no-reply@example.com>';
  const log = db.prepare('INSERT INTO email_log (to_address, subject, body, status, error) VALUES (?, ?, ?, ?, ?)');

  async function send(to, subject, body) {
    const recipients = [...new Set((Array.isArray(to) ? to : [to]).map((s) => String(s || '').trim()).filter(Boolean))];
    if (!recipients.length) return { sent: false, reason: 'sense destinataris' };
    if (!apiKey) {
      log.run(recipients.join(', '), subject, body, 'no enviat', 'Correu no configurat (BREVO_API_KEY)');
      return { sent: false, reason: 'no configurat' };
    }
    try {
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: parseAddress(from), to: recipients.map((email) => ({ email })), subject, textContent: body }),
      });
      if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      log.run(recipients.join(', '), subject, body, 'enviat', null);
      return { sent: true };
    } catch (err) {
      log.run(recipients.join(', '), subject, body, 'error', err.message);
      return { sent: false, reason: err.message };
    }
  }

  return { send, configured: Boolean(apiKey) };
}

module.exports = { createMailer };
