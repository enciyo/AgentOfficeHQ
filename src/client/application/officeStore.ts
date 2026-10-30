// Application state and use cases of the UI (Zustand store). Talks to the outside only through ports.
import { createStore } from 'zustand/vanilla';
import { createT, type Locale, type Translate } from '../../shared/i18n/index.ts';
import type { RoomKind } from '../../shared/catalog.ts';
import type { Approval, LogEntry, Note, Office, ProviderHold, ProviderInfo, PublicAgent, Schedule, Settings, Task, TeamFile, Visitor } from '../../shared/types.ts';
import type { AgentDraft } from '../domain/agentForm.ts';
import { draftPayload } from '../domain/agentForm.ts';
import { attentionOf, type Attention } from '../domain/attention.ts';
import { errorMessage, formatDateTime } from '../domain/format.ts';
import { coffeeBreak, drinkCoffee, freshFun, rollEvents, tickFun, type Fun, type Weather } from '../domain/fun.ts';
import { chainHoldLabel, chatItems, dropPrompt, dropProblem, pmAgent, standupLines, unreadCount, type StandupLine } from '../domain/views.ts';
import { addLiveEntry, emptyTranscript, mergeLoaded, type Transcript } from '../domain/transcript.ts';
import { readGraphics, type Graphics } from '../domain/quality.ts';
import type { Alerts, EventFeed, Gateway, KeyValueStorage, Preset, ScheduleDraft, ServerEvent, Snapshot, Stage } from './ports.ts';

export type InspectorTab = 'tasks' | 'log' | 'settings';
export type Modal = 'hire' | 'settings' | 'priority' | 'visitor' | null;
export type Theme = 'system' | 'light' | 'dark';
export type DrawerTab = 'board' | 'flow' | 'activity' | 'files' | 'approvals' | 'knowledge' | 'leaders';
export interface Actor { name: string; color?: string }
interface FeedItem { id: number; ts: number; actors: Actor[]; text: string }
interface Toast { id: number; text: string }

export interface OfficeState {
  theme: Theme;
  graphics: Graphics;
  office: Office | null;
  agents: Record<string, PublicAgent>;
  tasks: Record<string, Task>;
  logs: Record<string, LogEntry[]>;
  /** The one task whose log is on screen, kept up to date from the live feed. */
  transcript: Transcript | null;
  presets: Preset[];
  providers: ProviderInfo[];
  /** CLIs that may not start runs for now, by provider id. */
  providerHolds: Record<string, ProviderHold>;
  settings: Settings;
  schedules: Schedule[];
  approvals: Approval[];
  /** The team's shared notes. */
  notes: Note[];
  selectedId: string | null;
  tab: InspectorTab;
  modal: Modal;
  kanbanOpen: boolean;
  /** The drawer covers the whole window. */
  drawerFull: boolean;
  drawerTab: DrawerTab;
  chatOpen: boolean;
  chatSeenAt: number;
  chatClearedAt: number;
  /** Bumped when the user should start typing a task (e.g. pressed E next to an agent). */
  composerFocus: number;
  feed: FeedItem[];
  toasts: Toast[];
  visitors: Visitor[];
  /** The visitor whose card is open. */
  visitorId: string | null;
  fun: Fun;
  weather: Weather;
  /** Random fire drills and showers. */
  funEvents: boolean;
  standup: { at: number; lines: StandupLine[] } | null;
  /** The task whose details the Flow tab shows. */
  flowTaskId: string | null;
  /** Completed flow roots hidden in this browser; the underlying task history stays intact. */
  flowHidden: string[];
  /** When set, the Outputs tab shows only these files (what a task chain wrote). */
  outputsFocus: { title: string; paths: string[] } | null;
  /** The output to open in the Outputs tab. */
  outputPath: string | null;
  /** Bumped whenever files in the working directory change (the Outputs tab reloads). */
  filesVersion: number;
  /** What each agent needs from the CEO, derived from the rest of this state. */
  attention: Record<string, Attention>;
  /** Per agent: failures that ended up to this time had their sign dismissed (this browser only). */
  acknowledged: Record<string, number>;
}

