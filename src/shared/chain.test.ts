// How much a delegation chain has used: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainBlock, chainRootId, chainUsage } from './chain.ts';
import type { Limits, Task } from './types.ts';

let n = 0;
const task = (over: Partial<Task>) => ({ id: `t${++n}`, parentId: null, status: 'done', startedAt: 1, cost: 0, ...over }) as Task;
const limits = (over: Partial<Limits>) => ({ chainMaxTurns: 0, chainBudgetUsd: 0, ...over }) as Limits;

// A report goes back down the depth but stays under the same root, which is what lets a loop be counted at all
const root = task({ id: 'root', cost: 1 });
const sub = task({ id: 'sub', parentId: 'root', depth: 1, cost: 2 } as Partial<Task>);
const report = task({ id: 'report', parentId: 'sub', depth: 0, kind: 'report', cost: null } as Partial<Task>);
const waiting = task({ id: 'waiting', parentId: 'report', status: 'queued', startedAt: null });
const other = task({ id: 'other', cost: 100 });
const all = [waiting, report, other, sub, root];

test('the root of a chain is found from any step, and a missing parent makes a root', () => {
  assert.equal(chainRootId(all, waiting), 'root');
  assert.equal(chainRootId(all, root), 'root');
  assert.equal(chainRootId(all, task({ id: 'x', parentId: 'gone' })), 'x');
});

test('usage counts every turn that started under the root and what it is known to have cost', () => {
  assert.deepEqual(chainUsage(all, waiting), { rootId: 'root', turns: 3, cost: 3 });
});

test('a task put back in the queue does not count against itself until it runs again', () => {
  const back = task({ id: 'back', status: 'queued', startedAt: null, ranMs: 5000 });
  assert.equal(chainUsage([back], back).turns, 0);
});

test('a chain is blocked at its turn cap or its budget, and 0 turns either off', () => {
  assert.equal(chainBlock(limits({}), all, waiting), null);
  assert.equal(chainBlock(limits({ chainMaxTurns: 4, chainBudgetUsd: 3.5 }), all, waiting), null);
  assert.deepEqual(chainBlock(limits({ chainMaxTurns: 3 }), all, waiting), { kind: 'chainTurns', spent: 3, cap: 3, rootId: 'root' });
  assert.deepEqual(chainBlock(limits({ chainBudgetUsd: 3 }), all, waiting), { kind: 'chainBudget', spent: 3, cap: 3, rootId: 'root' });
});
