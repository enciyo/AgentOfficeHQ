// HTTP API (Hono). Handlers only translate HTTP to application calls.
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import type { TKey } from '../../shared/i18n/index.ts';
import type { Agents } from '../application/agents.ts';
import type { Approvals } from '../application/approvals.ts';
import type { Github } from '../application/github.ts';
import type { Knowledge } from '../application/knowledge.ts';
import type { Schedules } from '../application/schedules.ts';
import type { Tasks } from '../application/tasks.ts';
import type { Translator } from '../application/translator.ts';
import type { Workspace } from '../application/workspace.ts';
import { DomainError } from '../domain/errors.ts';
import type { SseBroadcaster } from '../infrastructure/sseBroadcaster.ts';
import * as schema from './schemas.ts';

interface Services { agents: Agents; tasks: Tasks; schedules: Schedules; approvals: Approvals; knowledge: Knowledge; github: Github; workspace: Workspace; events: SseBroadcaster; i18n: Translator; clientDir: string }

// Validates the JSON body; failures answer `{ error }` like every other error in this API.
// Schema messages are translation keys.
const validated = <T extends ZodType>(s: T, i18n: Translator) =>
  zValidator('json', s, (result, c) => (result.success ? undefined : c.json({ error: i18n.t((result.error.issues[0]?.message ?? 'err.invalid') as TKey) }, 400)));

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
const contentType = (file: string) => TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'text/plain; charset=utf-8';

// For routes whose body is optional.
const optionalBody = async (req: { json(): Promise<unknown> }) => req.json().catch(() => ({}));

