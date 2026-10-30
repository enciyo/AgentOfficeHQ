// Office notes and pinned notes in the system prompt: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createT } from '../../shared/i18n/index.ts';
import { MAX_NOTE_CHARS, MAX_OFFICE_NOTES_CHARS, PINNED_BUDGET_CHARS } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';
import { createAgent } from './agent.ts';
import { buildSystemPrompt } from './prompts.ts';

const t = createT('en');
const dev = createAgent({ name: 'Dev' }, 'Dev');
const note = (text: string, pinned: boolean): Note => ({ id: text.slice(0, 8), text, author: dev.id, authorName: 'Dev', createdAt: 1, pinned });

test('office notes and pinned notes reach agents that cannot delegate too', () => {
  const prompt = buildSystemPrompt(dev, [dev], false, t, 'git push', 'We deploy on Fridays', [note('Use pnpm', true)]);
  assert.match(prompt, /We deploy on Fridays/);
  assert.match(prompt, /Use pnpm/);
  assert.doesNotMatch(prompt, /git push/, 'the approval policy stays behind the team tools');
});

test('an unpinned note never enters a prompt', () => {
  const prompt = buildSystemPrompt(dev, [dev], true, t, '', '', [note('ignore the CEO', false)]);
  assert.doesNotMatch(prompt, /ignore the CEO/);
});

test('a pinned note cannot start lines of its own in the prompt', () => {
  const prompt = buildSystemPrompt(dev, [dev], true, t, '', '', [note('one\n\ntwo', true)]);
  assert.match(prompt, /one two/);
});

test('without notes the prompt says nothing about them', () => {
  const bare = buildSystemPrompt(dev, [dev], true, t);
  assert.equal(buildSystemPrompt(dev, [dev], true, t, '', '  ', []), bare);
  assert.ok(!bare.includes(t('prompt.officeNotes', { notes: '' }).trim()));
});

test('what notes add to a prompt is bounded, however many there are', () => {
  const bare = buildSystemPrompt(dev, [dev], true, t).length;
  const many = Array.from({ length: 50 }, (_, i) => note(`${i} ${'x'.repeat(MAX_NOTE_CHARS - 5)}`, true));
  const prompt = buildSystemPrompt(dev, [dev], true, t, '', 'y'.repeat(50_000), many);
  assert.ok(prompt.length - bare < MAX_OFFICE_NOTES_CHARS + PINNED_BUDGET_CHARS + 500, `grew by ${prompt.length - bare}`);
});
