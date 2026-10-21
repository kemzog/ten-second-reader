// Fetch every feed in feeds.json and write a small items.json per category for the app.
// Usage: node scripts/fetch.mjs <feeds.json> <outDir>
// The private data repo runs this and publishes outDir to its `items` branch, which the app reads with the user's token.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const SUMMARY_LEN = 90;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  removeNSPrefix: true,
  processEntities: true,
  htmlEntities: true,
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => {
  if (x == null) return '';
  if (typeof x === 'object') return text(x['#text'] ?? '');
  return String(x);
};

export function cleanText(s) {
  return text(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function atomLink(links) {
  const all = arr(links);
  const alt = all.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? all[0];
  return alt ? alt['@href'] ?? text(alt) : '';
}

// Some feeds (e.g. HBR) give links like "/2026/10/slug"; resolve them against the site.
function absolute(link, base) {
  try {
    return new URL(link, base).href;
  } catch {
    return link;
  }
}

// Normalize RSS 2.0, RSS 1.0 (RDF) and Atom into one item shape.
// Relative links resolve against feed.site if set, else the channel link, else feed.url.
export function parseFeed(xml, source, feed = {}) {
  const doc = parser.parse(xml);
  let raw = [];
  let site = '';
  if (doc.rss) {
    site = text(doc.rss.channel?.link);
    raw = arr(doc.rss.channel?.item).map((i) => ({
      title: i.title,
      link: text(i.link),
      summary: i.description ?? i.encoded,
      date: i.pubDate ?? i.date,
      guid: text(i.guid),
    }));
  } else if (doc.RDF) {
    site = text(doc.RDF.channel?.link);
    raw = arr(doc.RDF.item).map((i) => ({
      title: i.title,
      link: text(i.link),
      summary: i.description,
      date: i.date,
      guid: i['@about'],
    }));
  } else if (doc.feed) {
    site = atomLink(doc.feed.link);
    raw = arr(doc.feed.entry).map((e) => ({
      title: e.title,
      link: atomLink(e.link),
      summary: e.summary ?? e.content,
      date: e.published ?? e.updated,
      guid: text(e.id),
    }));
  }
  const base = feed.site || absolute(site.trim(), feed.url) || feed.url;
  return raw
    .map((r) => {
      const title = cleanText(r.title);
      const link = absolute(r.link.trim(), base);
      let summary = cleanText(r.summary);
      if (summary === title) summary = '';
      if (summary.length > SUMMARY_LEN) summary = summary.slice(0, SUMMARY_LEN) + '…';
      const t = Date.parse(text(r.date));
      return {
        id: createHash('sha1').update(r.guid || link || title).digest('hex').slice(0, 12),
        title,
        summary,
        link,
        source,
        published: Number.isNaN(t) ? null : new Date(t).toISOString(),
      };
    })
    .filter((i) => i.title && i.link);
}

// Keep only fresh items, cap each source so one feed can't flood the screen.
export function selectItems(items, { maxAgeHours, perFeed, now = Date.now() }) {
  const cutoff = now - maxAgeHours * 3600_000;
  const perSource = new Map();
  const seen = new Set();
  return items
    .filter((i) => i.published && Date.parse(i.published) >= cutoff)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .filter((i) => {
      if (seen.has(i.link)) return false;
      seen.add(i.link);
      const n = perSource.get(i.source) ?? 0;
      if (n >= perFeed) return false;
      perSource.set(i.source, n + 1);
      return true;
    });
}

async function fetchFeed(feed) {
  const { name, url } = feed;
  const res = await fetch(url, {
    headers: { 'user-agent': 'ten-second-reader (+https://github.com/kemzog/ten-second-reader)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), name, feed);
}

// Each category gets its own file: <outDir>/<category>/items.json.
async function fetchCategory(category, feeds, config, outDir) {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const all = [];
  results.forEach((r, i) => {
    const { name } = feeds[i];
    if (r.status === 'fulfilled') {
      console.log(`ok   ${category}/${name}: ${r.value.length}`);
      all.push(...r.value);
    } else {
      console.warn(`fail ${category}/${name}: ${r.reason.message}`);
    }
  });
  const items = selectItems(all, config);
  const out = { updated: new Date().toISOString(), feeds: feeds.map((f) => f.name), items };
  const dir = join(outDir, category);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'items.json'), JSON.stringify(out));
  console.log(`wrote ${category}: ${items.length} items`);
}

// Summarize a candidate feed for the curate page: recent titles show what it covers.
export function summarizeCandidate(candidate, items) {
  const dated = items
    .filter((i) => i.published)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const recent = dated.length ? dated : items;
  return {
    ...candidate,
    count: items.length,
    latest: dated[0]?.published ?? null,
    samples: recent.slice(0, 5).map((i) => i.title),
  };
}

// Hand-picked candidates live in this repo's candidates.json; the daily analysis adds its picks
// to candidates.json next to feeds.json in the data repo. The same URL in both keeps the data repo's fields.
export function mergeCandidates(base, extra = {}) {
  const out = {};
  for (const cat of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    const byUrl = new Map();
    for (const c of [...(base[cat] ?? []), ...(extra[cat] ?? [])]) byUrl.set(c.url, { ...byUrl.get(c.url), ...c });
    out[cat] = [...byUrl.values()];
  }
  return out;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Ones already in feeds.json or that fail to fetch are left out.
async function fetchCandidates(config, dataDir, outDir) {
  const candidates = mergeCandidates(
    JSON.parse(await readFile(new URL('../candidates.json', import.meta.url), 'utf8')),
    await readJson(join(dataDir, 'candidates.json'), {}),
  );
  const current = new Set(Object.values(config.categories).flat().map((f) => f.url));
  const out = { updated: new Date().toISOString(), categories: {} };
  for (const [category, list] of Object.entries(candidates)) {
    const todo = list.filter((c) => !current.has(c.url));
    const results = await Promise.allSettled(todo.map(fetchFeed));
    out.categories[category] = [];
    results.forEach((r, i) => {
      const c = todo[i];
      if (r.status === 'fulfilled' && r.value.length) {
        console.log(`ok   candidate ${category}/${c.name}: ${r.value.length}`);
        out.categories[category].push(summarizeCandidate(c, r.value));
      } else {
        console.warn(`fail candidate ${category}/${c.name}: ${r.reason?.message ?? 'no items'}`);
      }
    });
  }
  const dir = join(outDir, 'curate');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'candidates.json'), JSON.stringify(out));
  // The daily analysis's write-up of reading tendencies, shown at the top of the curate page.
  const insights = await readJson(join(dataDir, 'insights.json'), null);
  if (insights) await writeFile(join(dir, 'insights.json'), JSON.stringify(insights));
}

async function main(feedsPath = 'feeds.json', outDir = 'out') {
  const config = JSON.parse(await readFile(feedsPath, 'utf8'));
  for (const [category, feeds] of Object.entries(config.categories)) {
    await fetchCategory(category, feeds, config, outDir);
  }
  await fetchCandidates(config, dirname(feedsPath), outDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2], process.argv[3]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
