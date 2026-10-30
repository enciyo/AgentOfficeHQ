// Contract every agent CLI integration implements. To add a new tool, see CONTRIBUTING.md.
import type { Agent, Task } from '../../../shared/types.ts';
import type { AgentEvent } from '../../domain/ports.ts';
import type { ErrorRule } from './errors.ts';

/** Provider-neutral events parsed from a CLI's output; the task runner only knows these. */
export type ProviderEvent = AgentEvent;

/** Stateful per-run parser: feed it one stdout line at a time. */
type LineParser = (line: string) => ProviderEvent[];

/** How to start the office MCP server (team tools) for a run. */
interface McpLaunch { command: string; args: string[]; env: Record<string, string> }

/** One entry of a provider's model picker. */
export interface ModelOption { value: string; label: string }

export interface RunContext {
  agent: Agent;
  task: Task;
  cwd: string;
  /** Persona + team instructions; providers without a system-prompt flag prepend it to the prompt. */
  systemPrompt: string;
  mcp: McpLaunch;
}

export interface Provider {
  /** Stable identifier stored on agents (`agent.provider`). Lowercase, no spaces. */
  id: string;
  label: string;
  /** Suggestions for the model field; any model string the CLI accepts still works. Empty value = CLI default. */
  models: ModelOption[];
  /**
   * Asks the CLI for the models it currently offers (installed providers, credentials).
   * The result replaces `models` while it is fresh; an empty list or a rejection keeps `models`.
   */
  listModels?(bin: string): Promise<ModelOption[]>;
  /** Whether agents on this provider can call the office team tools (list_team, delegate_task, task_status). */
  delegation: boolean;
  /** Executable names looked up on PATH when no explicit path is configured. */
  binaryNames: string[];
  /** Extra absolute locations to check for the executable. */
  binaryPaths?: string[];
  /** Arguments for the executable (without the executable itself). */
  buildArgs(ctx: RunContext): string[];
  /** Creates a fresh parser for one run. Must ignore lines it does not understand. */
  createParser(): LineParser;
  /** How this CLI says it failed, first match wins: its own wording, then `COMMON_ERRORS`. All such patterns live here. */
  errors: ErrorRule[];
  /** Arguments of the health check; it must exit 0 and print the version. Defaults to `--version`. */
  versionArgs?: string[];
  /** Environment for the child process (defaults to the server's environment). */
  env?(ctx: RunContext): NodeJS.ProcessEnv;
}
