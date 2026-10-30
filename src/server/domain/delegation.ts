// Delegation/report chain rules. Pure functions over the task list.
import type { Translate } from '../../shared/i18n/index.ts';
import { chainRootId } from '../../shared/chain.ts';
import type { Agent, Task, TaskStatus } from '../../shared/types.ts';

export const MAX_DELEGATION_DEPTH = 4;

/** At startup a held report goes out by itself only if its chain was active this recently: sending one starts a paid run. */
export const AUTO_RELEASE_WINDOW_MS = 24 * 3_600_000;

const isOpen = (t: Task) => t.status === 'queued' || t.status === 'running';

/** `rootId` and every task below it (delegations, reports, decision messages). */
export function subtree(tasks: Task[], rootId: string) {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
  }
  return ids;
}

/**
 * Is anything under `rootId` still unfinished: a queued/running task below it, a report held below it, or a pending
 * approval asked from it or from anything below it (`pending` = task ids with an undecided approval)?
 */
export function hasOpenUnder(tasks: Task[], rootId: string, pending: string[] = []) {
  const ids = subtree(tasks, rootId);
  if (pending.some(id => ids.has(id))) return true;
  ids.delete(rootId);
  return tasks.some(t => ids.has(t.id) && (isOpen(t) || t.awaiting));
}

/** Did a restart cut off a run in the chain under (and including) `rootId`? */
export function cutOffUnder(tasks: Task[], rootId: string) {
  const ids = subtree(tasks, rootId);
  return tasks.some(t => ids.has(t.id) && t.interrupted);
}

/** When the chain under (and including) `rootId` last had something end. */
export function lastEndedUnder(tasks: Task[], rootId: string) {
  const ids = subtree(tasks, rootId);
  return tasks.reduce((last, t) => (ids.has(t.id) ? Math.max(last, t.endedAt ?? 0) : last), 0);
}

/**
 * What a held report says: the last turn its own agent ended under it, where a lead merges the parts or fails to.
 * A cancelled turn merged nothing, and with no turn at all the report keeps its own result.
 */
export function lastTurnUnder(tasks: Task[], held: Task) {
  const ids = subtree(tasks, held.id);
  ids.delete(held.id);
  const turns = tasks.filter(t => ids.has(t.id) && t.agentId === held.agentId && (t.status === 'done' || t.status === 'error'));
  return turns.reduce((last, t) => (last === held || (t.endedAt ?? 0) >= (last.endedAt ?? 0) ? t : last), held);
}

/** The nearest ancestor whose report is held and whose last open piece just finished, if any. */
export function releasableAncestor(tasks: Task[], finished: Task, pending: string[] = []): Task | null {
  const byId = (id: string | null) => tasks.find(t => t.id === id);
  for (let p = byId(finished.parentId); p; p = byId(p.parentId)) {
    if (p.awaiting) return hasOpenUnder(tasks, p.id, pending) ? null : p;
  }
  return null;
}

/**
 * What a browser loads of the task list: the newest tasks, and every chain still going as a whole, because it works
 * out a chain's root and usage from what it has.
 */
export function snapshotTasks(tasks: Task[], newest: number) {
  const keep = new Set(tasks.slice(-newest).map(t => t.id));
  const roots = new Set(tasks.filter(t => isOpen(t) || t.awaiting).map(t => chainRootId(tasks, t)));
  for (const root of roots) for (const id of subtree(tasks, root)) keep.add(id);
  return tasks.filter(t => keep.has(t.id));
}

/** Message a worker's report becomes when it is sent to whoever assigned the task. */
export function reportPrompt(worker: Agent, task: Task, status: TaskStatus, result: string, t: Translate, landed: Task = task, again = false) {
  const report = t('report.message', {
    worker: worker.name, role: worker.role, id: task.id, verdict: t(status === 'done' ? 'report.done' : 'report.failed'),
    prompt: task.prompt, result: (result || t('report.empty')) + mergeWarning(landed, t),
  });
  // `again`: this task reported before. A report turn's follow-up goes out as that report, the one its reader knows
  const follow = landed.correction ? landed : task;
  if (!follow.correction && !again) return report;
  const id = follow === task ? follow.resolves ?? follow.retryOf ?? task.id : task.id;
  return t(follow.resolves ? 'report.resolving' : 'report.correction', { id, report });
}

/** A run can end well and its work still not be in the shared checkout: whoever reads the report must know. */
function mergeWarning(task: Task, t: Translate) {
  if (task.merge === 'conflict') return '\n\n' + t('report.mergeConflict', { branch: task.branch ?? '', error: (task.mergeNote ?? '').slice(0, 500) });
  if (task.merge === 'rejected') return '\n\n' + t('report.mergeRejected', { note: task.mergeNote ? t('approval.note', { note: task.mergeNote }) : '' });
  return '';
}

/** What an agent is told when a task continues after a restart cut its run off. */
export const resumePrompt = (task: Task, t: Translate) => t('resume.message', { prompt: task.prompt });
/** The same task again in its session, after a CLI limit or login failure ended the last run. */
export const retryPrompt = (task: Task, t: Translate) => t('retry.message', { prompt: task.prompt });

export const delegationPrompt = (boss: Agent | undefined, prompt: string, t: Translate) =>
  t('delegation.assigned', { boss: boss ? `${boss.name} (${boss.role})` : t('delegation.someone'), prompt });
