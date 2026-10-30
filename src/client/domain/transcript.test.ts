// The live transcript of one task: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.ts';
import { addLiveEntry, emptyTranscript, entryKey, filterEntries, kindCounts, mergeLoaded, visibleLogEntries } from './transcript.ts';

const e = (ts: number, text: string, over: Partial<LogEntry> = {}): LogEntry => ({ ts, kind: 'text', text, taskId: 't', ...over });

test('entries arriving while the log loads are kept once, in order', () => {
  let tr = emptyTranscript('t');
  tr = addLiveEntry(tr, e(5, 'both'));
  tr = addLiveEntry(tr, e(6, 'only live'));
  tr = mergeLoaded(tr, { entries: [e(1, 'old'), e(5, 'both')], total: 2, limit: 100 });
  assert.deepEqual(tr.entries.map(x => x.text), ['old', 'both', 'only live']);
  assert.equal(tr.total, 3);
  assert.equal(tr.loaded, true);
});

test('a reload brings the detail of an entry that came in live', () => {
  let tr = mergeLoaded(emptyTranscript('t'), { entries: [], total: 0, limit: 100 });
  tr = addLiveEntry(tr, e(1, 'Ran ls', { kind: 'tool', hasDetail: true }));
  tr = mergeLoaded(tr, { entries: [e(1, 'Ran ls', { kind: 'tool', detail: 'ls -la' })], total: 1, limit: 100 });
  assert.deepEqual(tr.entries.map(x => x.detail), ['ls -la']);
  assert.equal(tr.total, 1);
});

test('a cut log stays cut: older entries are not kept past the limit, the total keeps counting', () => {
  let tr = mergeLoaded(emptyTranscript('t'), { entries: [e(8, 'c'), e(9, 'd')], total: 40, limit: 2 });
  tr = addLiveEntry(tr, e(10, 'e'));
  assert.deepEqual(tr.entries.map(x => x.text), ['d', 'e']);
  assert.equal(tr.total, 41);
  const again = mergeLoaded({ ...tr, entries: [e(1, 'gone'), ...tr.entries] }, { entries: [e(9, 'd'), e(10, 'e')], total: 41, limit: 2 });
  assert.deepEqual(again.entries.map(x => x.text), ['d', 'e'], 'what fell out of the window does not come back');
  assert.equal(again.total, 41);
});

test('kinds are counted in a fixed order and only when present; the filter follows', () => {
  const entries = [e(1, 'x', { kind: 'tool' }), e(2, 'y', { kind: 'error' }), e(3, 'z', { kind: 'tool' }), e(4, 'w', { kind: 'task' })];
  assert.deepEqual(kindCounts(entries), [{ kind: 'task', count: 1 }, { kind: 'tool', count: 2 }, { kind: 'error', count: 1 }]);
  assert.deepEqual(filterEntries(entries, 'tool').map(x => x.text), ['x', 'z']);
  assert.equal(filterEntries(entries, 'all'), entries);
});

test('a final result is not shown again when the same task already streamed its full text', () => {
  const answer = 'İyiyim, teşekkürler — hazırım. 🙂';
  const entries = [
    e(1, answer, { taskId: 'same-task', kind: 'text' }),
    e(2, answer, { taskId: 'same-task', kind: 'result' }),
    e(3, answer, { taskId: 'other-task', kind: 'text' }),
    e(4, 'A different final answer', { taskId: 'other-task', kind: 'result' }),
  ];

  assert.deepEqual(visibleLogEntries(entries).map(x => [x.taskId, x.kind]), [
    ['same-task', 'result'],
    ['other-task', 'text'],
    ['other-task', 'result'],
  ]);
});

test('an entry is the same one before and after its detail arrives', () => {
  assert.equal(entryKey(e(1, 'a', { hasDetail: true })), entryKey(e(1, 'a', { detail: 'long' })));
  assert.notEqual(entryKey(e(1, 'a')), entryKey(e(1, 'a', { kind: 'tool' })));
});