const CHAT_SEEN_KEY = 'agent-office:chat-seen';
const CHAT_CLEARED_KEY = 'agent-office:chat-cleared';
const FLOW_HIDDEN_KEY = 'agent-office:flow-hidden';
const ACKNOWLEDGED_KEY = 'agent-office:attention-dismissed';
const FUN_KEY = 'agent-office:fun';
const FUN_EVENTS_KEY = 'agent-office:fun-events';
const PRIORITY_DAY_KEY = 'agent-office:priority-day';
const FUN_TICK_MS = 5000;
const DRILL_MS = 20_000;
const STANDUP_COOLDOWN_MS = 3 * 60_000;
const BREAK_COOLDOWN_MS = 60_000;
const FEED_LIMIT = 60;
const today = () => new Date().toDateString();
const toArray = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map(i => [i.id, i]));

const THEME_KEY = 'agent-office:theme';
const GRAPHICS_KEY = 'agent-office:graphics';

export interface Deps { gateway: Gateway; events: EventFeed; stage: Stage; storage: KeyValueStorage; alerts: Alerts; locale: Locale; /** Phones, tablets and small screens. */ lightDevice?: boolean }

export function createOfficeStore({ gateway, events, stage, storage, alerts, locale, lightDevice }: Deps) {
  const store = createStore<OfficeState>(() => ({
    office: null, agents: {}, tasks: {}, logs: {}, transcript: null, presets: [], providers: [], providerHolds: {}, settings: { language: locale } as Settings, schedules: [], approvals: [], notes: [],
    graphics: readGraphics(storage.get(GRAPHICS_KEY), !!lightDevice),
    theme: (['light', 'dark'] as const).find(v => v === storage.get(THEME_KEY)) ?? 'system',
    selectedId: null, tab: 'tasks', modal: null, kanbanOpen: false, drawerFull: false, drawerTab: 'board', chatOpen: false, chatSeenAt: Number(storage.get(CHAT_SEEN_KEY)) || 0, chatClearedAt: Number(storage.get(CHAT_CLEARED_KEY)) || 0,
    composerFocus: 0, feed: [], toasts: [],
    flowTaskId: null,
    flowHidden: (() => {
      try {
        const value: unknown = JSON.parse(storage.get(FLOW_HIDDEN_KEY) ?? '[]');
        return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : [];
      } catch { return []; }
    })(),
    outputsFocus: null, outputPath: null, filesVersion: 0, attention: {},
    acknowledged: (() => { try { return JSON.parse(storage.get(ACKNOWLEDGED_KEY) ?? '{}') as Record<string, number>; } catch { return {}; } })(),
    visitors: [], visitorId: null, weather: 'clear', funEvents: storage.get(FUN_EVENTS_KEY) !== 'off', standup: null,
    fun: (() => { try { return { ...freshFun(Date.now()), ...JSON.parse(storage.get(FUN_KEY) ?? '{}') } as Fun; } catch { return freshFun(Date.now()); } })(),
  }));
  const { getState: get, setState: set } = store;

  let nextId = 1;
  const t: Translate = (key, params) => createT(get().settings.language)(key, params);
  const actorOf = (id: string): Actor => {
    const a = get().agents[id];
    return a ? { name: a.name, color: a.color } : { name: id === 'user' ? `🧑‍💼 ${t('ui.you')}` : '?' };
  };
  const announce = (actors: string[] | Actor[], text: string) => {
    const resolved = actors.map(a => (typeof a === 'string' ? actorOf(a) : a));
    set(s => ({ feed: [{ id: nextId++, ts: Date.now(), actors: resolved, text }, ...s.feed].slice(0, FEED_LIMIT) }));
  };
  const toast = (text: string) => {
    const id = nextId++;
    set(s => ({ toasts: [...s.toasts, { id, text }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 3500);
  };
  /** Runs a command, reporting failures as toasts. */
  const attempt = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (e) { toast(errorMessage(e)); }
  };

  // Signs follow the state they come from, whatever changed it
  let shownSigns = '';
  const refreshAttention = () => {
    const { agents, tasks, approvals, settings, providers, providerHolds, acknowledged } = get();
    const attention = attentionOf(Object.values(agents), { tasks: Object.values(tasks), approvals, settings, providers, providerHolds, acknowledged }, t);
    const signs = JSON.stringify(attention);
    if (signs === shownSigns) return;
    shownSigns = signs;
    set({ attention });
    stage.setAttention(attention);
  };
  store.subscribe((s, p) => {
    if (s.agents !== p.agents || s.tasks !== p.tasks || s.approvals !== p.approvals || s.settings !== p.settings || s.providers !== p.providers || s.providerHolds !== p.providerHolds || s.acknowledged !== p.acknowledged) refreshAttention();
  });

  const applySettings = (settings: Settings) => {
    stage.setLanguage(createT(settings.language));
    stage.setPlayer({ name: settings.playerName || t('ui.you'), color: settings.playerColor || '#ff7a59' });
  };

  const applySnapshot = (s: Snapshot) => {
    set({ visitors: s.visitors ?? [] });
    stage.setVisitors(s.visitors ?? []);
    set({ office: s.office, presets: s.presets, providers: s.providers, providerHolds: s.providerHolds ?? {}, settings: s.settings, schedules: s.schedules ?? [], approvals: s.approvals ?? [], notes: s.notes ?? [], agents: toArray(s.agents), tasks: toArray(s.tasks) });
    applySettings(s.settings);
    stage.setOffice(s.office);
    stage.setAgents(s.agents);
    stage.setMorale(get().fun.morale);
  };

  const greet = (s: Snapshot) => {
    if (!s.providers.some(p => p.available)) toast(t('toast.noBin'));
    if (!s.agents.length) setTimeout(() => toast(t('toast.empty')), 600);
    else if (s.agents.some(a => a.name === 'Product Manager')) setTimeout(() => toast(t('toast.pmHint')), 600);
  };

  const onTask = (tk: Task) => {
    const prev = get().tasks[tk.id];
    set(s => ({ tasks: { ...s.tasks, [tk.id]: tk } }));
    if (prev?.status === tk.status) return;
    if (tk.status === 'done') {
      stage.flash(tk.agentId, tk.kind === 'report' ? t('flash.report') : t('flash.done'), 4500);
      if (tk.kind !== 'report') announce([tk.agentId], t('feed.done'));
    } else if (tk.status === 'error') {
      announce([tk.agentId], t('feed.error'));
    } else if (tk.status === 'running' && tk.kind !== 'report') {
      announce([tk.agentId], t('feed.started'));
    }
    if (prev && (tk.status === 'done' || tk.status === 'error')) alertFinished(tk);
  };

  /** Background-tab notification for the work the CEO cares about: their own tasks and the PM's replies. */
  const alertFinished = (tk: Task) => {
    const agent = get().agents[tk.agentId];
    const pm = pmAgent(Object.values(get().agents));
    const toPm = !!pm && tk.agentId === pm.id;
    if (!agent || (tk.from !== 'user' && !toPm)) return;
    const title = t(tk.status === 'done' ? 'alert.done' : 'alert.error', { name: agent.name });
    alerts.show(title, tk.result.replace(/\s+/g, ' ').slice(0, 160), () => (toPm ? actions.toggleChat(true) : actions.select(agent.id)));
  };

  const onEvent = (e: ServerEvent) => {
    switch (e.type) {
      case 'agent': {
        const isNew = !get().agents[e.agent.id];
        set(s => ({ agents: { ...s.agents, [e.agent.id]: e.agent } }));
        stage.upsertAgent(e.agent);
        if (isNew) announce([e.agent.id], t('feed.hired', { role: e.agent.role }));
        return;
      }
      case 'agent-removed': {
        const gone = get().agents[e.id];
        set(({ agents: { [e.id]: _, ...rest } }) => ({ agents: rest }));
        stage.removeAgent(e.id);
        if (gone) announce([{ name: gone.name }], t('feed.left'));
        if (get().selectedId === e.id) actions.select(null);
        return;
      }
      case 'task': return onTask(e.task);
      case 'log':
        // Only agents whose log was opened keep a local copy
        if (get().logs[e.agentId]) set(s => ({ logs: { ...s.logs, [e.agentId]: [...s.logs[e.agentId]!, e.entry] } }));
        if (get().transcript?.taskId === e.entry.taskId) set(s => ({ transcript: addLiveEntry(s.transcript!, e.entry) }));
        return;
      case 'office':
        if (JSON.stringify(e.office) !== JSON.stringify(get().office)) {
          set({ office: e.office });
          stage.setOffice(e.office);
        }
        return;
      case 'schedules':
        set({ schedules: e.schedules });
        return;
      case 'files-changed':
        set(s => ({ filesVersion: s.filesVersion + 1 }));
        return;
      case 'visitors': {
        const known = new Set(get().visitors.map(v => v.id));
        const arrived = e.visitors.filter(v => v.status === 'waiting' && !known.has(v.id));
        set({ visitors: e.visitors });
        stage.setVisitors(e.visitors);
        if (arrived.length) toast(t('visitor.arrived', { n: arrived.length, title: arrived[0]!.title }));
        return;
      }
      case 'approval': {
        const isNew = !get().approvals.some(a => a.id === e.approval.id);
        set(s => ({ approvals: isNew ? [...s.approvals, e.approval] : s.approvals.map(a => (a.id === e.approval.id ? e.approval : a)) }));
        if (isNew && e.approval.status === 'pending') {
          const name = actorOf(e.approval.agentId).name;
          toast(t('appr.new', { name, action: e.approval.action }));
          alerts.show(t('appr.alert', { name }), e.approval.action, () => actions.setDrawerTab('approvals'));
        }
        return;
      }
      case 'notes':
        return set({ notes: e.notes });
      case 'blocked':
        if ('label' in e) return toast(e.until === null
          ? t('toast.providerAuth', { label: e.label })
          : t('toast.providerLimit', { label: e.label, time: formatDateTime(e.until, get().settings.language) }));
        if (e.kind === 'chainTurns' || e.kind === 'chainBudget') return toast(chainHoldLabel(e, t));
        if (e.kind === 'minutes') return toast(t('toast.minutes', { spent: Math.round(e.spent), cap: e.cap }));
        return toast(e.kind === 'budget'
          ? t('toast.budget', { spent: e.spent.toFixed(2), cap: e.cap.toFixed(2) })
          : t('toast.agentBudget', { name: actorOf(e.agentId).name, spent: e.spent.toFixed(2), cap: e.cap.toFixed(2) }));
      case 'providerHolds':
        return set({ providerHolds: e.holds });
      case 'settings':
        set({ settings: e.settings });
        return applySettings(e.settings);
      case 'delegate':
        stage.courier(e.from, e.to, 'delegate');
        return announce([e.from, e.to], t('feed.delegated'));
      case 'report':
        stage.courier(e.from, e.to, 'report');
        return announce([e.from, e.to], t('feed.reported'));
    }
  };

  /** Events held back while a new snapshot loads: they are newer than it may be. */
  let missed: ServerEvent[] | null = null;
  const receive = (e: ServerEvent) => (missed ? void missed.push(e) : onEvent(e));

  /** The feed came back: everything since it dropped, like a restart closing the tasks on screen, was sent to nobody. */
  const catchUp = async () => {
    if (missed) return;
    missed = [];
    try {
      applySnapshot(await gateway.loadState());
      const { selectedId, agents, logs, transcript } = get();
      if (selectedId && !agents[selectedId]) actions.select(null);
      const opened = Object.keys(logs).filter(id => agents[id]);
      set({ logs: Object.fromEntries(await Promise.all(opened.map(async id => [id, await gateway.logs(id)] as const))) });
      if (transcript) await actions.reloadTranscript(transcript.taskId);
    } catch {
      // Gone again: the next reconnect brings it all
    }
    const events = missed;
    missed = null;
    events.forEach(onEvent);
  };

  // ---- office life (coffee, morale, drills, rain): browser-only and just for fun
  let lastStandup = 0, lastBreak = 0;
  const setFun = (fun: Fun) => {
    const wasEmpty = get().fun.coffee <= 0;
    set({ fun });
    storage.set(FUN_KEY, JSON.stringify(fun));
    stage.setMorale(fun.morale);
    if (!wasEmpty && fun.coffee <= 0) {
      toast(t('fun.coffeeOut'));
      for (const id of Object.keys(get().agents)) stage.flash(id, '😩', 3000);
    }
  };
  const funTick = () => {
    const now = Date.now();
    setFun(tickFun(get().fun, Object.values(get().agents), now));
    if (!get().funEvents || !stage.watched()) return;
    const roll = rollEvents(Math.random, FUN_TICK_MS, get().weather);
    if (roll.drill) actions.fireDrill();
    if (roll.weather !== get().weather) actions.setWeather(roll.weather);
  };

  const actions = {
    async init() {
      stage.setGraphics(get().graphics);
      try {
        const snapshot = await gateway.loadState();
        applySnapshot(snapshot);
        greet(snapshot);
        events.subscribe(receive, () => void catchUp());
        setInterval(funTick, FUN_TICK_MS);
      } catch (e) {
        toast(t('toast.connect', { error: errorMessage(e) }));
      }
    },

    toast,

    select(id: string | null, focus = false) {
      set({ selectedId: id });
      stage.selectAgent(id);
      if (id && focus) stage.focusAgent(id);
    },
    /** The player walked up to an agent and pressed E. */
    interact(id: string) {
      set(s => ({ tab: 'tasks', composerFocus: s.composerFocus + 1 }));
      actions.select(id);
    },
    setTab: (tab: InspectorTab) => set({ tab }),
    /** Goes where the agent's sign can be dealt with. */
    openAttention(id: string) {
      const target = get().attention[id]?.target ?? 'tasks';
      actions.select(id);
      if (target === 'approvals') actions.setDrawerTab('approvals');
      else if (target === 'settings') actions.openModal('settings');
      else set({ tab: 'tasks' });
    },
    /** The CEO saw this failure and leaves it as it is: its sign goes, a later failure brings a new one. */
    dismissAttention({ agentId, endedAt }: Task) {
      const acknowledged = { ...get().acknowledged, [agentId]: endedAt ?? Date.now() };
      storage.set(ACKNOWLEDGED_KEY, JSON.stringify(acknowledged));
      set({ acknowledged });
    },
    focusZone: (id?: string | null) => stage.focusZone(id),

    openModal(modal: Modal) {
      set({ modal });
      if (modal === 'settings') stage.setCovered(true); // it covers the office
    },
    closeModal() {
      set({ modal: null });
      stage.setCovered(get().drawerFull);
    },
    toggleKanban(open?: boolean) {
      const kanbanOpen = open ?? !get().kanbanOpen;
      if (!kanbanOpen) actions.setDrawerFull(false); // it opens at its usual size again
      set({ kanbanOpen });
    },
    setDrawerFull(drawerFull: boolean) {
      set({ drawerFull });
      stage.setCovered(drawerFull); // the office is out of sight: nobody walks it unseen
    },
    setDrawerTab: (drawerTab: DrawerTab) => set({ drawerTab, kanbanOpen: true }),
    toggleChat: (open?: boolean) => set(s => ({ chatOpen: open ?? !s.chatOpen })),
    /** Hides the messages so far from the chat view; tasks and agent memory are untouched. */
    clearChat() {
      const now = Date.now();
      storage.set(CHAT_CLEARED_KEY, String(now));
      set({ chatClearedAt: now, chatSeenAt: now });
    },
    /** Hides completed flow roots in this browser; it does not delete task records. */
    clearFlow(ids: string[]) {
      const flowHidden = [...new Set([...get().flowHidden, ...ids])];
      storage.set(FLOW_HIDDEN_KEY, JSON.stringify(flowHidden));
      let flowTaskId = get().flowTaskId;
      let task = flowTaskId ? get().tasks[flowTaskId] : undefined;
      while (task) {
        if (ids.includes(task.id)) { flowTaskId = null; break; }
        task = task.parentId ? get().tasks[task.parentId] : undefined;
      }
      set({ flowHidden, flowTaskId });
    },
    restoreFlow() {
      storage.set(FLOW_HIDDEN_KEY, '[]');
      set({ flowHidden: [], flowTaskId: null });
    },
    markChatSeen() {
      const now = Date.now();
      storage.set(CHAT_SEEN_KEY, String(now));
      set({ chatSeenAt: now });
    },
    /** Escape closes the innermost open thing. */
    escape() {
      const s = get();
      if (s.modal) return actions.closeModal();
      if (s.standup) return actions.closeStandup();
      if (s.chatOpen) return actions.toggleChat(false);
      if (s.drawerFull) return actions.setDrawerFull(false);
      if (s.kanbanOpen) return actions.toggleKanban(false);
      if (s.selectedId) actions.select(null);
    },

    async hire(draft: AgentDraft) {
      const agent = await attempt(() => gateway.hire(draftPayload(draft, t)));
      if (!agent) return;
      actions.closeModal();
      setTimeout(() => actions.select(agent.id, true), 100);
    },
    saveAgent: (id: string, draft: AgentDraft) => attempt(async () => { await gateway.updateAgent(id, draftPayload(draft, t)); toast(t('toast.saved')); }),
    fire: (id: string) => attempt(() => gateway.fire(id)),
    resetMemory: (id: string) => attempt(async () => { await gateway.resetMemory(id); toast(t('toast.memoryReset')); }),
    stopAgent: (id: string) => attempt(() => gateway.stop(id)),
    listFiles: () => attempt(() => gateway.files()),
    fileUrl: (path: string, download = false) => gateway.fileUrl(path, download),
    async deleteFile(path: string) {
      if (!(await attempt(async () => { await gateway.deleteFile(path); return true; }))) return false;
      toast(t('files.deleted', { path }));
      set(s => ({ outputPath: s.outputPath === path || s.outputPath?.startsWith(path + '/') ? null : s.outputPath }));
      return true;
    },
    /** Opens the Outputs tab on these files (e.g. what a task chain wrote), showing `open` first. */
    showOutputs(title: string, paths: string[], open?: string) {
      set({ outputsFocus: { title, paths }, outputPath: open ?? paths[0] ?? null, drawerTab: 'files', kanbanOpen: true });
    },
    openOutput: (path: string) => set({ outputPath: path, drawerTab: 'files', kanbanOpen: true }),
    clearOutputsFocus: () => set({ outputsFocus: null }),
    /** Opens the Flow tab on a task. */
    showTask: (taskId: string | null) => set(taskId ? { flowTaskId: taskId, drawerTab: 'flow', kanbanOpen: true } : { flowTaskId: null }),
    addSchedule: async (agentId: string, draft: ScheduleDraft) => !!(await attempt(async () => { await gateway.createSchedule({ agentId, ...draft }); toast(t('sched.added')); return true; })),
    toggleSchedule: (id: string, enabled: boolean) => attempt(() => gateway.updateSchedule(id, { enabled })),
    removeSchedule: (id: string) => attempt(() => gateway.deleteSchedule(id)),
    decide: (id: string, approve: boolean, note: string) => attempt(() => gateway.decideApproval(id, approve, note)),
    updateNote: (id: string, fields: Partial<Pick<Note, 'text' | 'pinned'>>) => attempt(() => gateway.updateNote(id, fields)),
    deleteNote: (id: string) => attempt(() => gateway.deleteNote(id)),
    alertsState: () => ({ supported: alerts.supported, enabled: alerts.enabled() }),
    setAlerts: async (on: boolean) => { const r = await alerts.setEnabled(on); if (on && !r) toast(t('alert.denied')); return r; },
    readFile: (path: string) => attempt(() => gateway.fileContent(path)),

    async assign(agentId: string, prompt: string) {
      const ok = await attempt(async () => { await gateway.assign(agentId, prompt); return true; });
      if (ok) stage.handoff(agentId);
      return !!ok;
    },
    /** Sends a message to the Product Manager (the chat window). */
    async sendChat(prompt: string) {
      const pm = pmAgent(Object.values(get().agents));
      return pm ? actions.assign(pm.id, prompt) : false;
    },
    completeTask: (id: string, result: string) => attempt(() => gateway.complete(id, result)),

    /** A task card was dropped on an agent. */
    async handoff(taskId: string, agentId: string) {
      const task = get().tasks[taskId];
      if (!task || task.agentId === agentId) return;
      const moved = await attempt(() => gateway.handoff(taskId, agentId));
      if (moved) toast(t('handoff.done', { name: actorOf(agentId).name }));
    },
    /** A file from the computer was dropped on an agent's desk: its content becomes a task. */
    async dropFile(agentId: string, file: File) {
      const text = await file.text().catch(() => '\u0000');
      const problem = dropProblem(file.size, text);
      if (problem) return toast(t(problem, { name: file.name }));
      if (await actions.assign(agentId, dropPrompt(file.name, text, t))) toast(t('drop.done', { name: file.name, agent: actorOf(agentId).name }));
    },
    async react(taskId: string, emoji: string) {
      const task = await attempt(() => gateway.react(taskId, emoji));
      if (task?.reactions?.includes(emoji)) stage.cheer(task.agentId, emoji);
    },
    async openPullRequest(taskId: string) {
      const task = await attempt(() => gateway.openPullRequest(taskId));
      if (task?.pr) toast(t('pr.opened'));
      return task?.pr;
    },

    // ---- GitHub visitors
    openVisitor: (id: string) => set({ visitorId: id, modal: 'visitor' }),
    refreshVisitors: async () => { const v = await attempt(() => gateway.refreshVisitors()); if (v) toast(t('visitor.refreshed', { n: v.filter(x => x.status === 'waiting').length })); },
    async acceptVisitor(id: string, agentId: string) {
      if (await attempt(async () => { await gateway.acceptVisitor(id, agentId); return true; })) { actions.closeModal(); stage.handoff(agentId); }
    },
    async rejectVisitor(id: string) {
      if (await attempt(async () => { await gateway.rejectVisitor(id); return true; })) actions.closeModal();
    },

    // ---- rooms and office life
    /** The player walked into a room. */
    enterRoom(room: RoomKind) {
      const now = Date.now();
      if (room === 'ceo' && storage.get(PRIORITY_DAY_KEY) !== today() && pmAgent(Object.values(get().agents)) && !get().modal) set({ modal: 'priority' });
      if (room === 'meeting' && now - lastStandup > STANDUP_COOLDOWN_MS && Object.keys(get().agents).length) actions.standup();
      if (room === 'coffee' || room === 'dining') toast(t('fun.coffeeHint', { level: Math.round(get().fun.coffee) }));
    },
    /** The CEO set (or skipped) today's priority: it goes to the PM like a chat message. */
    async setPriority(text: string) {
      storage.set(PRIORITY_DAY_KEY, today());
      actions.closeModal();
      if (text.trim() && await actions.sendChat(t('priority.prompt', { text: text.trim() }))) toast(t('priority.sent'));
    },
    standup() {
      lastStandup = Date.now();
      const lines = standupLines(Object.values(get().agents), Object.values(get().tasks), t);
      set({ standup: { at: lastStandup, lines } });
      stage.standup(lines);
    },
    closeStandup: () => set({ standup: null }),
    coffeeBreak() {
      const now = Date.now();
      if (now - lastBreak < BREAK_COOLDOWN_MS) return toast(t('fun.breakSoon'));
      lastBreak = now;
      setFun(coffeeBreak(get().fun, Object.keys(get().agents)));
      stage.coffeeBreak();
      toast(t('fun.break'));
    },
    drank: (agentId: string) => setFun(drinkCoffee(get().fun, agentId, Date.now())),
    fireDrill() {
      stage.fireDrill(DRILL_MS);
      toast(t('fun.drill'));
    },
    setWeather(weather: Weather) {
      set({ weather });
      stage.setWeather(weather);
    },
    setFunEvents(on: boolean) {
      storage.set(FUN_EVENTS_KEY, on ? 'on' : 'off');
      set({ funEvents: on });
    },
    cancelTask: (id: string) => attempt(() => gateway.cancel(id)),
    cancelChain: (id: string) => attempt(() => gateway.cancelChain(id)),
    releaseReport: (id: string) => attempt(() => gateway.releaseReport(id)),
    retryTask: (id: string) => attempt(() => gateway.retry(id)),
    resolveConflict: (id: string) => attempt(() => gateway.resolveConflict(id)),
    loadTaskDiff: (id: string) => attempt(() => gateway.taskDiff(id)),
    editTask: (id: string, prompt: string) => attempt(() => gateway.editTask(id, prompt)),
    setPaused: (paused: boolean) => attempt(() => gateway.setPaused(paused)),
    resumeProvider: (id: string) => attempt(() => gateway.resumeProvider(id)),

    async loadLogs(agentId: string) {
      if (get().logs[agentId]) return;
      const entries = await attempt(() => gateway.logs(agentId));
      if (entries) set(s => ({ logs: { ...s.logs, [agentId]: s.logs[agentId] ?? entries } }));
    },

    /** Starts following a task's log; again for the same task, it only reads the log anew. */
    watchTranscript(taskId: string) {
      if (get().transcript?.taskId !== taskId) set({ transcript: emptyTranscript(taskId) });
      return actions.reloadTranscript(taskId);
    },

    unwatchTranscript(taskId: string) {
      if (get().transcript?.taskId === taskId) set({ transcript: null });
    },

    async reloadTranscript(taskId: string) {
      const log = await attempt(() => gateway.taskLogs(taskId));
      const current = get().transcript;
      if (current?.taskId === taskId) set({ transcript: log ? mergeLoaded(current, log) : { ...current, loaded: true } });
    },

    async refreshDefaultRoles() {
      const updated = await attempt(() => gateway.refreshDefaultRoles());
      if (updated) toast(t(updated.length ? 'toast.rolesRefreshed' : 'toast.rolesNone', { n: updated.length }));
    },
    async installDefaultTeam() {
      const added = await attempt(() => gateway.installDefaultTeam());
      if (!added) return;
      toast(t('toast.teamInstalled', { names: added.join(', ') }));
      actions.closeModal();
    },
    async deleteTeam() {
      const removed = await attempt(() => gateway.deleteTeam());
      if (removed === undefined) return;
      toast(t('toast.teamDeleted', { n: removed }));
      actions.closeModal();
    },
    setTheme(theme: Theme) {
      storage.set(THEME_KEY, theme);
      set({ theme });
    },
    setGraphics(graphics: Graphics) {
      storage.set(GRAPHICS_KEY, JSON.stringify(graphics));
      set({ graphics });
      stage.setGraphics(graphics);
    },
    setDark(dark: boolean) { stage.setDark(dark); },
    badTeamFile() { toast(t('err.teamFile')); },
    async importTeam(file: TeamFile, replace: boolean) {
      const r = await attempt(() => gateway.importTeam(file, replace));
      if (!r) return;
      toast(t('toast.teamImported', { n: r.added.length, skipped: r.skipped }));
      actions.closeModal();
    },
    async saveSettings(form: { office: Pick<Office, 'name' | 'floorColor' | 'wallColor'>; settings: Partial<Settings> }) {
      await attempt(async () => {
        const current = get().office;
        if (!current || (['name', 'floorColor', 'wallColor'] as const).some(k => current[k] !== form.office[k])) await gateway.updateOffice(form.office);
        const languageChanged = form.settings.language !== undefined && form.settings.language !== get().settings.language;
        const r = await gateway.updateSettings(form.settings);
        set({ settings: r.settings, providers: r.providers });
        // Role templates and zone labels are produced by the server in the chosen language
        if (languageChanged) set({ presets: (await gateway.loadState()).presets });
        toast(r.providers.some(p => p.available) ? t('toast.savedOk') : t('toast.binStillMissing'));
        actions.closeModal();
      });
    },
  };

  return Object.assign(store, { actions });
}

export type OfficeStore = ReturnType<typeof createOfficeStore>;

/** Derived: unread PM messages for the chat badge. */
export function unreadOf(s: OfficeState) {
  const agents = Object.values(s.agents);
  const pm = pmAgent(agents);
  if (!pm) return 0;
  const t = createT(s.settings.language);
  return unreadCount(chatItems(pm, Object.values(s.tasks), id => (id === 'user' ? t('ui.you') : s.agents[id]?.name ?? '?'), t), s.chatSeenAt);
}
