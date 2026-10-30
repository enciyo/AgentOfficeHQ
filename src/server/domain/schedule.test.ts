// Recurring task timing: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, firstRun, usesClockTime } from './schedule.ts';

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('interval schedules count from now', () => {
  const now = at(2026, 11, 2, 10, 7);
  assert.equal(firstRun({ intervalMinutes: 30 }, now), now + 30 * 60_000);
  assert.equal(usesClockTime({ intervalMinutes: 60, at: '09:00' }), false, 'a time only applies to daily/weekly');
});

test('daily and weekly schedules start at the next wall-clock time', () => {
  assert.equal(firstRun({ intervalMinutes: 1440, at: '09:30' }, at(2026, 11, 2, 8)), at(2026, 11, 2, 9, 30));
  assert.equal(firstRun({ intervalMinutes: 1440, at: '09:30' }, at(2026, 11, 2, 9, 30)), at(2026, 11, 3, 9, 30));
  assert.equal(firstRun({ intervalMinutes: 10080, at: '18:00' }, at(2026, 11, 2, 20)), at(2026, 11, 3, 18));
});

test('advance keeps the rhythm and skips runs missed while offline', () => {
  const due = at(2026, 11, 2, 9);
  assert.equal(advance(due, 60, due + 1000), at(2026, 11, 2, 10));
  assert.equal(advance(due, 60, at(2026, 11, 2, 13, 15)), at(2026, 11, 2, 14));
  assert.equal(advance(due, 60, at(2026, 11, 2, 14)), at(2026, 11, 2, 15), 'never returns a time that is not in the future');
});
