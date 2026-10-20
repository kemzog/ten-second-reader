const BATCH = 10;
const SEEN_KEY = 'seen';
const SEEN_TTL = 48 * 3600_000;

const $ = (id) => document.getElementById(id);
const list = $('list');

function loadSeen() {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY)) ?? {};
    const cutoff = Date.now() - SEEN_TTL;
    for (const [id, t] of Object.entries(seen)) if (t < cutoff) delete seen[id];
    return seen;
  } catch {
    return {};
  }
}
const seen = loadSeen();
function markRead(ids) {
  const now = Date.now();
  for (const id of ids) seen[id] = now;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {}
}

let items = [];
let updated = null;
let batch = [];

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}分前`;
  return `${Math.round(m / 60)}時間前`;
}
const hhmm = (iso) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

const unread = () => items.filter((i) => !seen[i.id]);

function card(item) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener';
  a.dataset.id = item.id;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${item.source} · ${ago(item.published)}`;
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title;
  a.append(meta, title);
  if (item.summary) {
    const s = document.createElement('div');
    s.className = 'summary';
    s.textContent = item.summary;
    a.append(s);
  }
  a.addEventListener('click', () => {
    markRead([item.id]);
    a.classList.add('read');
    updateCount();
  });
  addSwipe(a, item);
  return a;
}

// Swipe left to dismiss a single card.
function addSwipe(el, item) {
  let x0 = null;
  let y0 = null;
  let dx = 0;
  el.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    dx = 0;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (x0 == null) return;
    dx = e.touches[0].clientX - x0;
    if (Math.abs(e.touches[0].clientY - y0) > Math.abs(dx)) { x0 = null; return; }
    if (dx < 0) el.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (x0 == null) return;
    x0 = null;
    el.style.transform = '';
    if (dx < -80) dismiss(el, item);
  });
}

function dismiss(el, item) {
  markRead([item.id]);
  el.classList.add('gone');
  el.addEventListener('transitionend', () => {
    el.remove();
    batch = batch.filter((i) => i.id !== item.id);
    if (!list.querySelector('.card:not(.read)')) next();
    else updateCount();
  }, { once: true });
}

function updateCount() {
  const n = unread().length;
  $('count').textContent = n ? `あと${n}件` : '';
  $('updated').textContent = updated ? `${hhmm(updated)} 更新` : '';
}

function render() {
  batch = unread().slice(0, BATCH);
  list.replaceChildren(...batch.map(card));
  const done = batch.length === 0;
  $('done').hidden = !done;
  list.hidden = done;
  $('finish').parentElement.hidden = done;
  if (done) {
    $('done-sub').textContent = items.length
      ? '新しい記事が届くまで、また後で。'
      : '記事がまだありません。';
    window.scrollTo(0, 0);
  }
  updateCount();
}

function next() {
  render();
  window.scrollTo(0, 0);
}

$('finish').addEventListener('click', () => {
  markRead(batch.map((i) => i.id));
  next();
});

async function load() {
  try {
    const res = await fetch('items.json', { cache: 'no-cache' });
    const data = await res.json();
    items = data.items;
    updated = data.updated;
  } catch {
    list.innerHTML = '<p class="empty">読み込めませんでした</p>';
    return;
  }
  render();
}

// Refresh when the app comes back to the foreground (iOS keeps PWAs suspended).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
load();
