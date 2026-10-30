// What an agent needs from the CEO, derived from the raw state: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createT } from '../../shared/i18n/index.ts';
import type { Approval, ProviderHold, PublicAgent, Settings, Task } from '../../shared/types.ts';
import { attentionOf, type AttentionInput } from './attention.ts';

const t = createT('en');
const NOW = 1_000_000;
let n = 0;
const task = (over: Partial<Task>): Task => ({
  id: `t${++n}`, agentId: 'a', prompt: '', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'done',
  createdAt: n, startedAt: n, endedAt: n + 10, result: '', cost: 0, ...over,
});
const agent = (over: Partial<PublicAgent> = {}): PublicAgent => ({
  id: 'a', name: 'A', kind: 'agent', provider: 'claude', role: '', color: '#000', prompt: '', model: '', cwd: '', permissionMode: '',
  allowedTools: '', team: '', sessionId: null, totalCost: 0, hiredAt: 0, status: 'idle', activity: '', currentTaskId: null, queued: 0, ...over,
});
const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'p1', agentId: 'a', taskId: null, action: 'git push', details: '', status: 'pending', note: '', createdAt: 1, decidedAt: null, ...over,
});
const limit: ProviderHold = { kind: 'limit', since: 0, until: NOW + 60_000, message: '' };
const login: ProviderHold = { kind: 'auth', since: 0, until: null, message: '' };

const signOf = (a: PublicAgent, over: Partial<AttentionInput> = {}) => attentionOf([a], {
  tasks: [], approvals: [], settings: { language: 'en', defaultProvider: 'claude' } as Settings, providers: [], providerHolds: {}, acknowledged: {}, ...over,
}, t, NOW)[a.id];

test('an agent with nothing wrong has no sign', () => {
  assert.equal(signOf(agent(), { tasks: [task({})] }), undefined);
  assert.equal(signOf(agent({ status: 'working', activity: 'Reading', queued: 2 })), undefined);
});

test('a pending approval names the action and opens the approvals tab, even while working', () => {
  const sign = signOf(agent({ status: 'working' }), { approvals: [approval()] })!;
  assert.equal(sign.kind, 'approval');
  assert.ok(sign.text.includes('git push'));
  assert.equal(sign.target, 'approvals');
  assert.equal(signOf(agent(), { approvals: [approval({ status: 'approved' })] }), undefined);
});

test('a merge waiting for review is an approval too', () => {
  assert.equal(signOf(agent({ queued: 1, activity: t('blocked.mergeReview') }), { approvals: [approval({ kind: 'merge' })] })!.kind, 'approval');
});

test('a failed task stays until it is retried, followed by success, or dismissed', () => {
  const failed = task({ status: 'error', result: 'CLI crashed\nstack', endedAt: 100 });
  const sign = signOf(agent(), { tasks: [failed] })!;
  assert.equal(sign.kind, 'error');
  assert.equal(sign.taskId, failed.id);
  assert.equal(sign.target, 'tasks');
  assert.ok(sign.text.includes('CLI crashed') && !sign.text.includes('stack'));

  const retry = task({ status: 'queued', retryOf: failed.id, endedAt: null });
  assert.equal(signOf(agent(), { tasks: [failed, retry] }), undefined, 'a retry is under way');
  assert.equal(signOf(agent(), { tasks: [failed, task({ endedAt: 200 })] }), undefined, 'later work went well');
  assert.equal(signOf(agent(), { tasks: [failed], acknowledged: { a: 100 } }), undefined, 'dismissed');
});

test('a dismissed error does not hide a newer one', () => {
  const older = task({ status: 'error', endedAt: 100 }), newer = task({ status: 'error', endedAt: 200 });
  assert.equal(signOf(agent(), { tasks: [older, newer], acknowledged: { a: 100 } })!.taskId, newer.id);
});

test('neither a cancelled retry nor a finished report clears a failure', () => {
  const failed = task({ status: 'error', endedAt: 100 });
  const cancelled = task({ status: 'cancelled', retryOf: failed.id, endedAt: 200 });
  const report = task({ kind: 'report', endedAt: 300 });
  assert.equal(signOf(agent(), { tasks: [failed, cancelled, report] })!.kind, 'error');
});

test('an error without a message still says something', () => {
  assert.equal(signOf(agent(), { tasks: [task({ status: 'error' })] })!.text, t('flash.error'));
});

test('a merge conflict stays until a resolver is open', () => {
  const conflict = task({ merge: 'conflict', endedAt: 100 });
  assert.equal(signOf(agent(), { tasks: [conflict] })!.kind, 'conflict');
  assert.equal(signOf(agent(), { tasks: [conflict, task({ status: 'running', resolves: conflict.id, endedAt: null })] }), undefined);
});

test('blocked shows the reason the server gave, only while work is really waiting', () => {
  const reason = t('blocked.budget', { spent: '5.00', cap: '5.00' });
  const sign = signOf(agent({ queued: 1, activity: reason }))!;
  assert.equal(sign.kind, 'blocked');
  assert.equal(sign.text, reason);
  assert.equal(sign.target, 'tasks');
  assert.equal(signOf(agent({ queued: 0, activity: reason })), undefined);
  assert.equal(signOf(agent({ queued: 1, activity: '' })), undefined, 'about to start');
});

