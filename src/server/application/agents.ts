// Agent roster use cases: hiring, editing, firing, and keeping the office layout in sync.
import { planOffice } from '../../shared/layout.ts';
import { buildCompany } from '../../shared/company/index.ts';
import { LOCALES } from '../../shared/i18n/index.ts';
import type { Agent, TeamMember } from '../../shared/types.ts';
import { createAgent, findAgent, toTeamFile } from '../domain/agent.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import type { Runner, StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Translator } from './translator.ts';
import type { Tasks } from './tasks.ts';

export class Agents {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly tasks: Tasks,
    private readonly runner: Runner,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }

  get(id: string) {
    const agent = this.state.agents.find(a => a.id === id);
    if (!agent) throw notFound(this.t('err.notFound'));
    return agent;
  }

  hire(fields: Partial<Agent>) {
    const agent = this.add(fields);
    this.relayout();
    this.notify.agent(agent);
    return this.notify.publicAgent(agent);
  }

  update(id: string, fields: Partial<Agent>) {
    const agent = this.get(id);
    this.assertProvider(fields.provider);
    // A session belongs to one CLI; switching provider starts fresh
    if (fields.provider !== undefined && fields.provider !== agent.provider) agent.sessionId = null;
    Object.assign(agent, fields);
    this.relayout();
    this.notify.agent(agent);
    return this.notify.publicAgent(agent);
  }

  fire(id: string) {
    this.remove(this.get(id));
    this.relayout();
  }

  stop(id: string) {
    const agent = this.state.agents.find(a => a.id === id);
    if (agent) this.tasks.stop(agent);
  }

  resetMemory(id: string) {
    const agent = this.get(id);
    agent.sessionId = null;
    this.store.save();
    this.notify.log(agent.id, 'system', this.t('log.memoryReset'));
    this.notify.agent(agent);
  }

  /** Installs the default team; with `replace` everyone is fired first, otherwise only missing roles are added. */
  installDefaultTeam(replace = false) {
    if (replace) this.remove(...this.state.agents);
    const added = buildCompany(this.i18n.locale).defaultTeam.filter(d => !findAgent(this.state.agents, d.name)).map(d => this.add(d));
    added.forEach((a, i) => (a.hiredAt += i)); // keep the order in the layout
    this.relayout();
    added.forEach(a => this.notify.agent(a));
    return added;
  }

  /** Fires everyone. Their finished work stays on the board. */
  deleteTeam() {
    const count = this.state.agents.length;
    this.remove(...this.state.agents);
    this.relayout();
    return count;
  }

  exportTeam() {
    return toTeamFile(this.state.agents, Date.now());
  }

  /**
   * Hires the workers of a team file. With `replace` the current team goes first; otherwise a worker whose name is
   * taken is skipped. The file is checked before anyone is fired. A CLI this machine lacks falls back to the default.
   */
  importTeam(members: Partial<TeamMember>[], replace = false) {
    const names = new Set<string>();
    for (const m of members) {
      const name = (m.name ?? '').trim().toLowerCase();
      if (names.has(name)) throw badRequest(this.t('err.teamFileDuplicate', { name: m.name ?? '' }));
      names.add(name);
    }
    if (replace) this.remove(...this.state.agents);
    const fresh = members.filter(m => !findAgent(this.state.agents, m.name ?? ''));
    const added = fresh.map(m => this.add({ ...m, provider: m.provider && this.runner.has(m.provider) ? m.provider : '' }));
    added.forEach((a, i) => (a.hiredAt += i)); // keep the order in the layout
    this.relayout();
    added.forEach(a => this.notify.agent(a));
    return { added: added.map(a => a.name), skipped: members.length - added.length };
  }

  /**
   * Brings agents of the default team (matched by name) up to date with the current role definitions: role, prompt,
   * allowed tools and permission mode. Their CLI, model, memory and history stay as they are.
   */
  refreshDefaultRoles() {
    const updated: Agent[] = [];
    // The team may have been installed in another language: an agent gets the text of the language its name is in,
    // so the names quoted in its prompt are still its teammates'
    const locales = [this.i18n.locale, ...LOCALES.filter(l => l !== this.i18n.locale)];
    for (const d of locales.flatMap(l => buildCompany(l).defaultTeam)) {
      const agent = findAgent(this.state.agents, d.name);
      if (!agent || agent.kind !== 'agent' || updated.includes(agent)) continue;
      Object.assign(agent, { role: d.role, prompt: d.prompt, allowedTools: d.allowedTools, permissionMode: d.permissionMode });
      updated.push(agent);
    }
    this.store.save();
    updated.forEach(a => this.notify.agent(a));
    return updated;
  }

  /** Rebuilds the office from the team and assigns desks; publishes whatever changed. */
  relayout() {
    const plan = planOffice(this.state.agents, this.t);
    const office = { ...this.state.office, width: plan.width, depth: plan.depth, tier: plan.tier, items: plan.items };
    if (JSON.stringify(office) !== JSON.stringify(this.state.office)) {
      this.state.office = office;
      this.notify.publish({ type: 'office', office });
    }
    for (const a of this.state.agents) {
      const deskId = plan.desks[a.id] || null;
      if (a.deskId !== deskId) { a.deskId = deskId; this.notify.agent(a); }
    }
    this.store.save();
  }

  /** Starts every agent's queue (used at startup). */
  resume() {
    this.state.agents.forEach(a => this.tasks.runNext(a));
  }

  private add(fields: Partial<Agent>) {
    if (!fields.name?.trim()) throw badRequest(this.t('err.nameRequired'));
    if (findAgent(this.state.agents, fields.name)) throw badRequest(this.t('err.nameTaken'));
    this.assertProvider(fields.provider);
    const agent = createAgent(fields, this.t('role.assistant'));
    this.state.agents.push(agent);
    this.notify.log(agent.id, 'system', this.t('log.hired', { name: agent.name, role: agent.role }));
    return agent;
  }

  /** They leave first: closing their work can release a report, and none may go to someone on the way out. */
  private remove(...gone: Agent[]) {
    this.state.agents = this.state.agents.filter(a => !gone.includes(a));
    for (const agent of gone) {
      this.tasks.abandon(agent);
      this.notify.publish({ type: 'agent-removed', id: agent.id });
    }
  }

  private assertProvider(id?: string) {
    if (id && !this.runner.has(id)) throw badRequest(this.t('err.unknownProvider', { id }));
  }
}
