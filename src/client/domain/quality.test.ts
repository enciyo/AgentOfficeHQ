// Graphics settings: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUALITY, QUALITY_LEVELS, readGraphics } from './quality.ts';

test('each step costs at least as much as the one before', () => {
  for (let i = 1; i <= MAX_QUALITY; i++) {
    const [low, high] = [QUALITY_LEVELS[i - 1]!, QUALITY_LEVELS[i]!];
    assert.ok(high.pixelRatio >= low.pixelRatio && high.shadows >= low.shadows && high.occlusion >= low.occlusion && high.rainDrops >= low.rainDrops);
  }
});

test('saved settings are read, and anything broken falls back to the default', () => {
  assert.deepEqual(readGraphics('{"level":0,"auto":false}', false), { level: 0, auto: false });
  assert.deepEqual(readGraphics(null, false), { level: 2, auto: true });
  assert.deepEqual(readGraphics(null, true), { level: 1, auto: true });
  assert.deepEqual(readGraphics('{"level":9}', false), { level: 2, auto: true });
  assert.deepEqual(readGraphics('not json', false), { level: 2, auto: true });
});
