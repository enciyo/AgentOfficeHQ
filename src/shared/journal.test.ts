// A chain's handoffs as a journal: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createT } from './i18n/index.ts';
import { chainJournal, journalMarkdown, journalState, requestCode } from './journal.ts';
import type { Task } from './types.ts';

let n = 0;
const task = (over: Partial<Task>) => ({
  id: String(++n), agentId: 'a', from: 'user', prompt: 'do it', parentId: null, depth: 0, kind: 'task', status: 'done',
  createdAt: n, startedAt: n, endedAt: n, result: '', cost: 0, ...over,
}) as Task;

const ceoToPm = task({ id: 'r', agentId: 'pm', prompt: 'Add a remember me box\n\nmore detail' });
const toDev = task({ id: 'd', agentId: 'dev', from: 'pm', parentId: 'r', depth: 1, createdAt: 10, branch: 'agent/dev', repo: '/w', merge: 'conflict', files: ['src/login.ts', 'docs/login-page/4-development.md'] });
const resolver = task({ id: 'd2', agentId: 'dev', from: 'pm', parentId: 'r', depth: 1, createdAt: 20, resolves: 'd', merge: 'merged', branch: 'agent/dev', repo: '/w' });
const toTest = task({ id: 't', agentId: 'test', from: 'pm', parentId: 'r', depth: 1, createdAt: 30, merge: 'pending', branch: 'agent/test', files: ['docs/login-page/5-test-report.md'] });
const cut = task({ id: 'x', agentId: 'qa', from: 'test', parentId: 't', depth: 2, createdAt: 40, status: 'error', interrupted: true });
const report = task({ id: 'rep', agentId: 'pm', from: 'dev', parentId: 'd2', kind: 'report', createdAt: 25 });
const unrelated = task({ id: 'u', createdAt: 5 });
const all = [unrelated, toTest, cut, ceoToPm, resolver, report, toDev];

test('states: done work is in unless its merge says otherwise; errors say whether a restart cut them off', () => {
  assert.equal(journalState(ceoToPm), 'in');
  assert.equal(journalState(task({ merge: 'unchanged' })), 'in');
  assert.equal(journalState(toDev), 'conflict');
  assert.equal(journalState(toTest), 'pending');
  assert.equal(journalState(task({ merge: 'rejected' })), 'rejected');
  assert.equal(journalState(cut), 'interrupted');
  assert.equal(journalState(task({ status: 'error' })), 'failed');
  assert.equal(journalState(task({ status: 'running' })), 'running');
});

test('a chain reads in the order its handoffs were made, found from any of its tasks', () => {
  const j = chainJournal(all, 'x')!;
  assert.equal(j.rootId, 'r');
  assert.deepEqual(j.entries.map(e => e.taskId), ['r', 'd', 'd2', 'rep', 't', 'x']);
  const d = j.entries[1]!;
  assert.deepEqual([d.from, d.to, d.branch, d.repo, d.merge], ['pm', 'dev', 'agent/dev', '/w', 'conflict']);
  assert.equal(j.entries[0]!.summary, 'Add a remember me box');
  assert.equal(chainJournal(all, 'nope'), null);
});

test('conflicts, pending merges and interrupted runs are flagged, unless a resolver or retry took them over', () => {
  const j = chainJournal(all, 'r')!;
  assert.deepEqual(j.flagged.map(e => e.taskId), ['t', 'x']);
  assert.equal(j.entries.find(e => e.taskId === 'd')!.followedBy, 'd2');
  // A cancelled retry takes nothing over
  const retry = task({ id: 'x2', parentId: 't', retryOf: 'x', status: 'cancelled', createdAt: 50 });
  assert.deepEqual(chainJournal([...all, retry], 'r')!.flagged.map(e => e.taskId), ['t', 'x']);
});

test('the request code is the docs/<code>/ folder most of the chain writes to', () => {
  assert.equal(chainJournal(all, 'r')!.code, 'login-page');
  assert.equal(requestCode(['docs/a/x.md', 'docs/b/y.md', 'docs/b/z.md', 'docs/c.md', 'src/a.ts']), 'b');
  assert.equal(requestCode(['src/a.ts', 'docs/readme.md']), null);
});

test('the Markdown puts what needs attention first and lists every handoff', () => {
  const t = createT('en');
  const names: Record<string, string> = { user: 'CEO', pm: 'Product Manager', dev: 'Tech Lead', test: 'Test Lead', qa: 'Tester' };
  const md = journalMarkdown(chainJournal(all, 'r')!, id => names[id] ?? id, t, new Date(2026, 10, 18, 7, 5).getTime());
  assert.match(md, /^# Task journal · login-page\n/);
  assert.match(md, /Updated 2026-11-18 07:05 · 6 handoffs/);
  assert.ok(md.indexOf('## Needs attention') < md.indexOf('## Handoffs'));
  assert.match(md, /- 🙋 #t · Product Manager → Test Lead: Awaiting merge approval \(`agent\/test`\)/);
  assert.match(md, /### 1\. ✅ #r · CEO → Product Manager\n/);
  assert.match(md, /### 4\. ✅ #rep · Tech Lead → Product Manager · report/);
  assert.match(md, /- Changed files: `src\/login.ts`, `docs\/login-page\/4-development.md`/);
  assert.match(md, /#d2 took this work over/);
  // Nothing flagged: no attention section at all
  const clean = journalMarkdown(chainJournal([ceoToPm], 'r')!, id => names[id] ?? id, t);
  assert.ok(!clean.includes('Needs attention'));
});
