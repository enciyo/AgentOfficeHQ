// Task lifecycle and the delegation/report chain, against an in-memory store and a scripted runner: `npm test`
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, LogEntry, ProviderInfo, PublicAgent, Settings, Task } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import { ProviderUnavailable } from '../domain/errors.ts';
import { MAX_REQUEUES } from '../domain/limits.ts';
import { MAX_LOG_DETAIL } from '../domain/logs.ts';
import type { AgentEvent, DomainEvent, Isolation, ProviderFailure, RunCallbacks, RunRequest, Runner, State, StateStore, Workcell } from '../domain/ports.ts';
import { Agents } from './agents.ts';
import { Approvals } from './approvals.ts';
import { Notifier } from './notifier.ts';
import { PresenceBoard } from './presence.ts';
import { Tasks } from './tasks.ts';
import { Translator } from './translator.ts';

interface Run { request: RunRequest; callbacks: RunCallbacks; stopped: boolean }

/** Runner whose runs the test drives by hand: emit events, then exit. */
class ScriptedRunner implements Runner {
  runs: Run[] = [];
  missing = new Set<string>();
  start(request: RunRequest, callbacks: RunCallbacks) {
    if (this.missing.has(request.agent.provider)) throw new ProviderUnavailable(request.agent.provider, request.agent.provider);
    const run: Run = { request, callbacks, stopped: false };
    this.runs.push(run);
    return { stop: () => { run.stopped = true; callbacks.onExit({ code: null, stderr: '' }); } };
  }
  has = () => true;
  delegates = () => true;
  label = (id: string) => id;
  /** What the next failed runs read as. */
  failure: ProviderFailure = { kind: 'other', resetAt: null };
  classify = () => this.failure;
  providers = async (): Promise<ProviderInfo[]> => [];

  /** The open run of an agent. */
  of(agent: Agent) {
    const run = [...this.runs].reverse().find(r => r.request.agent.id === agent.id);
    assert.ok(run, `${agent.name} has no run`);
    return run;
  }
  finish(agent: Agent, result: Extract<AgentEvent, { type: 'result' }> | null, events: AgentEvent[] = []) {
    const run = this.of(agent);
    for (const e of events) run.callbacks.onEvent(e);
    if (result) run.callbacks.onEvent(result);
    run.callbacks.onExit({ code: result?.ok ? 0 : 1, stderr: result ? '' : 'boom' });
  }
}

/** Records what isolation was asked to do. */
class FakeIsolation implements Isolation {
  calls: string[] = [];
  /** Why the next merges fail ('' = they work). */
  conflict = '';
  /** What the next runs leave to merge ('' = nothing changed). */
  commit = 'c0ffee1';
  enter(base: string, key: string): Workcell {
    this.calls.push(`enter ${key}`);
    return { cwd: `${base}/.agent-worktrees/${key}`, repo: base, branch: `agent/${key}`, head: 'ba5e', synced: true, error: '' };
  }
  integrate(cell: Workcell, message: string, { merge = true } = {}) {
    this.calls.push(`integrate ${cell.branch} ${message}`);
    if (!this.commit) return { committed: false, merged: false, error: '', commit: '' };
    return { committed: true, merged: merge && !this.conflict, error: merge ? this.conflict : '', commit: this.commit };
  }
  merge(_repo: string, branch: string) {
    this.calls.push(`merge ${branch}`);
    return { merged: !this.conflict, error: this.conflict };
  }
  discard(_repo: string, branch: string, commit: string) {
    this.calls.push(`discard ${branch} ${commit}`);
  }
  trunk = () => 'main';
  diff(repo: string, from: string, to: string) {
    this.calls.push(`diff ${repo} ${from} ${to}`);
    return { files: [{ path: 'x.md', status: 'M', additions: 2, deletions: 1, binary: false }], patch: '+x', truncated: false };
  }
  commitRemoval(_base: string, rel: string) {
    this.calls.push(`remove ${rel}`);
  }
}

function setup(...agents: Agent[]) {
  const state: State = {
    office: { name: 'HQ', width: 20, depth: 14, floorColor: '', wallColor: '', items: [] },
    agents, tasks: [],
    settings: { language: 'en', binaries: {}, defaultCwd: '/work', playerName: 'CEO', playerColor: '', limits: { taskTimeoutMin: 0, maxConcurrent: 0, dailyBudgetUsd: 0, agentDailyBudgetUsd: 0 } } as Settings,
    schedules: [], approvals: [], visitors: [],
  };
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const events: DomainEvent[] = [];
  const logs: Record<string, LogEntry[]> = {};
  const presence = new PresenceBoard();
  const notify = new Notifier(store, presence, { publish: e => events.push(e) }, { append: (id, e) => (logs[id] ??= []).push(e), recent: id => logs[id] ?? [], ofTask: async () => ({ entries: [], total: 0 }) });
  const runner = new ScriptedRunner();
  const isolation = new FakeIsolation();
  const tasks = new Tasks(store, notify, runner, presence, new Translator(store), isolation);
  const approvals = new Approvals(store, notify, tasks, new Translator(store));
  const roster = new Agents(store, notify, tasks, runner, new Translator(store));
  return { state, tasks, runner, events, logs, isolation, approvals, roster };
}

const agent = (name: string, over: Partial<Agent> = {}) => createAgent({ name, ...over }, 'Dev');
const ok = (text: string, costUsd = 0): Extract<AgentEvent, { type: 'result' }> => ({ type: 'result', ok: true, text, costUsd });
const tasksOf = (state: State, a: Agent) => state.tasks.filter((t: Task) => t.agentId === a.id);

test('a failed run counts what it reported, on the task and on the agent', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  const task = tasks.create(dev.id, 'one');
  runner.finish(dev, { type: 'result', ok: false, text: 'boom', costUsd: 0.4 });
  assert.equal(task.status, 'error');
  assert.equal(task.cost, 0.4);
  assert.equal(dev.totalCost, 0.4);
  assert.equal(tasksOf(state, dev).length, 1);
});

test('a cancelled run counts the cost it reports while it is going down', () => {
  const dev = agent('Dev');
  const { tasks, runner, events } = setup(dev);
  const task = tasks.create(dev.id, 'one');
  const { callbacks } = runner.of(dev);
  runner.of(dev).callbacks.onExit = () => {}; // the process outlives the cancel
  tasks.cancel(task.id);
  assert.equal(task.status, 'cancelled');
  callbacks.onEvent({ type: 'result', ok: false, text: 'stopped', costUsd: 0.2 });
  assert.equal(task.cost, 0.2);
  assert.equal(dev.totalCost, 0.2);
  assert.ok(events.some(e => e.type === 'task' && (e.task as Task).id === task.id && (e.task as Task).cost === 0.2), 'the client hears of it');
});

test('a timed-out run keeps its cost', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dev = agent('Dev');
    const { state, tasks, runner } = setup(dev);
    state.settings.limits.taskTimeoutMin = 1;
    const task = tasks.create(dev.id, 'one');
    runner.of(dev).callbacks.onEvent({ type: 'result', ok: true, text: 'almost', costUsd: 0.3 });
    mock.timers.tick(60_000);
    assert.equal(task.status, 'error');
    assert.equal(task.cost, 0.3);
    assert.equal(dev.totalCost, 0.3);
  } finally { mock.timers.reset(); }
});

test('a run whose CLI reports no cost is unknown, not $0; a task that never ran stays at $0', () => {
  const dev = agent('Dev');
  const { tasks, runner } = setup(dev);
  const silent = tasks.create(dev.id, 'codex');
  const never = tasks.create(dev.id, 'never');
  tasks.cancel(never.id);
  runner.finish(dev, { type: 'result', ok: true, text: 'done' });
  assert.equal(silent.status, 'done');
  assert.equal(silent.cost, null);
  assert.equal(dev.totalCost, 0);
  assert.equal(never.cost, 0);
  const failed = tasks.create(dev.id, 'dies without a word');
  runner.finish(dev, null);
  assert.equal(failed.cost, null);
  const free = tasks.create(dev.id, 'free model');
  runner.finish(dev, ok('done', 0));
  assert.equal(free.cost, 0);
});

test('the known cost of a running task counts against the budget before it ends', () => {
  const dev = agent('Dev');
  const other = agent('Other');
  const { state, tasks, runner } = setup(dev, other);
  state.settings.limits.dailyBudgetUsd = 1;
  const first = tasks.create(dev.id, 'one');
  runner.of(dev).callbacks.onEvent({ type: 'result', ok: true, text: 'lingers', costUsd: 1 });
  assert.equal(first.status, 'running');
  const second = tasks.create(other.id, 'two');
  assert.equal(second.status, 'queued');
});

test('the daily minutes cap holds new tasks whatever they cost, and says so once', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 15, 12) }); // minutes count from midnight, so not just after it
  const dev = agent('Dev');
  const { state, tasks, events } = setup(dev);
  state.settings.limits.dailyRunMinutes = 10;
  const now = Date.now();
  state.tasks.push({ id: 'old', agentId: dev.id, prompt: 'p', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'done', createdAt: now - 1, startedAt: now - 660_000, endedAt: now - 1, result: '', cost: null });
  const task = tasks.create(dev.id, 'next');
  assert.equal(task.status, 'queued');
  tasks.pump();
  assert.equal(events.filter(e => e.type === 'blocked' && e.kind === 'minutes').length, 1);
  state.settings.limits.dailyRunMinutes = 0;
  tasks.pump();
  assert.equal(task.status, 'running');
});

test('a task put back by a CLI limit keeps the cost and run time of that attempt; the next one adds to them', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const dev = agent('Dev');
    const { tasks, runner, state } = setup(dev);
    const task = tasks.create(dev.id, 'one');
    mock.timers.tick(5000);
    runner.failure = { kind: 'limit', resetAt: null };
    runner.finish(dev, { type: 'result', ok: false, text: 'limit', costUsd: 0.1 });
    assert.equal(task.status, 'queued');
    assert.equal(task.cost, 0.1);
    assert.equal(task.ranMs, 5000);
    state.providerHolds = {};
    tasks.pump();
    runner.finish(dev, ok('done', 0.2));
    assert.ok(Math.abs(task.cost! - 0.3) < 1e-9);
    assert.ok(Math.abs(dev.totalCost - 0.3) < 1e-9);
  } finally { mock.timers.reset(); }
});

test('tasks run one at a time per agent and record the result and cost', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  const first = tasks.create(dev.id, 'one');
  const second = tasks.create(dev.id, 'two');
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(runner.runs.length, 1);
  assert.equal(runner.runs[0]!.request.cwd, '/work');

  runner.finish(dev, ok('done one', 0.5), [{ type: 'session', id: 's1' }]);
  assert.equal(first.status, 'done');
  assert.equal(first.result, 'done one');
  assert.equal(first.cost, 0.5);
  assert.equal(dev.totalCost, 0.5);
  assert.equal(dev.sessionId, 's1');
  assert.equal(second.status, 'running', 'the next queued task starts');
  assert.equal(tasksOf(state, dev).length, 2);
});

test('a failed run marks the task as error and forgets a session that never started', () => {
  const dev = agent('Dev', { sessionId: 'stale' });
  const { tasks, runner } = setup(dev);
  const task = tasks.create(dev.id, 'x');
  runner.finish(dev, null);
  assert.equal(task.status, 'error');
  assert.match(task.result, /boom/);
  assert.equal(dev.sessionId, null);
});

