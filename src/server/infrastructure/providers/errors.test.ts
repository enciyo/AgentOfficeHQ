// What a failed CLI run said, read as a neutral failure: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, getProvider } from './index.ts';
import { COMMON_ERRORS, classifyFailure, parseResetTime } from './errors.ts';

const local = (h: number, m = 0, day = 4) => new Date(2026, 10, day, h, m).getTime();
const now = local(15);
const said = (id: string, text: string, stderr = '', code: number | null = 1) => classifyFailure(getProvider(id).errors, { text, stderr, code }, now);
const MIN = 60_000;

// The kinds seen in real runs, on every CLI: agents on opencode reach the same vendors, so they get the same words
const FORMS: [string, 'limit' | 'auth' | 'permission' | 'other'][] = [
  ['You\'ve hit your session limit · resets 7pm (Europe/Istanbul)', 'limit'],
  ['Session limit reached ∙ resets 3am', 'limit'],
  ['5-hour limit reached ∙ resets 3am', 'limit'],
  ['Weekly limit reached · resets Nov 7, 4pm', 'limit'],
  ['Claude AI usage limit reached|1790000000', 'limit'],
  ['You\'ve hit your limit', 'limit'],
  ['You\'ve hit your usage limit. Upgrade to Pro or try again in 3 hours 12 minutes.', 'limit'],
  ['Rate limit reached for gpt-5. Please try again in 1.5s.', 'limit'],
  ['rate_limit_error: This request would exceed your limit', 'limit'],
  ['API Error: 429 Too Many Requests', 'limit'],
  ['insufficient_quota: You exceeded your current quota', 'limit'],
  ['Unauthorized', 'auth'],
  ['401 Unauthorized', 'auth'],
  ['API Error: 401 {"type":"authentication_error"}', 'auth'],
  ['Invalid API key · Please run /login', 'auth'],
  ['Not logged in', 'auth'],
  ['OAuth token has expired', 'auth'],
  ['The user rejected permission to use this specific tool call.', 'permission'],
  ['The user has specified a rule which prevents you from using this specific tool call.', 'permission'],
  ['Permission denied', 'permission'],
  ['EACCES: permission denied, open \'/x\'', 'permission'],
  ['403 Forbidden', 'permission'],
  // Words that are close but mean something else
  ['Prompt is too long: context limit exceeded', 'other'],
  ['Token limit of the model exceeded', 'other'],
  ['Unexpected token < in JSON at position 0', 'other'],
  ['The session could not be found', 'other'],
  ['Failed at line 429', 'other'],
  ['boom', 'other'],
  ['', 'other'],
];

for (const p of PROVIDERS) {
  test(`${p.id}: error rules`, () => {
    assert.ok(p.errors.length);
    for (const r of p.errors) {
      assert.ok(r.pattern || r.exitCode !== undefined, 'a rule needs something to match');
      assert.ok(!r.pattern?.global && !r.pattern?.sticky, 'a stateful pattern would match every other time');
    }
    for (const [text, kind] of FORMS) assert.equal(said(p.id, text).kind, kind, text);
  });
}

test('each CLI knows its own login and limit wording', () => {
  assert.equal(said('claude', 'Credit balance is too low').kind, 'limit');
  assert.equal(said('codex', 'Please run `codex login`').kind, 'auth');
  assert.equal(said('cursor', 'Press any key to sign in, or run cursor-agent login').kind, 'auth');
  assert.equal(said('opencode', 'ProviderAuthError').kind, 'auth');
  assert.equal(said('opencode', 'PermissionRejectedError').kind, 'permission');
});

test('stderr only speaks when the run gave no verdict of its own', () => {
  assert.equal(said('claude', '', 'Error: 401 Unauthorized').kind, 'auth');
  assert.equal(said('claude', 'The session could not be found', 'mcp office: Unauthorized').kind, 'other');
});

test('exit data counts: a wrapper that could not execute the CLI', () => {
  assert.equal(said('codex', '', '', 126).kind, 'permission');
  assert.equal(said('codex', '', '', 1).kind, 'other');
  assert.equal(classifyFailure([{ kind: 'limit', pattern: /x/, exitCode: 9 }], { text: 'x', stderr: '', code: 1 }, now).kind, 'other');
  assert.equal(classifyFailure([{ kind: 'limit', pattern: /x/, exitCode: 9 }], { text: 'x', stderr: '', code: 9 }, now).kind, 'limit');
});

