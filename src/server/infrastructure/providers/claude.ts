import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolKind } from '../../domain/ports.ts';
import { COMMON_ERRORS } from './errors.ts';
import type { Provider, ProviderEvent } from './types.ts';
import { fullInput, parseJsonLine, squash } from './util.ts';

// "Bash(git status) WebSearch, Bash(npm test:*)" → spaces inside parentheses are not split
const parseTools = (text: unknown) => String(text || '').match(/[^\s,()]+(?:\([^)]*\))?/g) || [];

/** The file a write call changes; it counts as written only once its result comes back without an error. */
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const writtenBy = (name: string, input: Record<string, any> = {}) =>
  WRITES.has(name) && (input.file_path || input.notebook_path) ? String(input.file_path || input.notebook_path) : '';

/** Neutral description of a Claude tool call (the application localizes it). */
function toolEvent(name: string, input: Record<string, any> = {}): ProviderEvent {
  const tool = (kind: ToolKind, summary?: unknown): ProviderEvent => {
    const detail = summary === undefined || kind === 'delegate' ? (summary as string | undefined) : squash(summary, kind === 'grep' ? 40 : 70);
    return { type: 'tool', tool: kind, detail, ...fullInput(input, detail) };
  };
  switch (name) {
    case 'Bash': return tool('shell', input.description || input.command);
    case 'Read': return tool('read', path.basename(String(input.file_path ?? '')));
    case 'Edit': case 'MultiEdit': return tool('edit', path.basename(String(input.file_path ?? '')));
    case 'Write': return tool('write', path.basename(String(input.file_path ?? '')));
    case 'NotebookEdit': return tool('edit', path.basename(String(input.notebook_path ?? '')));
    case 'Glob': return tool('search', input.pattern);
    case 'Grep': return tool('grep', input.pattern);
    case 'WebSearch': return tool('web', input.query);
    case 'WebFetch': return tool('web', input.url);
    case 'TodoWrite': return tool('plan');
    case 'Task': case 'Agent': return tool('agent', input.description);
    case 'mcp__office__delegate_task': return tool('delegate', `${input.to}: ${squash(input.task, 50)}`);
    case 'mcp__office__list_team': return tool('team');
    case 'mcp__office__task_status': return tool('status');
    default: return tool('other', name.replace(/^mcp__/, ''));
  }
}

// Claude desktop app bundles its own CLI (newest version first)
function bundledBinaries() {
  const root = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
  const ls = (dir: string) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const found: { p: string; m: number }[] = [];
  for (const ver of ls(root)) {
    for (const sub of ls(path.join(root, ver))) {
      const p = path.join(root, ver, sub, 'claude.app/Contents/MacOS/claude');
      if (fs.existsSync(p)) found.push({ p, m: fs.statSync(p).mtimeMs });
    }
  }
  return found.sort((a, b) => b.m - a.m).map(f => f.p);
}

export const claude: Provider = {
  id: 'claude',
  label: 'Claude Code',
  models: [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' }],
  delegation: true,
  binaryNames: ['claude'],
  errors: [
    { kind: 'limit', pattern: /\bcredit balance is too low\b/i },
    { kind: 'auth', pattern: /\brun \/login\b/i },
    ...COMMON_ERRORS,
  ],
  get binaryPaths() {
    return [path.join(os.homedir(), '.claude/local/claude'), ...bundledBinaries()];
  },

  buildArgs({ agent, task, systemPrompt, mcp }) {
    const allowed = ['mcp__office__list_team', 'mcp__office__delegate_task', 'mcp__office__task_status', 'mcp__office__request_approval', 'mcp__office__remember', 'mcp__office__recall', ...parseTools(agent.allowedTools)];
    const args = ['-p', task.prompt, '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', systemPrompt,
      '--mcp-config', JSON.stringify({ mcpServers: { office: mcp } }),
      '--permission-mode', agent.permissionMode || 'acceptEdits',
      '--allowedTools', ...allowed];
    if (agent.model) args.push('--model', agent.model);
    if (agent.sessionId) args.push('--resume', agent.sessionId);
    return args;
  },

  createParser() {
    const writing = new Map<string, string>(); // tool_use id → file it writes
    return (line) => {
      const msg = parseJsonLine(line);
      if (!msg) return [];
      const events: ProviderEvent[] = [];
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id) events.push({ type: 'session', id: msg.session_id });
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) events.push({ type: 'text', text: c.text });
          else if (c.type === 'tool_use') {
            events.push(toolEvent(c.name, c.input));
            const file = writtenBy(c.name, c.input);
            if (file && c.id) writing.set(c.id, file);
          }
        }
      } else if (msg.type === 'user') {
        for (const c of msg.message?.content || []) {
          if (c.type !== 'tool_result') continue;
          const file = writing.get(c.tool_use_id);
          writing.delete(c.tool_use_id);
          if (file && !c.is_error) events.push({ type: 'files', files: [file] });
          if (c.is_error) {
            const text = Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text || '').join(' ') : String(c.content || '');
            events.push({ type: 'tool-error', text });
          }
        }
      } else if (msg.type === 'result') {
        events.push({ type: 'result', ok: !msg.is_error, text: msg.result || '', ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}) });
      }
      return events;
    };
  },

  env() {
    // Clear related variables so it is not detected as a nested Claude Code session
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
    return env;
  },
};