test('a missing CLI fails the task and moves on to the next one', () => {
  const dev = agent('Dev', { provider: 'ghost' });
  const { tasks, runner } = setup(dev);
  runner.missing.add('ghost');
  const a = tasks.create(dev.id, 'a');
  assert.equal(a.status, 'error');
  assert.equal(runner.runs.length, 0);
});

test('cancel: queued tasks are cancelled, running ones are stopped', () => {
  const dev = agent('Dev');
  const { tasks, runner } = setup(dev);
  const running = tasks.create(dev.id, 'a');
  const queued = tasks.create(dev.id, 'b');
  tasks.cancel(queued.id);
  assert.equal(queued.status, 'cancelled');
  tasks.cancel(running.id);
  assert.equal(running.status, 'cancelled');
  assert.ok(runner.runs[0]!.stopped);
});

test('humans are never run; they complete tasks by hand', () => {
  const pat = agent('Pat', { kind: 'human' });
  const { tasks, runner } = setup(pat);
  const task = tasks.create(pat.id, 'review');
  assert.equal(task.status, 'queued');
  assert.equal(runner.runs.length, 0);
  tasks.complete(task.id, 'looks good');
  assert.equal(task.status, 'done');
  assert.throws(() => tasks.complete(task.id, 'again'));
});

test('delegation rules: unknown member, self and depth limit', () => {
  const lead = agent('Lead'), other = agent('Other');
  const { tasks } = setup(lead, other);
  const root = tasks.create(lead.id, 'plan');
  assert.throws(() => tasks.delegate(lead.id, 'Nobody', 'x', root.id));
  assert.throws(() => tasks.delegate(lead.id, 'Lead', 'x', root.id));
  root.depth = 4;
  assert.throws(() => tasks.delegate(lead.id, 'Other', 'x', root.id), /deep/);
});

test('a lead\'s report waits for the team, then goes up once with the merged result', () => {
  const pm = agent('PM'), lead = agent('Lead'), w1 = agent('W1'), w2 = agent('W2');
  const { state, tasks, runner, events } = setup(pm, lead, w1, w2);

  // CEO → PM; PM hands the stage to the lead and is done for now
  const ceoTask = tasks.create(pm.id, 'build it');
  const { taskId: leadTaskId } = tasks.delegate(pm.id, 'Lead', 'design it', ceoTask.id);
  runner.finish(pm, ok('handed off'));
  assert.equal(ceoTask.awaiting, true, 'the PM waits for the stage before answering the CEO');

  // Lead splits the work, then finishes its own turn: the report is held
  const leadTask = state.tasks.find(t => t.id === leadTaskId)!;
  tasks.delegate(lead.id, 'W1', 'part 1', leadTask.id);
  tasks.delegate(lead.id, 'W2', 'part 2', leadTask.id);
  runner.finish(lead, ok('split'));
  assert.equal(leadTask.status, 'done');
  assert.equal(leadTask.awaiting, true);
  assert.ok(!state.tasks.some(t => t.kind === 'report' && t.agentId === pm.id), 'nothing reported to the PM yet');

  // Each worker's report becomes a message to the lead
  runner.finish(w1, ok('part 1 ready'));
  runner.finish(w2, ok('part 2 ready'));
  const toLead = state.tasks.filter(t => t.kind === 'report' && t.agentId === lead.id);
  assert.equal(toLead.length, 2);
  assert.ok(toLead.every(t => t.from !== lead.id));
  assert.ok(events.some(e => e.type === 'report' && e.to === lead.id));

  // The lead reads the first report (still one open), then the second and merges: only now the PM hears back
  runner.finish(lead, ok('noted'));
  assert.ok(!state.tasks.some(t => t.kind === 'report' && t.agentId === pm.id));
  runner.finish(lead, ok('merged design'));
  const toPm = state.tasks.filter(t => t.kind === 'report' && t.agentId === pm.id);
  assert.equal(toPm.length, 1);
  assert.match(toPm[0]!.prompt, /merged design/);
  assert.equal(leadTask.awaiting, false);

  // The PM reads it; with nothing open below, the CEO's task is released (no boss above the CEO)
  runner.finish(pm, ok('all done'));
  assert.equal(ceoTask.awaiting, false);
  assert.equal(state.tasks.filter(t => t.status === 'queued' || t.status === 'running').length, 0);
});

test('with worktrees on, the run happens in the agent\'s checkout and is merged before the report goes up', () => {
  const lead = agent('Lead'), dev = agent('Dev Ops');
  const { state, tasks, runner, isolation } = setup(lead, dev);
  state.settings.worktrees = true;
  const root = tasks.create(lead.id, 'plan');
  tasks.delegate(lead.id, 'Dev Ops', 'build', root.id);
  assert.equal(runner.of(dev).request.cwd, `/work/.agent-worktrees/dev-ops-${dev.id}`);
  runner.finish(dev, ok('built'));
  const report = state.tasks.find(t => t.kind === 'report')!;
  assert.ok(report, 'the lead got the report');
  const integrated = isolation.calls.findIndex(c => c.startsWith(`integrate agent/dev-ops-${dev.id}`));
  assert.ok(integrated >= 0 && isolation.calls.lastIndexOf(`enter dev-ops-${dev.id}`) < integrated);
  assert.match(isolation.calls[integrated]!, /Dev Ops \(Dev\) #\w+\n\n[\s\S]*build/);

  state.settings.worktrees = false;
  tasks.create(dev.id, 'shared');
  assert.equal(runner.of(dev).request.cwd, '/work');
});

test('max concurrent: extra agents wait and start when a slot frees up', () => {
  const a = agent('A'), b = agent('B'), c = agent('C');
  const { state, tasks, runner } = setup(a, b, c);
  state.settings.limits.maxConcurrent = 2;
  tasks.create(a.id, 'x'); tasks.create(b.id, 'y');
  const third = tasks.create(c.id, 'z');
  assert.equal(third.status, 'queued');
  assert.equal(runner.runs.length, 2);
  runner.finish(a, ok('done'));
  assert.equal(third.status, 'running');
});

test('daily budget: once reached nothing new starts, announced once; raising the cap resumes', () => {
  const a = agent('A'), b = agent('B');
  const { state, tasks, runner, events } = setup(a, b);
  state.settings.limits.dailyBudgetUsd = 1;
  tasks.create(a.id, 'pricey');
  runner.finish(a, ok('spent', 1.2));
  const waiting = tasks.create(b.id, 'next');
  tasks.create(a.id, 'more');
  assert.equal(waiting.status, 'queued');
  assert.equal(events.filter(e => e.type === 'blocked').length, 1);
  state.settings.limits.dailyBudgetUsd = 5;
  tasks.pump();
  assert.equal(waiting.status, 'running');
});

test('per-agent budget only holds that agent', () => {
  const a = agent('A'), b = agent('B');
  const { state, tasks, runner } = setup(a, b);
  state.settings.limits.agentDailyBudgetUsd = 0.5;
  tasks.create(a.id, 'x');
  runner.finish(a, ok('spent', 0.6));
  assert.equal(tasks.create(a.id, 'again').status, 'queued');
  assert.equal(tasks.create(b.id, 'other').status, 'running');
});

test('a run over the time limit is stopped and the task fails', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = agent('A');
    const { state, tasks, runner } = setup(a);
    state.settings.limits.taskTimeoutMin = 1;
    const task = tasks.create(a.id, 'slow');
    mock.timers.tick(59_000);
    assert.equal(task.status, 'running');
    mock.timers.tick(2_000);
    assert.ok(runner.runs[0]!.stopped);
    assert.equal(task.status, 'error');
    assert.match(task.result, /1/);
  } finally {
    mock.timers.reset();
  }
});

test('approval: the report waits for the decision, which reaches the agent as a message', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, approvals, events } = setup(lead, dev);
  const root = tasks.create(lead.id, 'ship it');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'deploy', root.id);
  runner.finish(lead, ok('waiting for dev'));

  const ask = approvals.request(dev.id, taskId, 'push to main', 'all tests green');
  assert.equal(ask.status, 'pending');
  assert.ok(events.some(e => e.type === 'approval'));
  runner.finish(dev, ok('asked the CEO'));
  const devTask = state.tasks.find(t => t.id === taskId)!;
  assert.equal(devTask.awaiting, true, 'no report while the approval is pending');
  assert.ok(!state.tasks.some(t => t.kind === 'report' && t.agentId === lead.id));

  approvals.decide(ask.id, true, 'go');
  assert.throws(() => approvals.decide(ask.id, false));
  const decision = state.tasks.find(t => t.parentId === taskId && t.agentId === dev.id)!;
  assert.equal(decision.kind, 'report');
  assert.match(decision.prompt, /push to main[\s\S]*go/);
  runner.finish(dev, ok('pushed'));
  const toLead = state.tasks.filter(t => t.kind === 'report' && t.agentId === lead.id);
  assert.equal(toLead.length, 1, 'one report with the merged result');
  assert.match(toLead[0]!.prompt, /pushed/);
});

test('dragging a queued task to another agent moves it; finished work is given again', () => {
  const a = agent('Ada'), b = agent('Bo');
  const { state, tasks, runner, events } = setup(a, b);
  const busy = tasks.create(a.id, 'busy');
  const queued = tasks.create(a.id, 'later');
  assert.equal(queued.status, 'queued');
  assert.throws(() => tasks.handoff(busy.id, b.id), /running/, 'a running task would be done twice');

  const moved = tasks.handoff(queued.id, b.id);
  assert.equal(moved, queued, 'a queued task changes hands, keeping its id and chain');
  assert.equal(queued.agentId, b.id);
  assert.equal(queued.status, 'running', 'the new owner starts it right away');
  assert.ok(events.some(e => e.type === 'delegate' && e.from === a.id && e.to === b.id));

  runner.finish(a, ok('first'));
  const first = tasksOf(state, a)[0]!;
  const again = tasks.handoff(first.id, b.id);
  assert.notEqual(again.id, first.id);
  assert.equal(again.prompt, 'busy');
  assert.equal(first.status, 'done', 'the original stays as it was');
  assert.throws(() => tasks.handoff(again.id, b.id), /already/);
});

test('reactions toggle and only known emoji are accepted', () => {
  const a = agent('Ada');
  const { tasks } = setup(a);
  const task = tasks.create(a.id, 'x');
  tasks.react(task.id, '🎉');
  tasks.react(task.id, '👍');
  assert.deepEqual(task.reactions, ['🎉', '👍']);
  tasks.react(task.id, '🎉');
  assert.deepEqual(task.reactions, ['👍']);
  assert.throws(() => tasks.react(task.id, 'lol'));
});

test('with worktrees the run commit is kept on the task (for pull requests)', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  state.settings.worktrees = true;
  const task = tasks.create(dev.id, 'change things');
  runner.finish(dev, ok('changed'));
  assert.equal(task.commit, 'c0ffee1');
});

test('an office-wide model for a CLI overrides the agent model without changing the agent', () => {
  const dev = agent('Dev', { provider: 'claude', model: 'sonnet' });
  const other = agent('Cody', { provider: 'codex', model: 'gpt-5' });
  const { state, tasks, runner } = setup(dev, other);
  state.settings.modelOverrides = { claude: 'opus' };
  tasks.create(dev.id, 'x');
  tasks.create(other.id, 'y');
  assert.equal(runner.of(dev).request.agent.model, 'opus');
  assert.equal(dev.model, 'sonnet', 'the agent keeps its own setting');
  assert.equal(runner.of(other).request.agent.model, 'gpt-5', 'other CLIs are not touched');
});

