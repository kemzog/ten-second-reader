// Page-flip reader: one article per page, swipe right to turn the page like a magazine.
// Shares data, token, read state and history with the list pages (app.js); only the UI differs.
import {
  flush, getExcluded, getSeen, getToken, logEvent, markSeen, pendingCount, pullExcluded, pullSeen, readItems,
  setToken,
} from './sync.js';
import { claudeUrl } from './claude.js';
import { splitSource, tidySummary, usableImage, phrases } from './images.js';

const CATEGORY = document.body.dataset.category;
const ITEMS_KEY = `items:${CATEGORY}`;
const GOOD_KEY = 'good';
const COMMIT = 0.28; // fraction of the width past which a released drag turns the page
const FLICK = 0.45; // px/ms; a fast flick turns the page however short
const TURN_MS = 340;

const $ = (id) => document.getElementById(id);
const book = $('book');
const seen = getSeen();

const good = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(GOOD_KEY)) ?? {};
    const cutoff = Date.now() - 30 * 86400 * 1000;
    for (const [id, t] of Object.entries(o)) if (!(t >= cutoff)) delete o[id];
    return o;
  } catch {
    return {};
  }
})();

let items = [];
let updated = null;
let pages = []; // snapshot of unread items, fixed while reading so pages never shift
let idx = 0; // current page; pages.length = the closing page
let busy = false; // a turn animation is running
const turned = new Set(); // read but not yet sent with markSeen

// Top-right stamp: date and time once, e.g. "11.17 16:20" (no separate "N時間前").
const stamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const hhmm = (iso) => new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
// Each source gets its own ink colour, so turning to a new source feels like a new section.
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const event = (type, item) => logEvent({
  type, category: CATEGORY, id: item.id, source: item.source, title: item.title, link: item.link, published: item.published,
});

const HEART = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8.1 3.6 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.9 1.3-1.8 2.9-2.9 4.9-2.9 3.5 0 5.6 3.6 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>';
const BUBBLE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 5.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><circle cx="8.5" cy="11.5" r="1.1"/><circle cx="12" cy="11.5" r="1.1"/><circle cx="15.5" cy="11.5" r="1.1"/></svg>';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function leaf(i) {
  const l = el('article', 'leaf');
  l.dataset.i = i;
  const item = pages[i];
  if (!item) {
    l.classList.add('end');
    l.append(el('p', 'end-mark', '✓'), el('p', 'end-title', '完了'),
      el('p', 'end-sub', pages.length ? `${pages.length}本めくりました。新しい記事はまた後で。` : '新しい記事はまだありません。'));
    const again = el('button', 'again', '新着を確認');
    again.type = 'button';
    again.addEventListener('click', () => location.reload());
    l.append(again, el('div', 'shade'));
    return l;
  }
  const { name, topic } = splitSource(item.source);
  l.style.setProperty('--hue', hue(name));
  const page = el('a', 'page');
  page.href = item.link;
  page.target = '_blank';
  page.rel = 'noopener';
  page.draggable = false; // a native link drag would cancel the page turn on PC
  page.addEventListener('click', (e) => {
    if (dragged) { e.preventDefault(); return; }
    event('open', item);
  });
  // Index-style head, like a magazine's contents list: LABEL + serial number on the left,
  // the date on the right, a rule beneath.
  const head = el('div', 'masthead');
  const label = el('div', 'label');
  label.append(el('span', 'kicker', CATEGORY.toUpperCase()), el('span', 'no-num', String(i + 1).padStart(2, '0')));
  head.append(label, el('time', 'pubdate', stamp(item.published)));
  page.append(head);
  const image = usableImage(item.image);
  if (image) {
    const fig = el('figure', 'photo');
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer'; // some sites refuse hotlinked images with a foreign referrer
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => { fig.remove(); l.classList.add('no-photo'); fit(l); });
    img.src = image;
    fig.append(img);
    page.append(fig);
  } else {
    l.classList.add('no-photo');
  }
  const body = el('div', 'body');
  const byline = el('div', 'byline');
  byline.append(el('span', 'source', name));
  if (topic) byline.append(el('span', 'topic', topic));
  // 『』 only on short Japanese titles that carry no brackets of their own.
  const quoted = /[\u3040-\u30ff\u4e00-\u9fff]/.test(item.title) && item.title.length <= 24 && !/[「」『』]/.test(item.title);
  const head1 = el('h1', 'headline');
  // wrap only between phrases (Safari has no word-break: auto-phrase)
  phrases(quoted ? `『${item.title}』` : item.title).forEach((p, n) => {
    if (n) head1.append(document.createElement('wbr'));
    head1.append(p);
  });
  body.append(byline, head1);
  const dek = tidySummary(item.summary);
  if (dek) body.append(el('span', 'rule'), el('p', 'dek', dek));
  page.append(body);
  const like = el('button', 'good');
  like.type = 'button';
  like.innerHTML = HEART;
  like.setAttribute('aria-label', '読んで良かった');
  like.setAttribute('aria-pressed', String(!!good[item.id]));
  like.addEventListener('click', () => toggleGood(like, item));
  const ask = el('button', 'ask');
  ask.type = 'button';
  ask.innerHTML = BUBBLE;
  ask.setAttribute('aria-label', 'この記事についてClaudeと話す');
  ask.addEventListener('click', () => {
    window.open(claudeUrl(item), '_blank', 'noopener');
    event('claude', item);
  });
  const foot = el('div', 'foot');
  const left = pages.length - i - 1;
  foot.append(el('span', 'date', left ? `残り${left}本` : '最後の1本'), like, ask);
  l.append(page, foot, el('div', 'cross l'), el('div', 'cross r'), el('div', 'shade'));
  return l;
}

