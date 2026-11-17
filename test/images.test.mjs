import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSource, tidySummary, usableImage } from '../public/images.js';

test('usableImage drops title cards, favicons and broken URLs', () => {
  assert.equal(usableImage('https://res.cloudinary.com/zenn/image/upload/s--x--/c_fit,l_text:abc/og.png'), '');
  assert.equal(usableImage('https://qiita-user-contents.imgix.net/https%3A%2F%2Fcdn.qiita.com%2Fassets%2Fpublic%2Fx.png?txt=t'), '');
  assert.equal(usableImage('https://cdn-ak2.favicon.st-hatena.com/64?url=https%3A%2F%2Fa'), '');
  assert.equal(usableImage('https://dhbr.diamond.jphttps//dhbr2.ismcdn.jp/common/images/rss-thumbnail.jpg'), '');
  assert.equal(usableImage('https://dhbr2.ismcdn.jp/mwimgs/7/2/-/img_7.jpg'), 'https://dhbr2.ismcdn.jp/mwimgs/7/2/-/img_7.jpg');
  assert.equal(usableImage(''), '');
});

test('tidySummary stops at a sentence end', () => {
  assert.equal(tidySummary('一文目です。二文目の途中で切れてそ…'), '一文目です。');
  assert.equal(tidySummary('短い要約。'), '短い要約。');
  assert.equal(tidySummary('A first sentence. Then a cut-off wo…'), 'A first sentence.');
  assert.equal(tidySummary('句点がないまま長く続く文章で、途中で切れ…'), '句点がないまま長く続く文章で…');
});

test('splitSource separates the feed topic from the publication', () => {
  assert.deepEqual(splitSource('Zenn トピック: AIエージェント'), { name: 'Zenn', topic: 'AIエージェント' });
  assert.deepEqual(splitSource('Qiita タグ: Claude Code'), { name: 'Qiita', topic: 'Claude Code' });
  assert.deepEqual(splitSource('DHBR'), { name: 'DHBR', topic: '' });
});

test('phrases: wraps between bunsetsu only', async () => {
  const { phrases } = await import('../public/images.js');
  assert.deepEqual(phrases('AIエージェントの「完了しました」を信用しない仕組みを作った'),
    ['AIエージェントの', '「完了しました」を', '信用しない', '仕組みを', '作った']);
  assert.deepEqual(phrases(''), []);
});