test('agents without a model of their own use the office default for their CLI', () => {
  const plain = agent('Plain', { provider: 'claude', model: '' });
  const picky = agent('Picky', { provider: 'claude', model: 'haiku' });
  const { state, tasks, runner } = setup(plain, picky);
  state.settings.defaultModels = { claude: 'sonnet' };
  tasks.create(plain.id, 'x');
  tasks.create(picky.id, 'y');
  assert.equal(runner.of(plain).request.agent.model, 'sonnet');
  assert.equal(runner.of(picky).request.agent.model, 'haiku', "an agent's own choice wins over the default");
  assert.equal(plain.model, '', 'the default is not written into the agent');
});

test('agents without a CLI of their own run on the office default CLI', () => {
  const follower = agent('Follower');
  const own = agent('Own', { provider: 'codex' });
  const { state, tasks, runner } = setup(follower, own);
  assert.equal(follower.provider, '', 'new agents follow the office default');
  state.settings.defaultProvider = 'opencode';
  state.settings.defaultModels = { opencode: 'openai/gpt-5' };
  tasks.create(follower.id, 'x');
  tasks.create(own.id, 'y');
  assert.equal(runner.of(follower).request.agent.provider, 'opencode');
  assert.equal(runner.of(follower).request.agent.model, 'openai/gpt-5', 'the default model of the default CLI applies');
  assert.equal(runner.of(own).request.agent.provider, 'codex');
});

test('a run remembers the outputs it wrote, as paths in the shared working directory', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  state.settings.worktrees = true;
  const task = tasks.create(dev.id, 'write docs');
  runner.finish(dev, ok('done'), [
    { type: 'tool', tool: 'write', files: ['/work/.agent-worktrees/' + `dev-${dev.id}` + '/docs/a.md'] },
    { type: 'tool', tool: 'edit', files: ['docs/b.md', 'docs/a.md'] },
    { type: 'tool', tool: 'edit', files: ['/etc/passwd', '../outside.md'] },
  ]);
  assert.deepEqual(task.files, ['docs/a.md', 'docs/b.md']);
});

test('the full input of a tool call goes to the log, capped, and stays out of the live events', () => {
  const dev = agent('Dev');
  const { tasks, runner, logs, events } = setup(dev);
  const task = tasks.create(dev.id, 'x');
  const input = 'cat ' + 'a'.repeat(MAX_LOG_DETAIL);
  runner.finish(dev, ok('done'), [
    { type: 'tool', tool: 'shell', detail: 'cat aaa…', input },
    { type: 'tool', tool: 'read', detail: 'a.md' },
    { type: 'tool-error', text: 'e'.repeat(1000) },
    { type: 'tool-error', text: 'short' },
  ]);
  const ofRun = logs[dev.id]!.filter(l => l.taskId === task.id);
  const [shell, read] = ofRun.filter(l => l.kind === 'tool');
  assert.equal(shell!.detail, input.slice(0, MAX_LOG_DETAIL) + '…');
  assert.equal(read!.detail, undefined);
  const [long, short] = ofRun.filter(l => l.kind === 'error');
  assert.equal(long!.text.length, 400);
  assert.equal(long!.detail!.length, 1000, 'the summary is cut, the log keeps the whole message');
  assert.equal(short!.detail, undefined);

  const live = events.flatMap(e => (e.type === 'log' && (e.entry as LogEntry).taskId === task.id ? [e.entry as LogEntry] : []));
  assert.ok(live.every(l => l.detail === undefined), 'live events never carry the detail');
  assert.deepEqual(live.filter(l => l.kind === 'tool').map(l => !!l.hasDetail), [true, false]);
});

// ---- stuck chains: every way a task closes lets the report above it go

/** Boss gave Lead a task; Lead delegated to Dev and finished, so its report is held. */
function heldChain(...others: Agent[]) {
  const boss = agent('Boss'), lead = agent('Lead'), dev = agent('Dev');
  const ctx = setup(boss, lead, dev, ...others);
  const top = ctx.tasks.create(boss.id, 'run the project');
  const { taskId: leadId } = ctx.tasks.delegate(boss.id, 'Lead', 'build it', top.id);
  const { taskId: devId } = ctx.tasks.delegate(lead.id, 'Dev', 'code it', leadId);
  ctx.runner.finish(lead, ok('split the work'));
  const leadTask = ctx.state.tasks.find(t => t.id === leadId)!;
  const devTask = ctx.state.tasks.find(t => t.id === devId)!;
  assert.equal(leadTask.awaiting, true);
  return { ...ctx, boss, lead, dev, top, leadTask, devTask };
}
const reportsTo = (state: State, a: Agent) => state.tasks.filter(t => t.kind === 'report' && t.agentId === a.id);

test('cancelling the last open subtask releases the held report', () => {
  const dev2 = agent('Dev2');
  const { state, tasks, boss, top, leadTask, lead } = heldChain(dev2);
  const { taskId } = tasks.delegate(lead.id, 'Dev2', 'more', leadTask.id);
  const queued = tasks.create(dev2.id, 'next');
  const devRun = state.tasks.find(t => t.parentId === leadTask.id && t.agentId !== dev2.id)!;
  tasks.cancel(devRun.id);
  assert.equal(leadTask.awaiting, true, 'Dev2 is still open');
  tasks.cancel(taskId);
  tasks.cancel(queued.id);
  assert.equal(leadTask.awaiting, false);
  const sent = reportsTo(state, boss);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.parentId, leadTask.id);
  assert.match(sent[0]!.prompt, /split the work/);
  assert.ok(top);
});

test('a cancelled queued task gets endedAt and sends no report of its own', () => {
  const dev = agent('Dev');
  const { state, tasks } = setup(dev);
  tasks.create(dev.id, 'busy');
  const queued = tasks.create(dev.id, 'later');
  tasks.cancel(queued.id);
  assert.equal(queued.status, 'cancelled');
  assert.ok(queued.endedAt);
  assert.equal(state.tasks.filter(t => t.kind === 'report').length, 0);
});

test('stopping the running subtask releases the report once, without waiting for the process', () => {
  const { state, tasks, boss, dev, leadTask, devTask, runner } = heldChain();
  const run = runner.of(dev);
  const exit = run.callbacks.onExit;
  let exited = false;
  run.callbacks.onExit = (info) => { exited = true; exit(info); };
  tasks.cancel(devTask.id);
  assert.ok(exited);
  assert.equal(devTask.status, 'cancelled');
  assert.ok(devTask.endedAt);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
});

test('a cancelled merge turn sends the held report with its own result, not an empty one', () => {
  const { state, tasks, runner, boss, lead, dev, leadTask } = heldChain();
  runner.finish(dev, ok('coded'));
  const merge = reportsTo(state, lead)[0]!;
  assert.equal(merge.status, 'running', 'the report to the lead started');
  tasks.cancel(merge.id);
  const sent = reportsTo(state, boss);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.prompt, /split the work/);
  assert.equal(leadTask.awaiting, false);
});

test('firing an agent closes their work with endedAt and releases the report above it', () => {
  const { state, roster, boss, dev, leadTask, devTask, runner } = heldChain();
  const later = state.tasks[state.tasks.push({ ...devTask, id: 'later', status: 'queued', startedAt: null, endedAt: null }) - 1]!;
  roster.fire(dev.id);
  assert.ok(runner.of(dev).stopped);
  assert.equal(devTask.status, 'cancelled');
  assert.equal(later.status, 'cancelled');
  assert.ok(later.endedAt);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
});

test('firing the worker of a held report passes the release on to the report above it', () => {
  const { state, tasks, roster, boss, lead, dev, top, leadTask, devTask, runner } = heldChain();
  runner.finish(boss, ok('delegated'));
  assert.equal(top.awaiting, true);
  roster.fire(lead.id);
  assert.equal(leadTask.awaiting, true, 'Dev is still working');
  tasks.cancel(devTask.id);
  assert.equal(leadTask.awaiting, false);
  assert.equal(top.awaiting, false, 'nobody can report for the lead, so the top of the chain is not left waiting');
  assert.equal(reportsTo(state, boss).length, 0);
  assert.ok(dev);
});

test('firing everyone at once starts no run for a report nobody will read', () => {
  const { state, roster, runner } = heldChain();
  const started = runner.runs.length;
  roster.installDefaultTeam(true);
  assert.equal(runner.runs.length, started);
  assert.ok(state.tasks.every(t => t.status !== 'queued' && t.status !== 'running'));
});

test('deciding the approval of a fired agent releases that agent\'s own held report', () => {
  const { state, tasks, approvals, roster, runner, boss, dev, leadTask, devTask } = heldChain();
  const ask = approvals.request(dev.id, devTask.id, 'push', '');
  runner.finish(dev, ok('asked'));
  assert.equal(devTask.awaiting, true);
  roster.fire(dev.id);
  approvals.decide(ask.id, false);
  assert.equal(devTask.awaiting, false);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
  assert.ok(tasks);
});

test('cancelling a whole chain closes everything under it and spawns no run', () => {
  const { state, tasks, approvals, runner, boss, dev, top, leadTask, devTask, events } = heldChain();
  runner.finish(boss, ok('delegated'));
  const next = tasks.delegate(leadTask.agentId, 'Dev', 'and this', leadTask.id);
  const ask = approvals.request(dev.id, devTask.id, 'push', '');
  const started = runner.runs.length;
  tasks.cancelChain(top.id);
  assert.equal(runner.runs.length, started, 'no queued task and no report started');
  assert.equal(runner.of(dev).stopped, true);
  assert.equal(devTask.status, 'cancelled');
  assert.equal(state.tasks.find(t => t.id === next.taskId)!.status, 'cancelled');
  assert.equal(state.tasks.filter(t => t.kind === 'report').length, 0);
  assert.equal(top.awaiting, false);
  assert.equal(leadTask.awaiting, false);
  assert.equal(ask.status, 'rejected');
  assert.ok(ask.decidedAt);
  assert.ok(events.some(e => e.type === 'approval' && (e.approval as { status: string }).status === 'rejected'));
});

test('cancelling part of a chain still releases the report above that part', () => {
  const { state, tasks, boss, lead, runner, leadTask } = heldChain();
  runner.finish(boss, ok('delegated'));
  const top = state.tasks[0]!;
  tasks.cancelChain(leadTask.id);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, lead).length, 0);
  assert.equal(top.awaiting, false, 'the top task has nothing open left');
  assert.equal(top.from, 'user');
});

test('cancelling a chain that only has a stuck report clears it without a report', () => {
  const { state, tasks, boss, dev, leadTask, devTask, runner } = heldChain();
  runner.finish(dev, ok('coded'));
  state.tasks.splice(state.tasks.findIndex(t => t.kind === 'report'), 1);
  assert.equal(devTask.status, 'done');
  tasks.cancelChain(leadTask.id);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 0);
});

