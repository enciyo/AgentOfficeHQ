// The team's shared notes: agents write, only the CEO pins: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NOTE_CHARS } from '../../shared/knowledge.ts';
import type { Settings } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import { DomainError } from '../domain/errors.ts';
import type { DomainEvent, State, StateStore } from '../domain/ports.ts';
import { Knowledge } from './knowledge.ts';
import type { Notifier } from './notifier.ts';
import { Translator } from './translator.ts';

function setup() {
  const dev = createAgent({ name: 'Dev' }, 'Dev');
  const state = { agents: [dev], tasks: [{ id: 't1' }], settings: { language: 'en' } as Settings } as unknown as State;
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const events: DomainEvent[] = [];
  const logged: string[] = [];
  const notify = { publish: (e: DomainEvent) => events.push(e), log: (_: string, __: string, text: string) => logged.push(text) } as unknown as Notifier;
  return { dev, state, events, logged, knowledge: new Knowledge(store, notify, new Translator(store)) };
}

const failsWith = (status: number) => (e: unknown) => e instanceof DomainError && e.status === status;

test('what an agent remembers is stored with its author and time, and stays unpinned', () => {
  const { dev, state, events, logged, knowledge } = setup();
  const note = knowledge.remember(dev.id, 't1', ' use pnpm ');
  assert.equal(note.text, 'use pnpm');
  assert.equal(note.pinned, false);
  assert.equal(note.author, dev.id);
  assert.equal(note.authorName, 'Dev');
  assert.equal(note.taskId, 't1');
  assert.ok(note.createdAt > 0);
  assert.deepEqual(state.notes, [note]);
  assert.deepEqual(events.at(-1), { type: 'notes', notes: state.notes });
  assert.equal(logged.length, 1);
});

test('an unknown task is not recorded on the note', () => {
  const { dev, knowledge } = setup();
  assert.equal(knowledge.remember(dev.id, 'gone', 'x').taskId, undefined);
});

test('only someone in the office can remember, and only something of a sensible size', () => {
  const { dev, knowledge } = setup();
  assert.throws(() => knowledge.remember('stranger', undefined, 'x'), failsWith(404));
  assert.throws(() => knowledge.remember(dev.id, undefined, '   '), failsWith(400));
  assert.throws(() => knowledge.remember(dev.id, undefined, 'x'.repeat(MAX_NOTE_CHARS + 1)), failsWith(400));
});

test('the CEO pins, edits and deletes', () => {
  const { dev, state, events, knowledge } = setup();
  const note = knowledge.remember(dev.id, undefined, 'one');
  assert.equal(knowledge.update(note.id, { pinned: true }).pinned, true);
  const edited = knowledge.update(note.id, { text: ' two ' });
  assert.equal(edited.text, 'two');
  assert.equal(edited.pinned, true, 'an edit keeps the pin');
  assert.throws(() => knowledge.update(note.id, { text: ' ' }), failsWith(400));
  assert.equal(note.text, 'two');
  knowledge.remove(note.id);
  assert.deepEqual(state.notes, []);
  assert.deepEqual(events.at(-1), { type: 'notes', notes: [] });
  assert.throws(() => knowledge.remove(note.id), failsWith(404));
  assert.throws(() => knowledge.update(note.id, { pinned: true }), failsWith(404));
});

test('recall reads the notes, on a state saved before there were any too', () => {
  const { dev, knowledge } = setup();
  assert.match(knowledge.recall('pnpm').text, /./);
  knowledge.remember(dev.id, undefined, 'use pnpm');
  assert.match(knowledge.recall('pnpm').text, /use pnpm/);
});
