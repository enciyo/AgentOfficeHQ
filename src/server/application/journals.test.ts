// Writing a chain's journal to docs/<request-code>/journal.md: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings, Task } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import type { FileTree, State, StateStore } from '../domain/ports.ts';
import { Journals } from './journals.ts';
import { Translator } from './translator.ts';

const task = (over: Partial<Task>) => ({
  id: '1', agentId: '', from: 'user', prompt: 'Add a remember me box', parentId: null, depth: 0, kind: 'task', status: 'done',
  createdAt: 1, startedAt: 1, endedAt: 2, result: '', cost: 0, ...over,
}) as Task;

function setup(journalFile: boolean) {
  const pm = createAgent({ name: 'Product Manager' }, 'Product');
  const dev = createAgent({ name: 'Tech Lead' }, 'Development');
  const root = task({ id: 'r', agentId: pm.id, files: ['docs/login-page/1-requirements.md'] });
  const sub = task({ id: 's', agentId: dev.id, from: pm.id, parentId: 'r', depth: 1, createdAt: 5, merge: 'conflict', branch: 'agent/tech-lead' });
  const state = {
    agents: [pm, dev], tasks: [root, sub],
    settings: { language: 'en', defaultCwd: '/work', journalFile, playerName: 'Mustafa' } as Settings,
  } as unknown as State;
  const store: StateStore = { state, fresh: false, save() {}, saveNow() {} };
  const written: [string, string, string][] = [];
  const files = { write: (root: string, rel: string, text: string) => (written.push([root, rel, text]), true) } as unknown as FileTree;
  return { state, sub, written, journals: new Journals(store, files, new Translator(store), 0) };
}

test('the journal goes to the request folder of the chain, with the CEO by name and conflicts on top', () => {
  const { journals, written } = setup(true);
  assert.equal(journals.write('r'), 'docs/login-page/journal.md');
  const [root, rel, text] = written[0]!;
  assert.deepEqual([root, rel], ['/work', 'docs/login-page/journal.md']);
  assert.match(text, /# Task journal · login-page/);
  assert.match(text, /Mustafa → Product Manager/);
  assert.match(text, /## Needs attention\n\n- 🔀 #s · Product Manager → Tech Lead: Conflict: not merged \(`agent\/tech-lead`\)/);
});

test('nothing is written when the setting is off or the chain has no request code', () => {
  const off = setup(false);
  assert.equal(off.journals.write('r'), null);
  off.journals.touch(off.sub);
  assert.equal(off.written.length, 0);
  const on = setup(true);
  on.state.tasks[0]!.files = ['notes.md'];
  assert.equal(on.journals.write('r'), null);
  assert.equal(on.written.length, 0);
});

test('changes in a row write the chain once, found from any of its tasks', async () => {
  const { journals, written, sub } = setup(true);
  journals.touch(sub);
  journals.touch(sub);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(written.length, 1);
  assert.equal(written[0]![1], 'docs/login-page/journal.md');
});