test('a run cannot delegate from a task that was cancelled', () => {
  const { tasks, dev, devTask } = heldChain();
  tasks.cancel(devTask.id);
  assert.throws(() => tasks.delegate(dev.id, 'Lead', 'one more', devTask.id));
});

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** A chain as a restart finds it: `lead` held under `from: boss`, `sub` closed below it. */
function stored(subEnded: number) {
  const boss = agent('Boss'), lead = agent('Lead'), dev = agent('Dev');
  const ctx = setup(boss, lead, dev);
  const base = { prompt: 'p', depth: 1, kind: 'task' as const, createdAt: NOW - 100 * HOUR, startedAt: NOW - 100 * HOUR, result: 'lead result', cost: 0 };
  const leadTask: Task = { ...base, id: 'lead', agentId: lead.id, from: boss.id, parentId: null, status: 'done', endedAt: NOW - 99 * HOUR, awaiting: true };
  const sub: Task = { ...base, id: 'sub', agentId: dev.id, from: lead.id, parentId: 'lead', depth: 2, status: 'cancelled', endedAt: subEnded, result: '' };
  ctx.state.tasks.push(leadTask, sub);
  return { ...ctx, boss, lead, dev, leadTask, sub };
}

test('startup: an old held report stays stuck and starts no paid run', () => {
  const { state, tasks, runner, boss, leadTask } = stored(NOW - 25 * HOUR);
  tasks.reconcile(NOW);
  assert.equal(leadTask.awaiting, true);
  assert.equal(runner.runs.length, 0);
  assert.equal(reportsTo(state, boss).length, 0);
});

test('startup: a held report whose last subtask ended within a day is sent', () => {
  const { state, tasks, runner, boss, leadTask } = stored(NOW - 23 * HOUR);
  tasks.reconcile(NOW);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
  assert.equal(runner.runs.length, 1);
});

test('startup: held reports with open work under them stay as they are', () => {
  const { tasks, runner, leadTask, sub } = stored(NOW - HOUR);
  sub.status = 'queued';
  sub.endedAt = null;
  tasks.reconcile(NOW);
  assert.equal(leadTask.awaiting, true);
  assert.equal(runner.runs.length, 0);
});

test('startup: a recently interrupted run fails with endedAt and its report waits for the CEO, as does everything above it', () => {
  const { state, tasks, runner, boss, lead, leadTask, sub } = stored(NOW - 2 * HOUR);
  sub.status = 'running';
  sub.startedAt = NOW - HOUR;
  sub.endedAt = null;
  tasks.reconcile(NOW);
  assert.equal(sub.status, 'error');
  assert.equal(sub.endedAt, NOW - HOUR, 'all we know is when it started');
  assert.match(sub.result, /restarted/);
  assert.equal(sub.awaiting, true);
  assert.equal(leadTask.awaiting, true);
  assert.equal(runner.runs.length, 0, 'stopping the server stops the chain');
  assert.deepEqual([reportsTo(state, lead).length, reportsTo(state, boss).length], [0, 0]);

  tasks.reconcile(NOW + HOUR);
  assert.equal(runner.runs.length, 0, 'and so does a second restart');
  assert.throws(() => tasks.releaseReport(leadTask.id), 'the report below goes first');
  tasks.releaseReport(sub.id);
  assert.equal(reportsTo(state, lead).length, 1);
  assert.equal(leadTask.awaiting, true);
});

test('startup: with restarts allowed to start runs, the deepest held report of an interrupted chain goes up', () => {
  const { state, tasks, boss, lead, leadTask, sub } = stored(NOW - 2 * HOUR);
  state.settings.resumeInterrupted = true;
  sub.status = 'running';
  sub.startedAt = NOW - HOUR;
  sub.endedAt = null;
  tasks.reconcile(NOW);
  assert.equal(sub.status, 'error');
  assert.equal(sub.endedAt, NOW - HOUR, 'all we know is when it started');
  assert.match(sub.result, /restarted/);
  assert.equal(sub.awaiting, false);
  assert.equal(reportsTo(state, lead).length, 1, 'the lead hears about it');
  assert.equal(reportsTo(state, boss).length, 0, 'and the lead\'s own report waits for that');
  assert.equal(leadTask.awaiting, true);
});

test('startup: a run interrupted long ago starts nothing; its report can be sent by hand', () => {
  const { state, tasks, runner, lead, sub } = stored(0);
  sub.status = 'running';
  sub.startedAt = NOW - 30 * HOUR;
  sub.endedAt = null;
  tasks.reconcile(NOW);
  assert.equal(sub.status, 'error');
  assert.equal(sub.awaiting, true, 'visible as stuck');
  assert.equal(runner.runs.length, 0);
  tasks.releaseReport(sub.id);
  assert.equal(sub.awaiting, false);
  assert.equal(reportsTo(state, lead).length, 1);
});

test('startup: closed tasks that never got endedAt are dated from when they started, and stay old', () => {
  const { tasks, runner, leadTask, sub } = stored(0);
  sub.endedAt = null;
  tasks.reconcile(NOW);
  assert.equal(sub.endedAt, sub.startedAt);
  assert.equal(leadTask.awaiting, true);
  assert.equal(runner.runs.length, 0);
});

test('startup: an interrupted task the CEO gave has nobody to report to, so it is not held', () => {
  const dev = agent('Dev');
  const { state, tasks } = setup(dev);
  state.tasks.push({ id: 'x', agentId: dev.id, prompt: 'p', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'running', createdAt: 1, startedAt: 1, endedAt: null, result: '', cost: 0 });
  tasks.reconcile(NOW);
  assert.equal(state.tasks[0]!.status, 'error');
  assert.ok(!state.tasks[0]!.awaiting);
});

test('releasing by hand sends a stuck report; anything else is refused', () => {
  const { state, tasks, runner, boss, leadTask, sub } = stored(NOW - 30 * HOUR);
  tasks.releaseReport(leadTask.id);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
  assert.equal(runner.runs.length, 1);
  assert.throws(() => tasks.releaseReport(leadTask.id), 'already sent');
  assert.throws(() => tasks.releaseReport(sub.id), 'never held');
});

test('releasing by hand is refused while work is still open under the report', () => {
  const { tasks, leadTask, devTask } = heldChain();
  assert.equal(devTask.status, 'running');
  assert.throws(() => tasks.releaseReport(leadTask.id));
  assert.equal(leadTask.awaiting, true);
});

test('a run that goes silent is stopped and fails; any output buys it more time', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = agent('A');
    const { state, tasks, runner } = setup(a);
    state.settings.limits.silenceTimeoutMin = 1;
    const task = tasks.create(a.id, 'quiet');
    mock.timers.tick(50_000);
    runner.of(a).callbacks.onActivity();
    mock.timers.tick(50_000);
    assert.equal(task.status, 'running', 'output restarted the clock');
    mock.timers.tick(11_000);
    assert.ok(runner.runs[0]!.stopped);
    assert.equal(task.status, 'error');
    assert.match(task.result, /no output/);
    assert.ok(task.endedAt);
  } finally {
    mock.timers.reset();
  }
});

test('a silence limit of 0 never stops a run', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = agent('A');
    const { state, tasks, runner } = setup(a);
    state.settings.limits.silenceTimeoutMin = 0;
    const task = tasks.create(a.id, 'quiet');
    mock.timers.tick(24 * 60 * 60_000);
    assert.equal(task.status, 'running');
    assert.equal(runner.runs[0]!.stopped, false);
  } finally {
    mock.timers.reset();
  }
});

test('the watchdog is gone once a run ends', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = agent('A');
    const { state, tasks, runner } = setup(a);
    state.settings.limits.silenceTimeoutMin = 1;
    const task = tasks.create(a.id, 'x');
    runner.finish(a, ok('fine'));
    mock.timers.tick(120_000);
    assert.equal(task.status, 'done');
    assert.equal(runner.runs[0]!.stopped, false);
  } finally {
    mock.timers.reset();
  }
});

test('shutdown: runs are stopped, stay open for the next start, and nothing new starts or reports', async () => {
  const boss = agent('Boss'), dev = agent('Dev');
  const { tasks, runner, state } = setup(boss, dev);
  const given = tasks.create(dev.id, 'work', { from: boss.id });
  const next = tasks.create(dev.id, 'next');
  await tasks.shutdown();
  assert.ok(runner.runs[0]!.stopped);
  assert.equal(given.status, 'running', 'reconcile decides at the next start');
  assert.equal(given.endedAt, null);
  assert.equal(next.status, 'queued');
  assert.equal(runner.runs.length, 1);
  assert.equal(state.tasks.length, 2, 'no report went out');
  tasks.create(dev.id, 'late');
  tasks.pump();
  assert.equal(runner.runs.length, 1, 'nothing starts on the way down');
});

