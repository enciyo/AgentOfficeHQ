// Worktree isolation against real git repositories in a temp dir: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify } from '../domain/agent.ts';
import { GitIsolation, MAX_PATCH_BYTES } from './gitIsolation.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-')));

test('slugify makes branch-safe names', () => {
  assert.equal(slugify('Baş Analist'), 'bas-analist');
  assert.equal(slugify('İç Işık'), 'ic-isik');
  assert.equal(slugify('***'), 'agent');
});

test('agents work on their own branch and their work is merged back', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const a = iso.enter(base, 'dev-a');
  const b = iso.enter(base, 'dev-b');
  assert.equal(a.branch, 'agent/dev-a');
  assert.notEqual(a.cwd, b.cwd);
  assert.ok(fs.existsSync(path.join(base, '.git')), 'a plain folder becomes a repository');

  fs.writeFileSync(path.join(a.cwd, 'a.md'), 'from a');
  fs.writeFileSync(path.join(b.cwd, 'b.md'), 'from b');
  assert.ok(!fs.existsSync(path.join(base, 'a.md')), 'nothing leaks before the task ends');
  const first = iso.integrate(a, 'task a');
  assert.deepEqual({ ...first, commit: '' }, { committed: true, merged: true, error: '', commit: '' });
  assert.equal(git(base, 'rev-parse', 'agent/dev-a'), first.commit, 'the commit of the run is reported');
  assert.equal(iso.integrate(b, 'task b').merged, true);
  assert.equal(fs.readFileSync(path.join(base, 'a.md'), 'utf8'), 'from a');
  assert.ok(fs.existsSync(path.join(base, 'b.md')));
  assert.equal(git(base, 'status', '--porcelain'), '', 'worktrees are not reported as untracked');

  // The next task starts from everything merged so far
  const again = iso.enter(base, 'dev-a');
  assert.ok(again.synced);
  assert.ok(fs.existsSync(path.join(again.cwd, 'b.md')));
  assert.deepEqual(iso.integrate(again, 'nothing'), { committed: false, merged: false, error: '', commit: '' });
});

test('a conflicting merge is aborted and the branch is kept', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const a = iso.enter(base, 'a');
  const b = iso.enter(base, 'b');
  fs.writeFileSync(path.join(a.cwd, 'same.md'), 'A');
  fs.writeFileSync(path.join(b.cwd, 'same.md'), 'B');
  assert.equal(iso.integrate(a, 'a').merged, true);
  const r = iso.integrate(b, 'b');
  assert.equal(r.committed, true);
  assert.equal(r.merged, false);
  assert.match(r.error, /CONFLICT.*same\.md/, 'git says what conflicts');
  assert.equal(fs.readFileSync(path.join(base, 'same.md'), 'utf8'), 'A');
  assert.equal(git(base, 'status', '--porcelain'), '', 'no half-finished merge is left behind');
  assert.ok(git(base, 'branch', '--list', 'agent/b'));
});

test('a run the agent committed itself still reports its commit', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const cell = iso.enter(base, 'dev');
  fs.writeFileSync(path.join(cell.cwd, 'x.md'), 'x');
  git(cell.cwd, 'add', '-A');
  git(cell.cwd, 'commit', '-qm', 'by the agent');
  const r = iso.integrate(cell, 'task');
  assert.equal(r.committed, false);
  assert.equal(r.merged, true);
  assert.equal(r.commit, git(base, 'rev-parse', 'agent/dev'));
});

test('a deleted output is committed, so the next run does not see it', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const a = iso.enter(base, 'dev');
  fs.mkdirSync(path.join(a.cwd, 'docs'));
  fs.writeFileSync(path.join(a.cwd, 'docs', 'old.md'), 'old');
  fs.writeFileSync(path.join(a.cwd, 'keep.md'), 'keep');
  iso.integrate(a, 'write');
  fs.writeFileSync(path.join(base, 'draft.md'), 'not ours'); // someone's uncommitted work stays as it is

  fs.rmSync(path.join(base, 'docs'), { recursive: true });
  iso.commitRemoval(base, 'docs', 'removed docs');
  assert.equal(git(base, 'status', '--porcelain'), '?? draft.md');
  const next = iso.enter(base, 'dev');
  assert.ok(!fs.existsSync(path.join(next.cwd, 'docs', 'old.md')));
  assert.ok(fs.existsSync(path.join(next.cwd, 'keep.md')));
  iso.commitRemoval(base, 'never-tracked.md', 'nothing'); // nothing to commit is fine
});

test('a folder ignored by an enclosing repository gets its own repository', () => {
  const outer = tmp();
  git(outer, 'init', '-q');
  fs.writeFileSync(path.join(outer, '.gitignore'), 'workspace/\n');
  git(outer, 'add', '-A');
  git(outer, 'commit', '-qm', 'outer');
  const base = path.join(outer, 'workspace');
  const cell = new GitIsolation().enter(base, 'x');
  assert.equal(cell.repo, base);
  assert.ok(cell.cwd.startsWith(path.join(base, '.agent-worktrees')));
  assert.equal(git(outer, 'branch', '--list', 'agent/x'), '', 'the outer repository is untouched');
});

test('inside a tracked subfolder the enclosing repository is used and the subpath kept', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, 'app'));
  fs.writeFileSync(path.join(repo, 'app', 'x.txt'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const cell = new GitIsolation().enter(path.join(repo, 'app'), 'dev');
  assert.equal(cell.repo, repo);
  assert.equal(cell.cwd, path.join(repo, '.agent-worktrees', 'dev', 'app'));
  assert.ok(fs.existsSync(path.join(cell.cwd, 'x.txt')));
});

