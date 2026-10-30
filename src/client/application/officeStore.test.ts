// The signs reach the 3D view by themselves and lead to the right place: `npm test`
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, PublicAgent, Settings, Task } from '../../shared/types.ts';
import { attentionOf } from '../domain/attention.ts';
import { createOfficeStore } from './officeStore.ts';
import type { Alerts, EventFeed, Gateway, ServerEvent, Snapshot, Stage } from './ports.ts';

type Signs = ReturnType<typeof attentionOf>;

const agent = (over: Partial<PublicAgent> = {}): PublicAgent => ({
  id: 'a', name: 'A', kind: 'agent', provider: 'claude', role: '', color: '#000', prompt: '', model: '', cwd: '', permissionMode: '',
  allowedTools: '', team: '', sessionId: null, totalCost: 0, hiredAt: 0, status: 'idle', activity: '', currentTaskId: null, queued: 0, ...over,
});
const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', agentId: 'a', prompt: '', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'running',
  createdAt: 1, startedAt: 1, endedAt: null, result: '', cost: 0, ...over,
});
const approval: Approval = { id: 'p', agentId: 'a', taskId: null, action: 'git push', details: '', status: 'pending', note: '', createdAt: 1, decidedAt: null };

async function office() {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const saved = new Map<string, string>();
  const signs: Signs[] = [];
  const flashes: string[] = [];
  const stage = new Proxy({} as Stage, {
    get: (_, name) => (...args: unknown[]) => {
      if (name === 'setAttention') signs.push(args[0] as Signs);
      if (name === 'flash') flashes.push(args[1] as string);
      return false;
    },
  });
  let emit: (e: ServerEvent) => void = () => {};
  let reconnect = () => {};
  const events: EventFeed = { subscribe: (fn, back) => { emit = fn; reconnect = back; } };
  const snapshot = {
    office: { name: '', width: 1, depth: 1, floorColor: '', wallColor: '', items: [] }, agents: [agent()], tasks: [task()], presets: [],
    providers: [{ id: 'claude', label: 'Claude Code', available: true }], settings: { language: 'en', defaultProvider: 'claude' } as Settings, schedules: [], approvals: [], visitors: [],
  } as unknown as Snapshot;
  const loads = { count: 0, gate: Promise.resolve() };
  const logs = { read: [] as string[] };
  const store = createOfficeStore({
    gateway: {
      loadState: async () => { loads.count++; const s = { ...snapshot }; await loads.gate; return s; },
      logs: async (id: string) => (logs.read.push(id), []),
    } as unknown as Gateway, events, stage,
    storage: { get: k => saved.get(k) ?? null, set: (k, v) => void saved.set(k, v) }, alerts: { show() {} } as unknown as Alerts, locale: 'en',
  });
  await store.actions.init();
  return { store, signs, flashes, saved, snapshot, loads, logs, emit: (e: ServerEvent) => emit(e), reconnect: () => reconnect() };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('flow history is hidden in this browser and can be restored', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, saved } = await office();

  store.setState({ flowTaskId: 't1' });
  store.actions.clearFlow(['t1', 't2']);
  assert.deepEqual(store.getState().flowHidden, ['t1', 't2']);
  assert.equal(store.getState().flowTaskId, null);
  assert.equal(saved.get('agent-office:flow-hidden'), '["t1","t2"]');

  store.actions.clearFlow(['t2', 't3']);
  assert.deepEqual(store.getState().flowHidden, ['t1', 't2', 't3']);
  store.actions.restoreFlow();
  assert.deepEqual(store.getState().flowHidden, []);
  assert.equal(saved.get('agent-office:flow-hidden'), '[]');
});

test('clearing one flow leaves a different selected flow open', async (c) => {
  c.after(() => mock.timers.reset());
  const { store } = await office();
  store.setState({
    tasks: {
      t1: task({ id: 't1' }),
      t2: task({ id: 't2' }),
      child: task({ id: 'child', parentId: 't2' }),
    },
    flowTaskId: 'child',
  });

  store.actions.clearFlow(['t1']);
  assert.equal(store.getState().flowTaskId, 'child');
  store.actions.clearFlow(['t2']);
  assert.equal(store.getState().flowTaskId, null);
});

test('a failure and an approval become signs, not flashes that fade', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, signs, flashes, emit } = await office();
  emit({ type: 'task', task: task({ status: 'error', result: 'boom', endedAt: 5 }) });
  assert.equal(signs.at(-1)!.a!.kind, 'error');
  emit({ type: 'approval', approval });
  assert.equal(signs.at(-1)!.a!.kind, 'approval');
  assert.equal(store.getState().attention.a!.kind, 'approval');
  assert.deepEqual(flashes, []);
  emit({ type: 'approval', approval: { ...approval, status: 'approved' } });
  assert.equal(signs.at(-1)!.a!.kind, 'error', 'still not dealt with');
});