test('shutdown waits for slow runs, and a run that finished in time keeps its result', async () => {
  const boss = agent('Boss'), dev = agent('Dev');
  const { tasks, runner, state } = setup(boss, dev);
  const task = tasks.create(dev.id, 'work', { from: boss.id });
  const run = runner.of(dev);
  const stop = run.callbacks.onExit;
  // A process that only goes away some time after it was told to
  let exit = () => {};
  run.callbacks.onExit = info => { exit = () => stop(info); };
  let done = false;
  const down = tasks.shutdown().then(() => { done = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(done, false);
  run.callbacks.onEvent(ok('finished just in time', 0.25));
  exit();
  await down;
  assert.equal(task.status, 'done');
  assert.equal(task.cost, 0.25);
  const report = state.tasks.find(t => t.kind === 'report');
  assert.equal(report?.status, 'queued', 'the report waits for the next start');
  assert.equal(runner.runs.length, 1);
});

/** A server that went down with `dev` in the middle of a run. */
function interrupted(over: Partial<Task> = {}, sessionId: string | null = 's1') {
  const boss = agent('Boss'), dev = agent('Dev', { sessionId });
  const ctx = setup(boss, dev);
  const task: Task = { id: 'run', agentId: dev.id, prompt: 'build it', from: boss.id, parentId: null, depth: 0, kind: 'task', status: 'running', createdAt: 1, startedAt: 2, endedAt: null, result: '', cost: 0, ...over };
  ctx.state.tasks.push(task);
  return { ...ctx, boss, dev, task };
}

test('startup: with resuming off an interrupted run fails and starts nothing; its report can be sent by hand', () => {
  const now = Date.now();
  const { tasks, roster, runner, boss, task } = interrupted({ startedAt: now - 1000 });
  tasks.reconcile(now);
  roster.resume();
  assert.equal(task.status, 'error');
  assert.equal(task.endedAt, now - 1000);
  assert.equal(task.resumed, undefined);
  assert.equal(task.awaiting, true, 'the report waits');
  assert.equal(runner.runs.length, 0);
  tasks.releaseReport(task.id);
  assert.equal(runner.of(boss).request.task.kind, 'report');
});

/** Lead's merge turn after Dev finished, cut off by a restart: the report it was to send is still held. */
function interruptedMerge() {
  const ctx = heldChain();
  const { runner, state, dev, lead, leadTask } = ctx;
  runner.finish(dev, ok('code done'));
  const turn = state.tasks.find(t => t.kind === 'report' && t.agentId === lead.id)!;
  assert.equal(turn.status, 'running');
  assert.equal(leadTask.awaiting, true);
  return { ...ctx, turn };
}

test('startup: a merge turn cut off by a restart is not reported as a job well done', () => {
  const { state, tasks, boss, runner, leadTask, turn } = interruptedMerge();
  const before = runner.runs.length;
  tasks.reconcile();
  assert.equal(turn.status, 'error');
  assert.equal(leadTask.awaiting, true, 'it waits for the CEO');
  assert.equal(runner.runs.length, before);
  assert.equal(reportsTo(state, boss).length, 0);

  tasks.releaseReport(leadTask.id);
  const sent = reportsTo(state, boss)[0]!;
  assert.match(sent.prompt, /could not complete/);
  assert.match(sent.prompt, /restarted/);
  assert.doesNotMatch(sent.prompt, /split the work/);
});

test('startup: with restarts allowed to start runs, the cut-off merge turn is what the report says', () => {
  const { state, tasks, boss, leadTask, turn } = interruptedMerge();
  state.settings.resumeInterrupted = true;
  state.agents.find(a => a.id === turn.agentId)!.sessionId = null; // nothing to resume
  tasks.reconcile();
  assert.equal(leadTask.awaiting, false);
  assert.match(reportsTo(state, boss)[0]!.prompt, /could not complete/);
});

test('startup: a decision message cut off by a restart does not read as the work being done', () => {
  const { state, tasks, approvals, runner, boss, lead, dev, leadTask } = heldChain();
  const ask = approvals.request(lead.id, leadTask.id, 'push', '');
  runner.finish(dev, ok('code done'));
  runner.finish(lead, ok('read it'));
  approvals.decide(ask.id, true);
  tasks.reconcile();
  assert.equal(leadTask.awaiting, true);
  tasks.releaseReport(leadTask.id);
  assert.match(reportsTo(state, boss)[0]!.prompt, /could not complete/);
});

test('a retried merge turn that was cut off takes the held report with it', () => {
  const before = interruptedMerge();
  const { boss, lead, leadTask, turn } = before;
  const { state, tasks, runner } = setup(...before.state.agents); // the next server: no run is left
  state.tasks.push(...before.state.tasks);
  tasks.reconcile();
  tasks.retry(turn.id);
  assert.equal(reportsTo(state, boss).length, 0);
  runner.finish(lead, ok('merged after all'));
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
  assert.match(reportsTo(state, boss)[0]!.prompt, /merged after all/);
  assert.doesNotMatch(reportsTo(state, boss)[0]!.prompt, /\[Correction\]/, 'nobody heard of the failure');
});

test('a failed merge turn run again sends its result where the failure went', () => {
  const { state, tasks, runner, boss, lead, leadTask, turn } = interruptedMerge();
  runner.finish(lead, { type: 'result', ok: false, text: 'crashed' });
  assert.match(reportsTo(state, boss)[0]!.prompt, /could not complete/);
  runner.finish(boss, ok('the top task'));
  runner.finish(boss, ok('noted the failure'));

  const again = tasks.retry(turn.id);
  assert.equal(again.kind, 'report');
  assert.equal(again.correction, true);
  assert.equal(leadTask.awaiting, true);
  runner.finish(lead, ok('merged all well'));
  assert.equal(leadTask.awaiting, false);
  const sent = reportsTo(state, boss);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.prompt, /\[Correction\]/);
  assert.match(sent[1]!.prompt, new RegExp(`#${leadTask.id}`), 'by the number its reader knows');
  assert.match(sent[1]!.prompt, /merged all well/);
  assert.match(sent[1]!.prompt, /completed/);
});

test('an unread failure of a merge turn is withdrawn by its retry, which sends the only report', () => {
  const { state, tasks, runner, boss, lead, leadTask, turn } = interruptedMerge();
  const failedReport = () => reportsTo(state, boss).at(-1)!;
  runner.finish(lead, { type: 'result', ok: false, text: 'crashed' });
  assert.equal(failedReport().status, 'queued', 'the boss is still busy with the top task');
  const unread = failedReport();
  const again = tasks.retry(turn.id);
  assert.equal(unread.status, 'cancelled');
  assert.equal(again.correction, undefined);
  runner.finish(lead, ok('merged all well'));
  const live = reportsTo(state, boss).filter(t => t.status !== 'cancelled');
  assert.equal(live.length, 1);
  assert.match(live[0]!.prompt, /merged all well/);
  assert.doesNotMatch(live[0]!.prompt, /\[Correction\]/);
  assert.equal(leadTask.awaiting, false);
});

test('a cancelled retry of a merge turn leaves a failure already read alone', () => {
  const { state, tasks, runner, boss, lead, leadTask, turn } = interruptedMerge();
  runner.finish(lead, { type: 'result', ok: false, text: 'crashed' });
  runner.finish(boss, ok('the top task'));
  runner.finish(boss, ok('noted'));
  const again = tasks.retry(turn.id);
  tasks.cancel(again.id);
  assert.equal(leadTask.awaiting, false, 'nothing is left to say');
  assert.equal(reportsTo(state, boss).length, 1);
});

test('a cancelled retry of a merge turn holds the failure it withdrew', () => {
  const { state, tasks, runner, boss, lead, leadTask, turn } = interruptedMerge();
  runner.finish(lead, { type: 'result', ok: false, text: 'crashed' });
  const again = tasks.retry(turn.id);
  tasks.cancel(again.id);
  assert.equal(leadTask.awaiting, true);
  assert.equal(reportsTo(state, boss).filter(t => t.status !== 'cancelled').length, 0, 'a cancel starts no run');
  tasks.releaseReport(leadTask.id);
  const sent = reportsTo(state, boss).at(-1)!;
  assert.equal(sent.status, 'queued');
  assert.match(sent.prompt, /could not complete/);
  assert.match(sent.prompt, /crashed/);
});

test('a cancelled retry puts the failure it withdrew back on hold, and nothing above takes that for success', () => {
  const { state, tasks, runner, boss, lead, dev, leadTask, devTask } = heldChain();
  const busy = tasks.create(lead.id, 'something else');
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  const unread = reportsTo(state, lead).at(-1)!;
  assert.equal(unread.status, 'queued');
  assert.equal(busy.status, 'running');

  const again = tasks.retry(devTask.id);
  assert.equal(unread.status, 'cancelled');
  tasks.cancel(again.id);
  assert.equal(devTask.awaiting, true, 'told to nobody yet, and visible');
  assert.equal(leadTask.awaiting, true);
  assert.equal(reportsTo(state, boss).length, 0, 'the lead never read that this failed');
  assert.throws(() => tasks.releaseReport(leadTask.id));

  tasks.releaseReport(devTask.id);
  assert.match(reportsTo(state, lead).at(-1)!.prompt, /boom/);
});

test('a task with a held failure can be retried again after a cancelled retry', () => {
  const { tasks, runner, lead, dev, devTask } = heldChain();
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  runner.finish(lead, { type: 'result', ok: false, text: 'read and crashed' }); // reading it failed: the report was heard
  const first = tasks.retry(devTask.id);
  tasks.cancel(first.id);
  assert.ok(!devTask.awaiting, 'a failure already read needs no holding');
  const second = tasks.retry(devTask.id);
  assert.equal(second.status, 'running');
});

test('cancelling a chain from above takes a retry with it without holding anything', () => {
  const { state, tasks, runner, boss, lead, dev, leadTask, devTask } = heldChain();
  tasks.create(lead.id, 'something else');
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  tasks.retry(devTask.id);
  tasks.cancelChain(leadTask.id);
  assert.ok(!devTask.awaiting);
  assert.ok(!leadTask.awaiting);
  assert.equal(reportsTo(state, boss).length, 0);
});

test('a report held below keeps the one above from going, and firing its worker lets it go', () => {
  const { state, tasks, roster, boss, dev, leadTask, sub } = stored(NOW - 30 * HOUR);
  Object.assign(sub, { status: 'error', awaiting: true });
  assert.throws(() => tasks.releaseReport(leadTask.id));
  roster.fire(dev.id);
  assert.ok(!sub.awaiting, 'nobody is left to send it');
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
});

test('an approval asked from a cancelled task is refused', () => {
  const { tasks, approvals, state, dev, devTask } = heldChain();
  tasks.cancel(devTask.id);
  assert.throws(() => approvals.request(dev.id, devTask.id, 'push', ''), /not open/);
  assert.equal(state.approvals.length, 0);
});

test('a retried resolver still counts as the conflict\'s resolver', () => {
  const dev = agent('Dev');
  const { state, tasks, runner, isolation } = setup(dev);
  state.settings.worktrees = true;
  isolation.conflict = 'CONFLICT';
  const task = tasks.create(dev.id, 'one');
  runner.finish(dev, ok('done'));
  isolation.conflict = '';
  const fix = tasks.resolveConflict(task.id);
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  const again = tasks.retry(fix.id);
  assert.equal(again.resolves, task.id);
  assert.throws(() => tasks.resolveConflict(task.id), /already/);
});

function mergeTurnConflict() {
  const boss = agent('Boss'), lead = agent('Lead'), dev = agent('Dev');
  const ctx = setup(boss, lead, dev);
  ctx.state.settings.worktrees = true;
  const top = ctx.tasks.create(boss.id, 'run the project');
  const { taskId: leadId } = ctx.tasks.delegate(boss.id, 'Lead', 'build it', top.id);
  ctx.tasks.delegate(lead.id, 'Dev', 'code it', leadId);
  ctx.runner.finish(boss, ok('delegated'));
  ctx.runner.finish(lead, ok('split the work'));
  ctx.runner.finish(dev, ok('code done'));
  ctx.isolation.conflict = 'CONFLICT';
  const turn = reportsTo(ctx.state, lead).at(-1)!;
  ctx.runner.finish(lead, ok('merged the parts'));
  ctx.isolation.conflict = '';
  const leadTask = ctx.tasks.get(leadId);
  assert.equal(turn.merge, 'conflict');
  assert.equal(leadTask.awaiting, false);
  assert.match(reportsTo(ctx.state, boss).at(-1)!.prompt, /NOT merged/);
  ctx.runner.finish(boss, ok('noted'));
  return { ...ctx, boss, lead, turn, leadTask };
}

test('resolving a conflict of a report turn tells whoever heard of it', () => {
  const { state, tasks, runner, boss, lead, turn, leadTask } = mergeTurnConflict();
  const fix = tasks.resolveConflict(turn.id);
  assert.equal(fix.kind, 'report');
  runner.finish(lead, ok('conflict solved'));
  const sent = reportsTo(state, boss).at(-1)!;
  assert.equal(reportsTo(state, boss).length, 2);
  assert.match(sent.prompt, /\[Follow-up\]/);
  assert.match(sent.prompt, new RegExp(`#${leadTask.id}`));
  assert.match(sent.prompt, /conflict solved/);
  assert.doesNotMatch(sent.prompt, /NOT merged/);
  assert.equal(leadTask.awaiting, false);
});

test('a cancelled resolver of a report turn adds nothing to what was heard', () => {
  const { state, tasks, boss, turn, leadTask } = mergeTurnConflict();
  const fix = tasks.resolveConflict(turn.id);
  tasks.cancel(fix.id);
  assert.equal(leadTask.awaiting, false);
  assert.equal(reportsTo(state, boss).length, 1);
  assert.equal(tasks.resolveConflict(turn.id).status, 'running', 'and it can be tried again');
});

test('a time limit too long for a timer does not stop the run at once', (c) => {
  const delays: number[] = [];
  c.mock.method(globalThis, 'setTimeout', ((_fn: () => void, ms: number) => { delays.push(ms); return 0; }) as unknown as typeof setTimeout);
  const dev = agent('Dev');
  const { state, tasks } = setup(dev);
  Object.assign(state.settings.limits, { taskTimeoutMin: 99_999, silenceTimeoutMin: 99_999 });
  tasks.create(dev.id, 'one');
  c.mock.restoreAll();
  assert.equal(delays.length, 2);
  assert.ok(delays.every(ms => ms <= 2 ** 31 - 1));
});

test('an agent says what holds its queue back, until it no longer does', () => {
  const dev = agent('Dev');
  const { state, tasks, events } = setup(dev);
  const seen = () => (events.filter(e => e.type === 'agent').at(-1) as unknown as { agent: PublicAgent }).agent.blockedBy;
  state.settings.paused = true;
  tasks.create(dev.id, 'one');
  assert.equal(seen(), 'paused');
  tasks.setPaused(false);
  assert.equal(seen(), undefined);
});

test('startup: with resuming on an interrupted run continues its session, once', () => {
  const { state, tasks, roster, runner, dev, task } = interrupted();
  state.settings.resumeInterrupted = true;
  tasks.reconcile();
  assert.equal(task.status, 'queued');
  assert.equal(task.startedAt, null);
  assert.equal(task.resumed, true);
  roster.resume();
  assert.equal(task.status, 'running');
  const request = runner.of(dev).request;
  assert.equal(request.agent.sessionId, 's1');
  assert.match(request.task.prompt, /build it/);
  assert.notEqual(request.task.prompt, 'build it', 'the agent is told it was cut off');
  assert.equal(task.prompt, 'build it', 'the task itself does not change');

  // Down again in the middle of the second attempt: this time it fails
  tasks.reconcile();
  assert.equal(task.status, 'error');
  assert.ok(task.endedAt);
});

test('startup: a resumed task goes through the limits like any other', () => {
  const { state, tasks, roster, runner, task } = interrupted();
  state.settings.resumeInterrupted = true;
  state.settings.limits.dailyBudgetUsd = 1;
  state.tasks.push({ ...task, id: 'spent', status: 'done', cost: 2, endedAt: Date.now() });
  tasks.reconcile();
  roster.resume();
  assert.equal(task.status, 'queued');
  assert.equal(runner.runs.length, 0);
});

test('startup: a run without a session to continue fails even with resuming on', () => {
  const { state, tasks, task } = interrupted({}, null);
  state.settings.resumeInterrupted = true;
  tasks.reconcile();
  assert.equal(task.status, 'error');
  assert.equal(task.resumed, undefined);
});

test('startup: the report above a resumed task keeps waiting for it', () => {
  const { state, tasks, boss, task } = interrupted({ parentId: 'lead' });
  state.settings.resumeInterrupted = true;
  const held: Task = { ...task, id: 'lead', agentId: boss.id, from: 'user', parentId: null, status: 'done', endedAt: Date.now(), awaiting: true };
  state.tasks.push(held);
  tasks.reconcile();
  assert.equal(held.awaiting, true);
  assert.equal(task.status, 'queued');
});

const failed = (text: string): Extract<AgentEvent, { type: 'result' }> => ({ type: 'result', ok: false, text });
const inHour = () => Date.now() + 3_600_000;

test('a limit puts the task back, keeps the session and tells nobody above', () => {
  const lead = agent('Lead'), dev = agent('Dev', { sessionId: 's1' });
  const { state, tasks, runner, events } = setup(lead, dev);
  const resetAt = inHour();
  runner.failure = { kind: 'limit', resetAt };
  const task = tasks.create(dev.id, 'work', { from: lead.id });
  runner.finish(dev, failed('You have hit your session limit'));
  assert.equal(task.status, 'queued');
  assert.equal(task.startedAt, null);
  assert.equal(task.requeues, 1);
  assert.equal(task.endedAt, null);
  assert.equal(dev.sessionId, 's1', 'a run that never got a session keeps the one it has');
  assert.equal(tasksOf(state, lead).length, 0, 'no failure report');
  assert.equal(events.filter(e => e.type === 'report').length, 0);
  assert.equal(runner.runs.length, 1, 'and no instant retry');
  const hold = state.providerHolds?.claude;
  assert.equal(hold?.kind, 'limit');
  assert.equal(hold?.until, resetAt + 60_000);
  assert.match(hold!.message, /session limit/);
});

test('a limit holds every agent on that CLI, and nobody else', () => {
  const a = agent('A'), b = agent('B'), c = agent('C', { provider: 'codex' });
  const { tasks, runner, events } = setup(a, b, c);
  runner.failure = { kind: 'limit', resetAt: inHour() };
  tasks.create(a.id, 'one');
  runner.finish(a, failed('limit'));
  const other = tasks.create(b.id, 'two');
  const free = tasks.create(c.id, 'three');
  assert.equal(other.status, 'queued');
  assert.equal(free.status, 'running');
  const blocked = events.filter(e => e.type === 'blocked');
  assert.equal(blocked.length, 1, 'announced once');
  assert.equal(blocked[0]!.kind, 'providerLimit');
});

test('the pump resumes held work once the time has passed, in the same session with a continue prompt', () => {
  const dev = agent('Dev', { sessionId: 's1' });
  const { state, tasks, runner, events } = setup(dev);
  runner.failure = { kind: 'limit', resetAt: inHour() };
  const task = tasks.create(dev.id, 'work');
  const next = tasks.create(dev.id, 'later');
  runner.finish(dev, failed('limit'));
  tasks.pump();
  assert.equal(runner.runs.length, 1, 'still held');
  state.providerHolds!.claude!.until = Date.now() - 1;
  tasks.pump();
  assert.equal(task.status, 'running', 'its turn comes first');
  assert.equal(next.status, 'queued');
  assert.equal(state.providerHolds!.claude, undefined, 'the hold is gone');
  assert.deepEqual(events.filter(e => e.type === 'providerHolds').at(-1)?.holds, {});
  assert.equal(runner.runs.length, 2);
  assert.notEqual(runner.runs[1]!.request.task.prompt, 'work');
  assert.match(runner.runs[1]!.request.task.prompt, /work/);
  assert.equal(task.prompt, 'work', 'the task itself keeps its text');
  runner.finish(dev, ok('finished'));
  assert.equal(task.status, 'done');
});

test('without a session the retry is the plain task', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  runner.failure = { kind: 'limit', resetAt: null };
  tasks.create(dev.id, 'work');
  runner.finish(dev, failed('limit'));
  assert.ok(state.providerHolds!.claude!.until! > Date.now() + 14 * 60_000, 'the default wait');
  state.providerHolds!.claude!.until = 0;
  tasks.pump();
  assert.equal(runner.runs[1]!.request.task.prompt, 'work');
});