function toggleGood(button, item) {
  const on = !good[item.id];
  if (on) good[item.id] = Date.now();
  else delete good[item.id];
  try {
    localStorage.setItem(GOOD_KEY, JSON.stringify(good));
  } catch {}
  button.setAttribute('aria-pressed', String(on));
  event(on ? 'good' : 'ungood', item);
}

// --- the stack: previous leaf (folded away, on top), current, next (underneath) ---

let prevLeaf = null;
let curLeaf = null;
let nextLeaf = null;

function build() {
  prevLeaf = idx > 0 ? leaf(idx - 1) : null;
  curLeaf = leaf(idx);
  nextLeaf = idx < pages.length ? leaf(idx + 1) : null;
  if (prevLeaf) { prevLeaf.classList.add('prev'); setAngle(prevLeaf, 90); }
  if (nextLeaf) nextLeaf.classList.add('next');
  curLeaf.classList.add('cur');
  book.replaceChildren(...[nextLeaf, curLeaf, prevLeaf].filter(Boolean));
  for (const l of [curLeaf, nextLeaf, prevLeaf]) if (l) fit(l);
  $('progress').textContent = idx < pages.length ? `あと${pages.length - idx}本` : '';
  $('prev').disabled = idx === 0;
  $('next').disabled = idx >= pages.length;
}

// Make the whole title and summary fit on the page: first a smaller photo, then no photo,
// then smaller type (down to 75%).
function fit(l) {
  const body = l.querySelector('.body');
  if (!body) return;
  const over = () => body.scrollHeight > body.clientHeight;
  const head = l.querySelector('.headline');
  const wide = () => head.scrollWidth > head.clientWidth;
  l.classList.remove('loose');
  l.style.removeProperty('--fit');
  const fig = l.querySelector('.photo');
  if (over() && fig) fig.classList.add('small');
  if (over() && fig) { fig.hidden = true; l.classList.add('no-photo'); }
  // a page without a photo: the title is set in one of three display sizes, the largest that fits
  if (l.classList.contains('no-photo')) {
    for (const big of [2.4, 1.75, 1.25]) {
      l.style.setProperty('--big', String(big));
      if (!over() && !wide()) break;
    }
  }
  for (let n = 19; (over() || wide()) && n >= 15; n--) l.style.setProperty('--fit', String(n / 20));
  // a phrase still too long for the line: let it break anywhere rather than run off the page
  if (wide()) l.classList.add('loose');
}
// A home-screen app on iPhone can lay out the fixed body a home-indicator short of the screen,
// leaving a band under the page. The app always owns the whole screen, so size it to that.
function fillScreen() {
  if (!navigator.standalone) return;
  const portrait = matchMedia('(orientation: portrait)').matches;
  const h = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  if (innerHeight >= h) return;
  document.body.style.bottom = 'auto';
  document.body.style.height = `${h}px`;
}
fillScreen();
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { fillScreen(); if (pages.length) build(); }, 150);
});

