import { COMMON_ERRORS } from './errors.ts';
import type { Provider, ProviderEvent } from './types.ts';
import { fullInput, parseJsonLine, squash, withSystemPrompt } from './util.ts';

// Cursor's print mode can write files; shell commands need --force. `plan` is read-only.
const PERMISSION_FLAGS: Record<string, string[]> = {
  bypassPermissions: ['--force'],
  plan: ['--plan'],
};

export const cursor: Provider = {
  id: 'cursor',
  label: 'Cursor CLI',
  models: [{ value: 'gpt-5', label: 'gpt-5' }, { value: 'sonnet-4', label: 'sonnet-4' }],
  // cursor-agent has no per-run MCP flag (it reads .cursor/mcp.json), so team tools are not injected.
  delegation: false,
  binaryNames: ['cursor-agent', 'agent'],
  errors: [
    { kind: 'auth', pattern: /\b(?:cursor-agent|agent) login\b|\bCURSOR_API_KEY\b/ },
    ...COMMON_ERRORS,
  ],

  buildArgs({ agent, task, systemPrompt }) {
    const args = ['-p', '--trust', '--output-format', 'stream-json', ...(PERMISSION_FLAGS[agent.permissionMode] ?? [])];
    if (agent.model) args.push('--model', agent.model);
    if (agent.sessionId) args.push('--resume', agent.sessionId);
    args.push(withSystemPrompt(systemPrompt, task.prompt));
    return args;
  },

  // Same envelope as Claude's stream-json; tool calls arrive as `tool_call` events.
  createParser() {
    return (line) => {
      const msg = parseJsonLine(line);
      if (!msg) return [];
      const events: ProviderEvent[] = [];
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id) events.push({ type: 'session', id: msg.session_id });
      } else if (msg.type === 'assistant') {
        for (const c of msg.message?.content || []) if (c.type === 'text' && c.text?.trim()) events.push({ type: 'text', text: c.text });
      } else if (msg.type === 'tool_call' && msg.subtype === 'started') {
        // tool_call: { readToolCall: { args: { path } } } | { shellToolCall: { args: { command } } } | ...
        const [key, call] = Object.entries<any>(msg.tool_call ?? {})[0] ?? [];
        // edit/write calls name the file they change
        const files = /edit|write/i.test(key ?? '') && call?.args?.path ? [String(call.args.path)] : [];
        if (key) events.push({ type: 'tool', tool: 'other', detail: `${key.replace(/ToolCall$/, '')}: ${squash(call?.args?.command ?? call?.args?.path ?? call?.args?.pattern ?? '', 50)}`, ...(files.length ? { files } : {}), ...fullInput(call?.args) });
      } else if (msg.type === 'result') {
        events.push({ type: 'result', ok: !msg.is_error, text: msg.result || '' });
      }
      return events;
    };
  },
};
