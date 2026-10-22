// KI-Websuche nach der ISBN eines Buchs, wenn die Bibliotheksquellen nichts
// Eindeutiges liefern. Claude sucht im Web (Amazon-, Verlags-, Bibliotheksseiten);
// übernommen wird nur eine ISBN, die wörtlich in den Suchtreffern vorkommt und
// deren Prüfziffer stimmt. Das Ergebnis ist immer nur ein Vorschlag für den Admin.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { cleanIsbn, validIsbn, isbn13to10 } from './amazon.js';

const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export function aiSearchEnabled() {
  return Boolean(client);
}

const PROMPT = (title, authors) => `Finde die ISBN dieses Buchs, wie es in Deutschland bei Amazon.de verkauft wird. Bevorzuge die aktuelle deutschsprachige Print-Ausgabe (Taschenbuch oder gebunden), kein E-Book, kein Hörbuch.

Titel: ${title}
Autor: ${authors || 'unbekannt'}

Suche im Web, z. B. nach Amazon.de-Seiten (die Adresse amazon.de/.../dp/<ISBN-10> enthält bei Büchern die ISBN-10), Verlagsseiten oder der Deutschen Nationalbibliothek. Nenne nur eine ISBN, die du in den Suchergebnissen tatsächlich gesehen hast. Erfinde nichts.

Antworte am Ende ausschließlich mit einem JSON-Objekt, ohne weiteren Text:
{"found": true|false, "isbn": "ISBN-10 oder ISBN-13", "title": "Titel der Ausgabe", "authors": "Autoren", "publisher": "Verlag", "year": "Jahr", "url": "Adresse des Treffers, in dem die ISBN steht"}`;

// Alle Texte aus den Suchergebnissen und Zitaten, gegen die geprüft wird
function evidenceOf(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) parts.push(r.url || '', r.title || '');
    }
    if (block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) parts.push(c.url || '', c.title || '', c.cited_text || '');
    }
  }
  return parts.join('\n');
}

function evidenceIsbns(evidence) {
  const found = new Set();
  // Bindestriche innerhalb von ISBNs entfernen
  const flat = evidence.replace(/(\d)[-\u2010\u2011](?=[\dXx])/g, '$1');
  for (const m of flat.matchAll(/(?<![\d])(97[89]\d{10}|\d{9}[\dXx])(?![\d])/g)) {
    const isbn = cleanIsbn(m[1]);
    if (validIsbn(isbn)) found.add(isbn);
  }
  // Amazon-Produktnummer in Adressen (bei Büchern = ISBN-10)
  for (const m of evidence.matchAll(/\/(?:dp|gp\/product)\/(\d{9}[\dX])/gi)) {
    const isbn = cleanIsbn(m[1]);
    if (validIsbn(isbn)) found.add(isbn);
  }
  return found;
}

function parseAnswer(content) {
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Prüft die Antwort gegen die Suchtreffer; reine Funktion, damit testbar.
export function verify(answer, evidence) {
  if (!answer?.found || !answer.isbn) return null;
  const isbn = cleanIsbn(answer.isbn);
  if (!validIsbn(isbn)) return null;
  // ISBN-10 und ISBN-13 derselben Ausgabe gelten als gleich
  const key = (x) => (x.length === 13 ? isbn13to10(x) || x : x);
  const seen = new Set([...evidenceIsbns(evidence)].map(key));
  if (!seen.has(key(isbn))) return null;
  return {
    source: 'KI-Websuche',
    isbn,
    title: String(answer.title || ''),
    authors: String(answer.authors || ''),
    publisher: String(answer.publisher || ''),
    year: String(answer.year || '').slice(0, 4),
    url: /^https:\/\//.test(answer.url || '') ? answer.url : '',
    language: 'de',
    cover: null,
  };
}

export async function aiFindIsbn(title, authors) {
  if (!client) throw new Error('Kein ANTHROPIC_API_KEY gesetzt.');
  const messages = [{ role: 'user', content: PROMPT(title, authors) }];
  const content = [];
  // Lange Suchen können pausieren (pause_turn); dann fortsetzen
  for (let i = 0; i < 3; i++) {
    const stream = client.messages.stream({
      model: config.anthropicModel,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages,
    });
    const message = await stream.finalMessage();
    content.push(...message.content);
    if (message.stop_reason === 'refusal') throw new Error('Die KI hat die Suche abgelehnt.');
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }
  return verify(parseAnswer(content), evidenceOf(content));
}
