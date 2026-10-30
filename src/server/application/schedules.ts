// Recurring tasks: kept in the state, checked every tick, turned into ordinary tasks when due.
import { randomUUID } from 'node:crypto';
import type { Schedule } from '../../shared/types.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { MIN_INTERVAL_MINUTES, advance, firstRun } from '../domain/schedule.ts';
import type { StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Tasks } from './tasks.ts';
import type { Translator } from './translator.ts';

type ScheduleFields = Pick<Schedule, 'agentId' | 'prompt' | 'intervalMinutes'> & Partial<Pick<Schedule, 'at' | 'enabled'>>;

export class Schedules {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly tasks: Tasks,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }

  private get(id: string) {
    const s = this.state.schedules.find(x => x.id === id);
    if (!s) throw notFound(this.i18n.t('err.notFound'));
    return s;
  }

  private check(s: Pick<Schedule, 'agentId' | 'prompt' | 'intervalMinutes'>) {
    if (!this.state.agents.some(a => a.id === s.agentId)) throw notFound(this.i18n.t('err.notFound'));
    if (!s.prompt.trim()) throw badRequest(this.i18n.t('err.taskEmpty'));
    if (!(s.intervalMinutes >= MIN_INTERVAL_MINUTES)) throw badRequest(this.i18n.t('err.intervalTooShort', { n: MIN_INTERVAL_MINUTES }));
  }

  create(fields: ScheduleFields, now = Date.now()) {
    const s: Schedule = { id: randomUUID().slice(0, 8), enabled: true, lastRunAt: null, createdAt: now, nextRunAt: 0, ...fields, prompt: fields.prompt.trim() };
    this.check(s);
    s.nextRunAt = firstRun(s, now);
    this.state.schedules.push(s);
    this.changed();
    return s;
  }

  update(id: string, fields: Partial<Omit<ScheduleFields, 'agentId'>>, now = Date.now()) {
    const s = this.get(id);
    const retimed = (fields.intervalMinutes !== undefined && fields.intervalMinutes !== s.intervalMinutes) || (fields.at !== undefined && fields.at !== s.at) || (fields.enabled && !s.enabled);
    Object.assign(s, fields);
    this.check(s);
    if (retimed) s.nextRunAt = firstRun(s, now);
    this.changed();
    return s;
  }

  remove(id: string) {
    this.state.schedules = this.state.schedules.filter(s => s.id !== this.get(id).id);
    this.changed();
  }

  /** Gives every due schedule's task to its agent; schedules of agents that left are dropped. */
  tick(now = Date.now()) {
    const before = this.state.schedules.length;
    this.state.schedules = this.state.schedules.filter(s => this.state.agents.some(a => a.id === s.agentId));
    let changed = this.state.schedules.length !== before;
    for (const s of this.state.schedules) {
      // A paused office piles nothing up: what fell due runs once when it resumes
      if (this.state.settings.paused || !s.enabled || s.nextRunAt > now) continue;
      // Neither does anything else that holds a queue back (a CLI limit, a login, a budget, a merge review):
      // the copy still waiting will do, so this slot is skipped and nothing runs twice in a row when the hold ends
      if (!this.state.tasks.some(t => t.scheduleId === s.id && t.status === 'queued')) {
        this.tasks.create(s.agentId, s.prompt, { scheduleId: s.id });
        s.lastRunAt = now;
      }
      s.nextRunAt = advance(s.nextRunAt, s.intervalMinutes, now);
      changed = true;
    }
    if (changed) this.changed();
  }

  private changed() {
    this.store.save();
    this.notify.publish({ type: 'schedules', schedules: this.state.schedules });
  }
}
