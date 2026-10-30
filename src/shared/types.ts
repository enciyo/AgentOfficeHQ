// Data model shared between the server and the browser.
import type { OfficeItem } from './catalog.ts';
import type { Locale } from './i18n/index.ts';

export type AgentKind = 'agent' | 'human';
export type AgentStatus = 'idle' | 'working' | 'waiting';
export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
/**
 * What became of a run's changes with worktrees on. unchanged: nothing to merge. pending: waits for the CEO's approval.
 * conflict: could not be merged, the branch is kept. rejected: the CEO turned it down, the branch dropped it.
 */
export type MergeStatus = 'merged' | 'unchanged' | 'pending' | 'conflict' | 'rejected';
export type LogKind = 'task' | 'text' | 'tool' | 'result' | 'error' | 'system';

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  role: string;
  /** Which agent CLI runs this agent's tasks (see src/server/providers); '' = the office default CLI. */
  provider: string;
  color: string;
  prompt: string;
  model: string;
  cwd: string;
  permissionMode: string;
  allowedTools: string;
  team: string;
  sessionId: string | null;
  totalCost: number;
  hiredAt: number;
  deskId?: string | null;
}

/** A worker as a team file carries them: their setup, without history, memory or this machine's folders. */
export type TeamMember = Pick<Agent, 'name' | 'kind' | 'role' | 'provider' | 'color' | 'prompt' | 'model' | 'permissionMode' | 'allowedTools' | 'team'>;

export const TEAM_FILE_FORMAT = 'agent-office-team';
export const TEAM_FILE_VERSION = 1;

/** The file a team is exported to and imported from. */
export interface TeamFile { format: typeof TEAM_FILE_FORMAT; version: typeof TEAM_FILE_VERSION; exportedAt: number; agents: TeamMember[] }

/** What can keep an agent's queue from starting. */
export type BlockKind = 'paused' | 'budget' | 'agentBudget' | 'minutes' | 'chainTurns' | 'chainBudget' | 'providerLimit' | 'providerAuth' | 'concurrency';

/** Agent sent to the client: persisted fields + runtime state. */
export interface PublicAgent extends Agent {
  status: AgentStatus;
  activity: string;
  currentTaskId: string | null;
  queued: number;
  /** What the server last found holding its queue back; `activity` says it in words. */
  blockedBy?: BlockKind;
}

export interface Task {
  id: string;
  agentId: string;
  prompt: string;
  from: string;
  parentId: string | null;
  depth: number;
  kind: 'task' | 'report';
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result: string;
  /** Known spend in USD so far. null: it ran and its CLI reported nothing, which is not the same as $0. */
  cost: number | null;
  /** Run time of earlier attempts that a CLI limit or login failure cut off (`startedAt` is reset for the next one). */
  ranMs?: number;
  awaiting?: boolean;
  /** Emoji the CEO reacted with (chat bubbles, task cards). */
  reactions?: string[];
  /** With worktrees on: the commit holding this run's changes on the agent's branch. */
  commit?: string;
  /** With worktrees on: where the agent's branch stood when this run started; `baseCommit`..`commit` is what it changed. */
  baseCommit?: string;
  /** The agent's branch this run worked on, and the repository it belongs to. */
  branch?: string;
  repo?: string;
  merge?: MergeStatus;
  /** Why it did not merge: git's message for a conflict, the CEO's note for a rejection. */
  mergeNote?: string;
  /** The task whose merge conflict this one was given to resolve. */
  resolves?: string;
  /** Pull request opened from `commit`. */
  pr?: string;
  /** Files this run wrote, relative to the shared working directory (the Outputs browser). */
  files?: string[];
  /** A restart cut this task's run off and it was put back to continue; a task gets this one attempt only. */
  resumed?: boolean;
  /** A restart cut this task's run off and it failed for that: what its chain reports is the CEO's to send. */
  interrupted?: boolean;
  /** Times a CLI limit or login failure put this task back in the queue; past the cap it fails like any other error. */
  requeues?: number;
  /** The failed task this one runs again. */
  retryOf?: string;
  /** A retry or resolver whose boss already heard how the first run went: its report replaces or follows up that one. */
  correction?: boolean;
  /** The schedule that gave this task. */
  scheduleId?: string;
}

/** An open GitHub issue or pull request waiting at the office door. */
export interface Visitor {
  /** "issue-12" / "pr-7" */
  id: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
  author: string;
  body: string;
  status: 'waiting' | 'accepted' | 'rejected';
  /** Who took the work, once accepted. */
  agentId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** Reactions the CEO can put on a message. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '🚀', '😵'] as const;

/** A task given to an agent again and again (e.g. a daily status report). */
export interface Schedule {
  id: string;
  agentId: string;
  prompt: string;
  /** 15, 60, 1440 (daily), 10080 (weekly), ... */
  intervalMinutes: number;
  /** "HH:MM" local time, for daily/weekly schedules. */
  at?: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
}

