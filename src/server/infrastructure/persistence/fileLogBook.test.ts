// The per-agent log on disk: what the transcript of one task reads back: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LogEntry } from '../../../shared/types.ts';
import { FileLogBook } from './fileLogBook.ts';

const book = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-logs-'));
  return { dir, logs: new FileLogBook(dir) };
};
const entry = (taskId: string | null, text: string, over: Partial<LogEntry> = {}): LogEntry => ({ ts: 1, kind: 'text', text, taskId, ...over });

test('a task log comes from the whole file, past the recent tail and without other tasks', async () => {
  const { logs } = book();
  for (let i = 0; i < 400; i++) logs.append('a', entry(i % 2 ? 't1' : 't2', `line ${i}`));
  logs.append('a', entry(null, 'between tasks'));
  const { entries, total } = await logs.ofTask('a', 't1', 1000);
  assert.equal(total, 200);
  assert.equal(entries[0]!.text, 'line 1', 'older than the 300 entries kept in memory, and in writing order');
  assert.ok(entries.every(e => e.taskId === 't1'));
});

test('a long task log is cut to its newest entries but still counted in full', async () => {
  const { logs } = book();
  for (let i = 0; i < 50; i++) logs.append('a', entry('t1', `line ${i}`));
  const { entries, total } = await logs.ofTask('a', 't1', 10);
  assert.equal(total, 50);
  assert.deepEqual(entries.map(e => e.text), Array.from({ length: 10 }, (_, i) => `line ${i + 40}`));
});

test('tool details stay on disk: a task log has them, the recent tail only says they exist', async () => {
  const { dir, logs } = book();
  logs.append('a', entry('t1', 'Ran ls', { kind: 'tool', detail: 'ls -la /tmp' }));
  assert.deepEqual((await logs.ofTask('a', 't1', 10)).entries.map(e => e.detail), ['ls -la /tmp']);
  const [live] = logs.recent('a');
  assert.equal(live!.detail, undefined);
  assert.equal(live!.hasDetail, true);
  const [reloaded] = new FileLogBook(dir).recent('a');
  assert.equal(reloaded!.detail, undefined, 'also after a restart, when the tail comes from the file');
  assert.equal(reloaded!.hasDetail, true);
});

test('another task quoted in a text is not that task, and a torn line is skipped', async () => {
  const { dir, logs } = book();
  logs.append('a', entry('t2', '{"taskId":"t1"} was mentioned'));
  logs.append('a', entry('t1', 'real'));
  await logs.ofTask('a', 't1', 10);
  fs.appendFileSync(path.join(dir, 'a.jsonl'), '{"ts":1,"kind":"text","taskId":"t1","te\n');
  const { entries, total } = await logs.ofTask('a', 't1', 10);
  assert.deepEqual(entries.map(e => e.text), ['real']);
  assert.equal(total, 1);
});

test('an agent without a log file has an empty task log', async () => {
  assert.deepEqual(await book().logs.ofTask('nobody', 't1', 10), { entries: [], total: 0 });
});

test('an id can not reach a file outside the logs folder', () => {
  const { dir, logs } = book();
  fs.writeFileSync(path.join(dir, '..', path.basename(dir) + '-outside.jsonl'), JSON.stringify(entry(null, 'secret')) + '\n');
  assert.deepEqual(logs.recent(`../${path.basename(dir)}-outside`), []);
});
