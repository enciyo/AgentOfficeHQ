// MCP SDK based stdio server that exposes team tools to agents.
// Every `claude` process starts it with its own AGENT_ID; the tools call the office server's HTTP API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createT, resolveLocale } from '../shared/i18n/index.ts';

const OFFICE_URL = process.env.OFFICE_URL || 'http://127.0.0.1:4317';
const AGENT_ID = process.env.AGENT_ID;
const TASK_ID = process.env.TASK_ID;

const t = createT(resolveLocale(process.env.LOCALE || process.env.LANG));

if (!AGENT_ID) {
  console.error(t('mcp.agentIdMissing'));
  process.exit(1);
}

// Office API responses are shaped by the server; callers validate the fields themselves.
async function officeApi(method: 'GET' | 'POST', path: string, body?: object): Promise<any> {
  const res = await fetch(`${OFFICE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
  return data;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

/** Wraps a handler so failures come back as tool errors instead of protocol errors. */
const safe =
  <A>(fn: (args: A) => Promise<string>) =>
  async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  };

const server = new McpServer({ name: 'office', version: '0.3.0' });

server.registerTool('list_team', { description: t('mcp.listTeam.desc') }, safe(async () => {
  const team = await officeApi('GET', '/api/team');
  if (!Array.isArray(team) || team.length === 0) return t('mcp.team.empty');
  return team
    .map((m) =>
      t('mcp.team.member', {
        name: m.name,
        role: m.role,
        team: m.team ? t('mcp.team.inTeam', { team: m.team }) : '',
        kind: m.kind === 'human' ? t('mcp.team.human') : t('mcp.team.ai'),
        status: m.status,
        queued: m.queued ? t('mcp.team.queued', { queued: m.queued }) : '',
      }),
    )
    .join('\n');
}));

server.registerTool(
  'delegate_task',
  {
    description: t('mcp.delegate.desc'),
    inputSchema: {
      to: z.string().min(1).describe(t('mcp.delegate.to')),
      task: z.string().min(1).describe(t('mcp.delegate.task')),
    },
  },
  safe(async ({ to, task }) => {
    const r = await officeApi('POST', '/api/delegate', { from: AGENT_ID, to, task, parentTaskId: TASK_ID });
    return t('mcp.delegate.ok', {
      taskId: r.taskId,
      to: r.to,
      human: r.kind === 'human' ? t('mcp.delegate.human') : '',
    });
  }),
);

server.registerTool(
  'task_status',
  {
    description: t('mcp.status.desc'),
    inputSchema: { task_id: z.string().min(1).describe(t('mcp.status.id')) },
  },
  safe(async ({ task_id }) => {
    const task = await officeApi('GET', `/api/tasks/${encodeURIComponent(task_id)}`);
    return t('mcp.status.format', {
      id: task.id,
      status: task.status,
      result: task.result ? t('mcp.status.result', { result: task.result }) : '',
    });
  }),
);

server.registerTool(
  'request_approval',
  {
    description: t('mcp.approval.desc'),
    inputSchema: {
      action: z.string().min(1).describe(t('mcp.approval.action')),
      details: z.string().default('').describe(t('mcp.approval.details')),
    },
  },
  safe(async ({ action, details }) => {
    const r = await officeApi('POST', '/api/approvals', { agentId: AGENT_ID, taskId: TASK_ID, action, details });
    return t('mcp.approval.ok', { id: r.id });
  }),
);

server.registerTool(
  'remember',
  {
    description: t('mcp.remember.desc'),
    inputSchema: { text: z.string().min(1).describe(t('mcp.remember.text')) },
  },
  safe(async ({ text: note }) => {
    const r = await officeApi('POST', '/api/notes', { agentId: AGENT_ID, taskId: TASK_ID, text: note });
    return t('mcp.remember.ok', { id: r.id });
  }),
);

server.registerTool(
  'recall',
  {
    description: t('mcp.recall.desc'),
    inputSchema: { query: z.string().default('').describe(t('mcp.recall.query')) },
  },
  safe(async ({ query }) => (await officeApi('GET', `/api/notes/recall?q=${encodeURIComponent(query)}`)).text),
);

server
  .connect(new StdioServerTransport())
  .then(() => console.error(t('mcp.serverStarted')))
  .catch((err) => {
    console.error(t('mcp.unhandled', { err: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
