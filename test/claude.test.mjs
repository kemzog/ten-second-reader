import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudePrompt, claudeUrl } from '../public/claude.js';

const item = { title: 'T & U', source: 'HBR', link: 'https://example.com/a?b=1', summary: 'S' };

test('claudeUrl prefills a prompt with the article', () => {
  const url = new URL(claudeUrl(item));
  assert.equal(url.origin + url.pathname, 'https://claude.ai/new');
  const q = url.searchParams.get('q');
  assert.equal(q, claudePrompt(item));
  assert.match(q, /タイトル: T & U/);
  assert.match(q, /URL: https:\/\/example\.com\/a\?b=1/);
  assert.match(q, /概要: S/);
});

test('claudePrompt leaves out an empty summary', () => {
  assert.doesNotMatch(claudePrompt({ ...item, summary: '' }), /概要/);
});
