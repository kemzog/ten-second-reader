// Fetch every feed in feeds.json and write a small items.json per category for the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// Each category is served from its own page: public/<category>/items.json.
async function fetchCategory(category, feeds, config) {
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
  const dir = new URL(`../public/${category}/`, import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('items.json', dir), JSON.stringify(out));
  console.log(`wrote ${category}: ${items.length} items`);
}

async function main() {
  const config = JSON.parse(await readFile(new URL('../feeds.json', import.meta.url), 'utf8'));
  for (const [category, feeds] of Object.entries(config.categories)) {
    await fetchCategory(category, feeds, config);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
