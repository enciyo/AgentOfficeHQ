// Per-agent git worktrees: each agent works on its own branch, and its work is merged back after every task.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { DiffFile, TaskDiff } from '../../shared/types.ts';
import type { Isolation, Workcell } from '../domain/ports.ts';

const DIR = '.agent-worktrees';
// Commits must not depend on the user's git identity being configured
const IDENTITY = ['-c', 'user.name=Agent Office', '-c', 'user.email=agent-office@localhost', '-c', 'commit.gpgsign=false'];

/** How much of a task's patch and file list is kept: enough to review, not enough to choke the browser. */
export const MAX_PATCH_BYTES = 200_000;
const MAX_DIFF_FILES = 500;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();

const tryGit = (cwd: string, ...args: string[]) => {
  try { return { ok: true, out: git(cwd, ...args) }; } catch (e: any) { return { ok: false, out: String(e.stderr || e.stdout || e.message).trim() }; }
};

/** Runs `git diff` as a machine reads it, whatever the user's git configuration prefers. */
const gitDiff = (repo: string, maxBuffer: number, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-color', '--no-renames', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer });

/** A patch over the cap arrives cut off; what is kept ends at a whole line. */
function cappedPatch(repo: string, from: string, to: string) {
  try {
    return { patch: gitDiff(repo, MAX_PATCH_BYTES, from, to, '--').trimEnd(), cut: false };
  } catch (e: any) {
    if (e.code !== 'ENOBUFS') throw e;
    const text = Buffer.from(String(e.stdout ?? '')).subarray(0, MAX_PATCH_BYTES).toString();
    return { patch: text.slice(0, Math.max(0, text.lastIndexOf('\n'))), cut: true };
  }
}

const worktreeOf = (repo: string, branch: string) => path.join(repo, DIR, branch.slice('agent/'.length));

export class GitIsolation implements Isolation {
  /** Repository root of a working directory; turns a plain folder into a repository on first use. */
  private repoOf(base: string) {
    fs.mkdirSync(base, { recursive: true });
    const top = tryGit(base, 'rev-parse', '--show-toplevel');
    // A folder the enclosing repository ignores (e.g. ./workspace in this project) gets a repository of its own
    const rel = top.ok ? path.relative(top.out, fs.realpathSync(base)) : '';
    if (top.ok && (!rel || !tryGit(top.out, 'check-ignore', '-q', rel + '/').ok)) return top.out;
    git(base, 'init', '-q');
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '--allow-empty', '-m', 'Agent Office: start');
    return git(base, 'rev-parse', '--show-toplevel');
  }

  enter(base: string, key: string): Workcell {
    const repo = this.repoOf(base);
    if (!tryGit(repo, 'rev-parse', '--verify', 'HEAD').ok) git(repo, 'commit', '-q', '--allow-empty', '-m', 'Agent Office: start');
    const exclude = path.join(git(repo, 'rev-parse', '--git-common-dir').replace(/^(?!\/)/, repo + '/'), 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes(DIR)) fs.appendFileSync(exclude, `\n${DIR}/\n`);

    const branch = `agent/${key}`;
    const tree = path.join(repo, DIR, key);
    if (!fs.existsSync(path.join(tree, '.git'))) {
      tryGit(repo, 'worktree', 'prune');
      const exists = tryGit(repo, 'rev-parse', '--verify', `refs/heads/${branch}`).ok;
      git(repo, 'worktree', 'add', '-q', ...(exists ? [tree, branch] : ['-b', branch, tree]));
    }
    // Pick up what others merged since the last task; never leave the worktree mid-merge
    const target = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const sync = tryGit(tree, 'merge', '-q', '--no-edit', target);
    if (!sync.ok) tryGit(tree, 'merge', '--abort');
    const sub = path.relative(repo, path.resolve(base));
    const cwd = path.join(tree, sub);
    fs.mkdirSync(cwd, { recursive: true });
    return { cwd, repo, branch, head: git(tree, 'rev-parse', 'HEAD'), synced: sync.ok, error: sync.ok ? '' : sync.out };
  }

  integrate(cell: Workcell, message: string, { merge = true } = {}) {
    const tree = worktreeOf(cell.repo, cell.branch);
    tryGit(tree, 'add', '-A');
    const commit_ = tryGit(tree, 'commit', '-q', '-m', message);
    const committed = commit_.ok;
    // Having nothing to commit fails too; work still lying around means the commit itself did
    if (!committed && tryGit(tree, 'status', '--porcelain').out) return { committed, merged: false, error: commit_.out, commit: '' };
    const ahead = Number(tryGit(cell.repo, 'rev-list', '--count', `HEAD..${cell.branch}`).out) || 0;
    // The agent may have committed on its own, leaving nothing for us to commit
    const commit = committed || ahead ? tryGit(tree, 'rev-parse', 'HEAD').out : '';
    if (!ahead || !merge) return { committed, merged: false, error: '', commit };
    return { committed, ...this.merge(cell.repo, cell.branch, message), commit };
  }

  merge(repo: string, branch: string, message: string) {
    const merge = tryGit(repo, 'merge', '-q', '--no-ff', '--no-edit', '-m', `Merge ${branch}: ${message.split('\n')[0]}`, branch);
    if (!merge.ok) tryGit(repo, 'merge', '--abort');
    return { merged: merge.ok, error: merge.ok ? '' : merge.out };
  }

  discard(repo: string, branch: string, commit: string) {
    git(worktreeOf(repo, branch), 'reset', '-q', '--hard', commit);
  }

  trunk(repo: string) {
    return git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  }

  diff(repo: string, from: string, to: string): TaskDiff {
    const list = 16 * 1024 * 1024;
    const status = gitDiff(repo, list, '--name-status', '-z', from, to, '--').split('\0');
    const kinds = new Map<string, string>();
    for (let i = 0; i + 1 < status.length; i += 2) kinds.set(status[i + 1]!, status[i]!);
    const files = gitDiff(repo, list, '--numstat', '-z', from, to, '--').split('\0').filter(Boolean).map((row): DiffFile => {
      const [additions = '', deletions = '', ...name] = row.split('\t');
      const file = name.join('\t');
      return { path: file, status: kinds.get(file) ?? 'M', additions: Number(additions) || 0, deletions: Number(deletions) || 0, binary: additions === '-' };
    });
    const { patch, cut } = cappedPatch(repo, from, to);
    return { files: files.slice(0, MAX_DIFF_FILES), patch, truncated: cut || files.length > MAX_DIFF_FILES };
  }

  commitRemoval(base: string, rel: string, message: string) {
    const repo = this.repoOf(base);
    const target = path.relative(repo, path.resolve(base, rel));
    // Untracked files leave nothing to commit; both calls then fail quietly
    tryGit(repo, 'add', '-A', '--', target);
    tryGit(repo, 'commit', '-q', '-m', message, '--', target);
  }
}