test('requeues are capped: then the task fails normally, the report goes up and nothing stays held', () => {
  const lead = agent('Lead'), dev = agent('Dev', { sessionId: 's1' });
  const { state, tasks, runner } = setup(lead, dev);
  runner.failure = { kind: 'limit', resetAt: null };
  const task = tasks.create(dev.id, 'work', { from: lead.id });
  for (let i = 0; i < MAX_REQUEUES; i++) {
    runner.finish(dev, failed('limit'));
    assert.equal(task.status, 'queued');
    state.providerHolds!.claude!.until = 0;
    tasks.pump();
    assert.equal(task.status, 'running');
  }
  runner.failure = { kind: 'limit', resetAt: null };
  runner.finish(dev, failed('still limited'));
  assert.equal(task.status, 'error');
  assert.equal(task.result, 'still limited');
  assert.equal(task.requeues, MAX_REQUEUES);
  assert.equal(dev.sessionId, 's1');
  assert.equal(state.providerHolds!.claude, undefined);
  assert.equal(tasksOf(state, lead).length, 1, 'the boss hears about it now');
});

test('a held chain stays held while its task waits for a limit', () => {
  const boss = agent('Boss'), lead = agent('Lead'), dev = agent('Dev', { provider: 'codex' });
  const { state, tasks, runner } = setup(boss, lead, dev);
  const top = tasks.create(lead.id, 'split', { from: boss.id });
  tasks.delegate(lead.id, 'Dev', 'part', top.id);
  runner.finish(lead, ok('waiting for dev'));
  assert.equal(top.awaiting, true);
  runner.failure = { kind: 'limit', resetAt: inHour() };
  runner.finish(dev, failed('limit'));
  assert.equal(top.awaiting, true);
  assert.equal(tasksOf(state, boss).length, 0);
  assert.equal(tasksOf(state, lead).length, 1);
});

test('a login failure pauses that CLI with the reason until it is resumed; queued work stays', () => {
  const a = agent('A', { sessionId: 's1' }), b = agent('B');
  const { state, tasks, runner, events } = setup(a, b);
  runner.failure = { kind: 'auth', resetAt: null };
  const first = tasks.create(a.id, 'one');
  const second = tasks.create(a.id, 'two');
  const third = tasks.create(b.id, 'three');
  runner.finish(a, failed('Unauthorized'));
  assert.deepEqual([first.status, second.status], ['queued', 'queued']);
  assert.equal(a.sessionId, 's1');
  assert.equal(state.providerHolds!.claude!.kind, 'auth');
  assert.equal(state.providerHolds!.claude!.until, null);
  assert.equal(events.find(e => e.type === 'blocked')?.kind, 'providerAuth');
  tasks.pump();
  assert.equal(runner.runs.length, 2, 'only what was already running ran');
  runner.finish(b, failed('Unauthorized'));
  assert.equal(third.status, 'queued');
  assert.equal(events.filter(e => e.type === 'blocked').length, 1);

  runner.failure = { kind: 'other', resetAt: null };
  tasks.resumeProvider('claude');
  assert.equal(state.providerHolds!.claude, undefined);
  assert.equal(first.status, 'running');
  assert.equal(third.status, 'running');
});

test('a later limit moves the wait out, and no limit replaces a paused login', () => {
  const a = agent('A'), b = agent('B'), c = agent('C');
  const { state, tasks, runner } = setup(a, b, c);
  for (const x of [a, b, c]) tasks.create(x.id, 'work');
  runner.failure = { kind: 'limit', resetAt: inHour() };
  runner.finish(a, failed('limit'));
  const until = state.providerHolds!.claude!.until!;
  runner.failure = { kind: 'limit', resetAt: until + 3_600_000 };
  runner.finish(b, failed('limit'));
  assert.ok(state.providerHolds!.claude!.until! > until);
  runner.failure = { kind: 'auth', resetAt: null };
  runner.finish(c, failed('Unauthorized'));
  assert.equal(state.providerHolds!.claude!.kind, 'auth');
  assert.equal(state.providerHolds!.claude!.until, null);
});

test('a paused login is not lifted by a limit from a run still in flight', () => {
  const a = agent('A'), b = agent('B');
  const { state, tasks, runner } = setup(a, b);
  tasks.create(a.id, 'one');
  tasks.create(b.id, 'two');
  runner.failure = { kind: 'auth', resetAt: null };
  runner.finish(a, failed('Unauthorized'));
  runner.failure = { kind: 'limit', resetAt: inHour() };
  runner.finish(b, failed('limit'));
  assert.equal(state.providerHolds!.claude!.kind, 'auth');
});

