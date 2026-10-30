// Recurring tasks turn into ordinary tasks when due: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import type { DomainEvent, State, StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import { Schedules } from './schedules.ts';
import type { Tasks } from './tasks.ts';
import { Translator } from './translator.ts';

function setup() {
  const dev = createAgent({ name: 'Dev' }, 'Dev');
  const state = { agents: [dev], tasks: [], schedules: [], settings: { language: 'en' } as Settings } as unknown as State;
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const given: string[] = [];
  const events: DomainEvent[] = [];
  const tasks = {
    create(agentId: string, prompt: string, { scheduleId }: { scheduleId?: string } = {}) {
      given.push(`${agentId}:${prompt}`);
      (state.tasks as unknown[]).push({ agentId, prompt, scheduleId, status: 'queued' });
    },
  } as unknown as Tasks;
  const notify = { publish: (e: DomainEvent) => events.push(e) } as unknown as Notifier;
  return { dev, state, given, events, schedules: new Schedules(store, notify, tasks, new Translator(store)) };
}

test('a due schedule gives its task once and moves to the next slot', () => {
  const { dev, given, events, schedules } = setup();
  const now = Date.now();
  const s = schedules.create({ agentId: dev.id, prompt: ' daily report ', intervalMinutes: 60 }, now);
  assert.equal(s.prompt, 'daily report');
  assert.equal(s.nextRunAt, now + 3_600_000);
  schedules.tick(now + 1000);
  assert.deepEqual(given, []);
  schedules.tick(s.nextRunAt);
  schedules.tick(s.nextRunAt - 1); // nextRunAt already moved on
  assert.deepEqual(given, [`${dev.id}:daily report`]);
  assert.equal(s.nextRunAt, now + 2 * 3_600_000);
  assert.ok(events.some(e => e.type === 'schedules'));

  schedules.update(s.id, { enabled: false });
  schedules.tick(s.nextRunAt + 1);
  assert.equal(given.length, 1, 'paused schedules do not run');
});

test('a paused office gives nothing, and one catch-up run follows when it resumes', () => {
  const { dev, state, given, schedules } = setup();
  const now = Date.now();
  const s = schedules.create({ agentId: dev.id, prompt: 'report', intervalMinutes: 60 }, now);
  state.settings.paused = true;
  schedules.tick(s.nextRunAt + 10 * 3_600_000);
  assert.deepEqual(given, [], 'a long pause does not pile up paid runs');
  state.settings.paused = false;
  schedules.tick(now + 10 * 3_600_000 + 3_600_000);
  assert.equal(given.length, 1);
});

test('validation, and schedules of agents who left are dropped', () => {
  const { dev, state, schedules } = setup();
  assert.throws(() => schedules.create({ agentId: dev.id, prompt: 'x', intervalMinutes: 1 }));
  assert.throws(() => schedules.create({ agentId: 'nobody', prompt: 'x', intervalMinutes: 60 }));
  schedules.create({ agentId: dev.id, prompt: 'x', intervalMinutes: 60 });
  state.agents = [];
  schedules.tick();
  assert.equal(state.schedules.length, 0);
});

test('a schedule whose last copy still waits in the queue gives no other, and owes nothing for the slots it skipped', () => {
  const { dev, state, given, schedules } = setup();
  const start = Date.now();
  const s = schedules.create({ agentId: dev.id, prompt: 'check', intervalMinutes: 30 }, start);
  const HOUR = 3_600_000;
  for (let h = 1; h <= 48; h++) schedules.tick(start + h * HOUR); // behind a hold of two days
  assert.equal(given.length, 1);
  assert.ok(s.nextRunAt > start + 48 * HOUR, 'no slot is left due');
  assert.equal(s.lastRunAt, start + HOUR);

  state.tasks[0]!.status = 'running';
  schedules.tick(start + 48 * HOUR + 1000);
  assert.equal(given.length, 1, 'the next copy waits for its own slot');
  schedules.tick(s.nextRunAt);
  assert.equal(given.length, 2);
});

test('another schedule\'s queued task does not hold a schedule back', () => {
  const { dev, given, schedules } = setup();
  const start = Date.now();
  schedules.create({ agentId: dev.id, prompt: 'one', intervalMinutes: 30 }, start);
  schedules.create({ agentId: dev.id, prompt: 'two', intervalMinutes: 30 }, start);
  schedules.tick(start + 3_600_000);
  assert.equal(given.length, 2);
});
