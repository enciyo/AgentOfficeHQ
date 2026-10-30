// Interfaces the application layer needs from the outside world (implemented in infrastructure/).
import type { Locale } from '../../shared/i18n/index.ts';
import type { Agent, Approval, LogEntry, Note, Office, ProviderHold, ProviderInfo, Schedule, Settings, Task, TaskDiff, Visitor } from '../../shared/types.ts';

export interface State { office: Office; agents: Agent[]; tasks: Task[]; settings: Settings; schedules: Schedule[]; approvals: Approval[]; visitors: Visitor[]; /** The team's shared notes. */ notes?: Note[]; /** CLIs that may not start runs for now, by provider id. */ providerHolds?: Record<string, ProviderHold> }

/** Mutable aggregate root plus persistence. */
export interface StateStore {
  readonly state: State;
  /** Whether the data directory was empty at startup (the default team is installed then). */
  readonly fresh: boolean;
  save(): void;
  saveNow(): void;
}

export type DomainEvent = { type: string; [key: string]: unknown };

/** Pushes live events to connected clients. */
export interface Publisher {
  publish(event: DomainEvent): void;
}

export interface FileEntry { path: string; size: number; mtime: number }

/** The files in a working directory (the agents' outputs). Never reaches outside the root. */
export interface FileTree {
  list(root: string): FileEntry[];
  /** null when the path is outside the root or unreadable. */
  read(root: string, rel: string): { text: string; truncated: boolean; binary: boolean } | null;
  /** The file's bytes as they are (preview, download); null when outside the root, not a file or too big. */
  raw(root: string, rel: string): Buffer | null;
  /** Deletes a file or folder inside the root; false when it is outside the root, the root itself or missing. */
  remove(root: string, rel: string): boolean;
}

/** Where one agent works when isolation is on: its own checkout on its own branch. */
export interface Workcell { cwd: string; repo: string; branch: string; /** The branch's commit once it is up to date: the run starts from here. */ head: string; synced: boolean; error: string }

/** Gives each agent an isolated checkout and folds its work back into the shared one. */
export interface Isolation {
  /** Prepares (or reuses) the agent's checkout of `base` and brings it up to date. */
  enter(base: string, key: string): Workcell;
  /**
   * Commits the run's changes and merges them into the shared checkout; a conflict leaves the branch for a human.
   * With `merge: false` it stops after the commit (`merge` follows once someone approved).
   */
  integrate(cell: Workcell, message: string, options?: { merge: boolean }): { committed: boolean; merged: boolean; error: string; /** The branch's commit with work not yet merged, '' when there is none. */ commit: string };
  /** Merges an agent branch into the shared checkout; a conflict is aborted and leaves both as they were. */
  merge(repo: string, branch: string, message: string): { merged: boolean; error: string };
  /** Takes an agent branch back to `commit`, dropping whatever came after it. */
  discard(repo: string, branch: string, commit: string): void;
  /** The branch of the shared checkout, which agent branches merge into. */
  trunk(repo: string): string;
  /** What changed from `from` to `to`, capped in size. Throws when the commits are not there (any more). */
  diff(repo: string, from: string, to: string): TaskDiff;
  /** Commits the deletion of `rel` (relative to `base`) in the shared checkout, so the agents' worktrees lose it too. */
  commitRemoval(base: string, rel: string, message: string): void;
}

/** An open issue or pull request on the code host. */
export interface Inbound { kind: 'issue' | 'pr'; number: number; title: string; url: string; author: string; body: string }

/** The repository's code host (GitHub through the `gh` CLI). Every call fails with a readable message when it is not usable. */
export interface CodeHost {
  /** Open issues and pull requests of the repository that holds `cwd`. */
  inbound(cwd: string): Promise<Inbound[]>;
  /** Pushes `commit` to `branch` on the remote and opens a pull request from it; returns the PR URL. */
  openPullRequest(cwd: string, pr: { commit: string; branch: string; title: string; body: string }): Promise<string>;
}

export interface LogBook {
  /** Keeps the whole entry on disk. */
  append(agentId: string, entry: LogEntry): void;
  /** The agent's latest entries, without their `detail`. */
  recent(agentId: string): LogEntry[];
  /** The last `limit` entries of a task with their `detail`, from the whole log, and how many there are in all. */
  ofTask(agentId: string, taskId: string, limit: number): Promise<{ entries: LogEntry[]; total: number }>;
}

/** Neutral vocabulary for what an agent is doing; the application turns it into localized text. */
export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'grep' | 'web' | 'plan' | 'agent' | 'delegate' | 'team' | 'status' | 'files' | 'other';

/** What an agent CLI reports while a task runs, independent of which CLI it is. */
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | {
    type: 'tool'; tool: ToolKind; detail?: string;
    /** Files the call writes (absolute or relative to the run's cwd). */ files?: string[];
    /** The call's whole input for the task transcript, when `detail` does not already say it all. */ input?: string;
  }
  | { type: 'tool-error'; text: string }
  /** Files a call has written, for CLIs that only know once the call succeeded. */
  | { type: 'files'; files: string[] }
  /** `costUsd`: what the run has cost so far, failed or not; left out when the CLI reported none (unknown, not $0). */
  | { type: 'result'; ok: boolean; text: string; costUsd?: number };

export interface RunRequest { agent: Agent; task: Task; cwd: string; systemPrompt: string; locale: Locale }
export interface RunCallbacks {
  onEvent(event: AgentEvent): void;
  /** Any output at all, even what no event comes from: the run is alive. */
  onActivity(): void;
  /** Called exactly once, even when the process can not be waited for. */
  onExit(info: { code: number | null; stderr: string }): void;
}
export interface RunHandle {
  /** Ends the run and whatever it started: asks first, then forces. Calling it again changes nothing. */
  stop(): void;
}

/** How a run ended, as far as the CLI said: the text of its failed result ('' without one), its stderr and exit code. */
export interface RunExit { text: string; stderr: string; code: number | null }
export type ProviderErrorKind = 'limit' | 'auth' | 'permission' | 'other';
/** A failed run in neutral terms; `resetAt` is when a limit lifts, null when the message names no time. */
export interface ProviderFailure { kind: ProviderErrorKind; resetAt: number | null }

/** Starts agent CLIs. `start` throws when the agent's CLI is not installed. */
export interface Runner {
  start(request: RunRequest, callbacks: RunCallbacks): RunHandle;
  has(providerId: string): boolean;
  delegates(providerId: string): boolean;
  label(providerId: string): string;
  /** Reads a failed run with that CLI's error rules. */
  classify(providerId: string, exit: RunExit, now: number): ProviderFailure;
  providers(): Promise<ProviderInfo[]>;
}
