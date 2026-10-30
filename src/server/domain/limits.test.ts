// Spend caps and concurrency rules: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderHold, Task } from '../../shared/types.ts';
import { DEFAULT_LIMITS, MAX_REQUEUES, blockReason, holdUntil, minutesSince, spentSince, startOfDay } from './limits.ts';

const now = new Date(2026, 10, 2, 15).getTime();
const done = (agentId: string, cost: number, endedAt = now - 1000) => ({ agentId, cost, endedAt }) as Task;

test('spend counts tasks finished today only', () => {
  const tasks = [done('a', 1), done('b', 2), done('a', 5, startOfDay(now) - 1)];
  assert.equal(spentSince(tasks, startOfDay(now)), 3);
  assert.equal(spentSince(tasks, startOfDay(now), 'a'), 1);
});

test('spend counts what running and put-back tasks have reported so far, and an unknown cost as nothing', () => {
  const tasks = [{ agentId: 'a', cost: 1, endedAt: null }, { agentId: 'a', cost: null, endedAt: now - 1 }, done('a', 2)] as Task[];
  assert.equal(spentSince(tasks, startOfDay(now)), 3);
  assert.deepEqual(blockReason({ ...DEFAULT_LIMITS, dailyBudgetUsd: 1 }, tasks.slice(0, 1), 'b', 0, now), { kind: 'budget', spent: 1, cap: 1 });
});

const MIN = 60_000;
const ran = (startedAt: number | null, endedAt: number | null, over: Partial<Task> = {}) => ({ startedAt, endedAt, ...over }) as Task;

test('minutes add up run time today: finished, running, past midnight and earlier attempts', () => {
  const today = startOfDay(now);
  assert.equal(minutesSince([ran(now - 10 * MIN, now - 5 * MIN)], today, now), 5);
  assert.equal(minutesSince([ran(now - 3 * MIN, null)], today, now), 3, 'a running task counts up to now');
  assert.equal(minutesSince([ran(today - 10 * MIN, today + 2 * MIN)], today, now), 2, 'only the part after midnight');
  assert.equal(minutesSince([ran(today - 10 * MIN, today - 5 * MIN)], today, now), 0, 'yesterday');
  assert.equal(minutesSince([ran(null, null)], today, now), 0, 'still queued');
  assert.equal(minutesSince([ran(null, null, { ranMs: 4 * MIN }), ran(now - MIN, null, { ranMs: 2 * MIN })], today, now), 7, 'attempts a CLI limit cut off');
});

test('the daily minutes cap does not care about dollars; 0 means off', () => {
  const tasks = [ran(now - 30 * MIN, now - MIN, { agentId: 'a', cost: null })];
  assert.equal(blockReason(DEFAULT_LIMITS, tasks, 'a', 0, now), null);
  assert.equal(blockReason({ ...DEFAULT_LIMITS, dailyRunMinutes: 30 }, tasks, 'b', 0, now), null);
  assert.deepEqual(blockReason({ ...DEFAULT_LIMITS, dailyRunMinutes: 29, maxConcurrent: 1 }, tasks, 'b', 5, now), { kind: 'minutes', spent: 29, cap: 29 });
});

test('budget caps come before the concurrency limit; 0 means off', () => {
  const tasks = [done('a', 2)];
  assert.equal(blockReason(DEFAULT_LIMITS, tasks, 'a', 99, now), null);
  assert.deepEqual(blockReason({ ...DEFAULT_LIMITS, dailyBudgetUsd: 2, maxConcurrent: 1 }, tasks, 'b', 5, now), { kind: 'budget', spent: 2, cap: 2 });
  assert.equal(blockReason({ ...DEFAULT_LIMITS, agentDailyBudgetUsd: 2 }, tasks, 'b', 0, now), null);
  assert.equal(blockReason({ ...DEFAULT_LIMITS, agentDailyBudgetUsd: 2 }, tasks, 'a', 0, now)?.kind, 'agentBudget');
  assert.deepEqual(blockReason({ ...DEFAULT_LIMITS, maxConcurrent: 2 }, tasks, 'a', 2, now), { kind: 'concurrency', max: 2 });
});

test('a held provider blocks until its time, after the budgets and before the concurrency limit', () => {
  const hold: ProviderHold = { kind: 'limit', since: now - 1, until: now + 1000, message: 'x' };
  assert.deepEqual(blockReason({ ...DEFAULT_LIMITS, maxConcurrent: 1 }, [], 'a', 5, now, hold), { kind: 'providerLimit', until: now + 1000 });
  assert.equal(blockReason(DEFAULT_LIMITS, [], 'a', 0, now + 1000, hold), null, 'over once the time comes');
  assert.equal(blockReason({ ...DEFAULT_LIMITS, dailyBudgetUsd: 1 }, [done('a', 2)], 'a', 0, now, hold)?.kind, 'budget');
});

test('a failed login blocks until someone resumes the provider', () => {
  const hold: ProviderHold = { kind: 'auth', since: now, until: null, message: 'Unauthorized' };
  assert.deepEqual(blockReason(DEFAULT_LIMITS, [], 'a', 0, now + 9e9, hold), { kind: 'providerAuth' });
});

test('a limit lasts until its reset plus a margin; without one the wait doubles and still spans a long limit', () => {
  assert.equal(holdUntil(now + 5000, 3, now), now + 5000 + 60_000);
  assert.equal(holdUntil(null, 0, now), now + 15 * 60_000);
  assert.equal(holdUntil(null, 2, now), now + 60 * 60_000);
  const waited = Array.from({ length: MAX_REQUEUES }, (_, i) => holdUntil(null, i, 0)).reduce((a, b) => a + b, 0);
  assert.ok(waited >= 5 * 3_600_000);
});

test('a paused office blocks before anything else, and a task of a chain at its limit waits', () => {
  const tasks = [{ id: 'r', agentId: 'a', parentId: null, cost: 5, startedAt: now, endedAt: now - 1 }, { id: 'q', agentId: 'a', parentId: 'r', cost: 0, startedAt: null, endedAt: null }] as Task[];
  const limits = { ...DEFAULT_LIMITS, dailyBudgetUsd: 1, chainMaxTurns: 1, chainBudgetUsd: 0 };
  assert.deepEqual(blockReason(limits, tasks, 'a', 0, now, undefined, { paused: true }), { kind: 'paused' });
  const free = { ...limits, dailyBudgetUsd: 0 };
  assert.deepEqual(blockReason(free, tasks, 'a', 0, now, undefined, { task: tasks[1] }), { kind: 'chainTurns', spent: 1, cap: 1, rootId: 'r' });
  assert.equal(blockReason(free, tasks, 'a', 0, now), null, 'no task, no chain to look at');
});

test('chains are bounded out of the box', () => {
  assert.ok(DEFAULT_LIMITS.chainMaxTurns > 0);
  assert.ok(DEFAULT_LIMITS.chainBudgetUsd > 0);
});