test('other failures stay as they were: permission errors and the office\'s own stops are not retried', () => {
  const dev = agent('Dev', { sessionId: 'stale' });
  const { state, tasks, runner } = setup(dev);
  runner.failure = { kind: 'permission', resetAt: null };
  const task = tasks.create(dev.id, 'x');
  runner.finish(dev, failed('Permission denied'));
  assert.equal(task.status, 'error');
  assert.equal(dev.sessionId, null);
  assert.equal(state.providerHolds?.claude, undefined);
});

test('a timeout is the office stopping the run, whatever the CLI printed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dev = agent('Dev');
    const { state, tasks, runner } = setup(dev);
    state.settings.limits.taskTimeoutMin = 1;
    runner.failure = { kind: 'limit', resetAt: null };
    const task = tasks.create(dev.id, 'x');
    mock.timers.tick(60_000);
    assert.equal(task.status, 'error');
    assert.equal(state.providerHolds?.claude, undefined);
  } finally { mock.timers.reset(); }
});

test('a hold survives a restart and is read from the state', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  state.providerHolds = { claude: { kind: 'auth', since: 1, until: null, message: 'Unauthorized' } };
  const task = tasks.create(dev.id, 'x');
  assert.equal(task.status, 'queued');
  assert.equal(runner.runs.length, 0);
});

test('the hold follows the CLI the agent really runs on', () => {
  const dev = agent('Dev', { provider: '' });
  const { state, tasks, runner } = setup(dev);
  state.settings.defaultProvider = 'codex';
  runner.failure = { kind: 'limit', resetAt: inHour() };
  tasks.create(dev.id, 'x');
  runner.finish(dev, failed('limit'));
  assert.ok(state.providerHolds?.codex);
});

// ---- office controls

const lastActivity = (events: DomainEvent[], a: Agent) =>
  (events.filter(e => e.type === 'agent' && (e.agent as Agent).id === a.id).at(-1)?.agent as { activity: string } | undefined)?.activity ?? '';

test('pausing lets a running task finish and starts nothing new until it is lifted', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner, events } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  const sub = tasks.create(dev.id, 'work', { from: boss.id, parentId: root.id, depth: 1 });
  const waiting = tasks.create(dev.id, 'next');
  tasks.setPaused(true);
  assert.equal(state.settings.paused, true);
  assert.ok(events.some(e => e.type === 'settings'));
  assert.equal(runner.of(dev).stopped, false);

  runner.finish(dev, ok('finished'));
  assert.equal(sub.status, 'done', 'what was running ends normally');
  assert.equal(waiting.status, 'queued');
  assert.match(lastActivity(events, dev), /Office paused/);
  const late = tasks.create(dev.id, 'given while paused');
  assert.equal(late.status, 'queued');
  assert.equal(runner.runs.length, 2);
  assert.ok(!events.some(e => e.type === 'blocked'), 'the CEO pressed the button, nothing to announce');

  tasks.setPaused(false);
  assert.equal(waiting.status, 'running');
  assert.equal(state.settings.paused, false);
});

test('an A->B->report->A loop stops at the turn limit with a reason, and goes on when the limit is raised', () => {
  const a = agent('A');
  const b = agent('B');
  const { state, tasks, runner, events, logs } = setup(a, b);
  state.settings.limits.chainMaxTurns = 3;
  const root = tasks.create(a.id, 'start'); // 1
  tasks.delegate(a.id, 'B', 'one', root.id); // 2
  runner.finish(b, ok('done'));
  runner.finish(a, ok('over to B')); // the report to A starts: 3
  const report = state.tasks.find(t => t.kind === 'report')!;
  assert.equal(report.status, 'running');
  assert.equal(report.depth, 0, 'the report goes back down, so depth alone never ends this');
  const again = tasks.delegate(a.id, 'B', 'two', report.id);
  const next = tasks.get(again.taskId);
  assert.equal(next.status, 'queued', 'the chain has used its turns');
  assert.match(lastActivity(events, b), /3 \/ 3/);
  assert.deepEqual(events.filter(e => e.type === 'blocked').map(e => e.kind), ['chainTurns']);
  assert.ok(logs[b.id]!.some(l => l.kind === 'system' && /3 \/ 3/.test(l.text)));

  tasks.pump();
  assert.equal(events.filter(e => e.type === 'blocked').length, 1, 'announced once per chain');

  state.settings.limits.chainMaxTurns = 4;
  tasks.pump();
  assert.equal(next.status, 'running');
});

test('a chain out of budget waits, while the same agent goes on with other work', () => {
  const a = agent('A');
  const b = agent('B');
  const { state, tasks, runner } = setup(a, b);
  state.settings.limits.chainBudgetUsd = 1;
  const root = tasks.create(a.id, 'start');
  tasks.delegate(a.id, 'B', 'expensive', root.id);
  const stuck = tasks.delegate(a.id, 'B', 'one more', root.id);
  const other = tasks.create(b.id, 'unrelated');
  runner.finish(b, ok('done', 1));
  assert.equal(tasks.get(stuck.taskId).status, 'queued');
  assert.equal(other.status, 'running', 'a chain at its limit does not hold up the queue behind it');
});

test('a retry stays in the chain: same agent, parent, sender, depth and prompt', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  const { taskId } = tasks.delegate(boss.id, 'Dev', 'build', root.id);
  const failed = tasks.get(taskId);
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  const again = tasks.retry(failed.id);
  assert.equal(again.status, 'running');
  assert.deepEqual([again.agentId, again.parentId, again.from, again.depth, again.kind, again.prompt, again.retryOf], [dev.id, root.id, boss.id, 1, 'task', failed.prompt, failed.id]);
  assert.equal(failed.status, 'error', 'the failure stays on record');
  assert.equal(state.tasks.length, 4); // lead, build, its report, the retry
});

test('a failure report nobody read yet is withdrawn: the retry sends the only report', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  const { taskId } = tasks.delegate(boss.id, 'Dev', 'build', root.id);
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' }); // boss still runs: the report waits
  const unread = state.tasks.find(t => t.kind === 'report')!;
  assert.equal(unread.status, 'queued');

  const again = tasks.retry(taskId);
  assert.equal(unread.status, 'cancelled');
  assert.equal(again.correction, undefined, 'nobody heard of the failure');
  runner.finish(dev, ok('fixed'));
  runner.finish(boss, ok('merged'));

  const reports = state.tasks.filter(t => t.kind === 'report' && t.agentId === boss.id && t.status !== 'cancelled');
  assert.equal(reports.length, 1);
  assert.match(reports[0]!.prompt, /fixed/);
  assert.doesNotMatch(reports[0]!.prompt, /boom/);
});

test('a failure report already read: the retry report corrects it and no second final report goes up', () => {
  const ceoTask = agent('Lead');
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(ceoTask, boss, dev);
  const top = tasks.create(ceoTask.id, 'all of it');
  const mid = tasks.delegate(ceoTask.id, 'Boss', 'part', top.id);
  const { taskId } = tasks.delegate(boss.id, 'Dev', 'build', mid.taskId);
  runner.finish(ceoTask, ok('waiting for Boss'));
  runner.finish(boss, ok('waiting for Dev'));
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' }); // the report starts right away
  assert.throws(() => tasks.retry(taskId), /still open/, 'Boss is reading it right now');
  runner.finish(boss, ok('Dev failed')); // read: Boss's own report goes up
  const upward = () => state.tasks.filter(t => t.kind === 'report' && t.agentId === ceoTask.id);
  assert.equal(upward().length, 1);
  runner.finish(ceoTask, ok('noted'));

  const again = tasks.retry(taskId);
  assert.equal(again.correction, true);
  runner.finish(dev, ok('fixed'));
  const correction = state.tasks.filter(t => t.kind === 'report' && t.agentId === boss.id).at(-1)!;
  assert.match(correction.prompt, /replaces/);
  assert.match(correction.prompt, /fixed/);
  runner.finish(boss, ok('good'));
  assert.equal(upward().length, 1, 'the final report is not sent twice');
});

test('a held failure report that never went out is taken over by the retry', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  const { taskId } = tasks.delegate(boss.id, 'Dev', 'build', root.id);
  runner.finish(boss, ok('waiting'));
  const failed = tasks.get(taskId);
  // What a restart leaves behind: the run failed, its report held back for `reconcile` and too old to go by itself
  tasks.reconcile(Date.now() + 48 * 3_600_000);
  assert.equal(failed.status, 'error');
  assert.equal(failed.awaiting, true);

  const again = tasks.retry(failed.id);
  assert.equal(failed.awaiting, false);
  assert.equal(again.correction, undefined);
  runner.finish(dev, ok('fixed'));
  const reports = state.tasks.filter(t => t.kind === 'report' && t.agentId === boss.id);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!.prompt, /fixed/);
});

test('only a failed task with nothing open under it and no live retry can be retried', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { tasks, runner } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  assert.throws(() => tasks.retry(root.id), /failed/, 'running');
  const sub = tasks.delegate(boss.id, 'Dev', 'build', root.id);
  runner.finish(boss, { type: 'result', ok: false, text: 'boom' });
  assert.throws(() => tasks.retry(root.id), /still open/, 'its subtask would report to nothing');
  runner.finish(dev, ok('done'));
  assert.equal(tasks.get(sub.taskId).status, 'done');
  runner.finish(boss, ok('read'));

  const first = tasks.retry(root.id);
  assert.throws(() => tasks.retry(root.id), /already/);
  tasks.cancel(first.id);
  assert.equal(tasks.retry(root.id).retryOf, root.id, 'a cancelled retry does not count');
});

test('a retry waits like any other task when the office is paused or its chain is out of turns', () => {
  const boss = agent('Boss');
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(boss, dev);
  const root = tasks.create(boss.id, 'lead');
  const { taskId } = tasks.delegate(boss.id, 'Dev', 'build', root.id);
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  runner.finish(boss, ok('read')); // the failure report: three turns so far
  runner.finish(boss, ok('noted'));
  state.settings.limits.chainMaxTurns = 3;
  const again = tasks.retry(taskId);
  assert.equal(again.status, 'queued');
  state.settings.limits.chainMaxTurns = 0;
  tasks.setPaused(true);
  assert.equal(again.status, 'queued');
  tasks.setPaused(false);
  assert.equal(again.status, 'running');
});

test('a retried root task is a new chain: it was the CEO who asked for it', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  const failed = tasks.create(dev.id, 'one');
  runner.finish(dev, { type: 'result', ok: false, text: 'boom' });
  state.settings.limits.chainMaxTurns = 1;
  assert.equal(tasks.retry(failed.id).status, 'running');
});

test('the prompt of a queued task can be edited, and only of a queued one', () => {
  const dev = agent('Dev');
  const { tasks, runner, events } = setup(dev);
  const running = tasks.create(dev.id, 'first');
  const queued = tasks.create(dev.id, 'second');
  assert.equal(tasks.edit(queued.id, 'better').prompt, 'better');
  assert.ok(events.some(e => e.type === 'task' && (e.task as Task).id === queued.id));
  assert.throws(() => tasks.edit(running.id, 'late'), /queued/);
  runner.finish(dev, ok('done'));
  assert.equal(runner.of(dev).request.task.prompt, 'better');
  assert.throws(() => tasks.edit(running.id, 'late'), /queued/);
});

// ---- review surface: honest merge status, approval before merging, resolving conflicts

const inWorktrees = (...agents: Agent[]) => {
  const office = setup(...agents);
  office.state.settings.worktrees = true;
  return office;
};
const reportsOf = (state: State) => state.tasks.filter(t => t.kind === 'report');

