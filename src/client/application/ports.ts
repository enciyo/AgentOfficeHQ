// What the application layer needs from the outside: the server API, live events, the 3D view.
import type { Graphics } from '../domain/quality.ts';
import type { Translate } from '../../shared/i18n/index.ts';
import type { RoomKind } from '../../shared/catalog.ts';
import type { Approval, LogEntry, Note, Office, ProviderHold, ProviderInfo, PublicAgent, Schedule, Settings, Task, TaskDiff, TaskLog, TeamFile, Visitor } from '../../shared/types.ts';
import type { Weather } from '../domain/fun.ts';
import type { Attention } from '../domain/attention.ts';
import type { StandupLine } from '../domain/views.ts';
import type { AgentDraft } from '../domain/agentForm.ts';

export interface ScheduleDraft { prompt: string; intervalMinutes: number; at?: string }

export interface OutputFile { path: string; size: number; mtime: number }

export interface Preset { id: string; role: string; color: string; prompt: string; allowedTools: string; permissionMode: string }

export interface Snapshot {
  office: Office; agents: PublicAgent[]; tasks: Task[]; presets: Preset[]; providers: ProviderInfo[]; settings: Settings; schedules: Schedule[]; approvals: Approval[]; visitors: Visitor[]; notes?: Note[]; providerHolds?: Record<string, ProviderHold>;
}

export type ServerEvent =
  | { type: 'agent'; agent: PublicAgent }
  | { type: 'agent-removed'; id: string }
  | { type: 'task'; task: Task }
  | { type: 'log'; agentId: string; entry: LogEntry }
  | { type: 'office'; office: Office }
  | { type: 'settings'; settings: Settings }
  | { type: 'schedules'; schedules: Schedule[] }
  | { type: 'approval'; approval: Approval }
  | { type: 'notes'; notes: Note[] }
  | { type: 'visitors'; visitors: Visitor[] }
  | { type: 'files-changed' }
  | { type: 'blocked'; agentId: string; kind: 'budget' | 'agentBudget' | 'minutes'; spent: number; cap: number }
  | { type: 'blocked'; agentId: string; kind: 'chainTurns' | 'chainBudget'; spent: number; cap: number }
  | { type: 'blocked'; agentId: string; kind: 'providerLimit' | 'providerAuth'; label: string; until: number | null }
  | { type: 'providerHolds'; holds: Record<string, ProviderHold> }
  | { type: 'delegate' | 'report'; from: string; to: string };

