// GitHub at the office door: open issues/PRs wait as visitors until the CEO hands them to someone,
// and a finished agent run (its worktree commit) can become a pull request.
import type { Task, Visitor } from '../../shared/types.ts';
import { CodeHostUnavailable, badRequest, notFound } from '../domain/errors.ts';
import type { CodeHost, StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Tasks } from './tasks.ts';
import type { Translator } from './translator.ts';

const KEEP = 200;
export const PR_BRANCH_PREFIX = 'agent-office/';

export class Github {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly tasks: Tasks,
    private readonly host: CodeHost,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }
  private polling = false;
  private readonly opening = new Map<string, Promise<Task>>();

  /** Readable failure for the CEO (missing `gh`, no remote, not logged in...). */
  private failure(err: unknown) {
    if (err instanceof CodeHostUnavailable) return badRequest(this.t('err.ghMissing'));
    return badRequest(this.t('err.github', { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }));
  }

  /**
   * Brings new open issues/PRs in as waiting visitors; waiting ones that were closed meanwhile leave.
   * `strict` (a manual refresh) reports failures; the background tick stays quiet.
   */
  async poll({ strict = false, now = Date.now() } = {}) {
    if (this.polling || (!strict && !this.state.settings.github)) return this.state.visitors;
    this.polling = true;
    try {
      const found = await this.host.inbound(this.state.settings.defaultCwd);
      const open = new Set(found.map(i => `${i.kind}-${i.number}`));
      const known = new Set(this.state.visitors.map(v => v.id));
      const fresh = found.filter(i => !known.has(`${i.kind}-${i.number}`)).map((i): Visitor => ({
        ...i, id: `${i.kind}-${i.number}`, status: 'waiting', agentId: null, createdAt: now, decidedAt: null,
      }));
      const before = this.state.visitors.length;
      this.state.visitors = this.state.visitors.filter(v => v.status !== 'waiting' || open.has(v.id)).concat(fresh).slice(-KEEP);
      if (fresh.length || this.state.visitors.length !== before) this.changed();
    } catch (err) {
      if (strict) throw this.failure(err);
    } finally {
      this.polling = false;
    }
    return this.state.visitors;
  }

  private visitor(id: string) {
    const v = this.state.visitors.find(x => x.id === id);
    if (!v) throw notFound(this.t('err.notFound'));
    if (v.status !== 'waiting') throw badRequest(this.t('err.visitorGone'));
    return v;
  }

  /** The visitor's issue/PR becomes a task for `agentId`. */
  accept(id: string, agentId: string, now = Date.now()) {
    const v = this.visitor(id);
    if (!this.state.agents.some(a => a.id === agentId)) throw notFound(this.t('err.notFound'));
    const task = this.tasks.create(agentId, this.t(v.kind === 'issue' ? 'visitor.issuePrompt' : 'visitor.prPrompt', {
      number: v.number, title: v.title, url: v.url, author: v.author || '?', body: v.body.trim() || '-',
    }));
    Object.assign(v, { status: 'accepted', agentId, decidedAt: now });
    this.changed();
    return { visitor: v, task };
  }

  reject(id: string, now = Date.now()) {
    const v = this.visitor(id);
    Object.assign(v, { status: 'rejected', decidedAt: now });
    this.changed();
    return v;
  }

  /** Pushes the task's commit to its own branch and opens a pull request from it. */
  /** A second click while the first is still pushing waits for the same pull request. */
  openPullRequest(taskId: string) {
    const running = this.opening.get(taskId);
    if (running) return running;
    const opening = this.createPullRequest(taskId).finally(() => this.opening.delete(taskId));
    this.opening.set(taskId, opening);
    return opening;
  }

  private async createPullRequest(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task.pr) return task;
    if (task.status !== 'done' || !task.commit) throw badRequest(this.t('err.prNoCommit'));
    const agent = this.state.agents.find(a => a.id === task.agentId);
    const summary = task.prompt.replace(/\s+/g, ' ').trim().slice(0, 72);
    try {
      task.pr = await this.host.openPullRequest(agent?.cwd || this.state.settings.defaultCwd, {
        commit: task.commit,
        branch: PR_BRANCH_PREFIX + task.id,
        title: this.t('pr.title', { name: agent?.name ?? '?', summary }),
        body: this.t('pr.body', { prompt: task.prompt.slice(0, 2000), result: task.result.slice(0, 4000), id: task.id }),
      });
    } catch (err) {
      throw this.failure(err);
    }
    this.store.save();
    this.notify.task(task);
    return task;
  }

  private changed() {
    this.store.save();
    this.notify.publish({ type: 'visitors', visitors: this.state.visitors });
  }
}
