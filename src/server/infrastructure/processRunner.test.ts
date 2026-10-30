// Process handling against small stand-in shell scripts (never a real agent CLI): `npm test`
import { spawnSync } from 'node:child_process';
import { before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Task } from '../../shared/types.ts';
import { createAgent } from '../domain/agent.ts';
import { ProcessRunner } from './processRunner.ts';
import { getProvider } from './providers/index.ts';

const GRACE = 100;
const task: Task = { id: 't', agentId: 'a', prompt: 'p', from: 'user', parentId: null, depth: 0, kind: 'task', status: 'queued', createdAt: 0, startedAt: null, endedAt: null, result: '', cost: 0 };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  return check();
}

// macOS checks a new executable the first time it runs: 0.2-1 s here, over 3 s with the whole suite running, and no
// time limit below is about that. So the runs share one CLI, run once up front, which reads its script from its cwd.
const CLI = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cli-')), 'cli');
fs.writeFileSync(CLI, '#!/bin/sh\nexec /bin/sh ./body\n', { mode: 0o755 });
before(() => { spawnSync(CLI, { cwd: path.dirname(CLI), stdio: 'ignore' }); });

/** Runs `body` as the agent's CLI; `dir` is where it can leave files for the test. */
function run(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  fs.writeFileSync(path.join(dir, 'body'), `${body.replaceAll('$DIR', dir).replaceAll('$NODE', process.execPath)}\n`);
  const runner = new ProcessRunner({ mcp: { command: 'true', args: [], officeUrl: '' }, binaryOverrides: () => ({ claude: CLI }), stopGraceMs: GRACE });
  const seen = { activity: 0, exit: null as { code: number | null; stderr: string } | null };
  const handle = runner.start(
    { agent: createAgent({ name: 'A', provider: 'claude' }, 'Dev'), task, cwd: dir, systemPrompt: '', locale: 'en' },
    { onEvent() {}, onActivity() { seen.activity++; }, onExit(info) { assert.equal(seen.exit, null, 'exits once'); seen.exit = info; } },
  );
  return { dir, handle, seen, read: (name: string) => Number(fs.readFileSync(path.join(dir, name), 'utf8')), ready: (name: string) => fs.existsSync(path.join(dir, name)) };
}

test('stopping a run reaches the processes it started', async () => {
  const r = run('sleep 30 & echo $! > $DIR/child.tmp; mv $DIR/child.tmp $DIR/child; wait');
  assert.ok(await until(() => r.ready('child')));
  const child = r.read('child');
  assert.ok(alive(child));
  r.handle.stop();
  assert.ok(await until(() => r.seen.exit !== null));
  assert.ok(await until(() => !alive(child)), 'the grandchild is gone too');
});

test('a process that ignores SIGTERM is killed after the grace period', async () => {
  const r = run(`trap '' TERM; echo $$ > $DIR/pid.tmp; mv $DIR/pid.tmp $DIR/pid; while :; do sleep 0.02; done`);
  assert.ok(await until(() => r.ready('pid')));
  const pid = r.read('pid');
  const started = Date.now();
  r.handle.stop();
  r.handle.stop(); // stopping twice changes nothing
  await new Promise(res => setTimeout(res, GRACE / 2));
  assert.ok(alive(pid), 'it gets its grace period');
  assert.ok(await until(() => r.seen.exit !== null));
  assert.ok(Date.now() - started >= GRACE);
  assert.ok(await until(() => !alive(pid)));
});

// Keeps the run's stdout open from outside its process group, so the 'close' event never comes
const ESCAPEE = `"$NODE" -e "require('child_process').spawn('sleep',['2'],{detached:true,stdio:'inherit'}).unref()"`;

test('a run that left something holding its output still ends, with its exit code', async (c) => {
  const r = run('sleep 30 & echo $! > $DIR/holder.tmp; mv $DIR/holder.tmp $DIR/holder\nexit 3');
  c.after(() => { try { process.kill(r.read('holder')); } catch {} });
  assert.ok(await until(() => r.seen.exit !== null), 'does not wait for the pipe to close');
  assert.equal(r.seen.exit!.code, 3);
  assert.ok(alive(r.read('holder')), 'the output was still open');
});

test('a stopped run that cannot be waited for still frees the agent', async () => {
  const r = run(`${ESCAPEE}\necho up > $DIR/up; sleep 30`);
  assert.ok(await until(() => r.ready('up')));
  r.handle.stop();
  assert.ok(await until(() => r.seen.exit !== null, 1500));
});

test('any output counts as activity, on either stream', async () => {
  const r = run('echo not-json; echo oops >&2');
  assert.ok(await until(() => r.seen.exit !== null));
  assert.equal(r.seen.exit!.code, 0);
  assert.ok(r.seen.activity >= 2);
  assert.match(r.seen.exit!.stderr, /oops/);
});

/** A runner that knows one CLI, a stand-in script: `providers()` would otherwise run every real CLI on this machine. A health check times its first run, so it gets room for the check above. */
function withCli(body: string, healthTimeoutMs = 30_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  const bin = path.join(dir, 'cli');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const runner = new ProcessRunner({ mcp: { command: 'true', args: [], officeUrl: '' }, binaryOverrides: () => ({ claude: bin }), healthTimeoutMs, catalog: [getProvider('claude')] });
  const claude = async () => (await runner.providers()).find(p => p.id === 'claude')!;
  return { dir, bin, runner, claude };
}

test('health: a CLI that answers is available, with its version', async () => {
  const { claude, dir } = withCli(`echo "$1" > ${'$'}(dirname "$0")/asked; printf '2.1.0 (Claude Code)\\nmore\\n'`);
  const p = await claude();
  assert.equal(p.health, 'ok');
  assert.equal(p.available, true);
  assert.equal(p.version, '2.1.0 (Claude Code)');
  assert.equal(fs.readFileSync(path.join(dir, 'asked'), 'utf8').trim(), '--version');
});

test('health: an executable file that fails is not available', async () => {
  const { claude, bin } = withCli('echo "dyld: Library not loaded" >&2; exit 3');
  const p = await claude();
  assert.equal(p.health, 'broken');
  assert.equal(p.available, false);
  assert.equal(p.path, bin);
  assert.match(p.healthError!, /Library not loaded/);
});

test('health: a CLI that hangs fails the check instead of holding it', async () => {
  const { claude } = withCli('exec sleep 30', 500);
  const p = await claude();
  assert.equal(p.health, 'broken');
  assert.ok(p.healthError);
});

test('health: the answer is reused, but a broken CLI is looked at again soon', async () => {
  const { claude, dir } = withCli(`echo x >> ${'$'}(dirname "$0")/count; echo 1.0`);
  await claude();
  await claude();
  assert.equal(fs.readFileSync(path.join(dir, 'count'), 'utf8').trim().split('\n').length, 1);
  const broken = withCli('exit 1');
  assert.equal((await broken.claude()).health, 'broken');
  fs.writeFileSync(broken.bin, '#!/bin/sh\necho 2.0\n', { mode: 0o755 });
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  try { assert.equal((await broken.claude()).health, 'ok'); } finally { mock.timers.reset(); }
});

test('a provider\'s rules read its failures', () => {
  const { runner } = withCli('true');
  assert.equal(runner.classify('codex', { text: 'Please run codex login', stderr: '', code: 1 }, 0).kind, 'auth');
  assert.equal(runner.label('codex'), 'Codex CLI');
});
