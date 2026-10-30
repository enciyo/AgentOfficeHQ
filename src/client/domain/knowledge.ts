// View logic of the Knowledge tab.
import { PINNED_BUDGET_CHARS, pinnedForPrompt } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';

/** Pinned notes in the order prompts take them, each saying whether it made it; then agents' unverified notes, newest first. */
export function knowledgeView(notes: Note[]) {
  const { included, omitted, used } = pinnedForPrompt(notes);
  return {
    pinned: [...included.map(note => ({ note, inPrompt: true })), ...omitted.map(note => ({ note, inPrompt: false }))],
    unverified: notes.filter(n => !n.pinned).sort((a, b) => b.createdAt - a.createdAt),
    used,
    budget: PINNED_BUDGET_CHARS,
  };
}
