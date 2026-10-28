import { fromBase64, getToken, logEvent, readItems, setToken, toBase64 } from '../sync.js';
import { analyze, formatFeeds, rank } from './score.js';

// Reads history and candidates from the private data repo, and adds feeds by committing its feeds.json.
const OWNER = 'kemzog';
const DATA_REPO = 'ten-second-reader-data';
const LABELS = { management: 'マネジメント', engineering: 'エンジニアリング', design: 'デザイン' };
const SKIP_KEY = 'curate-skip';
const SHOWN = 5;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const label = (cat) => LABELS[cat] ?? cat;
const ymd = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

let stats;
let candidates = {};
let insights; // the daily analysis's write-up, if any
let feeds; // current feeds.json from GitHub
let tab;
let showAll = false;
const skip = new Set(JSON.parse(localStorage.getItem(SKIP_KEY) ?? '[]'));

async function api(repo, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/contents/${path}`, {
    cache: 'no-store',
    ...init,
    headers: { authorization: `Bearer ${getToken()}`, accept: 'application/vnd.github+json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${repo}/${path}: ${res.status}`);
  return res;
}

async function loadHistory() {
  const files = await (await api(DATA_REPO, 'history')).json();
  const texts = await Promise.all(
    files
      .filter((f) => f.name.endsWith('.jsonl'))
      .map((f) => api(DATA_REPO, f.path, { headers: { accept: 'application/vnd.github.raw' } }).then((r) => r.text())),
  );
  return texts
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.t.localeCompare(b.t));
}

async function loadFeeds() {
  const json = await (await api(DATA_REPO, 'feeds.json')).json();
  return { config: JSON.parse(fromBase64(json.content)), sha: json.sha };
}

// --- tendencies ---

function bars(counts, max = 8) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, max);
  const top = rows[0]?.[1] ?? 1;
  const ul = el('ul', 'bars');
  for (const [name, n] of rows) {
    const li = el('li');
    const bar = el('span', 'bar');
    bar.style.width = `${(n / top) * 100}%`;
    li.append(el('span', 'bar-label', name), el('span', 'bar-track'), el('span', 'bar-n', String(n)));
    li.children[1].append(bar);
    ul.append(li);
  }
  return ul;
}

// The daily analysis's write-up: a summary and a few themes, newest day only.
function insightParts() {
  if (!insights?.summary) return [];
  const parts = [el('h2', null, `Claudeの分析（${ymd(insights.date)}）`), el('p', 'insight', insights.summary)];
  if (insights.themes?.length) {
    const ul = el('ul', 'themes');
    for (const t of insights.themes) ul.append(el('li', null, t));
    parts.push(ul);
  }
  return parts;
}

function renderTrend() {
  const box = $('trend');
  if (!stats.total) {
    box.replaceChildren(el('p', 'hint', 'まだ開いた記事の履歴がありません。リーダーで記事を開くとここに傾向が出ます。'));
    return;
  }
  const ja = Math.round(stats.jaShare * 100);
  const summary = el('p', 'trend-summary',
    `${ymd(stats.first)}〜${ymd(stats.last)} に ${stats.total}件 を開いた${stats.good ? `（Good ${stats.good}件）` : ''}。日本語 ${ja}% / 英語 ${100 - ja}%`);
  const cats = Object.fromEntries(Object.entries(stats.byCategory).map(([k, v]) => [label(k), v]));
  const kw = el('div', 'chips');
  for (const [k] of stats.keywords) kw.append(el('span', 'chip', k));
  const ins = insightParts();
  if (ins.length) ins.push(el('h2', null, '数字で見る'));
  const parts = [...ins, summary, el('h2', null, 'カテゴリ'), bars(cats), el('h2', null, 'よく開くサイト'), bars(stats.bySource)];
  if (stats.good) {
    // Good weighs more than an open in the keywords and in the ranking below.
    const recent = el('ul', 'themes');
    for (const t of stats.goodTitles) recent.append(el('li', null, t));
    parts.push(el('h2', null, 'Goodしたサイト'), bars(stats.goodBySource), el('h2', null, '最近のGood'), recent);
  }
  if (stats.keywords.length) parts.push(el('h2', null, 'よく出る言葉'), kw);
  const excluded = new Map();
  for (const e of stats.excludes) {
    if (e.type === 'exclude') excluded.set(`${e.category}/${e.source}`, e);
    else excluded.delete(`${e.category}/${e.source}`);
  }
  if (excluded.size) {
    parts.push(el('h2', null, '除外したサイト'),
      el('p', 'hint', [...excluded.values()].map((e) => `${e.source}（${label(e.category)}）`).join('、')));
  }
  box.replaceChildren(...parts);
}

// --- recommendations ---

function subscribed(category) {
  const list = feeds?.config.categories[category] ?? [];
  return new Set(list.flatMap((f) => [f.url, f.name]));
}

function renderTabs() {
  const cats = Object.keys(candidates);
  $('tabs').replaceChildren(
    ...cats.map((cat) => {
      const b = el('button', cat === tab ? 'tab on' : 'tab', label(cat));
      b.type = 'button';
      b.addEventListener('click', () => {
        tab = cat;
        showAll = false;
        renderTabs();
        renderRecs();
      });
      return b;
    }),
  );
}

