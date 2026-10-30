// Read models and small settings use cases.
import { buildCompany } from '../../shared/company/index.ts';
import type { Office, Settings, TaskLog } from '../../shared/types.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { snapshotTasks } from '../domain/delegation.ts';
import { TASK_LOG_LIMIT } from '../domain/logs.ts';
import type { FileTree, Isolation, LogBook, Runner, StateStore } from '../domain/ports.ts';
import type { Agents } from './agents.ts';
import type { Notifier } from './notifier.ts';
import type { Translator } from './translator.ts';

/** How many of the newest tasks a browser loads. */
const SNAPSHOT_TASKS = 200;

export class Workspace {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly runner: Runner,
    private readonly logs: LogBook,
    private readonly i18n: Translator,
    private readonly agents: Agents,
    private readonly files: FileTree,
    private readonly isolation: Isolation,
  ) {}

  private get state() { return this.store.state; }

  async snapshot() {
    const { office, agents, tasks, settings, schedules, approvals, visitors } = this.state;
    return {
      office, settings, schedules, approvals, visitors,
      notes: this.state.notes ?? [],
      providerHolds: this.state.providerHolds ?? {},
      agents: agents.map(a => this.notify.publicAgent(a)),
      tasks: snapshotTasks(tasks, SNAPSHOT_TASKS),
      presets: buildCompany(this.i18n.locale).presets,
      providers: await this.runner.providers(),
    };
  }

  /** Team roster as seen by agents (list_team). */
  team() {
    return this.state.agents.map(a => {
      const p = this.notify.publicAgent(a);
      return { name: a.name, role: a.role, team: a.team, kind: a.kind, status: p.status, queued: p.queued, activity: p.activity };
    });
  }

  logsOf(agentId: string) {
    return this.logs.recent(agentId);
  }

  /** What one task did, for its transcript; a task runs under one agent, so that agent's log holds it. */
  async taskLogs(taskId: string): Promise<TaskLog> {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw notFound(this.i18n.t('err.notFound'));
    return { ...await this.logs.ofTask(task.agentId, task.id, TASK_LOG_LIMIT), limit: TASK_LOG_LIMIT };
  }

  /** Full dump for the export download: persisted state plus each agent's recent log. */
  exportAll() {
    const { office, agents, tasks, settings, schedules, approvals } = this.state;
    return {
      exportedAt: new Date().toISOString(),
      office: { name: office.name, floorColor: office.floorColor, wallColor: office.wallColor },
      settings, agents, tasks, schedules, approvals, notes: this.state.notes ?? [],
      logs: Object.fromEntries(agents.map(a => [a.id, this.logs.recent(a.id)])),
    };
  }

  /** Files in the shared working directory, newest first. */
  outputs() {
    const root = this.state.settings.defaultCwd;
    return { root, files: this.files.list(root).sort((a, b) => b.mtime - a.mtime) };
  }

  output(rel: string) {
    const file = this.files.read(this.state.settings.defaultCwd, rel);
    if (!file) throw notFound(this.i18n.t('err.notFound'));
    return { path: rel, ...file };
  }

  /** The file as it is, with a content type for previews and downloads. */
  outputRaw(rel: string) {
    const bytes = this.files.raw(this.state.settings.defaultCwd, rel);
    if (!bytes) throw notFound(this.i18n.t('err.notFound'));
    return bytes;
  }

  /** Deletes an output file or folder; the working directory itself and repository state are off limits. */
  removeOutput(rel: string) {
    const root = this.state.settings.defaultCwd;
    if (!this.files.remove(root, rel)) throw notFound(this.i18n.t('err.notFound'));
    // Worktrees sync from commits: an uncommitted deletion would live on in every agent's checkout
    if (this.state.settings.worktrees) {
      try { this.isolation.commitRemoval(root, rel, this.i18n.t('git.removed', { path: rel })); } catch {}
    }
    this.notify.publish({ type: 'files-changed' });
  }

  /** The layout is automatic; only the name and colors can change. */
  updateOffice(fields: Partial<Pick<Office, 'name' | 'floorColor' | 'wallColor'>>) {
    this.state.office = { ...this.state.office, ...fields };
    this.store.save();
    this.notify.publish({ type: 'office', office: this.state.office });
  }

  async updateSettings(fields: Partial<Settings>) {
    const languageChanged = fields.language !== undefined && fields.language !== this.state.settings.language;
    // A session and a model name belong to one CLI: agents that follow the default start fresh when it changes
    if (fields.defaultProvider !== undefined && fields.defaultProvider !== this.state.settings.defaultProvider) {
      if (!this.runner.has(fields.defaultProvider)) throw badRequest(this.i18n.t('err.unknownProvider', { id: fields.defaultProvider }));
      for (const a of this.state.agents) {
        if (a.provider) continue;
        a.sessionId = null;
        a.model = '';
      }
    }
    Object.assign(this.state.settings, fields);
    if (fields.limits) this.agents.resume(); // raised caps or more slots let waiting tasks start
    if (languageChanged) this.agents.relayout(); // zone labels follow the language
    this.store.save();
    this.notify.publish({ type: 'settings', settings: this.state.settings });
    return { settings: this.state.settings, providers: await this.runner.providers() };
  }
}