test('a run in a worktree records where it started and what became of its changes', () => {
  const dev = agent('Dev');
  const { tasks, runner, isolation } = inWorktrees(dev);
  const task = tasks.create(dev.id, 'change');
  assert.equal(task.baseCommit, 'ba5e');
  assert.equal(task.branch, `agent/dev-${dev.id}`);
  assert.equal(task.repo, '/work');
  runner.finish(dev, ok('changed'));
  assert.equal(task.merge, 'merged');

  isolation.commit = '';
  const idle = tasks.create(dev.id, 'look');
  runner.finish(dev, ok('looked'));
  assert.equal(idle.merge, 'unchanged');
});

test('without worktrees a task has no merge status', () => {
  const dev = agent('Dev');
  const { tasks, runner } = setup(dev);
  const task = tasks.create(dev.id, 'change');
  runner.finish(dev, ok('changed'));
  assert.equal(task.merge, undefined);
  assert.equal(task.baseCommit, undefined);
});

test('a merge conflict is recorded, and the report says the work is not in', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation, logs } = inWorktrees(lead, dev);
  isolation.conflict = 'CONFLICT (add/add): same.md';
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  const task = tasks.get(taskId);
  assert.equal(task.status, 'done', 'the agent did its work');
  assert.equal(task.merge, 'conflict');
  assert.equal(task.mergeNote, 'CONFLICT (add/add): same.md');
  const [report] = reportsOf(state);
  assert.match(report!.prompt, /NOT merged/);
  assert.match(report!.prompt, /same\.md/);
  assert.match(report!.prompt, new RegExp(`agent/dev-${dev.id}`));
  assert.ok(logs[dev.id]!.some(l => l.kind === 'error' && /same\.md/.test(l.text)));
});

test('a clean merge reports nothing about merging', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner } = inWorktrees(lead, dev);
  const root = tasks.create(lead.id, 'plan');
  tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  assert.doesNotMatch(reportsOf(state)[0]!.prompt, /merge/i);
});

test('isolation throwing while it integrates reads as a conflict too', () => {
  const dev = agent('Dev');
  const { tasks, runner, isolation } = inWorktrees(dev);
  isolation.integrate = () => { throw new Error('git is gone'); };
  const task = tasks.create(dev.id, 'change');
  runner.finish(dev, ok('changed'));
  assert.equal(task.merge, 'conflict');
  assert.equal(task.mergeNote, 'git is gone');
});

test('the last turn of a lead decides what the held report says about merging', () => {
  const boss = agent('Boss'), lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation } = inWorktrees(boss, lead, dev);
  const root = tasks.create(boss.id, 'plan');
  const { taskId } = tasks.delegate(boss.id, 'Lead', 'split', root.id);
  tasks.delegate(lead.id, 'Dev', 'part', taskId);
  runner.finish(lead, ok('split'));
  runner.finish(dev, ok('part done'));
  isolation.conflict = 'CONFLICT: merged.md';
  runner.finish(lead, ok('all merged'));
  const report = state.tasks.find(t => t.kind === 'report' && t.agentId === boss.id)!;
  assert.match(report.prompt, /all merged/);
  assert.match(report.prompt, /NOT merged/);
});

test('the diff of a task comes from its commits; without them there is none', () => {
  const dev = agent('Dev');
  const { tasks, runner, isolation } = inWorktrees(dev);
  const task = tasks.create(dev.id, 'change');
  assert.equal(tasks.diff(task.id), null, 'nothing committed yet');
  runner.finish(dev, ok('changed'));
  assert.equal(tasks.diff(task.id)!.files[0]!.path, 'x.md');
  assert.ok(isolation.calls.includes('diff /work ba5e c0ffee1'));
  isolation.diff = () => { throw new Error('bad object'); };
  assert.equal(tasks.diff(task.id), null, 'commits that are gone fall back to the file list');
  assert.throws(() => tasks.diff('nope'), /not found/i);
});

test('with approval on, the work waits on its branch and the report waits for the decision', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation, approvals } = inWorktrees(lead, dev);
  state.settings.approveMerges = true;
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  const task = tasks.get(taskId);
  assert.equal(task.status, 'done');
  assert.equal(task.merge, 'pending');
  assert.equal(task.awaiting, true);
  assert.equal(reportsOf(state).length, 0);
  const asked = state.approvals[0]!;
  assert.deepEqual([asked.kind, asked.taskId, asked.agentId, asked.status], ['merge', taskId, dev.id, 'pending']);
  assert.match(asked.details, /1 file/);
  assert.ok(!isolation.calls.some(c => c.startsWith('merge ')));

  approvals.decide(asked.id, true);
  assert.ok(isolation.calls.includes(`merge agent/dev-${dev.id}`));
  assert.equal(task.merge, 'merged');
  assert.equal(task.awaiting, false);
  assert.equal(reportsOf(state).length, 1, 'the report goes up');
  assert.doesNotMatch(reportsOf(state)[0]!.prompt, /merge/i);
  assert.equal(state.tasks.filter(t => t.agentId === dev.id).length, 1, 'the decision takes no run of the agent');
});

test('a run that changed nothing asks nobody', () => {
  const dev = agent('Dev');
  const { state, tasks, runner, isolation } = inWorktrees(dev);
  state.settings.approveMerges = true;
  isolation.commit = '';
  const task = tasks.create(dev.id, 'look');
  runner.finish(dev, ok('looked'));
  assert.equal(task.merge, 'unchanged');
  assert.equal(state.approvals.length, 0);
});

test('a rejected merge drops the work from the branch and the report says so', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation, approvals } = inWorktrees(lead, dev);
  state.settings.approveMerges = true;
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  approvals.decide(state.approvals[0]!.id, false, 'wrong approach');
  const task = tasks.get(taskId);
  assert.equal(task.merge, 'rejected');
  assert.equal(task.mergeNote, 'wrong approach');
  assert.ok(isolation.calls.includes(`discard agent/dev-${dev.id} ba5e`));
  assert.ok(!isolation.calls.some(c => c.startsWith('merge ')));
  const [report] = reportsOf(state);
  assert.match(report!.prompt, /rejected/);
  assert.match(report!.prompt, /wrong approach/);
});

test('an approved merge that conflicts by then is a conflict', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation, approvals } = inWorktrees(lead, dev);
  state.settings.approveMerges = true;
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  isolation.conflict = 'CONFLICT: late.md';
  approvals.decide(state.approvals[0]!.id, true);
  assert.equal(tasks.get(taskId).merge, 'conflict');
  assert.match(reportsOf(state)[0]!.prompt, /late\.md/);
});

test('an agent with work waiting for approval starts nothing new until the decision', () => {
  const dev = agent('Dev');
  const { state, tasks, runner, approvals, events } = inWorktrees(dev);
  state.settings.approveMerges = true;
  tasks.create(dev.id, 'first');
  const second = tasks.create(dev.id, 'second');
  runner.finish(dev, ok('one'));
  assert.equal(second.status, 'queued', 'it would build on work that may be dropped');
  assert.equal(runner.runs.length, 1);
  assert.match((events.filter(e => e.type === 'agent').at(-1) as any).agent.activity, /approval/i);
  approvals.decide(state.approvals[0]!.id, true);
  assert.equal(second.status, 'running');
});

test('cancelling a chain drops the work waiting for approval and frees the agent', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation } = inWorktrees(lead, dev);
  state.settings.approveMerges = true;
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  tasks.cancelChain(root.id);
  assert.equal(state.approvals[0]!.status, 'rejected');
  assert.equal(tasks.get(taskId).merge, 'rejected');
  assert.ok(isolation.calls.includes(`discard agent/dev-${dev.id} ba5e`));
  const next = tasks.create(dev.id, 'next');
  assert.equal(next.status, 'running');
});

test('a fired agent\'s waiting work can still be decided', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation, approvals, roster } = inWorktrees(lead, dev);
  state.settings.approveMerges = true;
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  roster.fire(dev.id);
  approvals.decide(state.approvals[0]!.id, true);
  assert.ok(isolation.calls.includes(`merge agent/dev-${dev.id}`));
  assert.equal(tasks.get(taskId).merge, 'merged');
});

test('resolving a conflict is a task for the same agent in the same place of the chain', () => {
  const lead = agent('Lead'), dev = agent('Dev');
  const { state, tasks, runner, isolation } = inWorktrees(lead, dev);
  isolation.conflict = 'CONFLICT: same.md';
  const root = tasks.create(lead.id, 'plan');
  const { taskId } = tasks.delegate(lead.id, 'Dev', 'build', root.id);
  runner.finish(dev, ok('built'));
  runner.finish(lead, ok('read the report'));
  const conflicted = tasks.get(taskId);

  const fix = tasks.resolveConflict(taskId);
  assert.equal(fix.agentId, dev.id);
  assert.equal(fix.resolves, taskId);
  assert.deepEqual([fix.from, fix.parentId, fix.depth, fix.kind], [conflicted.from, conflicted.parentId, conflicted.depth, 'task']);
  assert.match(fix.prompt, /git merge main/);
  assert.match(fix.prompt, /same\.md/);
  assert.throws(() => tasks.resolveConflict(taskId), /already/, 'one resolver at a time');

  isolation.conflict = '';
  runner.finish(dev, ok('resolved'));
  assert.equal(fix.merge, 'merged');
  assert.equal(conflicted.merge, 'merged', 'the branch held its work, so that is in now too');
  assert.equal(conflicted.mergeNote, undefined);
  const report = reportsOf(state).at(-1)!;
  assert.equal(report.agentId, lead.id);
  assert.match(report.prompt, new RegExp(`#${taskId}`));
  assert.match(report.prompt, /could not be merged/);
});

test('a resolver that fails can be tried again; only a conflict can be resolved', () => {
  const dev = agent('Dev');
  const { tasks, runner, isolation } = inWorktrees(dev);
  isolation.conflict = 'CONFLICT';
  const task = tasks.create(dev.id, 'change');
  runner.finish(dev, ok('changed'));
  tasks.resolveConflict(task.id);
  runner.finish(dev, { type: 'result', ok: false, text: 'gave up' });
  assert.equal(task.merge, 'conflict');
  assert.equal(tasks.resolveConflict(task.id).status, 'running');
  isolation.conflict = '';
  runner.finish(dev, ok('fixed'));
  assert.throws(() => tasks.resolveConflict(task.id), /conflict/);
});

test('a run gets the office notes and pinned notes in its prompt, unpinned notes stay out, also without team tools', () => {
  const dev = agent('Dev');
  const { state, tasks, runner } = setup(dev);
  state.settings.officeNotes = 'We ship on Fridays';
  state.notes = [
    { id: 'p', text: 'Use pnpm', author: dev.id, authorName: 'Dev', createdAt: 1, pinned: true },
    { id: 'u', text: 'Skip the tests', author: dev.id, authorName: 'Dev', createdAt: 2, pinned: false },
  ];
  runner.delegates = () => false;
  tasks.create(dev.id, 'one');
  const { systemPrompt } = runner.of(dev).request;
  assert.match(systemPrompt, /We ship on Fridays/);
  assert.match(systemPrompt, /Use pnpm/);
  assert.doesNotMatch(systemPrompt, /Skip the tests/);
});
