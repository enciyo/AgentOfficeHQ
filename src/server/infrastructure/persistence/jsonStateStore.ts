// State persisted as data/state.json (debounced, atomic writes), with hourly copies in data/backups/.
import fs from 'node:fs';
import path from 'node:path';
import type { Office, Task } from '../../../shared/types.ts';
import { DEFAULT_LIMITS } from '../../domain/limits.ts';
import { createT, type Locale } from '../../../shared/i18n/index.ts';
import type { State, StateStore } from '../../domain/ports.ts';

const BACKUPS_KEPT = 48;

const defaultOffice = (): Office => ({ name: 'Ajans HQ', width: 20, depth: 14, floorColor: '#f6f7f9', wallColor: '#ffffff', items: [] });

/** Failed and cancelled runs used to lose their cost and read $0; that was never known. */
const knownCost = (t: Task): Task => (t.cost === 0 && t.startedAt && (t.status === 'error' || t.status === 'cancelled') ? { ...t, cost: null } : t);

export class JsonStateStore implements StateStore {
  readonly state: State;
  readonly fresh: boolean;
  private timer: NodeJS.Timeout | undefined;
  private readonly backups: string;

  constructor(private readonly file: string, defaults: { cwd: string; language: Locale }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.backups = path.join(path.dirname(file), 'backups');
    this.fresh = !fs.existsSync(file) && !this.latestBackup();
    this.state = this.load(defaults);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.state.tasks = this.state.tasks.slice(-500);
      this.write();
    }, 250);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.write();
  }

  private write() {
    const json = this.serialize();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.file);
    this.backup(json);
  }

  /** One copy per hour (state-YYYYMMDD-HH.json); the oldest beyond BACKUPS_KEPT are removed. */
  private backup(json: string) {
    try {
      fs.mkdirSync(this.backups, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');
      fs.writeFileSync(path.join(this.backups, `state-${stamp.slice(0, 8)}-${stamp.slice(8)}.json`), json);
      const all = this.backupFiles();
      for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) fs.rmSync(path.join(this.backups, old), { force: true });
    } catch {}
  }

  private backupFiles() {
    try { return fs.readdirSync(this.backups).filter(f => /^state-\d{8}-\d{2}\.json$/.test(f)).sort(); } catch { return []; }
  }

  private latestBackup() {
    const last = this.backupFiles().at(-1);
    return last ? path.join(this.backups, last) : null;
  }

  /** The state file, or — if it is missing or unreadable — the newest backup. A broken file is set aside, never overwritten. */
  private readSaved(): any | null {
    if (fs.existsSync(this.file)) {
      try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        console.error(`[state] ${this.file} is unreadable; moved aside, restoring the latest backup`);
      }
    }
    for (const f of this.backupFiles().reverse()) {
      try { return JSON.parse(fs.readFileSync(path.join(this.backups, f), 'utf8')); } catch {}
    }
    return null;
  }

  private load({ cwd, language }: { cwd: string; language: Locale }): State {
    const defaults = { language, binaries: {} as Record<string, string>, defaultProvider: 'claude', defaultModels: {} as Record<string, string>, modelOverrides: {} as Record<string, string>, defaultCwd: cwd, worktrees: false, approveMerges: false, limits: DEFAULT_LIMITS, resumeInterrupted: false, approvalPolicy: createT(language)('settings.approvalPolicyDefault'), officeNotes: '', github: false, playerName: 'CEO', playerColor: '#ff7a59' };
    const saved = this.readSaved();
    if (saved) {
      const { claudeBin, ...savedSettings } = saved.settings ?? {}; // claudeBin: pre-providers setting
      const settings = { ...defaults, ...savedSettings, binaries: { ...(claudeBin ? { claude: claudeBin } : {}), ...savedSettings.binaries }, limits: { ...DEFAULT_LIMITS, ...savedSettings.limits } };
      // The default approval list is written in the office's own language
      settings.approvalPolicy = savedSettings.approvalPolicy ?? createT(settings.language)('settings.approvalPolicyDefault');
      // Before there was a default CLI every agent named its own, almost always the built-in 'claude': let those follow the default
      if (savedSettings.defaultProvider === undefined) for (const a of saved.agents || []) if (a.provider === 'claude') a.provider = '';
      return {
        office: { ...defaultOffice(), ...saved.office },
        agents: saved.agents || [],
        tasks: (saved.tasks || []).map(knownCost),
        settings,
        schedules: saved.schedules || [],
        approvals: saved.approvals || [],
        visitors: saved.visitors || [],
        notes: saved.notes || [],
        providerHolds: saved.providerHolds || {},
      };
    }
    return { office: defaultOffice(), agents: [], tasks: [], settings: defaults, schedules: [], approvals: [], visitors: [], notes: [] };
  }

  // Office items are regenerated by relayout() on every launch; only the name and colors are stored
  private serialize() {
    const { name, floorColor, wallColor } = this.state.office;
    return JSON.stringify({ ...this.state, office: { name, floorColor, wallColor } }, null, 2);
  }
}
