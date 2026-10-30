// What of the office's knowledge may enter a system prompt, and how much: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Note } from './types.ts';
import { MAX_NOTE_CHARS, MAX_OFFICE_NOTES_CHARS, PINNED_BUDGET_CHARS, officeNotesForPrompt, pinnedForPrompt } from './knowledge.ts';

const note = (id: string, text: string, pinned: boolean, createdAt = 1): Note => ({ id, text, author: 'a', authorName: 'Dev', createdAt, pinned });

test('only pinned notes enter a prompt', () => {
  const { included, omitted } = pinnedForPrompt([note('a', 'unverified', false), note('b', 'pinned', true)]);
  assert.deepEqual(included.map(n => n.id), ['b']);
  assert.deepEqual(omitted, []);
});

test('pinned notes stop at the budget, the oldest first, and what did not fit is named', () => {
  const big = 'x'.repeat(MAX_NOTE_CHARS);
  const notes = Array.from({ length: 8 }, (_, i) => note(`n${i}`, big, true, 10 - i));
  const { included, omitted, used } = pinnedForPrompt(notes);
  assert.ok(used <= PINNED_BUDGET_CHARS);
  assert.equal(included[0]!.id, 'n7');
  assert.equal(included.length + omitted.length, 8);
  assert.ok(omitted.length > 0);
});

test('a smaller pinned note still fits after a big one did not', () => {
  const big = 'x'.repeat(MAX_NOTE_CHARS);
  const notes = [...Array.from({ length: 3 }, (_, i) => note(`n${i}`, big, true, i)), note('n3', big.slice(10), true, 3), note('over', big, true, 5), note('small', 'tiny', true, 6)];
  const { included, omitted } = pinnedForPrompt(notes);
  assert.deepEqual(omitted.map(n => n.id), ['over']);
  assert.ok(included.some(n => n.id === 'small'));
});

test('office notes are trimmed and cut at their cap', () => {
  assert.equal(officeNotesForPrompt('  use pnpm \n'), 'use pnpm');
  assert.equal(officeNotesForPrompt(''), '');
  assert.equal(officeNotesForPrompt('y'.repeat(MAX_OFFICE_NOTES_CHARS + 50)).length, MAX_OFFICE_NOTES_CHARS);
});
