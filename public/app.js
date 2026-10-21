import {
  flush, getExcluded, getSeen, getToken, logEvent, markSeen, pendingCount, pullExcluded, pullSeen, readItems, setExcluded,
  setToken,
} from './sync.js';

const BATCH = 10;
// Pages live at /<category>/, e.g. /ten-second-reader/management/.
const CATEGORY = location.pathname.split('/').filter(Boolean).at(-1) ?? '';
const ITEMS_KEY = `items:${CATEGORY}`;

const $ = (id) => document.getElementById(id);
const list = $('list');

const seen = getSeen();

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
  meta.append(exclude);
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
    markSeen([item.id]);
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
  // Checked = shown. Include excluded names too, in case a feed was renamed or dropped.
  const excluded = excludedSources();
  const names = [...new Set([...feeds, ...items.map((i) => i.source), ...excluded])];
  $('feeds').replaceChildren(
    ...names.map((source) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !excluded.has(source);
      box.addEventListener('change', () => {
        setExcluded(CATEGORY, source, !box.checked);
        render();
      });
      label.append(box, source);
      li.append(label);
      return li;
    }),
  );
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', import.meta.url));
load();
