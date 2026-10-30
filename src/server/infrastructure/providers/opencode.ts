import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolKind } from '../../domain/ports.ts';
import { COMMON_ERRORS } from './errors.ts';
import type { ModelOption, Provider, ProviderEvent } from './types.ts';
import { fullInput, parseJsonLine, squash, withSystemPrompt } from './util.ts';

const exec = promisify(execFile);

// Commands that only look at files; every agent may run them (no git, no find: those reach further).
const READ_ONLY = ['ls', 'ls *', 'pwd', 'cat *', 'head *', 'tail *', 'wc *', 'grep *', 'rg *', 'tree *'];

/** Claude-style allowed tools ("Bash(npm run:*) Bash(git status)") as opencode command patterns ("npm run *", "git status"). */
export const bashPatterns = (allowedTools: string) =>
  [...allowedTools.matchAll(/Bash\(([^)]+)\)/g)].map(m => m[1]!.replace(/:\*$/, ' *').trim());

// Claude-style write rules (Edit(docs/**), Edit(**/*.test.*)) as opencode edit patterns. opencode matches them
// against the absolute path and its "*" spans folders: docs/** becomes */docs/*, and **/*.test.* becomes *.test.*.
export const editPatterns = (allowedTools: string) =>
  [...allowedTools.matchAll(/(?:Edit|Write)\(([^)]+)\)/g)].map(m => {
    const glob = m[1]!.trim();
    return glob.startsWith('**/') ? glob.slice(3).replace(/\*\*/g, '*') : `*/${glob.replace(/\/\*\*$/, '/*').replace(/\*\*/g, '*')}`;
  });

/**
 * Agent permission modes (Claude vocabulary) and allowed tools as opencode's `permission` config. A non-interactive
 * run cannot ask: an "ask" rule rejects the call and ends the run, so every rule is allow or deny. The last matching
 * rule wins, hence "*" first. Bypass uses --auto instead.
 */
export function permissionsOf(permissionMode: string, allowedTools: string) {
  const rules = (allowed: string[]) => Object.fromEntries([['*', 'deny'], ...allowed.map(p => [p, 'allow'])]);
  const bash = rules([...READ_ONLY, ...bashPatterns(allowedTools)]);
  const webfetch = /\bWeb(Fetch|Search)\b/.test(allowedTools) ? 'allow' : 'deny';
  const writes = editPatterns(allowedTools);
  const freeEdit = /(^|\s)(Edit|Write)(\s|$)/.test(allowedTools);
  if (permissionMode === 'acceptEdits') return { edit: 'allow', bash, webfetch };
  if (permissionMode === 'default') return { edit: freeEdit ? 'allow' : writes.length ? rules(writes) : 'deny', bash, webfetch };
  if (permissionMode === 'plan') return { edit: 'deny', bash, webfetch };
  return null;
}

const TOOL_KINDS: Record<string, ToolKind> = {
  bash: 'shell', read: 'read', edit: 'edit', write: 'write', patch: 'edit', glob: 'search', grep: 'grep', webfetch: 'web', todowrite: 'plan', todoread: 'plan', task: 'agent',
};

/** `opencode models` prints one `provider/model` id per line; the rest is progress noise. */
export const parseModels = (stdout: string): ModelOption[] =>
  [...new Set(stdout.split('\n').map(l => l.trim()).filter(l => /^[\w.-]+\/[\w.-]+$/.test(l)))].map(value => ({ value, label: value }));

export const opencode: Provider = {
  id: 'opencode',
  label: 'opencode',
  models: [{ value: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' }, { value: 'openai/gpt-5', label: 'openai/gpt-5' }],
  delegation: true,
  binaryNames: ['opencode'],
  errors: [
    { kind: 'auth', pattern: /\bProviderAuthError\b|\bopencode auth login\b/ },
    { kind: 'permission', pattern: /\bPermission(?:Rejected|Denied)Error\b/ },
    ...COMMON_ERRORS,
  ],
  binaryPaths: [`${process.env.HOME ?? ''}/.opencode/bin/opencode`],

  // Only the models the installed providers are authenticated for show up here, so the list follows `opencode auth login`.
  async listModels(bin) {
    const { stdout } = await exec(bin, ['models'], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return parseModels(stdout);
  },

  buildArgs({ agent, task, systemPrompt }) {
    const args = ['run', '--format', 'json'];
    if (agent.permissionMode === 'bypassPermissions') args.push('--auto');
    if (agent.model) args.push('--model', agent.model);
    if (agent.sessionId) args.push('--session', agent.sessionId);
    args.push(withSystemPrompt(systemPrompt, task.prompt));
    return args;
  },

  // opencode has no per-run flags for MCP or permissions; both go in through OPENCODE_CONFIG_CONTENT.
  env({ agent, mcp }) {
    const config = {
      mcp: { office: { type: 'local', command: [mcp.command, ...mcp.args], environment: mcp.env, enabled: true } },
      ...(agent.permissionMode !== 'bypassPermissions' ? { permission: permissionsOf(agent.permissionMode || 'acceptEdits', agent.allowedTools) } : {}),
    };
    return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  },

  // `run --format json` emits one event per line: step_start, text, tool_use, step_finish, error.
  // There is no final result event; a step_finish whose reason is not "tool-calls" ends the run.
  // Only the closing steps' `cost` is counted: whether "tool-calls" steps carry one has not been seen in real output.
  createParser() {
    let lastText = '';
    let sessionSent = false;
    let spent: number | undefined;
    const cost = () => (spent === undefined ? {} : { costUsd: spent });
    return (line) => {
      const msg = parseJsonLine(line);
      if (!msg) return [];
      const events: ProviderEvent[] = [];
      if (!sessionSent && typeof msg.sessionID === 'string') {
        sessionSent = true;
        events.push({ type: 'session', id: msg.sessionID });
      }
      const part = msg.part ?? {};
      if (msg.type === 'text' && part.text?.trim()) {
        lastText = part.text;
        events.push({ type: 'text', text: part.text });
      } else if (msg.type === 'tool_use') {
        const { tool, state = {} } = part;
        if (state.status === 'error') events.push({ type: 'tool-error', text: squash(state.error, 200) });
        else if (state.status === 'completed' || state.status === 'running') {
          const input = state.input ?? {};
          const writes = state.status === 'completed' && ['edit', 'write', 'patch'].includes(tool) && input.filePath ? { files: [String(input.filePath)] } : {};
          const detail = squash(input.command ?? input.filePath ?? input.pattern ?? tool, 50);
          events.push({ type: 'tool', tool: TOOL_KINDS[tool] ?? 'other', detail, ...writes, ...fullInput(input, detail) });
        }
      } else if (msg.type === 'step_finish' && part.reason && part.reason !== 'tool-calls') {
        if (typeof part.cost === 'number') spent = (spent ?? 0) + part.cost;
        events.push({ type: 'result', ok: true, text: lastText, ...cost() });
      } else if (msg.type === 'error') {
        events.push({ type: 'result', ok: false, text: String(msg.error?.data?.message ?? msg.error?.name ?? 'opencode error'), ...cost() });
      }
      return events;
    };
  },
};
