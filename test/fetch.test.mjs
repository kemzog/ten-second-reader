import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, selectItems } from '../scripts/fetch.mjs';

const rss2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
<item><title>見出し &amp; テスト</title><link>https://a.example/1</link>
<description><![CDATA[<p>本文の<b>要約</b>です</p>]]></description>
<pubDate>Tue, 20 Oct 2026 07:00:00 GMT</pubDate><guid>a1</guid></item>
</channel></rss>`;

const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<item rdf:about="https://b.example/1"><title>RDF記事</title><link>https://b.example/1</link>
<description>説明</description><dc:date>2026-10-20T16:00:00+09:00</dc:date></item>
</rdf:RDF>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="html">Atom記事</title><link rel="alternate" href="https://c.example/1"/>
<id>tag:c,1</id><updated>2026-10-20T06:00:00Z</updated><summary>要約</summary></entry>
</feed>`;

test('parses RSS 2.0', () => {
  const [i] = parseFeed(rss2, 'A');
  assert.equal(i.title, '見出し & テスト');
  assert.equal(i.summary, '本文の 要約 です');
  assert.equal(i.link, 'https://a.example/1');
  assert.equal(i.published, '2026-10-20T07:00:00.000Z');
});

test('parses RSS 1.0 (RDF)', () => {
  const [i] = parseFeed(rdf, 'B');
  assert.equal(i.title, 'RDF記事');
  assert.equal(i.published, '2026-10-20T07:00:00.000Z');
});

test('parses Atom', () => {
  const [i] = parseFeed(atom, 'C');
  assert.equal(i.link, 'https://c.example/1');
  assert.equal(i.title, 'Atom記事');
});

test('resolves relative links against the channel link', () => {
  const xml = `<rss version="2.0"><channel><title>H</title><link>https://hbr.org</link>
<item><title>t</title><link>/2026/10/slug</link><pubDate>Tue, 20 Oct 2026 07:00:00 GMT</pubDate></item>
</channel></rss>`;
  assert.equal(parseFeed(xml, 'H', { url: 'http://feeds.hbr.org/x' }).at(0).link, 'https://hbr.org/2026/10/slug');
});

test('uses the configured site, then the feed URL', () => {
  const xml = `<rss version="2.0"><channel><title>H</title>
<item><title>t</title><link>/a</link></item></channel></rss>`;
  assert.equal(parseFeed(xml, 'H', { site: 'https://hbr.org', url: 'http://feeds.hbr.org/x' }).at(0).link, 'https://hbr.org/a');
  assert.equal(parseFeed(rss2, 'A', { url: 'https://other.example' }).at(0).link, 'https://a.example/1');
});

test('selectItems drops old items and caps per source', () => {
  const now = Date.parse('2026-10-20T08:00:00Z');
  const mk = (n, src, hoursAgo) => ({
    id: String(n), title: 't', link: `https://x/${n}`, source: src,
    published: new Date(now - hoursAgo * 3600_000).toISOString(),
  });
  const items = [mk(1, 'A', 1), mk(2, 'A', 2), mk(3, 'A', 3), mk(4, 'B', 30), mk(5, 'B', 0.5)];
  const out = selectItems(items, { maxAgeHours: 24, perFeed: 2, now });
  assert.deepEqual(out.map((i) => i.id), ['5', '1', '2']);
});

test('mergeCandidates adds data repo picks and lets them override by URL', async () => {
  const { mergeCandidates } = await import('../scripts/fetch.mjs');
  const merged = mergeCandidates(
    { management: [{ name: 'A', url: 'a', note: 'base' }], design: [{ name: 'D', url: 'd' }] },
    { management: [{ name: 'A', url: 'a', reason: 'why' }, { name: 'B', url: 'b' }], engineering: [{ name: 'E', url: 'e' }] },
  );
  assert.deepEqual(merged.management, [{ name: 'A', url: 'a', note: 'base', reason: 'why' }, { name: 'B', url: 'b' }]);
  assert.deepEqual(Object.keys(merged), ['management', 'design', 'engineering']);
});
