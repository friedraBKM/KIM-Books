// Datenhaltung in SQLite (eingebautes node:sqlite). Die Datei liegt in DATA_DIR,
// das in Coolify als Persistent Volume eingebunden wird.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const dbFile = path.join(config.dataDir, 'kim-books.sqlite');
const isNew = !fs.existsSync(dbFile);
export const db = new DatabaseSync(dbFile);

// Sicherung bei jedem Start, bevor Tabellen angepasst werden.
// Die letzten 20 Stände bleiben unter DATA_DIR/backups liegen.
const backupDir = path.join(config.dataDir, 'backups');
export function backupTo(file) {
  db.prepare('VACUUM INTO ?').run(file);
}
if (!isNew) {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupTo(path.join(backupDir, `kim-books-${stamp}.sqlite`));
    const old = fs.readdirSync(backupDir).filter((f) => f.endsWith('.sqlite')).sort().reverse().slice(20);
    for (const f of old) fs.unlinkSync(path.join(backupDir, f));
  } catch (err) {
    console.error('Sicherung beim Start fehlgeschlagen:', err.message);
  }
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Ein "Werk" ist das, was in der Rangliste steht. Mehrere Ausgaben
  -- (Original, Übersetzung, Taschenbuch) werden einem Werk zugeordnet.
  CREATE TABLE IF NOT EXISTS works (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '',
    cover TEXT,
    category TEXT,
    category_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS editions (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,              -- google | openlibrary | manual
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    authors TEXT NOT NULL DEFAULT '',
    year TEXT,
    publisher TEXT,
    language TEXT,
    cover TEXT,
    work_id INTEGER NOT NULL REFERENCES works(id),
    merge_reason TEXT,                 -- Begründung der KI, falls zusammengeführt
    separated INTEGER NOT NULL DEFAULT 0, -- vom Admin getrennt: KI fasst sie nicht wieder an
    needs_review INTEGER NOT NULL DEFAULT 0, -- manuell eingetragen, Admin soll prüfen
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source, source_id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY,
    voter TEXT NOT NULL,               -- Hash eines zufälligen Browser-Tokens, kein Personenbezug
    edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
    why TEXT NOT NULL DEFAULT '',
    why_status TEXT NOT NULL DEFAULT 'new', -- new | ok | flagged | hidden
    why_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter);
  CREATE INDEX IF NOT EXISTS idx_votes_edition ON votes(edition_id);
  CREATE INDEX IF NOT EXISTS idx_editions_work ON editions(work_id);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Spalten, die nach der ersten Version dazugekommen sind
function addColumn(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('editions', 'isbn', 'TEXT');
addColumn('works', 'isbn_override', 'TEXT');

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Entfernt Ausgaben ohne Stimmen und Werke ohne Ausgaben.
export function cleanupOrphans() {
  db.exec(`
    DELETE FROM editions WHERE id NOT IN (SELECT DISTINCT edition_id FROM votes);
    DELETE FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM editions);
  `);
}

// Vergleichsschlüssel für einfache Dubletten-Erkennung ohne KI.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function firstAuthorKey(authors) {
  const first = String(authors || '').split(',')[0];
  const parts = normalize(first).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