test('a limit carries the reset time it names; other kinds never do', () => {
  assert.equal(said('claude', 'You\'ve hit your session limit · resets 7pm').resetAt, local(19));
  assert.equal(said('claude', 'Session limit reached').resetAt, null);
  assert.equal(said('claude', 'Unauthorized, resets 7pm').resetAt, null);
});

test('reset times: clock forms, in local time, the next time that clock comes round', () => {
  assert.equal(parseResetTime('resets 7pm', now), local(19));
  assert.equal(parseResetTime('resets 7:30pm', now), local(19, 30));
  assert.equal(parseResetTime('Resets at 19:30', now), local(19, 30));
  assert.equal(parseResetTime('try again at 9:52 PM', now), local(21, 52));
  assert.equal(parseResetTime('resets 12am', now), local(0, 0, 5));
  assert.equal(parseResetTime('resets 3am', now), local(3, 0, 5), 'already past today');
  assert.equal(parseResetTime('resets 12pm', now), local(12, 0, 5));
});

test('reset times: a named zone is that zone\'s clock', () => {
  const at = Date.UTC(2026, 10, 4, 12);
  assert.equal(parseResetTime('resets 7pm (Europe/Istanbul)', at), Date.UTC(2026, 10, 4, 16));
  assert.equal(parseResetTime('resets 7pm (America/New_York)', at), Date.UTC(2026, 10, 5, 0));
  assert.equal(parseResetTime('resets 1pm (UTC)', at), Date.UTC(2026, 10, 4, 13));
  assert.equal(parseResetTime('resets 7pm (Not/A_Zone)', now), local(19), 'an unknown zone reads as local');
});

test('reset times: dates', () => {
  assert.equal(parseResetTime('resets Nov 7, 4pm', now), local(16, 0, 7));
  assert.equal(parseResetTime('resets Nov 7 at 4pm', now), local(16, 0, 7));
  assert.equal(parseResetTime('try again at Nov 7th, 2026 4:10 PM', now), local(16, 10, 7));
  assert.equal(parseResetTime('resets 2026-11-05T10:00:00Z', now), Date.UTC(2026, 10, 5, 10));
});

test('reset times: durations and epochs', () => {
  assert.equal(parseResetTime('try again in 3 hours 12 minutes', now), now + 192 * MIN);
  assert.equal(parseResetTime('try again in 2 days 1 hour', now), now + 49 * 60 * MIN);
  assert.equal(parseResetTime('Please try again in 1.5s.', now), now + 1500);
  assert.equal(parseResetTime('resets in 45m', now), now + 45 * MIN);
  assert.equal(parseResetTime('retry after 60 seconds', now), now + MIN);
  assert.equal(parseResetTime('retry-after: 120', now), now + 2 * MIN);
  assert.equal(parseResetTime('Claude AI usage limit reached|1794000000', now), 1794000000 * 1000);
  assert.equal(parseResetTime('Claude AI usage limit reached|1794000000000', now), 1794000000000);
});

test('reset times: nothing usable means none', () => {
  assert.equal(parseResetTime('Session limit reached', now), null);
  assert.equal(parseResetTime('resets 5', now), null, 'a bare number is not a clock');
  assert.equal(parseResetTime('resets 25:00', now), null);
  assert.equal(parseResetTime('Claude AI usage limit reached|1000000000', now), null, 'already over');
  assert.equal(parseResetTime('resets 2030-01-01T00:00:00Z', now), null, 'too far off to be true');
  assert.equal(parseResetTime('try again in 90 days', now), null);
});

test('a context or token limit is about the prompt, not the account', () => {
  for (const text of ['You hit the context limit for this model', 'hit the token limit', 'hit the tokens limit', 'hit your context limit', 'hit the output token limit']) {
    assert.equal(classifyFailure(COMMON_ERRORS, { text, stderr: '', code: 1 }, 0).kind, 'other', text);
  }
  for (const text of ['You have hit your limit', 'hit the limit', 'hit your plan limit', 'hit your usage limit', 'hit your 5-hour limit']) {
    assert.equal(classifyFailure(COMMON_ERRORS, { text, stderr: '', code: 1 }, 0).kind, 'limit', text);
  }
});
