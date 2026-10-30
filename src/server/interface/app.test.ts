// Routes of the office controls, against stubbed use cases: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Knowledge } from '../application/knowledge.ts';
import type { Tasks } from '../application/tasks.ts';
import type { Translator } from '../application/translator.ts';
import type { Agents } from '../application/agents.ts';
import type { Workspace } from '../application/workspace.ts';
import { createT } from '../../shared/i18n/index.ts';
import { notFound } from '../domain/errors.ts';
import { createApp } from './app.ts';
import { limits } from './schemas.ts';

function setup() {
  const calls: unknown[][] = [];
  const tasks = {
    edit: (id: string, prompt: string) => (calls.push(['edit', id, prompt]), { id, prompt }),
    retry: (id: string) => (calls.push(['retry', id]), { id: 'again', retryOf: id }),
    setPaused: (paused: boolean) => void calls.push(['paused', paused]),
    diff: (id: string) => (id === 'none' ? null : { files: [], patch: '+x', truncated: false }),
    resolveConflict: (id: string) => (calls.push(['resolve', id]), { id: 'fix', resolves: id }),
  } as unknown as Tasks;
  const knowledge = {
    remember: (...args: unknown[]) => (calls.push(['remember', ...args]), { id: 'n1', pinned: false }),
    recall: (query: string) => (calls.push(['recall', query]), { text: 'found' }),
    update: (id: string, fields: object) => (calls.push(['update', id, fields]), { id }),
    remove: (id: string) => void calls.push(['remove', id]),
  } as unknown as Knowledge;
  const agents = {
    get: (id: string) => { if (id !== 'a1') throw notFound('gone'); },
    deleteTeam: () => (calls.push(['deleteTeam']), 3),
    exportTeam: () => ({ format: 'agent-office-team', version: 1, exportedAt: 1, agents: [] }),
    importTeam: (members: object[], replace: boolean) => (calls.push(['importTeam', members, replace]), { added: ['A'], skipped: 0 }),
  } as unknown as Agents;
  const workspace = { logsOf: (id: string) => (calls.push(['logs', id]), []) } as unknown as Workspace;
  const app = createApp({ tasks, knowledge, agents, workspace, i18n: { t: createT('en') } as Translator, clientDir: '/nowhere' } as Parameters<typeof createApp>[0]);
  const call = (method: string, path: string, body?: object) =>
    app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { calls, call };
}

test('PATCH /tasks/:id trims the prompt and refuses an empty one', async () => {
  const { calls, call } = setup();
  assert.equal((await call('PATCH', '/api/tasks/t1', { prompt: ' better ' })).status, 200);
  assert.deepEqual(calls, [['edit', 't1', 'better']]);
  assert.equal((await call('PATCH', '/api/tasks/t1', { prompt: '  ' })).status, 400);
});

test('POST /tasks/:id/retry answers with the new task', async () => {
  const { calls, call } = setup();
  const res = await call('POST', '/api/tasks/t1/retry');
  assert.deepEqual(await res.json(), { id: 'again', retryOf: 't1' });
  assert.deepEqual(calls, [['retry', 't1']]);
});

test('POST /office/pause takes a boolean', async () => {
  const { calls, call } = setup();
  assert.equal((await call('POST', '/api/office/pause', { paused: true })).status, 200);
  assert.deepEqual(calls, [['paused', true]]);
  assert.equal((await call('POST', '/api/office/pause', {})).status, 400);
});

test('GET /tasks/:id/diff answers with the diff, or null when there is none', async () => {
  const { call } = setup();
  assert.deepEqual(await (await call('GET', '/api/tasks/t1/diff')).json(), { files: [], patch: '+x', truncated: false });
  assert.equal(await (await call('GET', '/api/tasks/none/diff')).json(), null);
});

test('POST /tasks/:id/resolve answers with the new task', async () => {
  const { calls, call } = setup();
  assert.deepEqual(await (await call('POST', '/api/tasks/t1/resolve')).json(), { id: 'fix', resolves: 't1' });
  assert.deepEqual(calls, [['resolve', 't1']]);
});

test('POST /notes is what agents write through: it cannot pin', async () => {
  const { calls, call } = setup();
  const res = await call('POST', '/api/notes', { agentId: 'a', taskId: 't1', text: 'use pnpm', pinned: true });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['remember', 'a', 't1', 'use pnpm']]);
});

test('GET /notes/recall searches', async () => {
  const { calls, call } = setup();
  assert.deepEqual(await (await call('GET', '/api/notes/recall?q=pnpm')).json(), { text: 'found' });
  assert.deepEqual(calls, [['recall', 'pnpm']]);
});

test('PATCH and DELETE /notes/:id edit, pin and delete', async () => {
  const { calls, call } = setup();
  assert.equal((await call('PATCH', '/api/notes/n1', { pinned: true, author: 'x' })).status, 200);
  assert.equal((await call('DELETE', '/api/notes/n1')).status, 200);
  assert.deepEqual(calls, [['update', 'n1', { pinned: true }], ['remove', 'n1']]);
});

test('GET /agents/:id/logs only reads the log of an agent that exists', async () => {
  const { calls, call } = setup();
  assert.equal((await call('GET', '/api/agents/a1/logs')).status, 200);
  assert.equal((await call('GET', '/api/agents/..%2F..%2Foutside/logs')).status, 404);
  assert.deepEqual(calls, [['logs', 'a1']]);
});

test('a time limit a timer can not hold is refused, with a message of its own', () => {
  const base = { taskTimeoutMin: 60, silenceTimeoutMin: 30, maxConcurrent: 0, dailyBudgetUsd: 0, agentDailyBudgetUsd: 0, dailyRunMinutes: 0, chainMaxTurns: 100, chainBudgetUsd: 2.5 };
  assert.equal(limits.safeParse(base).success, true);
  for (const key of ['taskTimeoutMin', 'silenceTimeoutMin']) {
    const parsed = limits.safeParse({ ...base, [key]: 99_999 });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error!.issues[0]!.message, 'err.timerTooLong');
  }
});

test('DELETE /team fires the team and says how many left', async () => {
  const { calls, call } = setup();
  assert.deepEqual(await (await call('DELETE', '/api/team')).json(), { removed: 3 });
  assert.deepEqual(calls, [['deleteTeam']]);
});

test('GET /team/export is a download', async () => {
  const { call } = setup();
  const res = await call('GET', '/api/team/export');
  assert.match(res.headers.get('Content-Disposition') ?? '', /attachment; filename="agent-office-team-/);
});

test('POST /team/import takes a team file, keeps only setup fields and refuses anything else', async () => {
  const { calls, call } = setup();
  const file = { format: 'agent-office-team', version: 1, agents: [{ name: ' A ', cwd: '/etc', sessionId: 's', role: 'r' }] };
  assert.equal((await call('POST', '/api/team/import', { ...file, replace: true })).status, 200);
  assert.deepEqual(calls, [['importTeam', [{ name: 'A', role: 'r' }], true]]);
  for (const bad of [{ ...file, format: 'other' }, { ...file, version: 2 }, { ...file, agents: [] }, { ...file, agents: [{ role: 'r' }] }]) {
    assert.equal((await call('POST', '/api/team/import', bad)).status, 400);
  }
  assert.equal(calls.length, 1);
});
