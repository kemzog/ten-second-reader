// Pure functions for the curate page: read history events, find tendencies, rank candidate feeds.
// No DOM here so it can be tested with node.

const HALF_LIFE_DAYS = 30;
const STOP = new Set(`the and for with from that this your you are how why what when who into about
over more than not new can will its our their they has have was were but all out just use using
one two get gets make makes ways way via vs it's don't here there them then these those also
after before most best should could would may might`.split(/\s+/));

// Tokens that carry topic: English words, katakana words, kanji compounds (plus their bigrams).
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z][a-z0-9+#]{1,}/g) ?? []) {
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
    if (w === 'ai' || w === 'ux' || w === 'pm') out.add(w);
  }
  for (const w of s.match(/[\u30a1-\u30fa\u30fc]{2,}/g) ?? []) out.add(w);
  for (const w of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (w.length <= 4) out.add(w);
    for (let i = 0; i + 2 <= w.length && w.length > 2; i++) out.add(w.slice(i, i + 2));
  }
  return [...out];
}

export const isJapanese = (text) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(String(text ?? ''));

// Newer reads count more, so the profile follows changing interests.
const recency = (t, now) => 0.5 ** ((now - Date.parse(t)) / (HALF_LIFE_DAYS * 86400_000));

// Summarize open events: counts per category/source, keywords, language mix.
export function analyze(events, now = Date.now()) {
  const opens = events.filter((e) => e.type === 'open' && e.title);
  const byCategory = {};
  const bySource = {};
  const keywords = {};
  const profile = {}; // category -> token -> weight
  const examples = {}; // token -> titles
  // Reads from feeds the reader later excluded don't say what they want more of.
  const excluded = new Set();
  for (const e of events) {
    const key = `${e.category}/${e.source}`;
    if (e.type === 'exclude') excluded.add(key);
    if (e.type === 'include') excluded.delete(key);
  }
  let ja = 0;
  for (const e of opens) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    if (isJapanese(e.title)) ja++;
    if (excluded.has(`${e.category}/${e.source}`)) continue;
    const w = recency(e.t, now);
    const p = (profile[e.category] ??= {});
    for (const tok of tokenize(e.title)) {
      p[tok] = (p[tok] ?? 0) + w;
      keywords[tok] = (keywords[tok] ?? 0) + 1;
      const ex = (examples[tok] ??= []);
      if (ex.length < 3 && !ex.includes(e.title)) ex.push(e.title);
    }
  }
  // Drop bigrams already covered by a longer keyword that occurs as often.
  const top = Object.entries(keywords)
    .filter(([k, n]) => n >= 2 || opens.length < 20)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .filter(([k, n], i, all) => !all.some(([k2, n2], j) => j < i && n2 === n && k2.includes(k)))
    .slice(0, 15);
  return {
    total: opens.length,
    first: opens[0]?.t ?? null,
    last: opens.at(-1)?.t ?? null,
    byCategory,
    bySource,
    keywords: top,
    jaShare: opens.length ? ja / opens.length : 0.5,
    profile,
    examples,
    excludes: events.filter((e) => e.type === 'exclude' || e.type === 'include'),
  };
}

// Score one candidate against the reader's profile for its category (other categories count a little).
export function scoreCandidate(candidate, category, stats) {
  const weights = new Map();
  const add = (text, w) => {
    for (const tok of tokenize(text)) weights.set(tok, Math.max(weights.get(tok) ?? 0, w));
  };
  for (const tag of candidate.tags ?? []) add(tag, 3);
  add(candidate.note, 1);
  for (const s of candidate.samples ?? []) add(s, 1);

  const matched = [];
  let score = 0;
  for (const [tok, w] of weights) {
    let interest = 0;
    for (const [cat, p] of Object.entries(stats.profile)) {
      interest += (p[tok] ?? 0) * (cat === category ? 1 : 0.3);
    }
    if (!interest) continue;
    score += interest * w;
    matched.push([tok, interest * w]);
  }
  score /= Math.sqrt(weights.size || 1);
  // Lean toward the language the reader actually reads.
  const langShare = candidate.lang === 'ja' ? stats.jaShare : 1 - stats.jaShare;
  score *= 0.5 + langShare;
  matched.sort((a, b) => b[1] - a[1]);
  return { score, matched: matched.slice(0, 4).map(([tok]) => tok) };
}

const FRESH_DAYS = 3;

// A pick the daily analysis added in the last few days.
export function isFresh(candidate, now = Date.now()) {
  const t = Date.parse(candidate.addedAt ?? '');
  return now - t < FRESH_DAYS * 86400e3;
}

// Candidates for one category, best first, minus ones already subscribed or dismissed.
// Fresh picks from the daily analysis come first, so each day's new suggestions are seen.
export function rank(candidates, category, stats, { skip = new Set(), now = Date.now() } = {}) {
  return candidates
    .map((c, order) => ({ ...c, order, fresh: isFresh(c, now), ...scoreCandidate(c, category, stats) }))
    .filter((c) => !skip.has(c.url))
    .sort((a, b) => b.fresh - a.fresh || b.score - a.score || a.order - b.order);
}

// Same layout as the hand-written feeds.json: one line per feed, so diffs stay readable.
export function formatFeeds(config) {
  const feed = (f) => `{ ${Object.entries(f).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  const head = Object.entries(config)
    .filter(([k]) => k !== 'categories')
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const cats = Object.entries(config.categories).map(
    ([cat, feeds]) => `    ${JSON.stringify(cat)}: [\n${feeds.map((f) => `      ${feed(f)}`).join(',\n')}\n    ]`,
  );
  return `{\n${head.join('\n')}\n  "categories": {\n${cats.join(',\n')}\n  }\n}\n`;
}
