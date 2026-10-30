// How much a delegation chain has used. A report lowers the depth again, so only counting the turns under the root
// stops A->B->report->A loops. Pure: the server decides with it, the browser explains the wait with it.
import type { Limits, Task } from './types.ts';

export interface ChainBlock { kind: 'chainTurns' | 'chainBudget'; spent: number; cap: number; rootId: string }

/** The task a chain started from; a parent that is gone makes a root. */
export function chainRootId(tasks: Task[], task: Task) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  let root = task;
  for (let up = byId.get(root.parentId ?? ''); up; up = byId.get(up.parentId ?? '')) root = up;
  return root.id;
}

/** Turns started under the task's root and what they are known to have cost. A task put back in the queue counts when it runs again. */
export function chainUsage(tasks: Task[], task: Task) {
  const rootId = chainRootId(tasks, task);
  const children = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const walk = tasks.filter(t => t.id === rootId);
  let turns = 0;
  let cost = 0;
  for (let t = walk.pop(); t; t = walk.pop()) {
    if (t.startedAt !== null) turns += 1;
    cost += t.cost || 0;
    walk.push(...(children.get(t.id) ?? []));
  }
  return { rootId, turns, cost };
}

/** Why this task's chain may not take another turn, or null. 0 turns a limit off. */
export function chainBlock(limits: Limits, tasks: Task[], task: Task): ChainBlock | null {
  const { chainMaxTurns, chainBudgetUsd } = limits;
  if (!(chainMaxTurns > 0) && !(chainBudgetUsd > 0)) return null;
  const { rootId, turns, cost } = chainUsage(tasks, task);
  if (chainBudgetUsd > 0 && cost >= chainBudgetUsd) return { kind: 'chainBudget', spent: cost, cap: chainBudgetUsd, rootId };
  if (chainMaxTurns > 0 && turns >= chainMaxTurns) return { kind: 'chainTurns', spent: turns, cap: chainMaxTurns, rootId };
  return null;
}
