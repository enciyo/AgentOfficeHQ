// GitHub visitors and pull requests, against a fake code host: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, Task } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import { CodeHostUnavailable } from '../domain/errors.ts';
import type { CodeHost, DomainEvent, Inbound, State, StateStore } from '../domain/ports.ts';
import { Github } from './github.ts';
import type { Notifier } from './notifier.ts';
import type { Tasks } from './tasks.ts';
import { Translator } from './translator.ts';

class FakeHost implements CodeHost {
  open: Inbound[] = [];
  pushed: string[] = [];
  fail: Error | null = null;
  async inbound() {
    if (this.fail) throw this.fail;
    return this.open;
  }
  async openPullRequest(_cwd: string, pr: { commit: string; branch: string; title: string; body: string }) {
    if (this.fail) throw this.fail;
    this.pushed.push(`${pr.commit}->${pr.branch}: ${pr.title}`);
    return 'https://github.com/o/r/pull/9';
  }
}

const issue = (number: number, title = 'Bug'): Inbound => ({ kind: 'issue', number, title, url: `https://github.com/o/r/issues/${number}`, author: 'ana', body: 'It breaks' });

function setup() {
  const dev = createAgent({ name: 'Dev' }, 'Dev');
  const state = { agents: [dev], tasks: [] as Task[], visitors: [], settings: { language: 'en', github: true, defaultCwd: '/work' } as Settings } as unknown as State;
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const events: DomainEvent[] = [];
  const given: { agentId: string; prompt: string }[] = [];
  const tasks = {
    create: (agentId: string, prompt: string) => { given.push({ agentId, prompt }); return { id: 't1', agentId, prompt }; },
    get: (id: string) => state.tasks.find(t => t.id === id)!,
  } as unknown as Tasks;
  const notify = { publish: (e: DomainEvent) => events.push(e), task() {} } as unknown as Notifier;
  const host = new FakeHost();
  return { dev, state, events, given, host, github: new Github(store, notify, tasks, host, new Translator(store)) };
}

test('open issues come in once as waiting visitors; closed waiting ones leave', async () => {
  const { state, events, host, github } = setup();
  host.open = [issue(1), issue(2)];
  await github.poll();
  assert.deepEqual(state.visitors.map(v => [v.id, v.status]), [['issue-1', 'waiting'], ['issue-2', 'waiting']]);
  assert.equal(events.filter(e => e.type === 'visitors').length, 1);

  await github.poll();
  assert.equal(state.visitors.length, 2, 'already known ones are not added again');
  assert.equal(events.filter(e => e.type === 'visitors').length, 1, 'nothing changed, nothing published');

  github.reject('issue-1');
  host.open = [issue(1)];
  await github.poll();
  assert.deepEqual(state.visitors.map(v => [v.id, v.status]), [['issue-1', 'rejected']], 'issue-2 was closed while waiting');
});

test('polling is quiet in the background and off unless turned on', async () => {
  const { state, host, github } = setup();
  host.fail = new CodeHostUnavailable('gh');
  await github.poll();
  await assert.rejects(github.poll({ strict: true }), /gh auth login/);
  state.settings.github = false;
  host.fail = null;
  host.open = [issue(3)];
  await github.poll();
  assert.equal(state.visitors.length, 0);
});

test('accepting a visitor gives the issue to an agent as a task', async () => {
  const { dev, state, given, host, github } = setup();
  host.open = [issue(7, 'Login fails')];
  await github.poll();
  github.accept('issue-7', dev.id);
  assert.equal(given.length, 1);
  assert.equal(given[0]!.agentId, dev.id);
  assert.match(given[0]!.prompt, /#7: Login fails/);
  assert.equal(state.visitors[0]!.status, 'accepted');
  assert.equal(state.visitors[0]!.agentId, dev.id);
  assert.throws(() => github.accept('issue-7', dev.id), /no longer waiting/);
});

test('a pull request needs a finished task with a commit and is opened once', async () => {
  const { dev, state, host, github } = setup();
  const task = { id: 'abc', agentId: dev.id, prompt: 'Fix login', result: 'Fixed', status: 'done', cost: 0 } as Task;
  state.tasks.push(task);
  await assert.rejects(github.openPullRequest('abc'), /worktrees/);
  task.commit = 'deadbeef';
  await Promise.all([github.openPullRequest('abc'), github.openPullRequest('abc')]); // a double click
  assert.equal(task.pr, 'https://github.com/o/r/pull/9');
  assert.deepEqual(host.pushed, ['deadbeef->agent-office/abc: Dev: Fix login']);
  await github.openPullRequest('abc');
  assert.equal(host.pushed.length, 1, 'no second pull request for the same task');
});
