// What happens to a run's git work: its worktree, folding it into the shared checkout, and the CEO's merge decision.
import { randomUUID } from 'node:crypto';
import type { Agent, Approval, Task, TaskDiff } from '../../shared/types.ts';
import { workcellKey } from '../domain/agent.ts';
import type { Isolation, StateStore, Workcell } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Translator } from './translator.ts';

export class Merges {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly isolation: Isolation,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }

  /** What a run changed, from its commits; null when it has none to show (the list of written files is what is left). */
  diff({ repo, baseCommit, commit }: Task): TaskDiff | null {
    if (!repo || !baseCommit || !commit) return null;
    try { return this.isolation.diff(repo, baseCommit, commit); } catch { return null; }
  }

  /** The branch a repository's work is merged into. */
  trunk(repo: string) { return this.isolation.trunk(repo); }

  /** The agent's own git worktree; falls back to the shared folder when git is not usable there. */
  enter(agent: Agent, task: Task, base: string): Workcell | null {
    try {
      const cell = this.isolation.enter(base, workcellKey(agent));
      this.notify.log(agent.id, 'system', this.t('log.worktree', { branch: cell.branch }), task.id);
      if (!cell.synced) this.notify.log(agent.id, 'error', this.t('log.syncFailed', { error: cell.error.slice(0, 300) }), task.id);
      return cell;
    } catch (err) {
      this.notify.log(agent.id, 'error', this.t('log.worktreeFailed', { error: err instanceof Error ? err.message.slice(0, 300) : String(err) }), task.id);
      return null;
    }
  }

  /** Folds a finished run's changes into the shared checkout, before anyone downstream starts reading them. */
  integrate(agent: Agent, task: Task, cell: Workcell) {
    try {
      const r = this.isolation.integrate(cell, `${agent.name} (${agent.role}) #${task.id}\n\n${task.prompt.slice(0, 2000)}`, { merge: !this.state.settings.approveMerges });
      if (r.commit) task.commit = r.commit;
      if (r.error) this.mergeFailed(task, r.error);
      else if (r.merged) this.merged(task);
      else if (r.commit) this.askToMerge(task);
      else task.merge = 'unchanged';
    } catch (err) {
      this.mergeFailed(task, err instanceof Error ? err.message : String(err));
    }
  }

  /** Merging a branch takes all its work along, so the conflicts of earlier runs on it are over too. */
  private merged(task: Task) {
    this.notify.log(task.agentId, 'system', this.t('log.merged', { branch: task.branch ?? '' }), task.id);
    task.merge = 'merged';
    delete task.mergeNote;
    for (const earlier of this.state.tasks) {
      if (earlier.merge !== 'conflict' || earlier.branch !== task.branch || earlier.repo !== task.repo) continue;
      earlier.merge = 'merged';
      delete earlier.mergeNote;
      this.notify.task(earlier);
    }
  }

  private mergeFailed(task: Task, error: string) {
    this.notify.log(task.agentId, 'error', this.t('log.mergeFailed', { branch: task.branch ?? '', error: error.slice(0, 300) }), task.id);
    task.merge = 'conflict';
    task.mergeNote = error.slice(0, 2000);
  }

  /** An undecided approval holds the report back, as any other does: it has to exist before the task finishes. */
  private askToMerge(task: Task) {
    task.merge = 'pending';
    const branch = task.branch ?? '';
    const diff = this.diff(task);
    const sum = (key: 'additions' | 'deletions') => diff?.files.reduce((n, f) => n + f[key], 0) ?? 0;
    const approval: Approval = {
      id: randomUUID().slice(0, 8), agentId: task.agentId, taskId: task.id, kind: 'merge', action: this.t('merge.approvalAction', { branch }),
      details: diff ? this.t('merge.approvalDetails', { files: diff.files.length, additions: sum('additions'), deletions: sum('deletions') }) : '',
      status: 'pending', note: '', createdAt: Date.now(), decidedAt: null,
    };
    this.state.approvals.push(approval);
    this.state.approvals = this.state.approvals.slice(-300);
    this.notify.log(task.agentId, 'system', this.t('log.approvalRequested', { action: approval.action }), task.id);
    this.notify.publish({ type: 'approval', approval });
  }

  /** Merges changes that waited for the CEO. */
  approve(task: Task) {
    try {
      const r = this.isolation.merge(task.repo ?? '', task.branch ?? '', `#${task.id}`);
      if (r.merged) this.merged(task);
      else this.mergeFailed(task, r.error);
    } catch (err) {
      this.mergeFailed(task, err instanceof Error ? err.message : String(err));
    }
  }

  /** The agent waited for this decision, so nothing has been built on the work: its branch goes back to before the run. */
  drop(task: Task, note: string) {
    try {
      this.isolation.discard(task.repo ?? '', task.branch ?? '', task.baseCommit ?? '');
    } catch (err) {
      this.notify.log(task.agentId, 'error', this.t('log.discardFailed', { branch: task.branch ?? '', error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }), task.id);
    }
    task.merge = 'rejected';
    if (note) task.mergeNote = note;
  }
}
