// Benachrichtigt den Admin, wenn ein Buch manuell eingetragen wurde.
// Wege: E-Mail (SMTP) und/oder Webhook (z. B. Teams, Slack, ntfy). Beides optional.
import nodemailer from 'nodemailer';
import { config } from './config.js';

const mailer = config.smtp.host && config.notifyEmail
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : null;

export function notifyChannels() {
  return { email: Boolean(mailer), webhook: Boolean(config.notifyWebhookUrl) };
}

// Mehrere manuelle Einträge innerhalb von 2 Minuten werden zu einer Nachricht gebündelt.
let queue = [];
let timer = null;

export function notifyManualEntry(book) {
  if (!mailer && !config.notifyWebhookUrl) return;
  queue.push(book);
  if (!timer) timer = setTimeout(flush, 2 * 60 * 1000);
}

async function flush() {
  const books = queue;
  queue = [];
  timer = null;
  if (!books.length) return;

  const outcome = (b) => {
    const p = b.lookup?.pick;
    if (b.lookup?.status === 'auto') return `   Amazon-Link automatisch gesetzt: ${p.title} (${p.source}, ISBN ${p.isbn})`;
    if (b.lookup?.status === 'suggested') return `   Vorschlag zum Bestätigen: ${p.title} (${p.source}, ISBN ${p.isbn})`;
    return '   Keine ISBN gefunden – Link führt zur Amazon-Suche';
  };
  const list = books.map((b) => `- ${b.title}${b.authors ? ` (${b.authors})` : ''}\n${outcome(b)}`).join('\n');
  const link = config.publicUrl ? `${config.publicUrl}/admin` : '/admin';
  const subject = `Must-Read-Regal: ${books.length} Buch/Bücher manuell eingetragen – bitte prüfen`;
  const text = `Folgende Bücher wurden ohne Treffer in der Buchsuche manuell eingetragen:\n\n${list}\n\nBitte im Admin-Bereich prüfen: ${link}\n`;

  if (mailer) {
    try {
      await mailer.sendMail({ from: config.smtp.from, to: config.notifyEmail, subject, text });
    } catch (err) {
      console.error('E-Mail-Benachrichtigung fehlgeschlagen:', err.message);
    }
  }
  if (config.notifyWebhookUrl) {
    try {
      await fetch(config.notifyWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${subject}\n\n${text}` }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.error('Webhook-Benachrichtigung fehlgeschlagen:', err.message);
    }
  }
}
