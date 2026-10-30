// Running tasks: picks what an agent does next, drives its CLI process and settles how the run ended.
import path from 'node:path';
import type { Agent, Task } from '../../shared/types.ts';
import { providerOf } from '../domain/agent.ts';
import { chainBlock } from '../../shared/chain.ts';
import { ProviderUnavailable } from '../domain/errors.ts';
import { MAX_REQUEUES, MAX_TIMER_MIN, blockReason, holdUntil } from '../domain/limits.ts';
import { resumePrompt, retryPrompt } from '../domain/delegation.ts';
import { buildSystemPrompt } from '../domain/prompts.ts';
import type { AgentEvent, ProviderFailure, Runner, StateStore, Workcell } from '../domain/ports.ts';
import type { Blocks } from './blocks.ts';
import type { Merges } from './merges.ts';
import type { Notifier } from './notifier.ts';
import type { PresenceBoard } from './presence.ts';
import type { Reports } from './reports.ts';
import type { Translator } from './translator.ts';

const MAX_TASK_FILES = 200;
const outside = (rel: string) => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
/** The schema caps these; settings saved before it did may hold more, which setTimeout would turn into 1 ms. */
const timerMs = (minutes: number) => Math.min(minutes, MAX_TIMER_MIN) * 60_000;

export class Runs {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly runner: Runner,
    private readonly presence: PresenceBoard,
    private readonly i18n: Translator,
    private readonly blocks: Blocks,
    private readonly merges: Merges,
    private readonly reports: Reports,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }
  /** The server is going down: no run starts any more. */
  private closing = false;
  /** Tells `shutdown` the last run is gone. */
  private drained = () => {};

  stop(agent: Agent) {
    const p = this.presence.of(agent.id);
    if (!p.run) return;
    const task = this.state.tasks.find(t => t.id === p.taskId);
    if (task) this.reports.finish(task, 'cancelled', task.result);
    p.run.stop();
  }

  runNext(agent: Agent): void {
    const p = this.presence.of(agent.id);
    if (this.closing || p.run || agent.kind === 'human') return;
    p.blockedBy = null;
    const { limits, paused } = this.state.settings;
    const queue = this.state.tasks.filter(t => t.agentId === agent.id && t.status === 'queued');
    // A chain at its limit may wait for a long time; the work queued behind it does not wait with it
    const task = queue.find(t => !chainBlock(limits, this.state.tasks, t)) ?? queue[0];
    if (!task) { p.activity = ''; this.notify.agent(agent); return; }
    // Its next run would build on work that may yet be dropped
    if (this.state.approvals.some(a => a.kind === 'merge' && a.status === 'pending' && a.agentId === agent.id)) {
      p.activity = this.t('blocked.mergeReview');
      return this.notify.agent(agent);
    }
    const runtime = this.runtimeOf(agent);
    const block = blockReason(limits, this.state.tasks, agent.id, this.presence.running(), Date.now(), this.state.providerHolds?.[runtime.provider], { paused, task });
    if (block) return this.blocks.hold(agent, block, this.runtimeOf(agent).provider);

    const base = agent.cwd || this.state.settings.defaultCwd;
    const cell = this.state.settings.worktrees ? this.merges.enter(agent, task, base) : null;
    const cwd = cell?.cwd ?? base;
    let result: Extract<AgentEvent, { type: 'result' }> | null = null;
    let gotSession = false;
    /** What this run has reported so far; a task put back by a CLI limit has earlier attempts on top. */
    let reported = 0;
    // Booked as it is reported, not at the end: however the run ends, and even after a cancel, the money is spent
    const book = (usd: number) => {
      const added = usd - reported;
      reported = usd;
      task.cost = (task.cost ?? 0) + added;
      agent.totalCost = (agent.totalCost || 0) + added;
      this.store.save();
      this.notify.task(task);
    };
    /** Why the office stopped this run itself. */
    let failure = '';
    let silence: NodeJS.Timeout | undefined;
    const { taskTimeoutMin: timeoutMin, silenceTimeoutMin: silenceMin } = limits;
    const abort = (message: string) => {
      if (failure || task.status !== 'running') return;
      failure = message;
      this.notify.log(agent.id, 'error', message, task.id);
      p.run?.stop();
    };
    const watch = () => {
      clearTimeout(silence);
      if (silenceMin > 0) silence = setTimeout(() => abort(this.t('err.silent', { min: silenceMin })), timerMs(silenceMin));
    };
    const prompt = task.resumed ? resumePrompt(task, this.t) : task.requeues && agent.sessionId ? retryPrompt(task, this.t) : task.prompt;
    try {
      p.run = this.runner.start(
        { agent: runtime, task: { ...task, prompt }, cwd, locale: this.i18n.locale, systemPrompt: buildSystemPrompt(agent, this.state.agents, this.runner.delegates(runtime.provider), this.t, this.state.settings.approvalPolicy, this.state.settings.officeNotes, this.state.notes) },
        {
          onEvent: (e) => {
            if (e.type === 'session') gotSession = true;
            if (e.type === 'result') {
              result = e;
              if (e.costUsd !== undefined) book(e.costUsd);
            } else this.onEvent(agent, task, e, cwd, base);
          },
          onActivity: watch,
          onExit: ({ code, stderr }) => {
            clearTimeout(silence);
            if (p.timer) clearTimeout(p.timer);
            p.timer = null;
            p.run = null;
            p.taskId = null;
            p.activity = '';
            const outcome = failure ? null : result;
            const trouble = failure || outcome?.ok ? null : this.runner.classify(runtime.provider, { text: outcome?.text ?? '', stderr, code }, Date.now());
            // Stopped by the shutdown, not by anything that went wrong: the next start decides
            if (!this.closing || task.status !== 'running' || outcome?.ok) this.onExit(agent, task, outcome, gotSession, code, failure || stderr, cell, runtime.provider, trouble);
            if (this.closing && !this.presence.running()) this.drained();
          },
        },
      );
    } catch (err) {
      const message = err instanceof ProviderUnavailable ? this.t('err.cliMissing', { label: err.label, id: err.providerId.toUpperCase() }) : err instanceof Error ? err.message : String(err);
      this.notify.log(agent.id, 'error', message, task.id);
      this.reports.finish(task, 'error', message);
      return this.runNext(agent);
    }
    p.taskId = task.id;
    p.activity = this.t('activity.thinking');
    task.status = 'running';
    task.startedAt = Date.now();
    task.cost ||= null; // unknown until the CLI says otherwise
    if (cell) Object.assign(task, { baseCommit: cell.head, branch: cell.branch, repo: cell.repo });
    if (timeoutMin > 0) p.timer = setTimeout(() => abort(this.t('err.timeout', { min: timeoutMin })), timerMs(timeoutMin));
    watch();
    this.store.save();
    this.notify.task(task);
    this.notify.agent(agent);
    this.notify.log(agent.id, 'system', this.t('log.started', { dir: path.basename(cwd) }), task.id);
  }

  /**
   * The agent as it should run. CLI: its own, else the office default.
   * Model: a forced office-wide one for that CLI, else its own, else the office default for that CLI.
   */
  private runtimeOf(agent: Agent): Agent {
    const { modelOverrides, defaultModels, defaultProvider } = this.state.settings;
    const provider = providerOf(agent, defaultProvider);
    const model = modelOverrides?.[provider] || agent.model || defaultModels?.[provider] || '';
    return provider === agent.provider && model === agent.model ? agent : { ...agent, provider, model };
  }

  /** Starts whatever may start now: after a run ends, when limits or holds change, at midnight. */
  pump() {
    this.blocks.dropExpired();
    for (const agent of this.state.agents) this.runNext(agent);
  }

  /** Lifts a hold by hand: the login is fixed, or the limit is over sooner than the CLI said. */
  resumeProvider(id: string) {
    if (this.blocks.lift(id)) this.pump();
  }

  /**
   * The server is going down: stops every run and resolves once they are gone. What they were doing stays `running`
   * for `reconcile` to close or continue at the next start; a run that still finished properly counts, but its report
   * only starts then.
   */
  shutdown() {
    this.closing = true;
    return new Promise<void>((resolve) => {
      this.drained = resolve;
      this.presence.stopAll();
      if (!this.presence.running()) resolve();
    });
  }

  /**
   * A limit or a failed login is the CLI's trouble, not the task's: the task waits for the provider to come back
   * and nobody above hears of it. Every agent on that CLI waits with it, so the queue is not burnt through.
   */
  private requeue(agent: Agent, task: Task, provider: string, failure: ProviderFailure, message: string) {
    const tries = task.requeues ?? 0;
    const ranMs = (task.ranMs ?? 0) + (task.startedAt ? Date.now() - task.startedAt : 0);
    Object.assign(task, { status: 'queued', startedAt: null, requeues: tries + 1, ranMs });
    this.notify.task(task);
    this.blocks.holdProvider(agent, provider, failure.kind === 'limit' ? holdUntil(failure.resetAt, tries, Date.now()) : null, message);
  }

  private onEvent(agent: Agent, task: Task, e: Exclude<AgentEvent, { type: 'result' }>, cwd: string, base: string) {
    const p = this.presence.of(agent.id);
    switch (e.type) {
      case 'session':
        if (agent.sessionId !== e.id) { agent.sessionId = e.id; this.store.save(); }
        return;
      case 'text':
        this.notify.log(agent.id, 'text', e.text, task.id);
        p.activity = '💬 ' + e.text.replace(/\s+/g, ' ').slice(0, 90);
        return this.notify.agent(agent);
      case 'tool': {
        if (e.files) this.recordFiles(task, e.files, cwd, base);
        const summary = this.t(`tool.${e.tool}`, { detail: e.detail ?? '' });
        this.notify.log(agent.id, 'tool', summary, task.id, e.input);
        p.activity = summary;
        return this.notify.agent(agent);
      }
      case 'tool-error':
        return this.notify.log(agent.id, 'error', e.text.slice(0, 400), task.id, e.text.length > 400 ? e.text : undefined);
      case 'files':
        return this.recordFiles(task, e.files, cwd, base);
    }
  }

  /**
   * Remembers which outputs a run wrote, as paths in the shared working directory. A worktree mirrors the agent's
   * base folder, so a path relative to the run's cwd is the same path under `base`.
   */
  private recordFiles(task: Task, files: string[], cwd: string, base: string) {
    const root = path.resolve(this.state.settings.defaultCwd);
    const known = new Set(task.files ?? []);
    for (const f of files) {
      const rel = path.relative(path.resolve(cwd), path.resolve(cwd, f));
      if (outside(rel)) continue;
      const out = path.relative(root, path.resolve(base, rel));
      if (!out || outside(out)) continue;
      known.add(out.split(path.sep).join('/'));
    }
    if (known.size !== (task.files?.length ?? 0)) task.files = [...known].slice(0, MAX_TASK_FILES);
  }

  private onExit(agent: Agent, task: Task, result: Extract<AgentEvent, { type: 'result' }> | null, gotSession: boolean, code: number | null, stderr: string, cell: Workcell | null, provider: string, trouble: ProviderFailure | null) {
    if (task.status === 'cancelled') {
      this.notify.log(agent.id, 'system', this.t('log.stopped'), task.id);
      this.notify.task(task);
    } else if (result?.ok) {
      this.notify.log(agent.id, 'result', result.text, task.id);
      if (cell) this.merges.integrate(agent, task, cell);
      this.reports.finish(task, 'done', result.text);
    } else {
      // A limit or a failed login says nothing about the session, which often has not even been reached
      const unreachable = trouble?.kind === 'limit' || trouble?.kind === 'auth';
      // If the session is not found, start a new one on the next attempt
      if (!gotSession && agent.sessionId && !unreachable) agent.sessionId = null;
      const message = result?.text || stderr.trim().split('\n').slice(-3).join('\n') || this.t('err.exit', { code: code ?? '?' });
      this.notify.log(agent.id, 'error', message, task.id);
      if (trouble && unreachable && (task.requeues ?? 0) < MAX_REQUEUES) this.requeue(agent, task, provider, trouble, message);
      else this.reports.finish(task, 'error', message);
    }
    this.store.save();
    this.notify.agent(agent);
    // A slot (or the agent itself) is free again
    this.pump();
  }
}
