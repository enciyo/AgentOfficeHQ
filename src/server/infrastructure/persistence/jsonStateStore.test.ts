// State file safety: hourly backups and recovery from a broken state.json: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from './jsonStateStore.ts';

const defaults = { cwd: '/work', language: 'en' as const };

test('writes keep an hourly backup, and a broken state file is restored from it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-'));
  const file = path.join(dir, 'state.json');
  const first = new JsonStateStore(file, defaults);
  assert.equal(first.fresh, true);
  first.state.office.name = 'Kept HQ';
  first.saveNow();
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^state-\d{8}-\d{2}\.json$/);

  fs.writeFileSync(file, '{ broken');
  const second = new JsonStateStore(file, defaults);
  assert.equal(second.fresh, false);
  assert.equal(second.state.office.name, 'Kept HQ');
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-')), 'the broken file is kept aside');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agents saved before the default CLI existed follow it, unless they picked another CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { language: 'en' }, agents: [{ id: 'a', provider: 'claude' }, { id: 'b', provider: 'codex' }], tasks: [] }));
  const store = new JsonStateStore(file, defaults);
  assert.equal(store.state.settings.defaultProvider, 'claude');
  assert.deepEqual(store.state.agents.map(a => a.provider), ['', 'codex']);
  store.saveNow();
  store.state.agents[0]!.provider = 'claude'; // picked by hand afterwards: kept on the next load
  store.saveNow();
  assert.equal(new JsonStateStore(file, defaults).state.agents[0]!.provider, 'claude');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed runs saved when their cost was thrown away load as unknown, not $0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const file = path.join(dir, 'state.json');
  const task = (id: string, over: object) => ({ id, status: 'error', startedAt: 1, cost: 0, ...over });
  fs.writeFileSync(file, JSON.stringify({ tasks: [task('failed', {}), task('stopped', { status: 'cancelled' }), task('never', { startedAt: null }), task('done', { status: 'done' }), task('paid', { cost: 1 })] }));
  const { tasks, settings } = new JsonStateStore(file, defaults).state;
  assert.deepEqual(tasks.map(t => t.cost), [null, null, 0, 0, 1]);
  assert.equal(settings.limits.dailyRunMinutes, 0, 'off until someone sets it');
  fs.rmSync(dir, { recursive: true });
});

test('state saved before the process lifecycle settings loads with safe defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { limits: { taskTimeoutMin: 5 } } }));
  const { settings } = new JsonStateStore(file, defaults).state;
  assert.equal(settings.resumeInterrupted, false, 'resuming starts paid runs: only on request');
  assert.equal(settings.limits.taskTimeoutMin, 5);
  assert.equal(settings.limits.silenceTimeoutMin, 30);
  assert.ok(settings.limits.chainMaxTurns > 0, 'an old state file gets the chain limits too');
  assert.ok(settings.limits.chainBudgetUsd > 0);
  fs.rmSync(dir, { recursive: true });
});

test('a state saved before office notes existed loads, and notes survive a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { language: 'en' }, agents: [], tasks: [] }));
  const store = new JsonStateStore(file, defaults);
  assert.equal(store.state.settings.officeNotes, '');
  assert.deepEqual(store.state.notes, []);
  store.state.notes = [{ id: 'n', text: 'x', author: 'a', authorName: 'Dev', createdAt: 1, pinned: true }];
  store.saveNow();
  assert.deepEqual(new JsonStateStore(file, defaults).state.notes, store.state.notes);
  fs.rmSync(dir, { recursive: true, force: true });
});