export function createApp({ agents, tasks, schedules, approvals, knowledge, github, workspace, events, i18n, clientDir }: Services) {
  const app = new Hono();
  const body = <T extends ZodType>(s: T) => validated(s, i18n);

  app.onError((err, c) =>
    err instanceof DomainError ? c.json({ error: err.message }, err.status) : c.json({ error: err.message }, 500));

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: i18n.t('err.unknownEndpoint') }, 404) : c.text(i18n.t('err.notFoundPlain'), 404)));

  const api = app.basePath('/api');

  // A browser names the page a request comes from. Only the office's own pages may change things: another website,
  // or an agent-written page under /files/raw (sandboxed, origin "null"), could otherwise post a plain form here.
  // Agents' MCP server calls from Node and sends no Origin.
  api.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || !origin) return next();
    let host = '';
    try { host = new URL(origin).host; } catch {}
    if (!host || host !== c.req.header('host')) return c.json({ error: i18n.t('err.foreignOrigin') }, 403);
    return next();
  });

  api.get('/state', async (c) => c.json(await workspace.snapshot()));

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.write('retry: 2000\n\n');
      const unsubscribe = events.subscribe((e) => void stream.writeSSE({ data: JSON.stringify(e) }));
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(25000);
        await stream.write(': ping\n\n'); // keeps idle connections open
      }
    }));

  api.post('/agents', body(schema.hireAgent), (c) => c.json(agents.hire(c.req.valid('json'))));
  api.patch('/agents/:id', body(schema.updateAgent), (c) => c.json(agents.update(c.req.param('id'), c.req.valid('json'))));
  api.delete('/agents/:id', (c) => (agents.fire(c.req.param('id')), c.json({ ok: true })));
  api.post('/agents/:id/stop', (c) => (agents.stop(c.req.param('id')), c.json({ ok: true })));
  api.post('/agents/:id/reset', (c) => (agents.resetMemory(c.req.param('id')), c.json({ ok: true })));
  api.get('/agents/:id/logs', (c) => {
    agents.get(c.req.param('id'));
    return c.json(workspace.logsOf(c.req.param('id')));
  });
  api.post('/agents/:id/tasks', body(schema.assignTask), (c) => {
    agents.get(c.req.param('id'));
    return c.json(tasks.create(c.req.param('id'), c.req.valid('json').prompt));
  });

  api.post('/team/defaults', async (c) => {
    const { replace } = schema.installTeam.parse(await optionalBody(c.req));
    return c.json({ added: agents.installDefaultTeam(replace).map(a => a.name) });
  });

  api.delete('/team', (c) => c.json({ removed: agents.deleteTeam() }));
  api.get('/team/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="agent-office-team-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(agents.exportTeam());
  });
  api.post('/team/import', body(schema.importTeam), (c) => {
    const { agents: members, replace } = c.req.valid('json');
    return c.json(agents.importTeam(members, replace));
  });

  api.post('/team/refresh-roles', (c) => c.json({ updated: agents.refreshDefaultRoles().map(a => a.name) }));

  api.post('/providers/:id/resume', (c) => (tasks.resumeProvider(c.req.param('id')), c.json({ ok: true })));

  // Human workers complete their tasks by hand; anyone can cancel
  api.post('/tasks/:id/complete', async (c) => {
    const { result } = schema.completeTask.parse(await optionalBody(c.req));
    return c.json(tasks.complete(c.req.param('id'), result));
  });
  api.post('/tasks/:id/cancel', (c) => c.json(tasks.cancel(c.req.param('id'))));
  api.post('/tasks/:id/cancel-chain', (c) => c.json(tasks.cancelChain(c.req.param('id'))));
  api.post('/tasks/:id/release', (c) => c.json(tasks.releaseReport(c.req.param('id'))));
  api.post('/tasks/:id/retry', (c) => c.json(tasks.retry(c.req.param('id'))));
  api.post('/tasks/:id/resolve', (c) => c.json(tasks.resolveConflict(c.req.param('id'))));
  api.get('/tasks/:id', (c) => c.json(tasks.get(c.req.param('id'))));
  api.get('/tasks/:id/diff', (c) => c.json(tasks.diff(c.req.param('id'))));
  api.get('/tasks/:id/logs', async (c) => c.json(await workspace.taskLogs(c.req.param('id'))));
  api.patch('/tasks/:id', body(schema.editTask), (c) => c.json(tasks.edit(c.req.param('id'), c.req.valid('json').prompt)));
  api.post('/tasks/:id/handoff', body(schema.handoffTask), (c) => c.json(tasks.handoff(c.req.param('id'), c.req.valid('json').agentId)));
  api.post('/tasks/:id/react', body(schema.reactTask), (c) => c.json(tasks.react(c.req.param('id'), c.req.valid('json').emoji)));
  api.post('/tasks/:id/pr', async (c) => c.json(await github.openPullRequest(c.req.param('id'))));

  // Open GitHub issues/PRs waiting at the door
  api.post('/visitors/refresh', async (c) => c.json(await github.poll({ strict: true })));
  api.post('/visitors/:id/accept', body(schema.acceptVisitor), (c) => c.json(github.accept(c.req.param('id'), c.req.valid('json').agentId)));
  api.post('/visitors/:id/reject', (c) => c.json(github.reject(c.req.param('id'))));

  api.post('/schedules', body(schema.createSchedule), (c) => c.json(schedules.create(c.req.valid('json'))));
  api.patch('/schedules/:id', body(schema.updateSchedule), (c) => c.json(schedules.update(c.req.param('id'), c.req.valid('json'))));
  api.delete('/schedules/:id', (c) => (schedules.remove(c.req.param('id')), c.json({ ok: true })));

  // Everything the office knows (state + recent logs), as a download
  api.get('/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="agent-office-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(workspace.exportAll());
  });

  // Read-only browser for what the agents wrote in the shared working directory
  api.get('/files', (c) => c.json(workspace.outputs()));
  api.get('/files/content', (c) => c.json(workspace.output(c.req.query('path') ?? '')));
  api.delete('/files', (c) => (workspace.removeOutput(c.req.query('path') ?? ''), c.json({ ok: true })));
  // The file itself, for previews (an HTML page loads its own css/js next to it) and downloads.
  // Agent-written pages run sandboxed: no access to this origin, so they cannot call the API.
  api.get('/files/raw/*', (c) => {
    let rel = '';
    try { rel = decodeURIComponent(c.req.path.slice(c.req.path.indexOf('/files/raw/') + '/files/raw/'.length)); } catch {} // a malformed %-escape names no file
    const bytes = workspace.outputRaw(rel);
    c.header('Content-Type', contentType(rel));
    c.header('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.query('download') !== undefined) c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`);
    return c.body(new Uint8Array(bytes));
  });

  api.post('/office/pause', body(schema.pauseOffice), (c) => (tasks.setPaused(c.req.valid('json').paused), c.json({ ok: true })));
  api.put('/office', body(schema.updateOffice), (c) => (workspace.updateOffice(c.req.valid('json')), c.json({ ok: true })));
  api.put('/settings', body(schema.updateSettings), async (c) => {
    const result = await workspace.updateSettings(c.req.valid('json'));
    if (c.req.valid('json').github) void github.poll(); // visitors show up right away
    return c.json(result);
  });

  api.post('/approvals/:id/decide', body(schema.decideApproval), (c) => {
    const { approve, note } = c.req.valid('json');
    return c.json(approvals.decide(c.req.param('id'), approve, note));
  });

  // The Knowledge tab: only here can a note be pinned
  api.patch('/notes/:id', body(schema.updateNote), (c) => c.json(knowledge.update(c.req.param('id'), c.req.valid('json'))));
  api.delete('/notes/:id', (c) => (knowledge.remove(c.req.param('id')), c.json({ ok: true })));

  // Used by the MCP server running inside each agent
  api.post('/notes', body(schema.rememberNote), (c) => {
    const { agentId, taskId, text } = c.req.valid('json');
    return c.json(knowledge.remember(agentId, taskId, text));
  });
  api.get('/notes/recall', (c) => c.json(knowledge.recall(c.req.query('q') ?? '')));
  api.post('/approvals', body(schema.requestApproval), (c) => {
    const { agentId, taskId, action, details } = c.req.valid('json');
    return c.json(approvals.request(agentId, taskId, action, details));
  });
  api.get('/team', (c) => c.json(workspace.team()));
  api.post('/delegate', body(schema.delegateTask), (c) => {
    const { from, to, task, parentTaskId } = c.req.valid('json');
    return c.json(tasks.delegate(from, to, task, parentTaskId));
  });

  app.use('*', serveStatic({ root: path.relative(process.cwd(), clientDir) }));
  return app;
}
