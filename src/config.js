// Alle Einstellungen kommen aus Umgebungsvariablen (in Coolify unter "Environment Variables").
import crypto from 'node:crypto';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  dataDir: env.DATA_DIR || './data',

  // Zugangscode für Teilnehmende. Leer = kein Code nötig.
  accessCode: (env.ACCESS_CODE || '').trim(),

  // Passwort für /admin (Benutzername: admin). Leer = Admin-Bereich gesperrt.
  adminPassword: env.ADMIN_PASSWORD || '',

  // Geheimnis zum Signieren von Cookies und Hashen der Teilnehmer-Tokens.
  // Wird es nicht gesetzt, entsteht bei jedem Neustart ein neues: Teilnehmende
  // müssten dann den Zugangscode neu eingeben und könnten ihre Auswahl nicht mehr ändern.
  secret: env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
  secretIsRandom: !env.APP_SECRET,

  googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY || '',
  openLibraryContact: env.OPENLIBRARY_CONTACT || '',

  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  // Wartezeit nach der letzten Abgabe, bevor der KI-Abgleich startet (Sekunden).
  reconcileDelay: Number(env.RECONCILE_DELAY_SECONDS || 30),

  // Benachrichtigung bei manuell eingetragenen Büchern
  notifyEmail: env.NOTIFY_EMAIL || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || '',

  // Verantwortliche Stelle für den Datenschutzhinweis (freier Text, z. B. "Max Muster, max@example.de")
  privacyContact: env.PRIVACY_CONTACT || '',

  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  maxWhyLength: 280,
};