test('the worktree reports where the run starts, and the diff shows what the run changed', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const first = iso.enter(base, 'other');
  fs.writeFileSync(path.join(first.cwd, 'keep.md'), 'one\ntwo\n');
  fs.writeFileSync(path.join(first.cwd, 'old.md'), 'old\n');
  iso.integrate(first, 'seed');

  const cell = iso.enter(base, 'dev');
  assert.equal(cell.head, git(cell.cwd, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(cell.cwd, 'keep.md'), 'one\n2\n');
  fs.writeFileSync(path.join(cell.cwd, 'ğüş.md'), 'new\n');
  fs.writeFileSync(path.join(cell.cwd, 'pic.bin'), Buffer.from([0, 1, 2, 0]));
  fs.rmSync(path.join(cell.cwd, 'old.md'));
  const { commit } = iso.integrate(cell, 'task');

  const diff = iso.diff(cell.repo, cell.head, commit);
  assert.deepEqual(diff.files, [
    { path: 'keep.md', status: 'M', additions: 1, deletions: 1, binary: false },
    { path: 'old.md', status: 'D', additions: 0, deletions: 1, binary: false },
    { path: 'pic.bin', status: 'A', additions: 0, deletions: 0, binary: true },
    { path: 'ğüş.md', status: 'A', additions: 1, deletions: 0, binary: false },
  ]);
  assert.match(diff.patch, /^-two$/m);
  assert.match(diff.patch, /^\+2$/m);
  assert.match(diff.patch, /b\/ğüş\.md/);
  assert.equal(diff.truncated, false);
  assert.deepEqual(iso.diff(cell.repo, commit, commit), { files: [], patch: '', truncated: false });
  assert.throws(() => iso.diff(cell.repo, cell.head, 'f'.repeat(40)), 'a commit that is gone is an error, not an empty diff');
});

test('a huge diff is cut at a line end and says so', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const cell = iso.enter(base, 'dev');
  fs.writeFileSync(path.join(cell.cwd, 'big.txt'), 'satır satır satır\n'.repeat(60000));
  const { commit } = iso.integrate(cell, 'big');
  const diff = iso.diff(cell.repo, cell.head, commit);
  assert.equal(diff.truncated, true);
  assert.equal(diff.files[0]!.additions, 60000, 'the file list still has the real numbers');
  assert.ok(Buffer.byteLength(diff.patch) <= MAX_PATCH_BYTES);
  assert.match(diff.patch, /satır$/, 'no half line or half character at the end');
});

test('with merging held back the run is committed but stays on its branch until merged', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const cell = iso.enter(base, 'dev');
  fs.writeFileSync(path.join(cell.cwd, 'x.md'), 'x');
  const r = iso.integrate(cell, 'task', { merge: false });
  assert.deepEqual(r, { committed: true, merged: false, error: '', commit: git(base, 'rev-parse', 'agent/dev') });
  assert.ok(!fs.existsSync(path.join(base, 'x.md')));
  assert.deepEqual(iso.merge(cell.repo, cell.branch, 'approved'), { merged: true, error: '' });
  assert.equal(fs.readFileSync(path.join(base, 'x.md'), 'utf8'), 'x');
});

test('a merge held back that conflicts by the time it is approved leaves everything as it was', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const a = iso.enter(base, 'a');
  const b = iso.enter(base, 'b');
  fs.writeFileSync(path.join(a.cwd, 'same.md'), 'A');
  fs.writeFileSync(path.join(b.cwd, 'same.md'), 'B');
  iso.integrate(b, 'b', { merge: false });
  iso.integrate(a, 'a');
  const r = iso.merge(b.repo, b.branch, 'approved');
  assert.equal(r.merged, false);
  assert.ok(r.error);
  assert.equal(git(base, 'status', '--porcelain'), '');
});

test('a discarded run is gone from the branch, so the next run does not build on it', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const cell = iso.enter(base, 'dev');
  fs.writeFileSync(path.join(cell.cwd, 'x.md'), 'x');
  iso.integrate(cell, 'task', { merge: false });
  iso.discard(cell.repo, cell.branch, cell.head);
  assert.equal(git(base, 'rev-parse', 'agent/dev'), cell.head);
  const next = iso.enter(base, 'dev');
  assert.ok(!fs.existsSync(path.join(next.cwd, 'x.md')));
  assert.deepEqual(iso.integrate(next, 'nothing'), { committed: false, merged: false, error: '', commit: '' });
});

test('an agent that merges the trunk into its branch and resolves the conflict gets merged', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const a = iso.enter(base, 'a');
  const b = iso.enter(base, 'b');
  fs.writeFileSync(path.join(a.cwd, 'same.md'), 'A');
  fs.writeFileSync(path.join(b.cwd, 'same.md'), 'B');
  iso.integrate(a, 'a');
  assert.equal(iso.integrate(b, 'b').merged, false);

  const again = iso.enter(base, 'b');
  assert.equal(again.synced, false, 'the conflict is still there');
  assert.equal(fs.readFileSync(path.join(again.cwd, 'same.md'), 'utf8'), 'B', 'and the worktree is left clean for the agent');
  assert.throws(() => git(again.cwd, 'merge', iso.trunk(again.repo)));
  fs.writeFileSync(path.join(again.cwd, 'same.md'), 'AB');
  const r = iso.integrate(again, 'resolved');
  assert.equal(r.merged, true);
  assert.equal(fs.readFileSync(path.join(base, 'same.md'), 'utf8'), 'AB');
});

test('a commit that fails is an error, not a run without changes', () => {
  const base = path.join(tmp(), 'work');
  const iso = new GitIsolation();
  const cell = iso.enter(base, 'dev');
  const hook = path.join(base, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho nope >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cell.cwd, 'x.md'), 'x');
  const r = iso.integrate(cell, 'task');
  assert.equal(r.merged, false);
  assert.match(r.error, /nope/);
});
