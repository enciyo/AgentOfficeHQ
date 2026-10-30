import { COMMON_ERRORS } from './errors.ts';
import type { Provider, ProviderEvent } from './types.ts';
import { fullInput, parseJsonLine, squash, withSystemPrompt } from './util.ts';

// Agent permission modes (Claude vocabulary) mapped to Codex sandbox flags
const PERMISSION_FLAGS: Record<string, string[]> = {
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
  acceptEdits: ['--full-auto'],
  plan: ['--sandbox', 'read-only'],
  default: ['--sandbox', 'read-only'],
};

/** Codex cannot limit writes to some folders: a role that may write somewhere (e.g. Edit(docs/**)) needs a writable sandbox. */
const codexMode = (agent: { permissionMode: string; allowedTools: string }) =>
  agent.permissionMode === 'default' && /\b(Edit|Write)\b/.test(agent.allowedTools) ? 'acceptEdits' : agent.permissionMode;

export const codex: Provider = {
  id: 'codex',
  label: 'Codex CLI',
  models: [{ value: 'gpt-5', label: 'gpt-5' }, { value: 'gpt-5-codex', label: 'gpt-5-codex' }],
  delegation: true,
  binaryNames: ['codex'],
  errors: [
    { kind: 'limit', pattern: /\bupgrade to (?:plus|pro)\b|\bpurchase more credits\b/i },
    { kind: 'auth', pattern: /\bcodex login\b/i },
    ...COMMON_ERRORS,
  ],

  buildArgs({ agent, task, cwd, systemPrompt, mcp }) {
    // `-c key=value` values are parsed as JSON, so tables and arrays can be passed inline
    const mcpFlags = ['command', 'args', 'env'].flatMap((k) => ['-c', `mcp_servers.office.${k}=${JSON.stringify(mcp[k as keyof typeof mcp])}`]);
    const flags = ['--json', '--skip-git-repo-check', '-C', cwd,
      ...(PERMISSION_FLAGS[codexMode(agent)] ?? PERMISSION_FLAGS.acceptEdits!),
      ...(agent.model ? ['-m', agent.model] : []), ...mcpFlags];
    const prompt = withSystemPrompt(systemPrompt, task.prompt);
    return agent.sessionId ? ['exec', ...flags, 'resume', agent.sessionId, prompt] : ['exec', ...flags, prompt];
  },

  // Understands both the current JSONL events (thread.*/item.*) and the older `{ msg: { type } }` envelope.
  createParser() {
    let lastText = '';
    return (line) => {
      const raw = parseJsonLine(line);
      if (!raw) return [];
      const events: ProviderEvent[] = [];
      const msg = raw.msg ?? raw;
      const type: string = msg.type ?? '';

      if (type === 'thread.started' && msg.thread_id) events.push({ type: 'session', id: msg.thread_id });
      else if (type === 'session_configured' && msg.session_id) events.push({ type: 'session', id: msg.session_id });
      else if (type === 'item.started' || type === 'item.completed') {
        const item = msg.item ?? {};
        if (item.type === 'agent_message' && type === 'item.completed' && item.text) {
          lastText = item.text;
          events.push({ type: 'text', text: item.text });
        } else if (item.type === 'command_execution' && type === 'item.started') {
          const detail = squash(item.command);
          events.push({ type: 'tool', tool: 'shell', detail, ...fullInput(item.command, detail) });
        } else if (item.type === 'file_change' && type === 'item.completed') {
          const files = (Array.isArray(item.changes) ? item.changes : []).map((c: any) => String(c?.path ?? '')).filter(Boolean);
          events.push({ type: 'tool', tool: 'files', ...(files.length ? { files } : {}) });
        } else if (item.type === 'mcp_tool_call' && type === 'item.started') {
          events.push({ type: 'tool', tool: 'other', detail: `${item.server}.${item.tool}`, ...fullInput(item.arguments) });
        }
      } else if (type === 'agent_message' && msg.message) {
        lastText = msg.message;
        events.push({ type: 'text', text: msg.message });
      } else if (type === 'exec_command_begin') {
        const command = Array.isArray(msg.command) ? msg.command.join(' ') : msg.command;
        const detail = squash(command);
        events.push({ type: 'tool', tool: 'shell', detail, ...fullInput(command, detail) });
      } else if (type === 'turn.completed' || type === 'task_complete') {
        events.push({ type: 'result', ok: true, text: msg.last_agent_message ?? lastText });
      } else if (type === 'turn.failed') {
        events.push({ type: 'result', ok: false, text: msg.error?.message ?? 'Codex turn failed' });
      } else if (type === 'error' && msg.message) {
        events.push({ type: 'result', ok: false, text: String(msg.message) });
      }
      return events;
    };
  },
};
