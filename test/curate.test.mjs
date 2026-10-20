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
  const text = readFileSync(new URL('../feeds.json', import.meta.url), 'utf8');
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
