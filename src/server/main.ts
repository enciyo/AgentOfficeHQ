// Agent Office — composition root. Wires the layers together and starts the HTTP server.
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { resolveLocale } from '../shared/i18n/index.ts';
import { Agents } from './application/agents.ts';
import { Approvals } from './application/approvals.ts';
import { Github } from './application/github.ts';
import { Knowledge } from './application/knowledge.ts';
import { Schedules } from './application/schedules.ts';
import { Notifier } from './application/notifier.ts';
import { PresenceBoard } from './application/presence.ts';
import { Tasks } from './application/tasks.ts';
import { Translator } from './application/translator.ts';
import { Workspace } from './application/workspace.ts';
import { DATA, HOST, MCP_SERVER, PORT, ROOT, TSX_BIN } from './config.ts';
import { FileLogBook } from './infrastructure/persistence/fileLogBook.ts';
import { JsonStateStore } from './infrastructure/persistence/jsonStateStore.ts';
import { GitIsolation } from './infrastructure/gitIsolation.ts';
import { GithubCli } from './infrastructure/githubCli.ts';
import { LocalFileTree } from './infrastructure/localFileTree.ts';
import { ProcessRunner } from './infrastructure/processRunner.ts';
import { SseBroadcaster } from './infrastructure/sseBroadcaster.ts';
import { createApp } from './interface/app.ts';

// First-run language comes from the environment; afterwards it is a setting.
const language = resolveLocale(process.env.LOCALE || process.env.LANG);
const store = new JsonStateStore(path.join(DATA, 'state.json'), { cwd: path.join(ROOT, 'workspace'), language });
const logs = new FileLogBook(path.join(DATA, 'logs'));
const events = new SseBroadcaster();
const presence = new PresenceBoard();
const i18n = new Translator(store);
const runner = new ProcessRunner({
  mcp: { command: TSX_BIN, args: [MCP_SERVER], officeUrl: `http://127.0.0.1:${PORT}` },
  binaryOverrides: () => store.state.settings.binaries,
});

const notify = new Notifier(store, presence, events, logs);
const isolation = new GitIsolation();
const tasks = new Tasks(store, notify, runner, presence, i18n, isolation);
const agents = new Agents(store, notify, tasks, runner, i18n);
const schedules = new Schedules(store, notify, tasks, i18n);
const approvals = new Approvals(store, notify, tasks, i18n);
const knowledge = new Knowledge(store, notify, i18n);
const github = new Github(store, notify, tasks, new GithubCli(), i18n);
const workspace = new Workspace(store, notify, runner, logs, i18n, agents, new LocalFileTree(), isolation);

const app = createApp({ agents, tasks, schedules, approvals, knowledge, github, workspace, events, i18n, clientDir: path.join(ROOT, 'dist', 'client') });

agents.relayout();
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`\n  ${i18n.t('console.running', { url: `http://localhost:${PORT}` })}`);
  if (HOST !== '127.0.0.1') {
    const nets = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
    for (const n of nets) console.log(`  ${i18n.t('console.lan', { url: `http://${n!.address}:${PORT}` })}`);
  }
  // Model lists come from the CLIs themselves, so this can take a moment; the office does not wait for it
  void runner.providers()
    .then(list => console.log(list.map(p => `  ${i18n.t('console.cli', { label: p.label, path: p.path || i18n.t('console.cliMissing') })}`).join('\n') + '\n'))
    .catch(err => console.error(err));
  if (store.fresh && !store.state.agents.length) agents.installDefaultTeam();
  tasks.reconcile();
  agents.resume();
  schedules.tick();
  // Schedules fall due; a new day resets the budget caps
  setInterval(() => { schedules.tick(); tasks.pump(); }, 30_000);
  // GitHub visitors (when turned on in settings)
  void github.poll();
  setInterval(() => void github.poll(), 5 * 60_000);
});

// Stops the CLIs (they run in their own process groups, so nothing else reaches them), then writes the state.
// The runner ends every run within its grace periods, so this does not hang.
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log(`\n  ${i18n.t('console.stopping')}`);
  server.close();
  await tasks.shutdown();
  store.saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Closing the terminal: its hangup no longer reaches the CLIs by itself. Node starts with this signal at its default
// even under nohup, so the background service is no different: without this it would die and leave its CLIs running.
process.on('SIGHUP', shutdown);
