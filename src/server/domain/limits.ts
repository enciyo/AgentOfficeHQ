// Spend caps and concurrency: whether an agent may start its next task now. Pure functions.
import { chainBlock, type ChainBlock } from '../../shared/chain.ts';
import type { Limits, ProviderHold, Task } from '../../shared/types.ts';

/** A full run of the default company takes about 60 turns; the chain caps are there for loops, not for that. */
export const DEFAULT_LIMITS: Limits = { taskTimeoutMin: 60, silenceTimeoutMin: 30, maxConcurrent: 0, dailyBudgetUsd: 0, agentDailyBudgetUsd: 0, dailyRunMinutes: 0, chainMaxTurns: 100, chainBudgetUsd: 20 };

/** The longest time limit a timer can hold: setTimeout turns anything above 2^31-1 ms (about 35,791 minutes) into 1 ms. */
export const MAX_TIMER_MIN = 35_000;

export const startOfDay = (now: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * What tasks are known to have cost since `since` (local midnight for "today"), optionally for one agent.
 * A task with no end yet is spending now: running, or put back with a failed attempt behind it.
 */
export const spentSince = (tasks: Task[], since: number, agentId?: string) =>
  tasks.reduce((sum, t) => ((t.endedAt ?? Infinity) >= since && (!agentId || t.agentId === agentId) ? sum + (t.cost || 0) : sum), 0);

/** Minutes agents ran since `since`, added up over all of them: two agents for ten minutes make twenty. */
export const minutesSince = (tasks: Task[], since: number, now: number) => tasks.reduce((sum, t) => {
  const end = t.endedAt ?? now;
  if (end < since) return sum;
  return sum + (t.ranMs ?? 0) + (t.startedAt ? end - Math.max(t.startedAt, since) : 0);
}, 0) / 60_000;

export type Block =
  | { kind: 'paused' }
  | ChainBlock
  | { kind: 'concurrency'; max: number }
  | { kind: 'budget'; spent: number; cap: number }
  | { kind: 'agentBudget'; spent: number; cap: number }
  /** In minutes. */
  | { kind: 'minutes'; spent: number; cap: number }
  | { kind: 'providerLimit'; until: number }
  | { kind: 'providerAuth' };

/** How often a CLI limit or login failure may put one task back; after that it fails, so a misread error cannot loop. */
export const MAX_REQUEUES = 5;
/** First wait when a limit names no reset time; it doubles per requeue, so the tries span even a 5-hour limit. */
const BACKOFF_MS = 15 * 60_000;
/** A reset time is rounded to the minute at best; trying right on it would burn a requeue. */
const RESET_MARGIN_MS = 60_000;

/** When a provider that hit a limit may run again. `requeues`: how often this task was put back already. */
export const holdUntil = (resetAt: number | null, requeues: number, now: number) =>
  resetAt !== null ? resetAt + RESET_MARGIN_MS : now + BACKOFF_MS * 2 ** requeues;

/** Why the agent's next task (`task`, when its chain matters) has to wait, or null if it may start. 0 means "no limit" everywhere. */
export function blockReason(limits: Limits, tasks: Task[], agentId: string, running: number, now: number, hold?: ProviderHold, { paused = false, task }: { paused?: boolean; task?: Task } = {}): Block | null {
  if (paused) return { kind: 'paused' };
  const today = startOfDay(now);
  if (limits.dailyBudgetUsd > 0) {
    const spent = spentSince(tasks, today);
    if (spent >= limits.dailyBudgetUsd) return { kind: 'budget', spent, cap: limits.dailyBudgetUsd };
  }
  if (limits.agentDailyBudgetUsd > 0) {
    const spent = spentSince(tasks, today, agentId);
    if (spent >= limits.agentDailyBudgetUsd) return { kind: 'agentBudget', spent, cap: limits.agentDailyBudgetUsd };
  }
  if (limits.dailyRunMinutes > 0) {
    const spent = minutesSince(tasks, today, now);
    if (spent >= limits.dailyRunMinutes) return { kind: 'minutes', spent, cap: limits.dailyRunMinutes };
  }
  const chain = task && chainBlock(limits, tasks, task);
  if (chain) return chain;
  if (hold && hold.until === null) return { kind: 'providerAuth' };
  if (hold?.until && hold.until > now) return { kind: 'providerLimit', until: hold.until };
  if (limits.maxConcurrent > 0 && running >= limits.maxConcurrent) return { kind: 'concurrency', max: limits.maxConcurrent };
  return null;
}
