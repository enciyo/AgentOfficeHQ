// Settings and output use cases against an in-memory store: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, Task } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import { TASK_LOG_LIMIT } from '../domain/logs.ts';
import type { FileTree, Isolation, LogBook, Runner, State, StateStore } from '../domain/ports.ts';
import type { Agents } from './agents.ts';
import { Notifier } from './notifier.ts';
import { PresenceBoard } from './presence.ts';
import { Translator } from './translator.ts';
import { Workspace } from './workspace.ts';

function setup() {
  const follower = createAgent({ name: 'Follower', provider: '', model: 'sonnet' }, 'Dev');
  const own = createAgent({ name: 'Own', provider: 'codex', model: 'gpt-5' }, 'Dev');
  follower.sessionId = own.sessionId = 's1';
  const state = {
    office: {}, agents: [follower, own], tasks: [], schedules: [], approvals: [], visitors: [],
    settings: { language: 'en', defaultProvider: 'claude', defaultCwd: '/work', worktrees: false } as Settings,
  } as unknown as State;
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const asked: [string, string, number][] = [];
  const logs: LogBook = { append() {}, recent: () => [], ofTask: async (agentId, taskId, limit) => (asked.push([agentId, taskId, limit]), { entries: [], total: 0 }) };
  const notify = new Notifier(store, new PresenceBoard(), { publish() {} }, logs);
  const runner = { has: (id: string) => ['claude', 'codex', 'opencode'].includes(id), providers: async () => [] } as unknown as Runner;
  const removed: string[] = [];
  const files = { remove: (_root: string, rel: string) => rel === 'docs/a.md' } as unknown as FileTree;
  const isolation = { commitRemoval: (_base: string, rel: string) => removed.push(rel) } as unknown as Isolation;
  const workspace = new Workspace(store, notify, runner, logs, new Translator(store), {} as Agents, files, isolation);
  return { state, workspace, follower, own, removed, asked };
}

test('changing the default CLI starts its followers fresh, without the old CLI model', async () => {
  const { workspace, follower, own } = setup();
  await workspace.updateSettings({ defaultProvider: 'opencode' });
  assert.deepEqual([follower.sessionId, follower.model], [null, '']);
  assert.deepEqual([own.sessionId, own.model], ['s1', 'gpt-5'], 'an agent with its own CLI keeps everything');
  await assert.rejects(workspace.updateSettings({ defaultProvider: 'nope' }), /nope/);
});

test('a task log is read from the log of the agent holding the task, and unknown tasks are not found', async () => {
  const { state, workspace, own, asked } = setup();
  state.tasks.push({ id: 't1', agentId: own.id } as Task);
  assert.deepEqual(await workspace.taskLogs('t1'), { entries: [], total: 0, limit: TASK_LOG_LIMIT });
  assert.deepEqual(asked, [[own.id, 't1', TASK_LOG_LIMIT]]);
  await assert.rejects(workspace.taskLogs('nope'), (e: Error & { status?: number }) => e.status === 404);
});

test('a deleted output is committed only when agents work in worktrees', () => {
  const { state, workspace, removed } = setup();
  workspace.removeOutput('docs/a.md');
  assert.deepEqual(removed, []);
  state.settings.worktrees = true;
  workspace.removeOutput('docs/a.md');
  assert.deepEqual(removed, ['docs/a.md']);
  assert.throws(() => workspace.removeOutput('missing.md'));
});

test('a browser gets the newest tasks and every chain still going, whole', async () => {
  const { state, workspace, own } = setup();
  const task = (id: string, parentId: string | null, status = 'done', over: Partial<Task> = {}) => ({ id, agentId: own.id, parentId, status, ...over }) as Task;
  state.tasks.push(task('root', null), task('gone', null), task('mid', 'root'));
  for (let i = 0; i < 250; i++) state.tasks.push(task(`n${i}`, null));
  state.tasks.push(task('tip', 'mid', 'queued'));
  const ids = (await workspace.snapshot()).tasks.map(t => t.id);
  assert.equal(ids.length, 200 + 2);
  assert.deepEqual(ids.slice(0, 3), ['root', 'mid', 'n51'], 'in their order, with the chain\'s old tasks');
  assert.ok(!ids.includes('gone'));
  assert.equal(ids.at(-1), 'tip');
});
