// Gemeinsame Hilfsfunktionen für alle Seiten.

// Erzeugt ein DOM-Element. Texte werden immer als Text gesetzt, nie als HTML.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function coverImg(url, small = false) {
  const cls = small ? 'cover klein' : 'cover';
  if (!url) return el('div', { class: cls, 'aria-hidden': 'true' });
  return el('img', { class: cls, src: `/api/cover?u=${encodeURIComponent(url)}`, alt: '', loading: 'lazy' });
}

export async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* leere Antwort */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Browserspeicher kann gesperrt sein (privates Fenster) – dann ohne weiter.
export const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignorieren */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignorieren */ }
  },
};

export function voterToken() {
  let token = store.get('kim_voter');
  if (!token) {
    token = crypto.randomUUID();
    store.set('kim_voter', token);
  }
  return token;
}

// Zeigt bei Bedarf die Abfrage des Zugangscodes und wartet, bis er stimmt.
export async function ensureAccess(gate, content) {
  const cfg = await api('/api/config');
  if (!cfg.codeRequired || cfg.hasAccess) {
    gate.hidden = true;
    content.hidden = false;
    return cfg;
  }
  gate.hidden = false;
  content.hidden = true;
  const form = gate.querySelector('form');
  const input = gate.querySelector('input');
  const msg = gate.querySelector('[data-msg]');
  input.focus();
  await new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      msg.textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: { code: input.value } });
        resolve();
      } catch (err) {
        msg.textContent = err.message;
      }
    });
  });
  gate.hidden = true;
  content.hidden = false;
  return { ...cfg, hasAccess: true };
}