function reason(c) {
  if (!c.matched.length) return null;
  const ex = stats.examples[c.matched[0]]?.[0];
  return `${c.matched.join('・')} に関心がありそう${ex ? `（「${ex}」など）` : ''}`;
}

function recCard(c) {
  const card = el('div', 'card rec');
  const meta = el('div', 'meta');
  meta.append(el('span', null, c.lang === 'ja' ? '日本語' : '英語'));
  if (c.latest) meta.append(el('span', null, `最終更新 ${ymd(c.latest)}`));
  if (c.fresh) meta.append(el('span', 'fresh', `新着 ${ymd(c.addedAt)}`));
  card.append(meta, el('div', 'title', c.name), el('div', 'note', c.note));
  // Picks from the daily analysis carry their own reasoning; hand-picked ones fall back to keyword overlap.
  const why = c.reason ?? reason(c);
  if (why) card.append(el('div', 'why', why));
  if (c.misfit) card.append(el('div', 'misfit', `合わないかも：${c.misfit}`));
  const samples = el('ul', 'samples');
  for (const s of (c.samples ?? []).slice(0, 3)) samples.append(el('li', null, s));
  card.append(samples);
  const actions = el('div', 'actions');
  const add = el('button', 'primary', '追加');
  const no = el('button', null, '興味なし');
  add.type = no.type = 'button';
  add.addEventListener('click', () => addFeed(c, add));
  no.addEventListener('click', () => {
    skip.add(c.url);
    try {
      localStorage.setItem(SKIP_KEY, JSON.stringify([...skip]));
    } catch {}
    logEvent({ type: 'dismiss-candidate', category: tab, source: c.name, url: c.url });
    renderRecs();
  });
  actions.append(add, no);
  card.append(actions);
  return card;
}

function renderRecs() {
  const box = $('recs');
  const have = subscribed(tab);
  const list = rank(candidates[tab] ?? [], tab, stats, { skip })
    .filter((c) => !have.has(c.url) && !have.has(c.name));
  if (!list.length) {
    box.replaceChildren(el('p', 'hint', '今出せる候補はありません。新しい候補は毎日の分析で追加されます。'));
    return;
  }
  const shown = showAll ? list : list.slice(0, SHOWN);
  const parts = shown.map(recCard);
  if (list.length > shown.length) {
    const more = el('button', 'more', `ほかの候補（${list.length - shown.length}件）`);
    more.type = 'button';
    more.addEventListener('click', () => {
      showAll = true;
      renderRecs();
    });
    parts.push(more);
  }
  box.replaceChildren(...parts);
}

async function addFeed(c, button) {
  if (!confirm(`「${c.name}」を${label(tab)}に追加しますか？\n数分後にリーダーに表示されます。`)) return;
  button.disabled = true;
  button.textContent = '追加中…';
  const category = tab;
  try {
    // Re-read right before writing so a concurrent change isn't overwritten.
    feeds = await loadFeeds();
    const list = (feeds.config.categories[category] ??= []);
    if (!list.some((f) => f.url === c.url)) {
      list.push(c.site ? { name: c.name, url: c.url, site: c.site } : { name: c.name, url: c.url });
      await api(DATA_REPO, 'feeds.json', {
        method: 'PUT',
        body: JSON.stringify({
          message: `feeds: ${label(category)}に${c.name}を追加（フィード探しから）`,
          content: toBase64(formatFeeds(feeds.config)),
          sha: feeds.sha,
          branch: 'main',
        }),
      });
      feeds = await loadFeeds();
    }
    logEvent({ type: 'add', category, source: c.name, url: c.url });
    $('status').textContent = `${c.name} を追加しました`;
    renderRecs();
  } catch (e) {
    button.disabled = false;
    button.textContent = '追加';
    const perm = /: (403|404)$/.test(e.message);
    alert(perm
      ? `追加できませんでした（${e.message}）。トークンに ten-second-reader-data の Contents: Read and write 権限があるか確認してください。`
      : `追加できませんでした（${e.message}）`);
  }
}

// --- startup ---

async function load() {
  if (!getToken()) {
    $('trend').replaceChildren(el('p', 'hint', '⚙︎ からGitHubトークンを設定してください。'));
    $('settings').showModal();
    return;
  }
  $('status').textContent = '読み込み中…';
  try {
    const [events, feedState, cands, ins] = await Promise.all([
      loadHistory(),
      loadFeeds(),
      readItems('curate/candidates.json').catch(() => ({ categories: {} })),
      readItems('curate/insights.json').catch(() => null),
    ]);
    stats = analyze(events);
    feeds = feedState;
    candidates = cands.categories;
    insights = ins;
    for (const e of events) if (e.type === 'dismiss-candidate') skip.add(e.url);
  } catch (e) {
    $('status').textContent = '';
    $('trend').replaceChildren(el('p', 'hint', `読み込めませんでした（${e.message}）。⚙︎ のトークンを確認してください。`));
    return;
  }
  $('status').textContent = '';
  const cats = Object.keys(candidates);
  tab = cats.sort((a, b) => (stats.byCategory[b] ?? 0) - (stats.byCategory[a] ?? 0))[0];
  renderTrend();
  renderTabs();
  renderRecs();
}

$('open-settings').addEventListener('click', () => {
  $('token').value = getToken();
  $('settings').showModal();
});
$('save-token').addEventListener('click', () => {
  setToken($('token').value);
  $('settings').close();
  load();
});

load();
