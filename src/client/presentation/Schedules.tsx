import { useMemo, useState, type FormEvent } from 'react';
import type { TKey } from '../../shared/i18n/index.ts';
import type { PublicAgent, Schedule } from '../../shared/types.ts';
import { formatDateTime } from '../domain/format.ts';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

const INTERVALS: [number, TKey][] = [[15, 'sched.m15'], [30, 'sched.m30'], [60, 'sched.h1'], [180, 'sched.h3'], [1440, 'sched.d1'], [10080, 'sched.w1']];
const DAILY = 1440;

/** Recurring tasks of one agent: list, pause/resume, delete, and a small form to add one. */
export function ScheduleList({ agent }: { agent: PublicAgent }) {
  const t = useT();
  const locale = useLocale();
  const all = useOffice(s => s.schedules);
  const mine = useMemo(() => all.filter(s => s.agentId === agent.id), [all, agent.id]);
  const { addSchedule, toggleSchedule, removeSchedule } = useActions();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ prompt: '', intervalMinutes: DAILY, at: '09:00' });

  const label = (s: Schedule) => {
    const known = INTERVALS.find(([m]) => m === s.intervalMinutes);
    const every = known ? t(known[1]) : t('sched.everyMin', { n: s.intervalMinutes });
    return s.at && s.intervalMinutes % DAILY === 0 ? `${every} ${s.at}` : every;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clock = draft.intervalMinutes % DAILY === 0;
    if (await addSchedule(agent.id, { prompt: draft.prompt, intervalMinutes: draft.intervalMinutes, ...(clock ? { at: draft.at } : {}) })) {
      setDraft({ ...draft, prompt: '' });
      setAdding(false);
    }
  };

  return (
    <div className="sched">
      <div className="sched-head">
        <span className="sec-label">{t('sched.title')}</span>
        {!adding && <button className="ghost sm" onClick={() => setAdding(true)}>{t('sched.add')}</button>}
      </div>
      {mine.map(s => (
        <div key={s.id} className={`sched-row ${s.enabled ? '' : 'off'}`}>
          <div className="when">🔁 {label(s)} · <small>{s.enabled ? t('sched.next', { when: formatDateTime(s.nextRunAt, locale) }) : t('sched.paused')}</small></div>
          <div className="what" title={s.prompt}>{s.prompt}</div>
          <div className="row end">
            <button className="ghost sm" onClick={() => toggleSchedule(s.id, !s.enabled)}>{t(s.enabled ? 'sched.pause' : 'sched.resume')}</button>
            <button className="ghost sm danger" onClick={() => removeSchedule(s.id)}>{t('sched.delete')}</button>
          </div>
        </div>
      ))}
      {adding && (
        <form className="sched-form" onSubmit={submit}>
          <textarea value={draft.prompt} onChange={e => setDraft({ ...draft, prompt: e.target.value })} placeholder={t('sched.prompt')} autoFocus />
          <div className="row">
            <label className="f">{t('sched.every')}
              <select value={draft.intervalMinutes} onChange={e => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}>
                {INTERVALS.map(([m, key]) => <option key={m} value={m}>{t(key)}</option>)}
              </select>
            </label>
            {draft.intervalMinutes % DAILY === 0 && <label className="f">{t('sched.at')}<input type="time" value={draft.at} onChange={e => setDraft({ ...draft, at: e.target.value })} required /></label>}
          </div>
          <div className="row end">
            <button type="button" className="sm" onClick={() => setAdding(false)}>{t('ui.cancel')}</button>
            <button className="primary sm" type="submit" disabled={!draft.prompt.trim()}>{t('sched.save')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
