import {
  flush, getExcluded, getSeen, getToken, logEvent, markSeen, pendingCount, pullExcluded, pullSeen, readItems, setExcluded,
  setToken,
} from './sync.js';
import { claudeUrl } from './claude.js';

const BATCH = 10;
// Pages live at /<category>/, e.g. /ten-second-reader/management/.
const CATEGORY = location.pathname.split('/').filter(Boolean).at(-1) ?? '';
const ITEMS_KEY = `items:${CATEGORY}`;

const $ = (id) => document.getElementById(id);
const list = $('list');

const seen = getSeen();

// Articles opened by tapping stay in the list (dimmed) until dismissed or 「読んだ」.
// Per device, kept 48h like seen.
const OPENED_KEY = 'opened';
const opened = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(OPENED_KEY)) ?? {};
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const [id, t] of Object.entries(o)) if (!(t >= cutoff)) delete o[id];
    return o;
  } catch {
    return {};
  }
})();
function markOpened(id) {
  opened[id] = Date.now();
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify(opened));
  } catch {}
}

let items = [];
let feeds = [];
let updated = null;
let batch = [];

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}分前`;
  return `${Math.round(m / 60)}時間前`;
}
const hhmm = (iso) =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

// The data repo fetches on cron '*/30 * * * *' (UTC, so :00/:30 in JST too).
// GitHub often starts scheduled runs a few minutes late, hence 「頃」.
function nextFetch() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d.toISOString();
}

const excludedSources = () => new Set(getExcluded()[CATEGORY] ?? []);
const unread = () => {
  const excluded = excludedSources();
  return items.filter((i) => !seen[i.id] && !excluded.has(i.source));
};

function card(item) {
  const a = document.createElement('a');
  a.className = 'card';
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener';
  a.dataset.id = item.id;
  if (opened[item.id]) a.classList.add('read');
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${item.source} · ${ago(item.published)}`;
  const exclude = document.createElement('button');
  exclude.type = 'button';
  exclude.className = 'exclude';
  exclude.textContent = '除外';
  exclude.setAttribute('aria-label', `${item.source}を除外`);
  exclude.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`「${item.source}」をこのページから除外しますか？\n設定からいつでも戻せます。`)) return;
    setExcluded(CATEGORY, item.source, true);
    render();
  });
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'ask';
  ask.textContent = 'Claude';
  ask.setAttribute('aria-label', 'この記事についてClaudeと話す');
  ask.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    askClaude(a, item);
  });
  meta.append(exclude, ask);
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
    logEvent({
      type: 'open',
      category: CATEGORY,
      id: item.id,
      source: item.source,
      title: item.title,
      link: item.link,
      published: item.published,
    });
    markOpened(item.id);
    a.classList.add('read');
    updateCount();
  });
  addSwipe(a, item);
  return a;
}

// Open a Claude conversation about the article; counts as reading it.
function askClaude(el, item) {
  window.open(claudeUrl(item), '_blank', 'noopener');
  logEvent({
    type: 'claude',
    category: CATEGORY,
    id: item.id,
    source: item.source,
    title: item.title,
    link: item.link,
    published: item.published,
  });
  markSeen([item.id]);
  el.classList.add('read');
  updateCount();
}

// Swipe left to dismiss a single card, right to ask Claude about it.
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
    el.style.transform = `translateX(${dx}px)`;
    el.classList.toggle('asking', dx > 80);
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (x0 == null) return;
    x0 = null;
    el.style.transform = '';
    el.classList.remove('asking');
    if (dx < -80) dismiss(el, item);
    else if (dx > 80) askClaude(el, item);
  });
}

function dismiss(el, item) {
  markSeen([item.id]);
  el.classList.add('gone');
  el.addEventListener('transitionend', () => {
    el.remove();
    batch = batch.filter((i) => i.id !== item.id);
    if (!list.querySelector('.card:not(.read)')) next();
    else updateCount();
  }, { once: true });
}

