// How much of a run the log keeps, and what of it travels.
import type { LogEntry } from '../../shared/types.ts';

/** The most of one tool call's input the log keeps; a file write would otherwise copy the whole file into it. */
export const MAX_LOG_DETAIL = 4000;
/** The newest entries of a task returned at once; the rest stay on disk. */
export const TASK_LOG_LIMIT = 1000;

export const capDetail = (text: string) => (text.length > MAX_LOG_DETAIL ? text.slice(0, MAX_LOG_DETAIL) + '…' : text);

/** An entry as it travels live and in recent logs: the detail stays on disk, only its existence is told. */
export function briefEntry(entry: LogEntry): LogEntry {
  if (entry.detail === undefined) return entry;
  const { detail: _, ...rest } = entry;
  return { ...rest, hasDetail: true };
}
