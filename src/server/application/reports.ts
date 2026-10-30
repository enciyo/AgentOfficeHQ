// How tasks close and how their reports travel up the chain: held while work is open under them, sent when it ends.
import type { Task, TaskStatus } from '../../shared/types.ts';
import { hasOpenUnder, lastTurnUnder, releasableAncestor, reportPrompt } from '../domain/delegation.ts';
import type { StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Translator } from './translator.ts';

/** Queues a task; a report is one, so it runs like any other. */
export type CreateTask = (agentId: string, prompt: string, options: { from: string; parentId: string; depth: number; kind: Task['kind'] }) => Task;

export class Reports {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly i18n: Translator,
    private readonly create: CreateTask,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }
  private agentOf = (id: string | null) => this.state.agents.find(a => a.id === id);
  /** Task ids with an undecided approval: their reports wait like they wait for subtasks. */
  pending = () => this.state.approvals.filter(a => a.status === 'pending' && a.taskId).map(a => a.taskId!);

  /**
   * The one way a task closes, so whatever is held above it can go. A cancelled task reports nothing itself.
   * `hold` (startup) keeps the report back for `reconcile` to weigh, and sends nothing.
   */
  finish(task: Task, status: TaskStatus, result: string, { at = Date.now(), hold = false } = {}) {
    task.status = status;
    task.result = result;
    task.endedAt = at;
    // If the agent split the work across the team, the report waits until the subtasks finish and are merged
    if (task.kind === 'task' && status !== 'cancelled') {
      if (hasOpenUnder(this.state.tasks, task.id, this.pending()) || (hold && this.agentOf(task.agentId) && this.agentOf(task.from))) task.awaiting = true;
      else if (!hold) this.report(task, status, result);
    }
    const kept = status === 'cancelled' && this.dropFollowUp(task);
    this.store.save();
    this.notify.task(task);
    if (!hold && !kept) this.releaseHeldReport(task);
  }

  /** The task whose report a run speaks for: its own, or for a report turn the task its agent reads that for. Null when nobody hears it. */
  reporterOf(run: Task) {
    const parentOf = (t: Task) => this.state.tasks.find(x => x.id === t.parentId);
    let at: Task | undefined = run;
    while (at && !(at.kind === 'task' && at.agentId === run.agentId)) at = parentOf(at);
    return at && this.agentOf(at.agentId) && this.agentOf(at.from) ? at : null;
  }

  /** The reports `task` sent, read or not. */
  reportsOf = (task: Task) => this.state.tasks.filter(t => t.parentId === task.id && t.kind === 'report' && t.from === task.agentId && t.status !== 'cancelled');

  /** A report turn run again has a report of its own to send: the one it spoke for, held again until it ends. */
  expectReport(run: Task, reporter: Task | null) {
    if (run.kind !== 'report' || !reporter || reporter.awaiting) return;
    reporter.awaiting = true;
    this.notify.task(reporter);
  }

  /**
   * A cancelled retry or resolver will not send what it was to send, so what came before it stands. Heard of: nothing
   * to add. Withdrawn or held by a retry: the failure is held for the CEO, as a cancel starts no run. True when it was.
   */
  private dropFollowUp(run: Task) {
    const first = this.state.tasks.find(t => t.id === (run.retryOf ?? run.resolves));
    const reporter = first && this.reporterOf(first);
    if (!reporter) return false;
    if (this.reportsOf(reporter).length) {
      if (reporter.awaiting && !hasOpenUnder(this.state.tasks, reporter.id, this.pending())) { reporter.awaiting = false; this.notify.task(reporter); }
      return false;
    }
    if (!run.retryOf) return false;
    reporter.awaiting = true;
    this.notify.task(reporter);
    return true;
  }

  // If another agent assigned the task, the report goes to that agent as a new message. False when there is nobody to tell.
  // `landed`: the run the report speaks for.
  private report(task: Task, status: TaskStatus, result: string, landed = task) {
    const worker = this.agentOf(task.agentId);
    const boss = this.agentOf(task.from);
    if (!worker || !boss) return false;
    this.notify.publish({ type: 'report', from: worker.id, to: boss.id, taskId: task.id, status });
    this.create(boss.id, reportPrompt(worker, task, status, result, this.t, landed, this.reportsOf(task).length > 0),
      { from: worker.id, parentId: task.id, depth: Math.max(0, task.depth - 1), kind: 'report' });
    return true;
  }

  /** Whatever just closed under it may have been the last thing a held report waited for. */
  releaseHeldReport(task: Task) {
    const held = releasableAncestor(this.state.tasks, task, this.pending());
    if (held) this.sendHeld(held);
  }

  /** Nothing more will close under `task`: sends its own held report, or else the one above it. */
  settle(task: Task) {
    if (task.awaiting && !hasOpenUnder(this.state.tasks, task.id, this.pending())) this.sendHeld(task);
    else this.releaseHeldReport(task);
  }

  // The report is the last turn its agent took under it (the leader merged the parts, or failed to).
  // With nobody to send it to (someone was fired) no report will finish under the next held one, so it goes on from here.
  sendHeld(held: Task) {
    held.awaiting = false;
    this.notify.task(held);
    const turn = lastTurnUnder(this.state.tasks, held);
    if (!this.report(held, turn.status, turn.result, turn)) this.releaseHeldReport(held);
    this.store.save();
  }
}