function updateCount() {
  const n = unread().filter((i) => !opened[i.id]).length;
  $('count').textContent = n ? `あと${n}件` : '';
  $('updated').textContent = updated ? `${hhmm(updated)} 更新 · 次 ${hhmm(nextFetch())}頃` : '';
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
  markSeen(batch.map((i) => i.id));
  next();
});

function show(data) {
  items = data.items;
  feeds = data.feeds ?? [];
  updated = data.updated;
  render();
}

function message(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  list.replaceChildren(p);
  list.hidden = false;
  $('done').hidden = true;
}

// Articles come from the private data repo, so they need the token.
// The last copy is kept on the device so the screen fills instantly.
async function load() {
  if (!getToken()) {
    message('⚙︎ からGitHubトークンを設定すると記事が表示されます');
    return;
  }
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(ITEMS_KEY));
  } catch {}
  if (cached && !items.length) show(cached);
  try {
    const data = await readItems(`${CATEGORY}/items.json`);
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(data));
    } catch {}
    show(data);
  } catch (e) {
    if (!cached) {
      message(/: (401|403|404)$/.test(e.message)
        ? `読み込めませんでした（${e.message}）。⚙︎ のトークンを確認してください`
        : '読み込めませんでした');
      return;
    }
  }
  // Drop what was read or excluded on another device.
  Promise.all([pullExcluded(), pullSeen()])
    .then(([ex, read]) => (ex || read) && render())
    .catch(() => {});
  flush().catch(() => {});
}

// --- settings: GitHub token and excluded feeds ---

const settings = $('settings');

function renderSettings() {
  $('token').value = getToken();
  const n = pendingCount();
  $('sync-status').textContent = getToken()
    ? n ? `未送信 ${n}件` : '同期済み'
    : `トークン未設定（未送信 ${n}件は端末に保存中）`;
  // Checked = shown. Excluded feeds are listed apart, folded, so the main list is only
  // what is shown. Include excluded names too, in case a feed was renamed or dropped.
  const excluded = excludedSources();
  const names = [...new Set([...feeds, ...items.map((i) => i.source), ...excluded])];
  const row = (source) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !excluded.has(source);
    box.addEventListener('change', () => {
      setExcluded(CATEGORY, source, !box.checked);
      render();
      renderSettings();
    });
    label.append(box, source);
    li.append(label);
    return li;
  };
  const hidden = names.filter((n) => excluded.has(n));
  $('feeds').replaceChildren(...names.filter((n) => !excluded.has(n)).map(row));
  $('excluded-feeds').replaceChildren(...hidden.map(row));
  $('excluded-title').textContent = `除外中のフィード（${hidden.length}）`;
  $('excluded-box').hidden = !hidden.length;
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
    await pullExcluded();
  } catch (e) {
    $('sync-status').textContent = `同期に失敗しました（${e.message}）`;
    return;
  }
  renderSettings();
  load();
});

// Refresh when the app comes back to the foreground (iOS keeps PWAs suspended).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

// Pull down at the top to reload, like Safari (home-screen apps have no reload button).
// A full reload also picks up a new version of the app.
const pull = document.createElement('div');
pull.className = 'pull';
document.body.prepend(pull);
let pullY0 = null;
let pullDy = 0;
document.addEventListener('touchstart', (e) => {
  pullY0 = window.scrollY <= 0 && !settings.open ? e.touches[0].clientY : null;
  pullDy = 0;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (pullY0 == null) return;
  pullDy = Math.max(e.touches[0].clientY - pullY0, 0);
  pull.style.height = `${Math.min(pullDy / 2, 60)}px`;
  pull.textContent = pullDy > 120 ? '↻ 離して更新' : '↓ 引っ張って更新';
}, { passive: true });
document.addEventListener('touchend', () => {
  if (pullY0 == null) return;
  pullY0 = null;
  if (pullDy > 120) {
    pull.textContent = '更新中…';
    location.reload();
  } else {
    pull.style.height = '';
  }
});

// Keep the 「次 HH:MM頃」 label current while the app stays open.
setInterval(updateCount, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', import.meta.url));
load();
