import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSeen } from '../public/sync.js';

test('mergeSeen keeps reads from both devices and drops old ones', () => {
  const now = Date.now();
  const old = now - 49 * 3600_000;
  const merged = mergeSeen({ a: now - 1000, b: old }, { a: now, c: now - 5000 });
  assert.deepEqual(merged, { a: now, c: now - 5000 });
});
