// Badges and the leaderboard: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicAgent, Task } from '../../shared/types.ts';
import { badgesOf, leaderboard } from './badges.ts';

let n = 0;
const at = (h: number) => new Date(2026, 0, 5, h, 0, 0).getTime();
const task = (over: Partial<Task>): Task => ({
  id: `t${++n}`, agentId: 'a', prompt: '', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'done',
  createdAt: at(10), startedAt: at(10), endedAt: at(11), result: '', cost: 0.01, ...over,
});
const agent = (id: string): PublicAgent => ({
  id, name: id, kind: 'agent', provider: 'claude', role: '', color: '#000', prompt: '', model: '', cwd: '', permissionMode: '',
  allowedTools: '', team: '', sessionId: null, totalCost: 0, hiredAt: 0, status: 'idle', activity: '', currentTaskId: null, queued: 0,
});

test('badges come from finished work; reports are not work', () => {
  assert.deepEqual(badgesOf([]), []);
  assert.deepEqual(badgesOf([task({ kind: 'report' })]), []);
  const five = Array.from({ length: 5 }, () => task({}));
  assert.deepEqual(badgesOf(five), ['first', 'flawless', 'frugal']);
  assert.ok(!badgesOf([...five, task({ status: 'error' })]).includes('flawless'));
  assert.ok(badgesOf([task({ commit: 'abc' })]).includes('merge'));
  assert.ok(badgesOf([task({ pr: 'https://x' })]).includes('pr'));
  assert.ok(badgesOf([task({ endedAt: at(2) })]).includes('nightOwl'));
  assert.ok(badgesOf([task({ startedAt: at(10), endedAt: at(10) + 30_000 })]).includes('speedy'));
  assert.ok(badgesOf([task({ reactions: ['👍', '🎉'] }), task({ reactions: ['🔥'] })]).includes('loved'));
});

test('the leaderboard ranks by done work, failures and badges', () => {
  const tasks = [
    task({ agentId: 'a' }), task({ agentId: 'a' }),
    task({ agentId: 'b' }), task({ agentId: 'b', status: 'error' }),
  ];
  const rows = leaderboard([agent('b'), agent('a'), agent('c')], tasks);
  assert.deepEqual(rows.map(r => r.agent.id), ['a', 'b', 'c']);
  assert.equal(rows[1]!.rate, 0.5);
  assert.equal(rows[2]!.done, 0);
});
