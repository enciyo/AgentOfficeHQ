// A chain's handoffs in order, one short entry each: who handed what to whom, where the work went and whether it is in.
// Pure: the Flow and Outputs tabs show it, and the server can write it to docs/<request-code>/journal.md for agents.
import { chainRootId } from './chain.ts';
import type { TKey, Translate } from './i18n/index.ts';
import type { MergeStatus, Task, TaskStatus } from './types.ts';

/**
 * What became of one handoff. in: done and, with worktrees, merged or with nothing to merge. queued/running: still
 * going. pending: its changes wait for the CEO. conflict: done, but not merged. rejected: the CEO dropped its changes.
 * failed / interrupted: the run ended in an error (a restart cut it off). cancelled: stopped on purpose.
 */
export type JournalState = 'in' | 'queued' | 'running' | 'pending' | 'conflict' | 'rejected' | 'failed' | 'interrupted' | 'cancelled';

export interface JournalEntry {
  taskId: string;
  kind: Task['kind'];
  /** Agent id of whoever handed it over, or 'user' for the CEO. */
  from: string;
  /** Agent id of whoever got it. */
  to: string;
  at: number;
  /** The task's first line, short. */
  summary: string;
  status: TaskStatus;
  state: JournalState;
  repo?: string;
  branch?: string;
  merge?: MergeStatus;
  files: string[];
  /** The retry or resolver that took this one over, when there is one that was not cancelled. */
  followedBy?: string;
  /** Needs the CEO: a conflict, a merge waiting for approval, a failed or interrupted run that nothing took over. */
  flagged: boolean;
}

export interface Journal {
  rootId: string;
  /** The request code the chain writes under (docs/<code>/), when its files say. */
  code: string | null;
  entries: JournalEntry[];
  /** The flagged entries, oldest first: what is not in or needs resolving. */
  flagged: JournalEntry[];
}

/** States that need the CEO when nothing took the work over. */
const NEEDS_YOU = new Set<JournalState>(['pending', 'conflict', 'failed', 'interrupted']);

export function journalState(task: Task): JournalState {
  if (task.status === 'queued' || task.status === 'running' || task.status === 'cancelled') return task.status;
  if (task.status === 'error') return task.interrupted ? 'interrupted' : 'failed';
  if (task.merge === 'pending' || task.merge === 'conflict' || task.merge === 'rejected') return task.merge;
  return 'in';
}

// A dot-name is never a request code (and `..` would leave docs/)
const DOCS = /^docs\/([^/.][^/]*)\//;

/** The request code most of these files are written under, or null. */
export function requestCode(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const code = DOCS.exec(f)?.[1];
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [code, n] of counts) if (!best || n > counts.get(best)!) best = code;
  return best;
}

/** The tasks of the chain `rootId` starts, in the order they were handed over. */
function chainTasks(tasks: Task[], rootId: string) {
  const kids = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const out: Task[] = [];
  const walk = tasks.filter(t => t.id === rootId);
  for (let t = walk.pop(); t; t = walk.pop()) {
    out.push(t);
    walk.push(...(kids.get(t.id) ?? []));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id));
}

const firstLine = (text: string) => {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/** The journal of the chain that `taskId` belongs to (any task of it will do). Null when the task is unknown. */
export function chainJournal(tasks: Task[], taskId: string): Journal | null {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return null;
  const rootId = chainRootId(tasks, task);
  const chain = chainTasks(tasks, rootId);
  const followers = new Map<string, string>();
  for (const t of chain) {
    const of = t.retryOf ?? t.resolves;
    if (of && t.status !== 'cancelled' && !followers.has(of)) followers.set(of, t.id);
  }
  const entries = chain.map((t): JournalEntry => {
    const state = journalState(t);
    const followedBy = followers.get(t.id);
    return {
      taskId: t.id, kind: t.kind, from: t.from, to: t.agentId, at: t.createdAt, summary: firstLine(t.prompt),
      status: t.status, state, files: t.files ?? [], flagged: NEEDS_YOU.has(state) && !followedBy,
      ...(t.repo ? { repo: t.repo } : {}), ...(t.branch ? { branch: t.branch } : {}), ...(t.merge ? { merge: t.merge } : {}),
      ...(followedBy ? { followedBy } : {}),
    };
  });
  return { rootId, code: requestCode(entries.flatMap(e => e.files)), entries, flagged: entries.filter(e => e.flagged) };
}

export const STATE_ICON: Record<JournalState, string> = {
  in: '✅', queued: '⏳', running: '🔄', pending: '🙋', conflict: '🔀', rejected: '🚫', failed: '❌', interrupted: '⚡', cancelled: '⏹',
};

export const stateLabel = (t: Translate, state: JournalState) => t(`journal.state.${state}` as TKey);

/** "2026-11-18 07:05" in the local time zone. */
export function journalTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Who handed it over to whom, by name; `nameOf('user')` is the CEO. */
export const handoffLine = (e: JournalEntry, nameOf: (id: string) => string) => `${nameOf(e.from)} → ${nameOf(e.to)}`;

/** The journal as Markdown, for docs/<code>/journal.md and for copying. */
export function journalMarkdown(journal: Journal, nameOf: (id: string) => string, t: Translate, now = Date.now()) {
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const head = (e: JournalEntry) => `${STATE_ICON[e.state]} #${e.taskId} · ${handoffLine(e, nameOf)}${e.kind === 'report' ? ` · ${t('journal.report')}` : ''}`;
  const lines = [
    `# ${t('journal.title')}${journal.code ? ` · ${journal.code}` : ''}`,
    '',
    `_${t('journal.updated', { time: journalTime(now), n: journal.entries.length })}_`,
    '',
  ];
  if (journal.flagged.length) {
    lines.push(`## ${t('journal.needsYou')}`, '');
    for (const e of journal.flagged) lines.push(`- ${head(e)}: ${stateLabel(t, e.state)}${e.branch ? ` (${code(e.branch)})` : ''}`);
    lines.push('');
  }
  lines.push(`## ${t('journal.handoffs')}`, '');
  journal.entries.forEach((e, i) => {
    lines.push(`### ${i + 1}. ${head(e)}`, '', `${journalTime(e.at)} · ${stateLabel(t, e.state)}`, '');
    if (e.summary) lines.push(`> ${e.summary}`, '');
    if (e.repo) lines.push(`- ${t('journal.repo')}: ${code(e.repo)}`);
    if (e.branch) lines.push(`- ${t('journal.branch')}: ${code(e.branch)}`);
    if (e.files.length) lines.push(`- ${t('journal.files')}: ${e.files.map(code).join(', ')}`);
    if (e.followedBy) lines.push(`- ${t('journal.followedBy', { id: e.followedBy })}`);
    if (lines.at(-1) !== '') lines.push('');
  });
  return lines.join('\n');
}