test('unrelated updates leave the signs object alone', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, signs, emit } = await office();
  emit({ type: 'task', task: task({ status: 'error', endedAt: 5 }) });
  const before = store.getState().attention, sent = signs.length;
  emit({ type: 'task', task: task({ status: 'error', endedAt: 5, cost: 1 }) });
  assert.equal(store.getState().attention, before);
  assert.equal(signs.length, sent);
});

test('clicking a sign opens where it can be dealt with', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, emit } = await office();
  store.setState({ tab: 'log' });
  emit({ type: 'task', task: task({ status: 'error', endedAt: 5 }) });
  store.actions.openAttention('a');
  assert.equal(store.getState().selectedId, 'a');
  assert.equal(store.getState().tab, 'tasks');

  emit({ type: 'approval', approval });
  store.actions.openAttention('a');
  assert.equal(store.getState().drawerTab, 'approvals');
  assert.equal(store.getState().kanbanOpen, true);

  emit({ type: 'approval', approval: { ...approval, status: 'rejected' } });
  store.actions.dismissAttention(task({ status: 'error', endedAt: 5 }));
  emit({ type: 'agent', agent: agent({ queued: 1 }) });
  emit({ type: 'providerHolds', holds: { claude: { kind: 'auth', since: 0, until: null, message: '' } } });
  store.actions.openAttention('a');
  assert.equal(store.getState().modal, 'settings');
});

test('a dismissed failure is remembered in the browser', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, signs, saved, emit } = await office();
  const failed = task({ status: 'error', endedAt: 5 });
  emit({ type: 'task', task: failed });
  store.actions.dismissAttention(failed);
  assert.deepEqual(signs.at(-1), {});
  assert.equal(JSON.parse(saved.get('agent-office:attention-dismissed')!).a, 5);
});

test('when the feed comes back after a restart, what was missed is loaded', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, snapshot, loads, logs, reconnect, emit } = await office();
  assert.equal(store.getState().tasks.t1!.status, 'running');
  store.setState({ selectedId: 'gone', logs: { a: [{ ts: 1, kind: 'text', text: 'old', taskId: null }], gone: [] } });
  snapshot.tasks = [task({ status: 'error', result: 'Interrupted', endedAt: 5 })];
  snapshot.agents = [agent({ activity: '' })];
  reconnect();
  await settled();
  assert.equal(loads.count, 2);
  assert.equal(store.getState().tasks.t1!.status, 'error');
  assert.equal(store.getState().attention.a!.kind, 'error');
  assert.equal(store.getState().selectedId, null, 'whoever left in between is no longer selected');
  assert.deepEqual(logs.read, ['a']);
  assert.deepEqual(store.getState().logs, { a: [] });

  // Loaded again it says nothing to the player, who only came back to a working office
  emit({ type: 'task', task: task({ id: 't2' }) });
  assert.equal(store.getState().tasks.t2!.id, 't2');
  assert.deepEqual(store.getState().toasts, []);
});

test('events that arrive while the state reloads are newer than it, and win', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, snapshot, loads, reconnect, emit } = await office();
  let open = () => {};
  loads.gate = new Promise(resolve => { open = resolve; });
  snapshot.tasks = [task({ status: 'running' })];
  reconnect();
  reconnect(); // one load at a time
  emit({ type: 'task', task: task({ status: 'done', endedAt: 9 }) });
  assert.equal(loads.count, 2);
  open();
  await settled();
  assert.equal(store.getState().tasks.t1!.status, 'done');
});

test('a reload that fails leaves the office as it was, and the feed working', async (c) => {
  c.after(() => mock.timers.reset());
  const { store, loads, reconnect, emit } = await office();
  loads.gate = Promise.reject(new Error('down'));
  loads.gate.catch(() => {});
  reconnect();
  await settled();
  emit({ type: 'task', task: task({ status: 'done', endedAt: 9 }) });
  assert.equal(store.getState().tasks.t1!.status, 'done');
});

test('Esc leaves the full-screen drawer first, then closes it; it opens at its usual size again', async () => {
  const { store } = await office();
  const { actions } = store;
  actions.toggleKanban(true);
  actions.setDrawerFull(true);
  actions.escape();
  assert.deepEqual([store.getState().kanbanOpen, store.getState().drawerFull], [true, false]);
  actions.escape();
  assert.equal(store.getState().kanbanOpen, false);
  actions.setDrawerFull(true);
  actions.toggleKanban(false);
  actions.toggleKanban(true);
  assert.equal(store.getState().drawerFull, false);
  mock.timers.reset();
});

test('Esc closes the settings page and leaves the drawer as it was', async () => {
  const { store } = await office();
  const { actions } = store;
  actions.toggleKanban(true);
  actions.setDrawerFull(true);
  actions.openModal('settings');
  actions.escape();
  assert.deepEqual([store.getState().modal, store.getState().drawerFull], [null, true]);
  mock.timers.reset();
});
