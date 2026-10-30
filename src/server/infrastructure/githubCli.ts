// GitHub through the `gh` CLI: open issues/PRs of a working directory's repository, and pull requests from agent commits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodeHostUnavailable } from '../domain/errors.ts';
import type { CodeHost, Inbound } from '../domain/ports.ts';

const run = promisify(execFile);
const FIELDS = 'number,title,url,author,body';
const BODY_MAX = 4000;

export class GithubCli implements CodeHost {
  constructor(private readonly bin = process.env.GH_BIN || 'gh') {}

  /** Runs a command; failures carry the last lines of stderr, a missing `gh` becomes CodeHostUnavailable. */
  private async exec(cmd: string, args: string[], cwd: string) {
    try {
      const { stdout } = await run(cmd, args, { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
      return stdout.trim();
    } catch (e: any) {
      if (e?.code === 'ENOENT' && cmd === this.bin) throw new CodeHostUnavailable(this.bin);
      throw new Error(String(e?.stderr || e?.message || e).trim().split('\n').slice(-2).join(' '));
    }
  }

  async inbound(cwd: string): Promise<Inbound[]> {
    const list = async (kind: Inbound['kind']) => {
      const raw = await this.exec(this.bin, [kind, 'list', '--state', 'open', '--limit', '20', '--json', FIELDS], cwd);
      return (JSON.parse(raw || '[]') as any[]).map((i): Inbound => ({
        kind, number: Number(i.number), title: String(i.title ?? ''), url: String(i.url ?? ''), author: String(i.author?.login ?? ''), body: String(i.body ?? '').slice(0, BODY_MAX),
      }));
    };
    const [issues, prs] = await Promise.all([list('issue'), list('pr')]);
    return [...issues, ...prs];
  }

  async openPullRequest(cwd: string, { commit, branch, title, body }: { commit: string; branch: string; title: string; body: string }) {
    await this.exec('git', ['push', '--force', 'origin', `${commit}:refs/heads/${branch}`], cwd);
    const out = await this.exec(this.bin, ['pr', 'create', '--head', branch, '--title', title, '--body', body], cwd);
    return out.split('\n').filter(Boolean).at(-1) ?? '';
  }
}
