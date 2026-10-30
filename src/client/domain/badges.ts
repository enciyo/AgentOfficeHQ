// Badges and the office leaderboard, derived from the tasks in memory.
import type { PublicAgent, Task } from '../../shared/types.ts';

export type BadgeId = 'first' | 'ten' | 'merge' | 'pr' | 'nightOwl' | 'speedy' | 'flawless' | 'frugal' | 'loved';

export const BADGE_EMOJI: Record<BadgeId, string> = {
  first: '✨', ten: '🔟', merge: '🔀', pr: '🚀', nightOwl: '🦉', speedy: '⚡', flawless: '💎', frugal: '🪙', loved: '❤️',
};

const FAST_MS = 60_000;
const CHEAP_AVG_USD = 0.05;

/** Badges earned by one agent's tasks (reports do not count as work). */
export function badgesOf(tasks: Task[]): BadgeId[] {
  const work = tasks.filter(t => t.kind !== 'report');
  const done = work.filter(t => t.status === 'done');
  const failed = work.filter(t => t.status === 'error').length;
  const spend = done.reduce((s, t) => s + (t.cost || 0), 0);
  const night = (t: Task) => { const h = new Date(t.endedAt ?? 0).getHours(); return h >= 0 && h < 5; };
  const earned: [BadgeId, boolean][] = [
    ['first', done.length >= 1],
    ['ten', done.length >= 10],
    ['merge', done.some(t => !!t.commit)],
    ['pr', work.some(t => !!t.pr)],
    ['nightOwl', done.some(night)],
    ['speedy', done.some(t => t.startedAt !== null && t.endedAt !== null && t.endedAt - t.startedAt < FAST_MS)],
    ['flawless', done.length >= 5 && failed === 0],
    ['frugal', done.length >= 5 && spend > 0 && spend / done.length < CHEAP_AVG_USD],
    ['loved', tasks.reduce((s, t) => s + (t.reactions?.length ?? 0), 0) >= 3],
  ];
  return earned.filter(([, ok]) => ok).map(([id]) => id);
}

export interface LeaderRow { agent: PublicAgent; done: number; failed: number; rate: number; cost: number; badges: BadgeId[]; score: number }

/** Agents ranked by finished work, success and badges. */
export function leaderboard(agents: PublicAgent[], tasks: Task[]): LeaderRow[] {
  const byAgent = new Map<string, Task[]>();
  for (const t of tasks) byAgent.set(t.agentId, [...(byAgent.get(t.agentId) ?? []), t]);
  return agents.map(agent => {
    const mine = byAgent.get(agent.id) ?? [];
    const work = mine.filter(t => t.kind !== 'report');
    const done = work.filter(t => t.status === 'done').length;
    const failed = work.filter(t => t.status === 'error').length;
    const badges = badgesOf(mine);
    return {
      agent, done, failed, badges,
      rate: done + failed ? done / (done + failed) : 0,
      cost: mine.reduce((s, t) => s + (t.cost || 0), 0),
      score: done * 10 - failed * 3 + badges.length * 5,
    };
  }).sort((a, b) => b.score - a.score || b.done - a.done || a.agent.name.localeCompare(b.agent.name));
}