export interface LogEntry {
  ts: number; kind: LogKind; text: string; taskId: string | null;
  /** The whole of what `text` summarizes, e.g. a tool call's input. Only the log of a task carries it. */
  detail?: string;
  /** There is a `detail` on disk, left out to keep live events and recent logs small. */
  hasDetail?: boolean;
}

export interface DiffFile { path: string; /** A added, M modified, D deleted, T type changed. */ status: string; additions: number; deletions: number; binary: boolean }

/** What a run changed. `truncated`: the list or the patch hit its size cap and shows only the beginning. */
export interface TaskDiff { files: DiffFile[]; patch: string; truncated: boolean }

/** The newest entries of one task; `total` counts them all, so `total > entries.length` means the log was cut. */
export interface TaskLog { entries: LogEntry[]; total: number; limit: number }

/** Guard rails for running agents; 0 turns a limit off. */
export interface Limits {
  /** A run longer than this is stopped and the task fails. */
  taskTimeoutMin: number;
  /** A run with no output for this long is stopped and the task fails. */
  silenceTimeoutMin: number;
  /** Agents running at the same time; the rest wait in their queues. */
  maxConcurrent: number;
  /** Total spend per local day; when reached, no new task starts until tomorrow or the cap is raised. */
  dailyBudgetUsd: number;
  /** The same, per agent. */
  agentDailyBudgetUsd: number;
  /** Total run time of all agents per local day, whatever it costs; works for CLIs that report no cost too. */
  dailyRunMinutes: number;
  /** Turns (runs, reports included) one chain may take under its root task; the next one waits. */
  chainMaxTurns: number;
  /** The same for what one chain has cost. */
  chainBudgetUsd: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** An agent asking the CEO before a risky step (push, deploy, delete, paid service...). */
export interface Approval {
  id: string;
  agentId: string;
  /** The task the agent was working on; its report waits for the decision. */
  taskId: string | null;
  /** 'merge': the office asks whether a finished run's changes may be merged. The decision needs no run of the agent. */
  kind?: 'merge';
  action: string;
  details: string;
  status: ApprovalStatus;
  note: string;
  createdAt: number;
  decidedAt: number | null;
}

/** Something a team member wants the office to know. Only the CEO pins; only pinned notes enter prompts. */
export interface Note {
  id: string;
  text: string;
  /** Agent id of whoever wrote it. */
  author: string;
  /** Their name then, for after they left. */
  authorName: string;
  createdAt: number;
  pinned: boolean;
  /** The task it was written during. */
  taskId?: string;
}

export interface Settings { language: Locale; /** Explicit executable path per provider id; empty/missing = auto-detect. */ binaries: Record<string, string>; /** CLI of agents that have none of their own (provider ''). */ defaultProvider: string; /** Model of agents that have none of their own, per provider id; empty/missing = the CLI's own default. */ defaultModels: Record<string, string>; /** Model forced on every agent of a provider, even those with their own; empty/missing = no override. */ modelOverrides: Record<string, string>; defaultCwd: string; /** Each agent works in its own git worktree; work is merged back after each task. */ worktrees: boolean; /** With worktrees: a finished run's changes wait for the CEO's approval before they are merged. */ approveMerges: boolean; limits: Limits; /** Steps agents must ask the CEO about first (empty = never ask). */ approvalPolicy: string; /** Told to every agent in its system prompt, whatever its CLI. */ officeNotes: string; /** After a restart, continue interrupted runs in their session (once per task) instead of failing them, and let the reports of those that fail go out. Starts paid runs at boot, so off by default: they wait to be sent by hand. */ resumeInterrupted: boolean; /** Show open GitHub issues/PRs of the working directory's repository as visitors (needs `gh`). */ github: boolean; /** The whole office is on hold: running tasks finish, nothing new starts. */ paused?: boolean; playerName: string; playerColor: string }

export interface Office {
  name: string;
  width: number;
  depth: number;
  floorColor: string;
  wallColor: string;
  tier?: number;
  items: OfficeItem[];
}

/** Why a CLI may not start runs: a usage limit until `until`, or a failed login until someone resumes it (`until` null). */
export interface ProviderHold { kind: 'limit' | 'auth'; since: number; until: number | null; /** What the CLI said. */ message: string }

/** A selectable agent CLI, as reported by the server. */
export interface ProviderInfo {
  id: string;
  label: string;
  models: { value: string; label: string }[];
  /** Can call the office team tools (list_team, delegate_task, task_status). */
  delegation: boolean;
  /** Executable found and it answers its health check. */
  available: boolean;
  /** missing: no executable. broken: there is one, but its health check failed. */
  health: 'ok' | 'missing' | 'broken';
  /** First line of its version output, when healthy. */
  version?: string;
  /** Why the health check failed, in the CLI's own words. */
  healthError?: string;
  /** Resolved executable path, null when not installed. */
  path: string | null;
}
