// When recurring tasks run. Pure functions over timestamps (local time for "at HH:MM").
import type { Schedule } from '../../shared/types.ts';

export const MIN_INTERVAL_MINUTES = 5;
const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** Daily/weekly schedules may pin a wall-clock time; shorter intervals simply count from now. */
export const usesClockTime = (s: Pick<Schedule, 'intervalMinutes' | 'at'>) => !!s.at && s.intervalMinutes % DAY_MINUTES === 0;

/** First run of a new (or re-timed) schedule. */
export function firstRun(s: Pick<Schedule, 'intervalMinutes' | 'at'>, now: number): number {
  if (!usesClockTime(s)) return now + s.intervalMinutes * MINUTE;
  const [h, m] = s.at!.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h!, m!, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Next run after `due` fired; runs missed while the server was down are skipped, not replayed. */
export function advance(due: number, intervalMinutes: number, now: number): number {
  const step = intervalMinutes * MINUTE;
  let next = due + step;
  if (next <= now) next += Math.ceil((now - next + 1) / step) * step;
  return next;
}
