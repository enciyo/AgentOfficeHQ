// Rules of the team's shared notes: searching them, labelling what a search returns, and how many are kept.
import type { Translate } from '../../shared/i18n/index.ts';
import { oneLine } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';

/** Most notes one recall returns. */
export const RECALL_LIMIT = 20;
/** Unverified notes kept; pinned ones are the CEO's and always stay. */
export const MAX_UNVERIFIED_NOTES = 300;

const hits = (note: Note, words: string[]) => {
  const text = note.text.toLowerCase();
  return words.filter(w => text.includes(w)).length;
};

/** Notes matching any word of the query (the latest ones without a query): pinned first, then the best match, then the newest. */
export function recallNotes(notes: Note[], query: string, limit = RECALL_LIMIT) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return notes
    .map(note => ({ note, score: hits(note, words) }))
    .filter(n => !words.length || n.score > 0)
    .sort((a, b) => Number(b.note.pinned) - Number(a.note.pinned) || b.score - a.score || b.note.createdAt - a.note.createdAt)
    .slice(0, limit)
    .map(n => n.note);
}

/** What an agent reads back. Agent-written text is one line each under a label of ours, so it cannot pass as pinned. */
export function recallText(notes: Note[], t: Translate) {
  if (!notes.length) return t('recall.none');
  const line = (n: Note, tag = '') => `- ${tag}${t('recall.line', { text: oneLine(n.text), author: oneLine(n.authorName), date: new Date(n.createdAt).toISOString().slice(0, 10) })}`;
  const pinned = notes.filter(n => n.pinned).map(n => line(n));
  const unverified = notes.filter(n => !n.pinned).map(n => line(n, `${t('recall.unverifiedTag')} `));
  return [
    ...(pinned.length ? [t('recall.pinned'), ...pinned] : []),
    ...(unverified.length ? [t('recall.unverified'), ...unverified] : []),
  ].join('\n');
}

/** Drops the oldest unverified notes beyond the cap. */
export function keepNotes(notes: Note[]) {
  const dropped = new Set(notes.filter(n => !n.pinned).sort((a, b) => b.createdAt - a.createdAt).slice(MAX_UNVERIFIED_NOTES));
  return notes.filter(n => !dropped.has(n));
}
