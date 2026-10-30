// Task use cases: what the CEO and the agents can do to tasks. Runs, reports and merges each have their own module.
import { randomUUID } from 'node:crypto';
import { REACTIONS, type Agent, type Task, type TaskDiff } from '../../shared/types.ts';
import { findAgent } from '../domain/agent.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { AUTO_RELEASE_WINDOW_MS, MAX_DELEGATION_DEPTH, cutOffUnder, delegationPrompt, hasOpenUnder, lastEndedUnder, subtree } from '../domain/delegation.ts';
import type { Isolation, Runner, StateStore } from '../domain/ports.ts';
import { Blocks } from './blocks.ts';
import { Merges } from './merges.ts';
import type { Notifier } from './notifier.ts';
import type { PresenceBoard } from './presence.ts';
import { Reports } from './reports.ts';
import { Runs } from './runs.ts';
import type { Translator } from './translator.ts';

interface TaskOptions { from?: string; parentId?: string | null; depth?: number; kind?: Task['kind']; retryOf?: string; correction?: boolean; resolves?: string; scheduleId?: string }

export class Tasks {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    runner: Runner,
    presence: PresenceBoard,
    private readonly i18n: Translator,
    isolation: Isolation,
  ) {
    this.merges = new Merges(store, notify, isolation, i18n);
    this.reports = new Reports(store, notify, i18n, (agentId, prompt, options) => this.create(agentId, prompt, options));
    this.runs = new Runs(store, notify, runner, presence, i18n, new Blocks(store, notify, runner, presence, i18n), this.merges, this.reports);
  }

  private readonly merges: Merges;
  private readonly reports: Reports;
  private readonly runs: Runs;

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }
  private agentOf = (id: string | null) => this.state.agents.find(a => a.id === id);

  get(id: string) {
    const task = this.state.tasks.find(t => t.id === id);
    if (!task) throw notFound(this.t('err.notFound'));
    return task;
  }

  create(agentId: string, prompt: string, { from = 'user', parentId = null, depth = 0, kind = 'task', retryOf, correction, resolves, scheduleId }: TaskOptions = {}): Task {
    const task: Task = {
      id: randomUUID().slice(0, 8), agentId, prompt, from, parentId, depth, kind,
      status: 'queued', createdAt: Date.now(), startedAt: null, endedAt: null, result: '', cost: 0,
      ...(retryOf ? { retryOf } : {}), ...(correction ? { correction } : {}), ...(resolves ? { resolves } : {}), ...(scheduleId ? { scheduleId } : {}),
    };
    this.state.tasks.push(task);
    this.store.save();
    this.notify.task(task);
    const agent = this.agentOf(agentId);
    if (agent) {
      this.notify.log(agentId, 'task', prompt, task.id);
      this.notify.agent(agent);
      this.runNext(agent);
    }
    return task;
  }

  /** An agent hands work to a teammate; the report returns to the delegator automatically. */
  delegate(fromId: string, toName: string, prompt: string, parentTaskId?: string) {
    const target = findAgent(this.state.agents, toName);
    if (!target) throw badRequest(this.t('err.noMember', { name: toName }));
    if (target.id === fromId) throw badRequest(this.t('err.selfTask'));
    const parent = this.state.tasks.find(t => t.id === parentTaskId);
    // The call of a run that is being stopped: nothing may grow under cancelled work
    if (parent?.status === 'cancelled') throw badRequest(this.t('err.taskClosed'));
    const depth = (parent?.depth || 0) + 1;
    if (depth > MAX_DELEGATION_DEPTH) throw badRequest(this.t('err.tooDeep'));
    const task = this.create(target.id, delegationPrompt(this.agentOf(fromId), prompt, this.t), { from: fromId || 'user', parentId: parentTaskId || null, depth });
    this.notify.publish({ type: 'delegate', from: fromId, to: target.id, taskId: task.id });
    return { taskId: task.id, to: target.name, kind: target.kind };
  }

  /** Manually completes a task (human workers). */
  complete(id: string, result: string) {
    const task = this.get(id);
    if (task.status !== 'queued' && task.status !== 'running') throw badRequest(this.t('err.taskClosed'));
    const text = result || this.t('task.completedDefault');
    this.notify.log(task.agentId, 'result', text, task.id);
    this.reports.finish(task, 'done', text);
    this.touch(task.agentId);
    return task;
  }

  cancel(id: string) {
    const task = this.get(id);
    const agent = this.agentOf(task.agentId);
    if (task.status === 'running') {
      if (agent) this.stop(agent);
    } else if (task.status === 'queued') {
      this.reports.finish(task, 'cancelled', task.result);
    }
    this.touch(task.agentId);
    return task;
  }

  /**
   * Cancels a task and everything under it. Nobody is waiting for what the chain was doing, so its held reports and
   * undecided approvals are dropped without a word: this starts no run. A report held above the chain goes on as usual.
   */
  cancelChain(id: string) {
    const root = this.get(id);
    const chain = subtree(this.state.tasks, id);
    const tasks = this.state.tasks.filter(t => chain.has(t.id));
    const letGo = () => { for (const t of tasks) if (t.awaiting) { t.awaiting = false; this.notify.task(t); } };
    letGo();
    for (const a of this.state.approvals) {
      if (a.status !== 'pending' || !a.taskId || !chain.has(a.taskId)) continue;
      Object.assign(a, { status: 'rejected', note: this.t('approval.chainCancelled'), decidedAt: Date.now() });
      this.notify.publish({ type: 'approval', approval: a });
      const waiting = a.kind === 'merge' && tasks.find(t => t.id === a.taskId);
      if (waiting) { this.merges.drop(waiting, a.note); this.notify.task(waiting); }
    }
    // Queued first: stopping a run starts the agent's next task
    for (const status of ['queued', 'running'] as const) for (const t of tasks) if (t.status === status) this.cancel(t.id);
    letGo(); // a cancelled retry hands its failure back to be held, which here nobody waits for either
    this.reports.releaseHeldReport(root);
    this.store.save();
    return root;
  }

  /** Rewrites what a task that has not started yet asks for. */
  edit(id: string, prompt: string) {
    const task = this.get(id);
    if (task.status !== 'queued') throw badRequest(this.t('err.taskNotQueued'));
    task.prompt = prompt;
    this.store.save();
    this.notify.task(task);
    this.notify.log(task.agentId, 'task', prompt, id);
    return task;
  }

  /**
   * Runs a failed task again as a new task in the same place of the chain, so its report goes where the first one
   * went. Of the failure report: one held back is dropped and one still unread is withdrawn, so the retry sends the
   * only report. One already read can not be taken back: the retry's report says it replaces it, and being a report it
   * sends nothing further up, so a final report that already left is not repeated. A failed report turn sends nothing
   * itself, so the report it spoke for goes out again from its retry. Cancelling the retry undoes this: `dropFollowUp`.
   */
  retry(id: string) {
    const failed = this.get(id);
    if (failed.status !== 'error') throw badRequest(this.t('err.taskNotFailed'));
    if (!this.agentOf(failed.agentId)) throw notFound(this.t('err.notFound'));
    if (this.state.tasks.some(t => t.retryOf === id && t.status !== 'cancelled')) throw badRequest(this.t('err.taskRetried'));
    const reporter = this.reports.reporterOf(failed);
    const reports = reporter ? this.reports.reportsOf(reporter) : [];
    const unread = reports.filter(t => t.status === 'queued');
    // Whatever else is open would report to a task nobody continues; a report being read now ends by itself
    if (hasOpenUnder(this.state.tasks.filter(t => !unread.includes(t)), id, this.reports.pending())) throw badRequest(this.t('err.retryOpenWork'));
    if (failed.awaiting) { failed.awaiting = false; this.notify.task(failed); }
    this.reports.expectReport(failed, reporter);
    const { from, parentId, depth, kind, resolves } = failed;
    const again = this.create(failed.agentId, failed.prompt, { from, parentId, depth, kind, retryOf: id, resolves, correction: failed.correction || reports.length > unread.length });
    // After the retry exists: a report held above must not take this for the chain's end
    for (const report of unread) this.cancel(report.id);
    return again;
  }

  /** What a run changed, from its commits; null when it has none to show (the list of written files is what is left). */
  diff(id: string): TaskDiff | null { return this.merges.diff(this.get(id)); }

  /**
   * Gives a merge conflict to the agent whose branch has it, in the same place of the chain. Merging that branch takes
   * the conflicted work with it. Whoever heard of the conflict hears how this went, as a follow-up and not as new work.
   */
  resolveConflict(id: string) {
    const task = this.get(id);
    if (task.merge !== 'conflict') throw badRequest(this.t('err.noConflict'));
    if (!this.agentOf(task.agentId)) throw notFound(this.t('err.notFound'));
    if (this.state.tasks.some(t => t.resolves === id && (t.status === 'queued' || t.status === 'running'))) throw badRequest(this.t('err.conflictResolving'));
    const prompt = this.t('merge.resolvePrompt', {
      id, branch: task.branch ?? '', target: this.merges.trunk(task.repo ?? ''), error: (task.mergeNote ?? '').slice(0, 1000), prompt: task.prompt.slice(0, 2000),
    });
    const reporter = this.reports.reporterOf(task);
    this.reports.expectReport(task, reporter);
    const { from, parentId, depth, kind } = task;
    // A report turn's conflict is only heard of once the report it spoke for went out
    const heard = kind === 'task' || !!reporter && this.reports.reportsOf(reporter).length > 0;
    return this.create(task.agentId, prompt, { from, parentId, depth, kind, resolves: id, correction: heard });
  }

  /** The CEO's answer on a run's waiting changes. Nothing is left for the agent to do, so its report just goes on. */
  decideMerge(task: Task, approve: boolean, note: string) {
    if (approve) this.merges.approve(task);
    else this.merges.drop(task, note);
    this.store.save();
    this.notify.task(task);
    this.reports.settle(task);
    const agent = this.agentOf(task.agentId);
    if (agent) this.runNext(agent);
  }

  /** Holds the whole office, or lets it go on. Running tasks are left to finish. */
  setPaused(paused: boolean) {
    this.state.settings.paused = paused;
    this.store.save();
    this.notify.publish({ type: 'settings', settings: this.state.settings });
    this.pump();
  }

  /** Sends a report that has nothing left to wait for (a stuck one is not sent by itself: it starts a paid run). */
  releaseReport(id: string) {
    const task = this.get(id);
    if (!task.awaiting || hasOpenUnder(this.state.tasks, id, this.reports.pending())) throw badRequest(this.t('err.reportNotStuck'));
    this.reports.sendHeld(task);
    return task;
  }

  /** Closes the work of an agent who has left the office; a report held between them and someone else has nowhere to go. */
  abandon(agent: Agent) {
    this.stop(agent);
    for (const t of this.state.tasks) if (t.agentId === agent.id && t.status === 'queued') this.reports.finish(t, 'cancelled', t.result);
    for (const t of this.state.tasks) {
      if (t.awaiting && (t.agentId === agent.id || t.from === agent.id) && !hasOpenUnder(this.state.tasks, t.id, this.reports.pending())) this.reports.sendHeld(t);
    }
  }

  /**
   * Startup: closes the runs the last server left behind, then lets held reports with nothing left to wait for go.
   * A report starts a paid run, so only chains active within AUTO_RELEASE_WINDOW_MS send theirs; older ones stay held
   * (stuck) until someone sends or cancels them. So do chains a restart cut off, unless `resumeInterrupted` lets a
   * restart start runs: stopping the server is how a chain that spends too much gets stopped.
   */
  reconcile(now = Date.now()) {
    for (const task of this.state.tasks) {
      if (task.status === 'running' && this.resumable(task)) {
        // Marked before it runs, so going down again during this attempt ends it
        Object.assign(task, { status: 'queued', startedAt: null, resumed: true });
        this.notify.log(task.agentId, 'system', this.t('log.resuming'), task.id);
        this.notify.task(task);
      } else if (task.status === 'running') {
        const message = this.t('err.interrupted');
        this.notify.log(task.agentId, 'error', message, task.id);
        task.interrupted = true;
        // When it really stopped is unknown; its start is the last thing known, and never makes old work look recent
        this.reports.finish(task, 'error', message, { at: task.startedAt ?? task.createdAt, hold: true });
      } else if (task.status !== 'queued') {
        task.endedAt ??= task.startedAt ?? task.createdAt; // closed before every closing path set it
      }
    }
    // Newest first: a report below goes before the one above it, which then waits for that report to be read
    for (const held of this.state.tasks.filter(t => t.awaiting).reverse()) {
      if (hasOpenUnder(this.state.tasks, held.id, this.reports.pending())) continue;
      if (!this.state.settings.resumeInterrupted && cutOffUnder(this.state.tasks, held.id)) continue;
      if (now - lastEndedUnder(this.state.tasks, held.id) <= AUTO_RELEASE_WINDOW_MS) this.reports.sendHeld(held);
    }
    this.store.saveNow();
  }

  /** A run can go on after a restart when that is turned on, this is its first time back and there is a session to continue. */
  private resumable(task: Task) {
    const agent = this.agentOf(task.agentId);
    return !!this.state.settings.resumeInterrupted && !task.resumed && agent?.kind === 'agent' && !!agent.sessionId;
  }

  /** Moves work to another agent (dragged onto them): a queued task changes hands, anything else is given again. */
  handoff(id: string, toId: string) {
    const task = this.get(id);
    const target = this.agentOf(toId);
    if (!target) throw notFound(this.t('err.notFound'));
    if (target.id === task.agentId) throw badRequest(this.t('err.sameAgent'));
    if (task.status === 'running') throw badRequest(this.t('err.taskRunning'));
    const fromId = task.agentId;
    let moved = task;
    if (task.status === 'queued') {
      task.agentId = target.id;
      this.store.save();
      this.notify.task(task);
      this.notify.log(target.id, 'task', task.prompt, task.id);
      this.touch(fromId);
      this.notify.agent(target);
      this.runNext(target);
    } else {
      moved = this.create(target.id, task.prompt);
    }
    this.notify.publish({ type: 'delegate', from: fromId, to: target.id, taskId: moved.id });
    return moved;
  }

  /** Toggles one of the CEO's emoji reactions on a task. */
  react(id: string, emoji: string) {
    const task = this.get(id);
    if (!(REACTIONS as readonly string[]).includes(emoji)) throw badRequest(this.t('err.invalid'));
    const now = task.reactions ?? [];
    task.reactions = now.includes(emoji) ? now.filter(e => e !== emoji) : [...now, emoji];
    this.store.save();
    this.notify.task(task);
    return task;
  }

  // The rest of the office talks to these through here
  stop(agent: Agent) { this.runs.stop(agent); }
  runNext(agent: Agent) { this.runs.runNext(agent); }
  pump() { this.runs.pump(); }
  resumeProvider(id: string) { this.runs.resumeProvider(id); }
  shutdown() { return this.runs.shutdown(); }
  releaseHeldReport(task: Task) { this.reports.releaseHeldReport(task); }
  settle(task: Task) { this.reports.settle(task); }

  private touch(agentId: string) {
    const agent = this.agentOf(agentId);
    if (agent) this.notify.agent(agent);
  }
}
