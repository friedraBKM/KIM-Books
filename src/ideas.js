// Ideenspeicher: Ideen sind sofort sichtbar, nur der Admin kann löschen und den Status setzen.
import { db, normalize } from './db.js';

export const IDEA_STATUS = ['neu', 'geplant', 'umgesetzt', 'verworfen'];
export const MAX_TEXT = 200;
export const MAX_DETAILS = 1000;

export class IdeaError extends Error {}

export function listIdeas(voter = null) {
  const rows = db.prepare(`
    SELECT i.id, i.text, i.details, i.status, i.created_at,
           COUNT(v.voter) AS votes,
           MAX(CASE WHEN v.voter = ? THEN 1 ELSE 0 END) AS mine
    FROM ideas i LEFT JOIN idea_votes v ON v.idea_id = i.id
    GROUP BY i.id
    ORDER BY i.id DESC
  `).all(voter ?? '');
  return rows.map((r) => ({ ...r, mine: Boolean(r.mine) }));
}

export function addIdea(textRaw, detailsRaw = '') {
  const text = String(textRaw ?? '').replace(/\s+/g, ' ').trim();
  const details = String(detailsRaw ?? '').trim().slice(0, MAX_DETAILS);
  if (text.length < 3) throw new IdeaError('Bitte die Idee in einem kurzen Satz beschreiben.');
  if (text.length > MAX_TEXT) throw new IdeaError(`Bitte höchstens ${MAX_TEXT} Zeichen; mehr passt in die Details.`);
  const key = normalize(text);
  const exists = db.prepare('SELECT text FROM ideas').all().some((r) => normalize(r.text) === key);
  if (exists) throw new IdeaError('Diese Idee steht schon im Speicher. Gib ihr dort ein +1.');
  const id = Number(db.prepare('INSERT INTO ideas (text, details) VALUES (?, ?)').run(text, details).lastInsertRowid);
  return { id, text, details };
}

// +1 umschalten: einmal geben, nochmal zurücknehmen
export function toggleVote(ideaId, voter) {
  const idea = db.prepare('SELECT id FROM ideas WHERE id = ?').get(ideaId);
  if (!idea) throw new IdeaError('Diese Idee gibt es nicht mehr.');
  const has = db.prepare('SELECT 1 FROM idea_votes WHERE idea_id = ? AND voter = ?').get(ideaId, voter);
  if (has) db.prepare('DELETE FROM idea_votes WHERE idea_id = ? AND voter = ?').run(ideaId, voter);
  else db.prepare('INSERT INTO idea_votes (idea_id, voter) VALUES (?, ?)').run(ideaId, voter);
  return !has;
}

export function setIdeaStatus(ideaId, status) {
  if (!IDEA_STATUS.includes(status)) throw new IdeaError('Unbekannter Status.');
  db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, ideaId);
}

export function deleteIdea(ideaId) {
  db.prepare('DELETE FROM idea_votes WHERE idea_id = ?').run(ideaId);
  db.prepare('DELETE FROM ideas WHERE id = ?').run(ideaId);
}
