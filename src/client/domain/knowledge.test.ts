// The Knowledge tab: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_NOTE_CHARS, PINNED_BUDGET_CHARS } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';
import { knowledgeView } from './knowledge.ts';

const note = (id: string, pinned: boolean, createdAt: number, text = 'x'): Note => ({ id, text, author: 'a', authorName: 'Dev', createdAt, pinned });

test('notes are split into pinned (prompt order) and unverified (newest first)', () => {
  const view = knowledgeView([note('u1', false, 1), note('p2', true, 3), note('u2', false, 2), note('p1', true, 1)]);
  assert.deepEqual(view.pinned.map(p => p.note.id), ['p1', 'p2']);
  assert.deepEqual(view.unverified.map(n => n.id), ['u2', 'u1']);
  assert.deepEqual(view.pinned.map(p => p.inPrompt), [true, true]);
  assert.equal(view.used, 2);
  assert.equal(view.budget, PINNED_BUDGET_CHARS);
});

test('a pinned note past the budget is flagged, so the CEO knows agents do not get it', () => {
  const big = 'x'.repeat(MAX_NOTE_CHARS);
  const view = knowledgeView(Array.from({ length: 5 }, (_, i) => note(`n${i}`, true, i, big)));
  assert.deepEqual(view.pinned.map(p => p.inPrompt), [true, true, true, true, false]);
});