test('a chain at its limit reads as blocked with that reason', () => {
  const reason = t('blocked.chainTurns', { spent: 100, cap: 100 });
  assert.equal(signOf(agent({ queued: 2, activity: reason }))!.text, reason);
});

test('a paused office marks agents with queued work, not everyone', () => {
  const settings = { language: 'en', defaultProvider: 'claude', paused: true } as Settings;
  const sign = signOf(agent({ queued: 1, activity: t('blocked.paused') }), { settings })!;
  assert.equal(sign.kind, 'paused');
  assert.equal(sign.text, t('blocked.paused'));
  assert.equal(signOf(agent(), { settings }), undefined);
  assert.equal(signOf(agent({ status: 'working', queued: 1 }), { settings }), undefined, 'a running task finishes');
});

test('a held CLI opens the settings, where it can be resumed', () => {
  const providers = [{ id: 'claude', label: 'Claude Code' }] as AttentionInput['providers'];
  const sign = signOf(agent({ queued: 1 }), { providers, providerHolds: { claude: limit } })!;
  assert.equal(sign.kind, 'limited');
  assert.equal(sign.target, 'settings');
  assert.ok(sign.text.includes('Claude Code'));
  assert.equal(signOf(agent({ queued: 1 }), { providers, providerHolds: { claude: login } })!.text, t('blocked.providerAuth', { label: 'Claude Code' }));
});

test('a hold follows the office default CLI, and an expired one is over', () => {
  const holds = { codex: limit };
  const settings = { language: 'en', defaultProvider: 'codex' } as Settings;
  assert.equal(signOf(agent({ provider: '', queued: 1 }), { settings, providerHolds: holds })!.kind, 'limited');
  assert.equal(signOf(agent({ provider: 'claude', queued: 1 }), { settings, providerHolds: holds }), undefined);
  assert.equal(signOf(agent({ provider: '', queued: 1 }), { settings, providerHolds: { codex: { ...limit, until: NOW - 1 } } }), undefined);
});

test('humans are not blocked: their queue is theirs to work through', () => {
  assert.equal(signOf(agent({ kind: 'human', status: 'waiting', queued: 1, activity: 'x' }), { settings: { language: 'en', paused: true } as Settings }), undefined);
});

test('waiting on a report says what for, and calmly', () => {
  const held = task({ id: 'r', awaiting: true });
  const open = task({ agentId: 'b', parentId: 'r', status: 'running', endedAt: null });
  const sign = signOf(agent(), { tasks: [held, open] })!;
  assert.equal(sign.kind, 'report');
  assert.equal(sign.tone, 'info');
  assert.ok(sign.text.includes('1'));
  assert.equal(signOf(agent({ status: 'working' }), { tasks: [held, open] }), undefined, 'busy with something else');
});

test('a stuck report is an alarm, even next to other work', () => {
  const sign = signOf(agent({ status: 'working' }), { tasks: [task({ awaiting: true })] })!;
  assert.equal(sign.text, t('task.stuck'));
  assert.equal(sign.tone, 'alert');
});

test('a stuck report is not hidden by a calm one on the same agent', () => {
  const waiting = task({ id: 'w', awaiting: true });
  const open = task({ agentId: 'b', parentId: 'w', status: 'running', endedAt: null });
  const stuck = task({ id: 's', awaiting: true });
  const sign = signOf(agent(), { tasks: [waiting, open, stuck] })!;
  assert.equal(sign.tone, 'alert');
  assert.equal(sign.text, t('task.stuck'));
});

test('a CLI\'s hold does not take the place of the reason the server gave', () => {
  const held = agent({ queued: 1, activity: 'Daily budget reached', blockedBy: 'budget' });
  const sign = signOf(held, { providerHolds: { claude: limit } })!;
  assert.equal(sign.kind, 'blocked');
  assert.equal(sign.text, 'Daily budget reached');
  const chain = signOf(agent({ queued: 1, activity: 'Chain at its limit', blockedBy: 'chainBudget' }), { providerHolds: { claude: login } })!;
  assert.equal(chain.kind, 'blocked');
  assert.equal(signOf(agent({ queued: 1, activity: 'held', blockedBy: 'providerLimit' }), { providerHolds: { claude: limit } })!.kind, 'limited');
  assert.equal(signOf(agent({ queued: 1, activity: 'full', blockedBy: 'concurrency' }), { providerHolds: { claude: limit } })!.kind, 'blocked', 'the server looks at slots last, so a hold it saw would have been named');
});

test('the most urgent reason wins', () => {
  const failed = task({ status: 'error' });
  const held = task({ awaiting: true, endedAt: 1 });
  assert.equal(signOf(agent({ queued: 1, activity: 'x' }), { tasks: [failed, held], approvals: [approval()] })!.kind, 'approval');
  assert.equal(signOf(agent({ queued: 1, activity: 'x' }), { tasks: [failed, held] })!.kind, 'error');
  assert.equal(signOf(agent({ queued: 1, activity: 'x' }), { tasks: [held] })!.kind, 'blocked');
});
