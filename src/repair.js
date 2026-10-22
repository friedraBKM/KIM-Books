// Nachbearbeitung im Admin: fehlende ISBN und Cover für alle Bücher nachholen.
// Läuft im Hintergrund; der Stand wird in meta gespeichert und im Admin angezeigt.
import { db, getMeta, setMeta } from './db.js';
import { backfillIsbns } from './search.js';
import { lookupIsbn } from './isbn-lookup.js';
import { refreshCover } from './covers.js';

let running = false;

export function repairStatus() {
  return { running, progress: getMeta('repair_progress'), last: getMeta('repair_last') };
}

function progress(text) {
  setMeta('repair_progress', text);
}

export function startRepair() {
  if (running) return false;
  running = true;
  run()
    .catch((err) => {
      console.error('Nachbearbeitung fehlgeschlagen:', err);
      setMeta('repair_last', { at: new Date().toISOString(), error: err.message });
    })
    .finally(() => {
      running = false;
      setMeta('repair_progress', null);
    });
  return true;
}

async function run() {
  const summary = { isbnChecked: 0, isbnAuto: 0, isbnSuggested: 0, coversChecked: 0, coversFound: 0 };

  progress('ISBN für Einträge aus der Google-Suche nachtragen …');
  await backfillIsbns();

  // Ausgaben ohne ISBN, für die noch kein Vorschlag offen ist und die nicht verworfen wurden
  const editions = db.prepare(`
    SELECT e.id FROM editions e
    WHERE e.isbn IS NULL AND (e.isbn_status IS NULL OR e.isbn_status = 'none')
      AND e.work_id NOT IN (SELECT id FROM works WHERE isbn_override IS NOT NULL)
      AND e.work_id NOT IN (SELECT work_id FROM editions WHERE isbn IS NOT NULL)
  `).all();
  for (const [i, row] of editions.entries()) {
    progress(`ISBN suchen: ${i + 1} von ${editions.length} …`);
    summary.isbnChecked++;
    try {
      const r = await lookupIsbn(row.id);
      if (r?.status === 'auto') summary.isbnAuto++;
      if (r?.status === 'suggested') summary.isbnSuggested++;
    } catch (err) {
      console.warn(`ISBN-Suche für Ausgabe ${row.id} fehlgeschlagen:`, err.message);
    }
  }

  const works = db.prepare('SELECT id FROM works WHERE cover IS NULL').all();
  for (const [i, w] of works.entries()) {
    progress(`Cover suchen: ${i + 1} von ${works.length} …`);
    summary.coversChecked++;
    try {
      if (await refreshCover(w.id)) summary.coversFound++;
    } catch (err) {
      console.warn(`Cover für Werk ${w.id} fehlgeschlagen:`, err.message);
    }
  }

  setMeta('repair_last', { at: new Date().toISOString(), ...summary });
  return summary;
}
