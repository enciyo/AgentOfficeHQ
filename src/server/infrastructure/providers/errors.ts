// Reads a failed CLI run: which kind of trouble it is, and when a limit lifts. The words themselves are data on each provider.
import type { ProviderFailure, ProviderErrorKind, RunExit } from '../../domain/ports.ts';

/** Matches when every field it has matches: `pattern` the CLI's error text, `exitCode` its exit code. */
export interface ErrorRule { kind: ProviderErrorKind; pattern?: RegExp; exitCode?: number }

/**
 * What every CLI can pass on from the vendors behind it (opencode reaches all of them). A provider lists its own
 * wording before these. Limit words name the limit: "context limit" and "token limit" are about the prompt, not the account,
 * and such a limit would hold the whole CLI while the same oversized session is sent again.
 */
export const COMMON_ERRORS: ErrorRule[] = [
  { kind: 'limit', pattern: /\b(?:session|usage|rate|request|quota|\d+[ -]?hour|hourly|daily|weekly|monthly)[ _-]limits?(?![a-z])/i },
  { kind: 'limit', pattern: /\bhit (?:your|the) (?:(?:plan|account|subscription|billing|credit|spend(?:ing)?) )?limit\b/i },
  { kind: 'limit', pattern: /\btoo many requests\b|\b(?:status|code|error|http)\W{0,3}429\b|\binsufficient_quota\b|\bquota (?:exceeded|exhausted|reached)\b|\b(?:exceeded|exhausted) your (?:current )?quota\b/i },
  { kind: 'auth', pattern: /\bunauthori[sz]ed\b|\bauthentication[ _](?:failed|error|required)\b|\b(?:status|code|error|http)\W{0,3}401\b/i },
  { kind: 'auth', pattern: /\bnot (?:logged|signed) in\b|\binvalid (?:x-)?(?:api[ _-]?key|access token|bearer token|auth(?:entication)? token|credentials?)\b/i },
  { kind: 'auth', pattern: /\b(?:oauth|access|auth|bearer|api) token (?:has )?(?:expired|been revoked)\b|\bplease (?:run |use )?\/?(?:login|log in|sign in)\b/i },
  { kind: 'permission', pattern: /\bpermissions? (?:denied|rejected|required)\b|\brejected permission\b|\bprevents you from using this\b|\bauto-rejecting\b/i },
  { kind: 'permission', pattern: /\bEACCES\b|\bEPERM\b|\bnot permitted\b|\bforbidden\b/i },
  // POSIX shells: found but could not be executed (a wrapper script around the CLI)
  { kind: 'permission', exitCode: 126 },
];

const MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
/** The longest a limit can really last; anything later was misread. */
const MAX_RESET_MS = 31 * MS.d!;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const EPOCH = /limit reached\|(\d{10,13})\b/i;
const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const RETRY_AFTER = /\bretry-after:?\s*(\d+)\b/i;
const DURATION = /\b(?:try again|retry|resets?|wait)\b[^.\n]{0,20}?\b(?:in|after|for)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*([dhms])/gi;
// "resets 7pm", "resets at 19:30", "resets Nov 7, 4pm (Europe/Istanbul)", "try again at Nov 7th, 2026 4:10 PM"
const CLOCK = /\b(?:resets?|try again)(?:\s+(?:on|at))*\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(?\s*([a-z_]+\/[a-z_/]+|utc|gmt)\)?)?/i;

/** How far `zone` (the machine's when undefined) is ahead of UTC at `at`. */
function zoneOffset(at: number, zone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at);
  const v = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall clock in `zone` shows this; the second pass settles a daylight-saving change in between. */
function fromWallClock(wall: number, zone: string | undefined) {
  const guess = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(guess, zone);
}

function clockTime(m: RegExpMatchArray, now: number) {
  const [, month, day, year, hourText, minute, half, zoneText] = m;
  if (!minute && !half) return null; // a bare number is not a clock
  let hour = Number(hourText);
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || Number(minute ?? 0) > 59) return null;
  let zone: string | undefined = zoneText && /^(utc|gmt)$/i.test(zoneText) ? 'UTC' : zoneText;
  try { zoneOffset(now, zone); } catch { zone = undefined; }

  const today = new Date(now + zoneOffset(now, zone));
  const at = (y: number, mo: number, d: number) => fromWallClock(Date.UTC(y, mo, d, hour, Number(minute ?? 0)), zone);
  const [y, mo, d] = [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()];
  if (!month) {
    const next = at(y, mo, d);
    return next > now ? next : at(y, mo, d + 1);
  }
  const index = MONTHS.indexOf(month.toLowerCase());
  if (index < 0) return null;
  const next = at(year ? Number(year) : y, index, Number(day));
  return next > now || year ? next : at(y + 1, index, Number(day));
}

function namedTime(text: string, now: number) {
  const epoch = text.match(EPOCH)?.[1];
  if (epoch) return Number(epoch) * (epoch.length > 10 ? 1 : 1000);
  const iso = text.match(ISO)?.[0];
  if (iso) return Date.parse(iso);
  const after = text.match(RETRY_AFTER)?.[1];
  if (after) return now + Number(after) * MS.s!;
  const span = text.match(DURATION)?.[1];
  if (span) return now + [...span.matchAll(DURATION_PART)].reduce((sum, p) => sum + Number(p[1]) * MS[p[2]!.toLowerCase()]!, 0);
  const clock = text.match(CLOCK);
  return clock ? clockTime(clock, now) : null;
}

/** When the limit a message talks about lifts, or null when it names no believable time. */
export function parseResetTime(text: string, now: number): number | null {
  const at = namedTime(text, now);
  return at !== null && Number.isFinite(at) && at > now && at - now <= MAX_RESET_MS ? at : null;
}

/** A result line is the CLI's own verdict; stderr, where anything may log, only speaks when there is none. */
export function classifyFailure(rules: ErrorRule[], { text, stderr, code }: RunExit, now: number): ProviderFailure {
  const said = text.trim() || stderr;
  const rule = rules.find(r => (!r.pattern || r.pattern.test(said)) && (r.exitCode === undefined || r.exitCode === code));
  const kind = rule?.kind ?? 'other';
  return { kind, resetAt: kind === 'limit' ? parseResetTime(said, now) : null };
}
