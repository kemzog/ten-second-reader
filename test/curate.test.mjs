import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, formatFeeds, rank, tokenize } from '../public/curate/score.js';
import { summarizeCandidate } from '../scripts/fetch.mjs';

const now = Date.parse('2026-10-20T12:00:00Z');
const open = (category, source, title, t = '2026-10-20T10:00:00Z') => ({ t, type: 'open', category, source, title });

test('tokenize keeps English words, katakana and kanji compounds', () => {
  const t = tokenize('バランス・スコアカードによる戦略的マネジメント and Agentic AI');
  for (const w of ['バランス', 'スコアカード', 'マネジメント', '戦略', 'agentic', 'ai']) assert.ok(t.includes(w), w);
  assert.ok(!t.includes('and'));
});

test('analyze counts categories, sources and language', () => {
  const s = analyze([
    open('management', 'DHBR', '戦略的マネジメントの構築'),
    open('management', 'DHBR', 'マネジメントと組織'),
    open('engineering', 'HN', 'DeepSeek banned'),
    { t: '2026-10-20T11:00:00Z', type: 'exclude', category: 'engineering', source: 'ITmedia' },
  ], now);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byCategory, { management: 2, engineering: 1 });
  assert.equal(s.bySource.DHBR, 2);
  assert.ok(Math.abs(s.jaShare - 2 / 3) < 1e-9);
  assert.equal(s.keywords[0][0], 'マネジメント');
  assert.equal(s.excludes.length, 1);
});

test('rank puts candidates that match reading history first and skips dismissed ones', () => {
  const s = analyze([open('management', 'DHBR', '戦略的マネジメントの構築'), open('management', 'DHBR', '組織の戦略')], now);
  const cands = [
    { name: 'Startup', url: 'a', lang: 'en', tags: ['startup'], note: '' },
    { name: 'Strategy', url: 'b', lang: 'ja', tags: ['戦略', '組織'], note: '' },
    { name: 'Gone', url: 'c', lang: 'ja', tags: ['戦略'], note: '' },
  ];
  const r = rank(cands, 'management', s, { skip: new Set(['c']) });
  assert.deepEqual(r.map((c) => c.name), ['Strategy', 'Startup']);
  assert.ok(r[0].matched.includes('戦略'));
});

test('rank keeps list order without history', () => {
  const r = rank([{ name: 'A', url: 'a', tags: [] }, { name: 'B', url: 'b', tags: [] }], 'design', analyze([], now));
  assert.deepEqual(r.map((c) => c.name), ['A', 'B']);
});

test('formatFeeds reproduces feeds.json layout', () => {
  const text = `{
  "maxAgeHours": 24,
  "perFeed": 5,
  "categories": {
    "management": [
      { "name": "DHBR", "url": "https://dhbr.diamond.jp/list/feed/rss" },
      { "name": "HBR", "url": "http://feeds.hbr.org/harvardbusiness", "site": "https://hbr.org" }
    ],
    "design": [
      { "name": "NN/g", "url": "https://www.nngroup.com/feed/rss/" }
    ]
  }
}
`;
  assert.equal(formatFeeds(JSON.parse(text)), text);
});

test('summarizeCandidate keeps the newest titles', () => {
  const c = summarizeCandidate({ name: 'X' }, [
    { title: 'old', published: '2026-01-01T00:00:00Z' },
    { title: 'new', published: '2026-10-01T00:00:00Z' },
  ]);
  assert.equal(c.count, 2);
  assert.equal(c.latest, '2026-10-01T00:00:00Z');
  assert.deepEqual(c.samples, ['new', 'old']);
});

test('candidates.json entries have name, url, lang and tags', () => {
  const all = JSON.parse(readFileSync(new URL('../candidates.json', import.meta.url), 'utf8'));
  for (const list of Object.values(all)) {
    for (const c of list) {
      assert.ok(c.name && c.url && ['ja', 'en'].includes(c.lang) && c.tags.length, c.name);
    }
  }
});

test('rank puts fresh picks from the daily analysis first', () => {
  const s = analyze([open('management', 'DHBR', '戦略的マネジメントの構築')], now);
  const list = rank([
    { name: 'Match', url: 'a', lang: 'ja', tags: ['マネジメント', '戦略'] },
    { name: 'Pick', url: 'b', lang: 'en', tags: ['design'], addedAt: '2026-10-19T21:00:00Z' },
    { name: 'Old pick', url: 'c', lang: 'en', tags: ['design'], addedAt: '2026-10-01T21:00:00Z' },
  ], 'management', s, { now });
  assert.deepEqual(list.map((c) => c.name), ['Pick', 'Match', 'Old pick']);
  assert.equal(list[0].fresh, true);
});

test('Good articles weigh more in the profile, and ungood takes one back', () => {
  const good = (id, title, type = 'good') => ({ t: '2026-10-20T10:30:00Z', type, category: 'management', source: 'DHBR', id, title });
  const ev = [
    { ...open('management', 'DHBR', '戦略の立て方'), id: 'a' },
    { ...open('management', 'DHBR', '組織の作り方'), id: 'b' },
    good('a', '戦略の立て方'),
  ];
  const s = analyze(ev, now);
  assert.equal(s.good, 1);
  assert.deepEqual(s.goodBySource, { DHBR: 1 });
  assert.deepEqual(s.goodTitles, ['戦略の立て方']);
  const p = s.profile.management;
  assert.ok(Math.abs(p['戦略'] / p['組織'] - 3) < 0.01, `${p['戦略']} vs ${p['組織']}`);
  const cands = [
    { name: 'Org', url: 'o', lang: 'ja', tags: ['組織'], note: '' },
    { name: 'Strategy', url: 's', lang: 'ja', tags: ['戦略'], note: '' },
  ];
  assert.deepEqual(rank(cands, 'management', s).map((c) => c.name), ['Strategy', 'Org']);

  const undone = analyze([...ev, good('a', '戦略の立て方', 'ungood')], now);
  assert.equal(undone.good, 0);
  assert.ok(Math.abs(undone.profile.management['戦略'] - undone.profile.management['組織']) < 0.01);
});
