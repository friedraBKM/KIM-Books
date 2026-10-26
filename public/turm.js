// Easter Egg auf der 404-Seite: „Bücherturm“. Ein Buch gleitet über dem Stapel hin und her,
// ein Tipp lässt es fallen. Was über den Stapel hinausragt, fällt herunter.
import { store } from './common.js';

const canvas = document.getElementById('turm');
const ctx = canvas.getContext('2d');
const W = 420;
const H = 520;
const BOOK = 30;          // Höhe eines Buchs
const GROUND = H - 40;    // Oberkante des Regalbretts

// Auf /spiel ist es kein Fehler, sondern eine Einladung
if (location.pathname.replace(/\/$/, '') === '/spiel') {
  document.getElementById('turm-kicker').textContent = 'Lesepause';
  document.getElementById('turm-titel').textContent = 'Lust auf eine kleine Pause?';
  document.getElementById('turm-unter').textContent = 'Stapel so viele Bücher, wie du kannst.';
  document.title = 'Must-Read-Regal – Bücherturm';
}

let titles = [
  'Die 1%-Methode', 'Deep Work', 'Schnelles Denken, langsames Denken', 'Die 7 Wege zur Effektivität',
  'Frag immer erst: warum', 'Selbstbild', 'Leben 3.0', 'Das Café am Rande der Welt', 'Der Alchimist',
  'Sorge dich nicht – lebe!', 'Die Kunst des klaren Denkens', 'Momo', 'Der kleine Prinz', 'Sapiens',
];
// Wenn möglich, Titel aus dem echten Regal nehmen
fetch('/api/shelf').then((r) => (r.ok ? r.json() : null)).then((d) => {
  const real = (d?.books || []).map((b) => b.title).filter(Boolean);
  if (real.length >= 3) titles = real;
}).catch(() => {});

