// What of the office's knowledge enters a system prompt, and how much. Shared: the server builds prompts from it,
// the Knowledge tab shows the CEO what did not fit.
import type { Note } from './types.ts';

/** Longest single note. */
export const MAX_NOTE_CHARS = 1000;
/** How much of the office notes setting enters a prompt. */
export const MAX_OFFICE_NOTES_CHARS = 2000;
/** How much pinned note text enters a prompt. */
export const PINNED_BUDGET_CHARS = 4000;

/** A note as one line, so its text cannot look like more entries or a heading. */
export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export const officeNotesForPrompt = (text = '') => text.trim().slice(0, MAX_OFFICE_NOTES_CHARS);

/** Pinned notes that fit the budget, the oldest first: a prompt stays the same until the CEO changes the pins. */
export function pinnedForPrompt(notes: Note[]) {
  const included: Note[] = [];
  const omitted: Note[] = [];
  let used = 0;
  for (const note of notes.filter(n => n.pinned).sort((a, b) => a.createdAt - b.createdAt)) {
    const size = oneLine(note.text).length;
    if (used + size > PINNED_BUDGET_CHARS) { omitted.push(note); continue; }
    included.push(note);
    used += size;
  }
  return { included, omitted, used };
}
