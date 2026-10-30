// The live transcript of one task: the log from the server plus what arrived over the live feed.
import type { LogEntry, LogKind, TaskLog } from '../../shared/types.ts';

export interface Transcript extends TaskLog { taskId: string; loaded: boolean }
export type KindFilter = LogKind | 'all';

const KINDS: LogKind[] = ['task', 'text', 'tool', 'result', 'error', 'system'];
export const LOG_PREFIX: Partial<Record<LogKind, string>> = { task: '🎯 ', result: '✅ ', error: '⚠️ ' };

export const emptyTranscript = (taskId: string): Transcript => ({ taskId, entries: [], total: 0, limit: Infinity, loaded: false });

/** Entries have no id; the same entry arrives live without its detail and loaded with it. */
export const entryKey = (e: LogEntry) => `${e.ts}|${e.kind}|${e.text}`;

export const addLiveEntry = (t: Transcript, entry: LogEntry): Transcript =>
  ({ ...t, entries: [...t.entries, entry].slice(-t.limit), total: t.total + 1 });

/** The log wins for what it holds; what came in live after its last entry was not written yet when it was read. */
export function mergeLoaded(t: Transcript, log: TaskLog): Transcript {
  const known = new Set(log.entries.map(entryKey));
  const lastTs = log.entries.at(-1)?.ts ?? -Infinity;
  const newer = t.entries.filter(e => e.ts >= lastTs && !known.has(entryKey(e)));
  return { ...t, ...log, entries: [...log.entries, ...newer].slice(-log.limit), total: log.total + newer.length, loaded: true };
}

export function kindCounts(entries: LogEntry[]) {
  return KINDS.map(kind => ({ kind, count: entries.filter(e => e.kind === kind).length })).filter(k => k.count > 0);
}

export const filterEntries = (entries: LogEntry[], kind: KindFilter) => (kind === 'all' ? entries : entries.filter(e => e.kind === kind));

/** Keep the final result, but don't show the same task's streamed text a second time. */
export function visibleLogEntries(entries: LogEntry[]) {
  const finalText = new Map<string, Set<string>>();
  for (const entry of entries) {
    if ((entry.kind !== 'result' && entry.kind !== 'error') || !entry.taskId) continue;
    const texts = finalText.get(entry.taskId) ?? new Set<string>();
    texts.add(entry.text);
    finalText.set(entry.taskId, texts);
  }
  return entries.filter(entry => !(entry.kind === 'text' && entry.taskId && finalText.get(entry.taskId)?.has(entry.text)));
}