function css(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function dark() {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function palette() {
  return {
    bg: css('--flaeche-leise', '#f6f2eb'),
    board: css('--text-headline', '#4c2147'),
    text: css('--text-neben', 'rgba(0,0,0,0.6)'),
    books: [css('--aubergine', '#4c2147'), css('--tuerkis', '#1eab9e'), css('--bis', '#00414c'), css('--sand', '#ddd3bc'), css('--maigruen', '#ccd500')],
    onBook: ['#ffffff', '#000000', '#ffffff', '#4c2147', '#000000'],
    // Hinweisband: hell Aubergine mit weißer Schrift, dunkel Türkis mit schwarzer Schrift
    msgBg: dark() ? css('--tuerkis', '#1eab9e') : css('--aubergine', '#4c2147'),
    msgFg: dark() ? '#000000' : '#ffffff',
  };
}
let colors = palette();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { colors = palette(); });

// Hochauflösend zeichnen
const dpr = Math.min(window.devicePixelRatio || 1, 3);
canvas.width = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

let stack, current, debris, camera, score, perfectRun, message, over, started, speed, colorIndex;
let best = Number(store.get('kim_turm_rekord')) || 0;
document.getElementById('rekord').textContent = best;

function nextTitle() {
  return titles[Math.floor(Math.random() * titles.length)];
}

function reset() {
  colorIndex = 0;
  stack = [{ x: W / 2 - 90, w: 180, color: 0, title: nextTitle() }];
  debris = [];
  camera = 0;
  score = 0;
  perfectRun = 0;
  speed = 2.2;
  over = false;
  started = false;
  message = { text: 'Tippen zum Starten', until: Infinity };
  spawn();
  document.getElementById('punkte').textContent = '0';
}

function spawn() {
  const top = stack[stack.length - 1];
  colorIndex = (colorIndex + 1) % 5;
  const fromLeft = stack.length % 2 === 0;
  current = { x: fromLeft ? -top.w : W, w: top.w, dir: fromLeft ? 1 : -1, color: colorIndex, title: nextTitle() };
}

function say(text, ms = 1400) {
  message = { text, until: performance.now() + ms };
}

function drop() {
  if (over) { reset(); return; }
  if (!started) { started = true; message = null; return; }
  const top = stack[stack.length - 1];
  const left = Math.max(current.x, top.x);
  const right = Math.min(current.x + current.w, top.x + top.w);
  const overlap = right - left;
  const level = stack.length;

  if (overlap <= 0) {
    debris.push({ ...current, y: GROUND - (level + 1) * BOOK, vy: 0, rot: 0, vr: current.dir * 0.04 });
    gameOver();
    return;
  }

  if (Math.abs(current.x - top.x) < 5) {
    // Perfekt gelandet: kein Verschnitt, nach drei Treffern wächst das Buch wieder
    perfectRun++;
    let w = top.w;
    if (perfectRun % 3 === 0) w = Math.min(220, w + 16);
    stack.push({ x: top.x - (w - top.w) / 2, w, color: current.color, title: current.title });
    say(perfectRun % 3 === 0 ? 'Perfekt! Buch wird breiter' : 'Perfekt!', 900);
  } else {
    perfectRun = 0;
    stack.push({ x: left, w: overlap, color: current.color, title: current.title });
    const cutX = current.x < top.x ? current.x : right;
    debris.push({ x: cutX, w: current.w - overlap, color: current.color, title: '', y: GROUND - (level + 1) * BOOK, vy: 0, rot: 0, vr: (current.x < top.x ? -1 : 1) * 0.05 });
  }

  score = stack.length - 1;
  document.getElementById('punkte').textContent = String(score);
  if (score === 10) say('Lesestoff für ein Jahr!', 1800);
  if (score === 25) say('Du bist jetzt offiziell ein Regal.', 2200);
  if (score === 42) say('42 – die Antwort auf alles.', 2600);
  speed = Math.min(6, 2.2 + score * 0.12);
  spawn();
}

function gameOver() {
  over = true;
  if (score > best) {
    best = score;
    store.set('kim_turm_rekord', String(best));
    document.getElementById('rekord').textContent = best;
    message = { text: `Neuer Rekord: ${score}! Tippen für Neustart`, until: Infinity };
  } else {
    message = { text: `Turm eingestürzt bei ${score}. Tippen für Neustart`, until: Infinity };
  }
}

function drawBook(b, y, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colors.books[b.color];
  ctx.fillRect(b.x, y, b.w, BOOK - 2);
  // Kapitalband links und rechts
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(b.x, y, 4, BOOK - 2);
  ctx.fillRect(b.x + b.w - 4, y, 4, BOOK - 2);
  if (b.title && b.w > 50) {
    ctx.fillStyle = colors.onBook[b.color];
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let t = b.title;
    if (ctx.measureText(t).width > b.w - 16) {
      while (t.length > 1 && ctx.measureText(`${t}…`).width > b.w - 16) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    ctx.fillText(t, b.x + b.w / 2, y + (BOOK - 2) / 2 + 1);
  }
  ctx.globalAlpha = 1;
}

function frame(now) {
  // Bewegung
  if (started && !over) {
    current.x += current.dir * speed;
    if (current.x + current.w > W + 40) current.dir = -1;
    if (current.x < -40) current.dir = 1;
  }
  const targetCam = Math.max(0, (stack.length - 9) * BOOK);
  camera += (targetCam - camera) * 0.1;
  for (const d of debris) { d.vy += 0.5; d.y += d.vy; d.rot += d.vr; }
  debris = debris.filter((d) => d.y - camera < H + 100);

  // Zeichnen
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(0, camera);
  ctx.fillStyle = colors.board;
  ctx.fillRect(20, GROUND, W - 40, 8);
  stack.forEach((b, i) => drawBook(b, GROUND - (i + 1) * BOOK));
  if (!over) drawBook(current, GROUND - (stack.length + 1) * BOOK - 6);
  for (const d of debris) {
    ctx.save();
    ctx.translate(d.x + d.w / 2, d.y + BOOK / 2);
    ctx.rotate(d.rot);
    drawBook({ ...d, x: -d.w / 2 }, -BOOK / 2, 0.9);
    ctx.restore();
  }
  ctx.restore();

  if (message && (message.until === Infinity || now < message.until)) {
    ctx.font = '700 17px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(message.text).width + 32;
    ctx.fillStyle = colors.msgBg;
    ctx.fillRect(W / 2 - w / 2, 28, w, 40);
    ctx.fillStyle = colors.msgFg;
    ctx.fillText(message.text, W / 2, 49);
  }
  requestAnimationFrame(frame);
}

canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); drop(); });
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.key === 'Enter') {
    if (e.target.closest?.('a, button')) return;
    e.preventDefault();
    drop();
  }
});

reset();
requestAnimationFrame(frame);
