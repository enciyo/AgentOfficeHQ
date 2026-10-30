// Office grid walking: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearOf, findPath, nearestFree, passingPush } from './pathfinding.ts';

const grid = (rows: string[]) => Uint8Array.from(rows.join('').split('').map(c => (c === '#' ? 1 : 0)));

test('a path goes around a wall', () => {
  const g = grid(['...', '##.', '...']);
  const path = findPath(g, 3, 3, 0, 0, 0, 2);
  assert.ok(path && path.length > 0);
  assert.ok(path.every(([x, z]) => !g[z * 3 + x]));
  assert.deepEqual(path.at(-1), [0, 2]);
});

test('a blocked target ends on the nearest free cell', () => {
  const g = grid(['...', '.#.', '...']);
  const [x, z] = findPath(g, 3, 3, 0, 0, 1, 1)!.at(-1)!;
  assert.equal(g[z * 3 + x], 0);
});

test('nearestFree says so when nothing is free', () => {
  assert.equal(nearestFree(grid(['##', '##']), 2, 2, 0, 0), null);
});

test('clearOf wants every other point far enough away', () => {
  assert.equal(clearOf({ x: 0, z: 0 }, [{ x: 1, z: 0 }, { x: 0, z: 2 }], 0.75), true);
  assert.equal(clearOf({ x: 0, z: 0 }, [{ x: 1, z: 0 }, { x: 0.5, z: 0 }], 0.75), false);
});

test('standing people are pushed straight apart, walking ones lean aside so a head-on meeting becomes passing', () => {
  assert.deepEqual(passingPush(1, 0, false), [1, 0]);
  const [x, z] = passingPush(1, 0, true);
  assert.ok(x > 0 && z > 0);
  assert.ok(Math.abs(Math.hypot(x, z) - 1) < 1e-9);
});