// The leaf hinges on its right edge and lifts toward the reader as the finger pulls its
// left edge to the right. The free edge follows the finger: its distance from the hinge is W·cos(angle).
function setAngle(l, deg) {
  l.style.transform = `rotateY(${deg}deg)`;
  // Light falls off as the page lifts; the page below brightens as it is uncovered.
  l.querySelector('.shade').style.opacity = String(Math.sin((deg * Math.PI) / 180) * 0.55);
}
function setUnder(l, p) {
  if (!l) return;
  l.style.transform = `scale(${0.965 + 0.035 * p})`;
  l.querySelector('.shade').style.opacity = String((1 - p) * 0.45);
}
const angleFor = (p) => (Math.acos(Math.min(Math.max(p, 0), 1)) * 180) / Math.PI;

// p: 0 = flat, 1 = turned away. For forward turns the current leaf lifts; for back the previous leaf returns.
function pose(dir, p) {
  if (dir > 0) {
    setAngle(curLeaf, angleFor(1 - p));
    setUnder(nextLeaf, p);
  } else {
    setAngle(prevLeaf, angleFor(p));
    setUnder(curLeaf, 1 - p);
  }
}

function animate(dir, from, to) {
  busy = true;
  const t0 = performance.now();
  const dur = TURN_MS * Math.max(Math.abs(to - from), 0.35);
  return new Promise((resolve) => {
    const step = (now) => {
      const k = Math.min((now - t0) / dur, 1);
      const e = 1 - (1 - k) ** 3; // ease-out
      pose(dir, from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
      else { busy = false; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

async function turn(dir, from = 0) {
  if (busy || !canTurn(dir)) return;
  await animate(dir, from, 1);
  if (dir > 0) markTurned(pages[idx]);
  idx += dir;
  build();
}

const canTurn = (dir) => (dir > 0 ? idx < pages.length : idx > 0);

// Reads are sent in small batches so flipping fast does not mean one commit per page.
function markTurned(item) {
  if (!item) return;
  turned.add(item.id);
  if (turned.size >= 5 || idx + 1 >= pages.length) sendTurned();
}
function sendTurned() {
  if (!turned.size) return;
  markSeen([...turned]);
  turned.clear();
}

// --- the top bar (progress, update time, settings): hidden until pulled down ---

const bar = document.querySelector('.bar');
let barShown = false;
const barShift = () => bar.offsetHeight;
function reveal(r) {
  r = Math.min(Math.max(r, 0), 1);
  if (drag) drag.r = r;
  bar.style.transform = `translateY(${(r - 1) * 100}%)`;
}
function setBar(on) {
  barShown = on;
  document.body.classList.add('revealing');
  reveal(on ? 1 : 0);
}

// --- touch / mouse drag ---

let drag = null;
let dragged = false;

book.addEventListener('pointerdown', (e) => {
  if (busy || e.button > 0 || e.target.closest('button')) return;
  drag = { x0: e.clientX, y0: e.clientY, dir: 0, p: 0, t: e.timeStamp, x: e.clientX, v: 0 };
  dragged = false;
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.dir && !drag.vert && !drag.locked) {
    const dy = e.clientY - drag.y0;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
    drag.locked = true;
    dragged = true;
    if (Math.abs(dy) > Math.abs(dx)) {
      // Vertical: pull down to reveal the bar, push up to tuck it away.
      drag.vert = true;
      drag.r0 = barShown ? 1 : 0;
      document.body.classList.remove('revealing');
    } else {
      drag.dir = dx > 0 ? 1 : -1; // swipe right = next page
      if (!canTurn(drag.dir)) drag.dir = 0;
    }
  }
  if (drag.vert) {
    reveal(drag.r0 + (e.clientY - drag.y0) / (barShift() * 1.6));
    return;
  }
  const dt = e.timeStamp - drag.t;
  if (dt > 0) drag.v = 0.8 * ((e.clientX - drag.x) / dt) + 0.2 * drag.v;
  drag.t = e.timeStamp;
  drag.x = e.clientX;
  const W = book.clientWidth;
  if (!drag.dir) {
    // Nothing to turn to: resist a little so it does not feel dead.
    curLeaf.style.transform = `translateX(${dx / 6}px)`;
    return;
  }
  drag.p = Math.min(Math.max((drag.dir > 0 ? dx : -dx) / W, 0), 1);
  if (!drag.raf) {
    drag.raf = requestAnimationFrame(() => {
      if (drag) { drag.raf = 0; pose(drag.dir, drag.p); }
    });
  }
});
function release() {
  if (!drag) return;
  if (drag.vert) {
    const r = drag.r ?? drag.r0;
    drag = null;
    setBar(r > (barShown ? 0.7 : 0.3));
    setTimeout(() => (dragged = false));
    return;
  }
  const { dir, p, v } = drag;
  cancelAnimationFrame(drag.raf);
  drag = null;
  if (!dir) { curLeaf.style.transform = ''; setTimeout(() => (dragged = false)); return; }
  const flick = p > 0.05 && (dir > 0 ? v > FLICK : v < -FLICK);
  if (p > COMMIT || flick) turn(dir, p);
  else animate(dir, p, 0);
  setTimeout(() => (dragged = false));
}
window.addEventListener('pointerup', release);
book.addEventListener('dragstart', (e) => e.preventDefault());
window.addEventListener('pointercancel', release);

// --- keyboard, wheel and buttons for PC ---

$('prev').addEventListener('click', () => turn(-1));
$('next').addEventListener('click', () => turn(1));
document.addEventListener('keydown', (e) => {
  if ($('settings').open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'j'].includes(e.key)) { e.preventDefault(); turn(1); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); turn(-1); }
  else if (e.key === 'Enter') curLeaf.querySelector('.page')?.click();
  else if (e.key === 'l') curLeaf.querySelector('.good')?.click();
});
let wheelAt = 0;
book.addEventListener('wheel', (e) => {
  // Vertical wheel down = next; a horizontal trackpad swipe follows the touch direction (right = next).
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY;
  if (Math.abs(d) < 20 || e.timeStamp - wheelAt < 450) return;
  wheelAt = e.timeStamp;
  turn(d > 0 ? 1 : -1);
}, { passive: true });

// --- data ---

function unread() {
  const excluded = new Set(getExcluded()[CATEGORY] ?? []);
  return items.filter((i) => !seen[i.id] && !excluded.has(i.source));
}

// Rebuild only when not in the middle of reading, so new data never moves the page under the finger.
function show(data, force) {
  items = data.items;
  updated = data.updated;
  $('updated').textContent = updated ? `${hhmm(updated)} 更新` : '';
  if (!force && idx > 0 && idx < pages.length) return;
  pages = unread();
  idx = 0;
  build();
}

function message(text) {
  book.replaceChildren(el('p', 'empty', text));
  $('progress').textContent = '';
}

async function load(force) {
  if (!getToken()) {
    message('⚙︎ からGitHubトークンを設定すると記事が表示されます');
    return;
  }
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(ITEMS_KEY));
  } catch {}
  if (cached && !pages.length && !items.length) show(cached, true);
  try {
    const data = await readItems(`${CATEGORY}/items.json`);
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(data));
    } catch {}
    show(data, force);
  } catch (e) {
    if (!cached) {
      message(/: (401|403|404)$/.test(e.message)
        ? `読み込めませんでした（${e.message}）。⚙︎ のトークンを確認してください`
        : '読み込めませんでした');
      return;
    }
  }
  Promise.all([pullExcluded(), pullSeen()])
    .then(([ex, read]) => (ex || read) && show({ items, updated }))
    .catch(() => {});
  flush().catch(() => {});
}

// --- settings ---

const settings = $('settings');
function renderSettings() {
  $('token').value = getToken();
  const n = pendingCount();
  $('sync-status').textContent = getToken() ? (n ? `未送信 ${n}件` : '同期済み') : 'トークン未設定';
}
$('open-settings').addEventListener('click', () => {
  renderSettings();
  settings.showModal();
});
$('save-token').addEventListener('click', async () => {
  setToken($('token').value);
  $('sync-status').textContent = '同期中…';
  try {
    await flush();
  } catch (e) {
    $('sync-status').textContent = `同期に失敗しました（${e.message}）`;
    return;
  }
  renderSettings();
  load(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sendTurned();
  else load();
});
window.addEventListener('pagehide', sendTurned);

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', import.meta.url));
load();