export interface Gateway {
  loadState(): Promise<Snapshot>;
  hire(payload: Partial<AgentDraft>): Promise<PublicAgent>;
  updateAgent(id: string, payload: Partial<AgentDraft>): Promise<void>;
  fire(id: string): Promise<void>;
  resetMemory(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  assign(agentId: string, prompt: string): Promise<void>;
  complete(taskId: string, result: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  cancelChain(taskId: string): Promise<void>;
  releaseReport(taskId: string): Promise<void>;
  retry(taskId: string): Promise<Task>;
  resolveConflict(taskId: string): Promise<Task>;
  /** null when the task has no commits to compare. */
  taskDiff(taskId: string): Promise<TaskDiff | null>;
  editTask(taskId: string, prompt: string): Promise<Task>;
  setPaused(paused: boolean): Promise<void>;
  resumeProvider(id: string): Promise<void>;
  installDefaultTeam(): Promise<string[]>;
  deleteTeam(): Promise<number>;
  importTeam(file: TeamFile, replace: boolean): Promise<{ added: string[]; skipped: number }>;
  refreshDefaultRoles(): Promise<string[]>;
  updateOffice(fields: Pick<Office, 'name' | 'floorColor' | 'wallColor'>): Promise<void>;
  updateSettings(fields: Partial<Settings>): Promise<{ settings: Settings; providers: ProviderInfo[] }>;
  logs(agentId: string): Promise<LogEntry[]>;
  taskLogs(taskId: string): Promise<TaskLog>;
  createSchedule(fields: ScheduleDraft & { agentId: string }): Promise<Schedule>;
  updateSchedule(id: string, fields: Partial<ScheduleDraft & { enabled: boolean }>): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  decideApproval(id: string, approve: boolean, note: string): Promise<Approval>;
  updateNote(id: string, fields: Partial<Pick<Note, 'text' | 'pinned'>>): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  files(): Promise<{ root: string; files: OutputFile[] }>;
  fileContent(path: string): Promise<{ path: string; text: string; truncated: boolean; binary: boolean }>;
  deleteFile(path: string): Promise<void>;
  /** Where the browser can load an output as it is (preview) or download it. */
  fileUrl(path: string, download?: boolean): string;
  handoff(taskId: string, agentId: string): Promise<Task>;
  react(taskId: string, emoji: string): Promise<Task>;
  openPullRequest(taskId: string): Promise<Task>;
  refreshVisitors(): Promise<Visitor[]>;
  acceptVisitor(id: string, agentId: string): Promise<void>;
  rejectVisitor(id: string): Promise<void>;
}

/** Drag data type of a task card (dropped on an agent to hand the task over). */
export const TASK_DRAG_TYPE = 'application/x-agent-office-task';

export type PlayerActionMode = 'none' | 'plant' | 'kick' | 'kiss' | 'clap' | 'highfive' | 'coffee' | 'confetti' | 'dance' | 'thumbs';

export interface EventFeed {
  /** `onReconnect`: the feed was lost and is back, and whatever happened in between was never sent. */
  subscribe(onEvent: (event: ServerEvent) => void, onReconnect: () => void): void;
}

/** The 3D office view. */
export interface Stage {
  /** The office behind the walls follows the UI's light or dark theme. */
  setDark(dark: boolean): void;
  /** Something covers the office: nothing is drawn and keys do not move the player. */
  setCovered(covered: boolean): void;
  setGraphics(graphics: Graphics): void;
  setLanguage(t: Translate): void;
  setPlayer(info: { name: string; color: string }): void;
  setOffice(office: Office): void;
  setAgents(agents: PublicAgent[]): void;
  upsertAgent(agent: PublicAgent): void;
  removeAgent(id: string): void;
  selectAgent(id: string | null): void;
  focusAgent(id: string): void;
  focusZone(id?: string | null): void;
  handoff(agentId: string): void;
  flash(agentId: string, text: string, ms?: number): void;
  /** The signs to show, by agent; whoever is left out has none. They stay until the next call. */
  setAttention(signs: Record<string, Attention>): void;
  courier(fromId: string, toId: string, mode: 'delegate' | 'report'): void;
  /** Open GitHub issues/PRs standing at the door; ones that are no longer waiting walk off. */
  setVisitors(visitors: Visitor[]): void;
  setMorale(morale: Record<string, number>): void;
  setWeather(weather: Weather): void;
  /** Whether someone can see the office now (a background tab cannot); surprises wait until then. */
  watched(): boolean;
  /** Everyone runs to the assembly point for `ms`. */
  fireDrill(ms: number): void;
  /** Idle agents gather in the meeting room; everyone says their line. */
  standup(lines: StandupLine[]): void;
  /** Idle agents walk to the coffee machine. */
  coffeeBreak(): void;
  /** An emoji flies from the player to the agent. */
  cheer(agentId: string, emoji: string): void;
  /** Selects the action the player performs when Space is pressed. */
  setActionMode(mode: PlayerActionMode): void;
}

/** What the 3D view reports back. */
export interface StageCallbacks {
  onSelectAgent(id: string | null): void;
  onInteract(id: string): void;
  onEnterRoom(room: RoomKind): void;
  /** The player clicked the coffee machine. */
  onCoffeeMachine(): void;
  /** An agent drank a cup at the machine. */
  onCoffee(agentId: string): void;
  onSelectVisitor(id: string): void;
  /** The sign over an agent was clicked. */
  onAttention(agentId: string): void;
  onDropTask(taskId: string, agentId: string): void;
  onDropFile(file: File, agentId: string): void;
}

/** Desktop notifications for finished work while the tab is in the background. */
export interface Alerts {
  readonly supported: boolean;
  enabled(): boolean;
  /** Asks for permission when turning on; resolves to the resulting state. */
  setEnabled(on: boolean): Promise<boolean>;
  show(title: string, body: string, onClick?: () => void): void;
}

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
