// Runs agent CLIs as child processes using the registered providers.
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderInfo } from '../../shared/types.ts';
import { ProviderUnavailable } from '../domain/errors.ts';
import type { RunCallbacks, RunExit, RunHandle, RunRequest, Runner } from '../domain/ports.ts';
import { classifyFailure } from './providers/errors.ts';
import { PROVIDERS, getProvider } from './providers/index.ts';
import type { ModelOption, Provider } from './providers/types.ts';
import { findBinary, squash } from './providers/util.ts';

/** How long a CLI's reported model list is reused before asking it again. */
const MODELS_TTL = 5 * 60_000;
/** How long a health answer is reused; a failure sooner, so a fixed CLI shows up when the settings are saved again. */
const HEALTH_OK_TTL = 5 * 60_000;
const HEALTH_FAILED_TTL = 15_000;
/** A CLI's cold start can take seconds; one that takes longer than this for its version is not usable. */
const HEALTH_TIMEOUT_MS = 8_000;
/** How long a run gets to go after SIGTERM, then after SIGKILL, and for its output to end once it has exited. */
const STOP_GRACE_MS = 5_000;
/** A child leading its own process group can be killed along with everything it started. */
const GROUPS = process.platform !== 'win32';
const exec = promisify(execFile);

type Health = Pick<ProviderInfo, 'version' | 'healthError'> & { health: 'ok' | 'broken' };

interface Options {
  /** Command that starts the office MCP server, and the URL it should call back. */
  mcp: { command: string; args: string[]; officeUrl: string };
  /** Explicit executable paths per provider id (from the settings screen). */
  binaryOverrides: () => Record<string, string>;
  stopGraceMs?: number;
  healthTimeoutMs?: number;
  /** The CLIs on offer; every registered one unless a test narrows it down. */
  catalog?: Provider[];
}

export class ProcessRunner implements Runner {
  /** Last known model list per provider, keyed by provider id and binary path. */
  private readonly modelCache = new Map<string, { at: number; models: ModelOption[] }>();
  /** Last health check per provider id and binary path; a promise, so calls at the same time share one check. */
  private readonly healthCache = new Map<string, { at: number; check: Promise<Health> }>();

  constructor(private readonly options: Options) {}

  has = (id: string) => PROVIDERS.some(p => p.id === id);
  delegates = (id: string) => getProvider(id).delegation;
  label = (id: string) => getProvider(id).label;
  classify = (id: string, exit: RunExit, now: number) => classifyFailure(getProvider(id).errors, exit, now);

  providers(): Promise<ProviderInfo[]> {
    return Promise.all((this.options.catalog ?? PROVIDERS).map(async (p) => {
      const path = this.binaryOf(p);
      const [models, health] = await Promise.all([this.modelsOf(p, path), path ? this.healthOf(p, path) : { health: 'missing' as const }]);
      return { id: p.id, label: p.label, models, delegation: p.delegation, available: health.health === 'ok', path, ...health };
    }));
  }

  /** Whether the CLI really runs here: an executable file can still be a broken install. Never throws. */
  private async healthOf(p: Provider, bin: string): Promise<Health> {
    const key = `${p.id}:${bin}`;
    const hit = this.healthCache.get(key);
    if (hit && Date.now() - hit.at < (await hit.check.then(h => (h.health === 'ok' ? HEALTH_OK_TTL : HEALTH_FAILED_TTL)))) return hit.check;
    const check = exec(bin, p.versionArgs ?? ['--version'], { timeout: this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS, killSignal: 'SIGKILL' }).then(
      ({ stdout }): Health => ({ health: 'ok', version: squash(stdout.trim().split('\n')[0], 80) }),
      (err: { stderr?: string; message?: string }): Health => ({ health: 'broken', healthError: squash(err.stderr?.trim() || err.message, 200) }),
    );
    this.healthCache.set(key, { at: Date.now(), check });
    return check;
  }

  /** Cached `listModels` result; a CLI that cannot list models (or fails) falls back to its static suggestions. */
  private async modelsOf(p: Provider, bin: string | null): Promise<ModelOption[]> {
    if (!bin || !p.listModels) return p.models;
    const key = `${p.id}:${bin}`;
    const hit = this.modelCache.get(key);
    if (hit && Date.now() - hit.at < MODELS_TTL) return hit.models;
    const models = await p.listModels(bin).catch(() => []);
    const resolved = models.length ? models : p.models;
    this.modelCache.set(key, { at: Date.now(), models: resolved });
    return resolved;
  }

  start({ agent, task, cwd, systemPrompt, locale }: RunRequest, { onEvent, onActivity, onExit }: RunCallbacks): RunHandle {
    const provider = getProvider(agent.provider);
    const bin = this.binaryOf(provider);
    if (!bin) throw new ProviderUnavailable(provider.label, provider.id);

    fs.mkdirSync(cwd, { recursive: true });
    const { command, args, officeUrl } = this.options.mcp;
    const mcp = { command, args, env: { OFFICE_URL: officeUrl, AGENT_ID: agent.id, TASK_ID: task.id, LOCALE: locale } };
    const run = { agent, task, cwd, systemPrompt, mcp };
    const proc = spawn(bin, provider.buildArgs(run), {
      cwd, env: provider.env?.(run) ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: GROUPS,
    });

    const parse = provider.createParser();
    let buffer = '';
    let stderr = '';
    let exitCode: number | null = null;
    let stopping = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;

    const signal = (name: NodeJS.Signals) => {
      try {
        if (GROUPS && proc.pid) process.kill(-proc.pid, name);
        else proc.kill(name);
      } catch {} // nothing left to signal
    };
    // The one way a run ends, so a process that never closes its output cannot hold the agent or a concurrency slot
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopping) signal('SIGKILL'); // whatever in the group outlived its leader
      proc.stdout.destroy();
      proc.stderr.destroy();
      // CLIs color their stderr for terminals; the color codes would show up as noise in the UI
      onExit({ code: exitCode, stderr: stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') });
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      onActivity();
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) try { parse(line).forEach(onEvent); } catch {}
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => { onActivity(); stderr = (stderr + chunk).slice(-4000); });
    proc.on('error', (err) => { stderr += String(err); });
    // Something the CLI left in the background can keep the output open long after it exited
    proc.on('exit', (code) => {
      exitCode = code;
      if (!stopping) timer = setTimeout(settle, grace);
    });
    proc.on('close', (code) => { exitCode ??= code; settle(); });
    return {
      stop: () => {
        if (stopping || settled) return;
        stopping = true;
        clearTimeout(timer);
        signal('SIGTERM');
        timer = setTimeout(() => {
          signal('SIGKILL');
          timer = setTimeout(settle, grace);
        }, grace);
      },
    };
  }

  private binaryOf = (p: Provider) => findBinary(p, this.options.binaryOverrides()[p.id]);
}
