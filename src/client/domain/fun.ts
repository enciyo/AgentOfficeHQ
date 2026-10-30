// Office life that is only for fun (kept in the browser): coffee, morale, rain and fire drills.
// Pure rules; the store ticks them and the 3D view draws them.

export const COFFEE_MAX = 100;
/** Coffee one cup takes out of the machine. */
export const CUP = 2;
/** One agent counts one cup per this much time, however often they walk past the machine. */
const CUP_EVERY_MS = 10 * 60_000;
const MORALE_START = 80;
/** Morale per minute: work drains it, rest brings it back, an empty coffee machine drains everyone. */
const WORK_DRAIN = 1.2;
const REST_GAIN = 0.5;
const NO_COFFEE_DRAIN = 0.8;
const CUP_BOOST = 20;
const BREAK_BOOST = 40;
/** Coffee the machine loses per minute of work in the office (people grab cups at their desks too). */
const COFFEE_PER_WORK_MINUTE = 0.6;

export interface Fun { coffee: number; morale: Record<string, number>; updatedAt: number; /** Last cup per agent. */ cups: Record<string, number> }
export type Weather = 'clear' | 'rain';

const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));

export const freshFun = (now: number): Fun => ({ coffee: COFFEE_MAX, morale: {}, updatedAt: now, cups: {} });

export const moraleOf = (fun: Fun, agentId: string) => fun.morale[agentId] ?? MORALE_START;

/** Advances morale and the coffee level to `now` (at most 10 minutes at once, so a sleeping tab does not drain everyone). */
export function tickFun(fun: Fun, agents: { id: string; status: string }[], now: number): Fun {
  const minutes = Math.min(10, Math.max(0, (now - fun.updatedAt) / 60_000));
  const empty = fun.coffee <= 0;
  const working = agents.filter(a => a.status === 'working').length;
  const morale: Record<string, number> = {};
  for (const a of agents) {
    const rate = (a.status === 'working' ? -WORK_DRAIN : REST_GAIN) - (empty ? NO_COFFEE_DRAIN : 0);
    morale[a.id] = clamp(moraleOf(fun, a.id) + rate * minutes, 100);
  }
  return { ...fun, coffee: clamp(fun.coffee - working * COFFEE_PER_WORK_MINUTE * minutes, COFFEE_MAX), morale, updatedAt: now };
}

/** An agent drinks a cup at the machine, if there is coffee and they did not just have one. */
export function drinkCoffee(fun: Fun, agentId: string, now: number): Fun {
  if (fun.coffee < CUP || now - (fun.cups[agentId] ?? -Infinity) < CUP_EVERY_MS) return fun;
  return {
    ...fun,
    coffee: fun.coffee - CUP,
    morale: { ...fun.morale, [agentId]: clamp(moraleOf(fun, agentId) + CUP_BOOST, 100) },
    cups: { ...fun.cups, [agentId]: now },
  };
}

/** The CEO refills the machine and everyone takes a short break. */
export function coffeeBreak(fun: Fun, agentIds: string[]): Fun {
  const morale = { ...fun.morale };
  for (const id of agentIds) morale[id] = clamp(moraleOf(fun, id) + BREAK_BOOST, 100);
  return { ...fun, coffee: COFFEE_MAX, morale };
}

/** Tired people walk slower. */
export const paceOf = (morale: number) => 0.6 + 0.4 * (morale / 100);

export const moodEmoji = (morale: number) => (morale >= 70 ? '😄' : morale >= 45 ? '🙂' : morale >= 20 ? '😐' : '😩');

/**
 * Random office events for one tick of `dtMs`; `roll` returns numbers in [0, 1).
 * On average a fire drill every ~2 hours and a shower every ~45 minutes, lasting 3–8 minutes.
 */
export function rollEvents(roll: () => number, dtMs: number, weather: Weather) {
  const chance = (everyMin: number) => roll() < dtMs / (everyMin * 60_000);
  return {
    drill: chance(120),
    weather: (weather === 'clear' ? (chance(45) ? 'rain' : 'clear') : chance(5) ? 'clear' : 'rain') as Weather,
  };
}
