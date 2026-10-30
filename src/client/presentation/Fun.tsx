// Office life UI: fun menu, stand-up, today's priority, GitHub visitors, reactions, morale, badges and the leaderboard.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { REACTIONS } from '../../shared/types.ts';
import { BADGE_EMOJI, badgesOf, leaderboard, type BadgeId } from '../domain/badges.ts';
import { COFFEE_MAX, moodEmoji, moraleOf } from '../domain/fun.ts';
import { pmAgent } from '../domain/views.ts';
import { Markdown, RichText, Who } from './common.tsx';
import { useActions, useOffice, useT } from './store.tsx';

const STANDUP_SHOW_MS = 25_000;

/** Top bar menu: coffee level, break, stand-up, fire drill, weather, random events. */
export function FunMenu() {
  const [open, setOpen] = useState(false);
  const coffee = useOffice(s => s.fun.coffee);
  const weather = useOffice(s => s.weather);
  const funEvents = useOffice(s => s.funEvents);
  const { fireDrill, setWeather, coffeeBreak, setFunEvents, standup } = useActions();
  const t = useT();
  const pick = (run: () => void) => () => { run(); setOpen(false); };
  const level = Math.round((coffee / COFFEE_MAX) * 100);
  return (
    <div className="fun-menu">
      <button className={`${open ? 'active' : ''} ${level <= 0 ? 'alert' : ''}`} title={t('fun.menu')} onClick={() => setOpen(!open)}>☕ {level}%</button>
      {open && (
        <div className="menu" onPointerLeave={() => setOpen(false)}>
          <div className="meter"><span>{t('fun.coffee')}</span><i><b style={{ width: `${level}%` }} /></i></div>
          <button onClick={pick(coffeeBreak)}>☕ {t('fun.breakAction')}</button>
          <button onClick={pick(standup)}>🗣️ {t('fun.standupAction')}</button>
          <button onClick={pick(fireDrill)}>🚨 {t('fun.drillAction')}</button>
          <button onClick={pick(() => setWeather(weather === 'rain' ? 'clear' : 'rain'))}>{weather === 'rain' ? `☀️ ${t('fun.sun')}` : `🌧️ ${t('fun.rain')}`}</button>
          <label className="check"><input type="checkbox" checked={funEvents} onChange={e => setFunEvents(e.target.checked)} />{t('fun.random')}</label>
        </div>
      )}
    </div>
  );
}

/** What everyone said at the stand-up; closes itself after a while. */
export function StandupPanel() {
  const standup = useOffice(s => s.standup);
  const { closeStandup } = useActions();
  const t = useT();
  useEffect(() => {
    if (!standup) return;
    const id = setTimeout(closeStandup, STANDUP_SHOW_MS);
    return () => clearTimeout(id);
  }, [standup, closeStandup]);
  if (!standup) return null;
  return (
    <section className="standup">
      <div className="standup-head"><b>🗣️ {t('standup.title')}</b><button className="icon ghost" title={t('ui.close')} onClick={closeStandup}>✕</button></div>
      {standup.lines.length
        ? standup.lines.map(l => <div key={l.agentId} className="standup-line"><Who id={l.agentId} /><span>{l.text}</span></div>)
        : <div className="empty">{t('standup.empty')}</div>}
    </section>
  );
}

/** Asked when the CEO walks into their room for the first time in a day. */
export function PriorityModal() {
  const { setPriority } = useActions();
  const pm = useOffice(s => pmAgent(Object.values(s.agents)));
  const t = useT();
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); setPriority(text); };
  return (
    <>
      <h2>{t('priority.title')}</h2>
      <div className="hint"><RichText text={t('priority.hint', { name: pm?.name ?? '' })} /></div>
      <form onSubmit={submit}>
        <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={t('priority.ph')} />
        <div className="row end">
          <button type="button" onClick={() => setPriority('')}>{t('priority.skip')}</button>
          <button className="primary" type="submit" disabled={!text.trim()}>{t('priority.send')}</button>
        </div>
      </form>
    </>
  );
}

/** A GitHub issue/PR at the door: give it to someone or send it away. */
export function VisitorModal() {
  const visitor = useOffice(s => s.visitors.find(v => v.id === s.visitorId));
  const agents = useOffice(s => s.agents);
  const { acceptVisitor, rejectVisitor } = useActions();
  const t = useT();
  const list = useMemo(() => Object.values(agents).sort((a, b) => (a.hiredAt || 0) - (b.hiredAt || 0)), [agents]);
  const [agentId, setAgentId] = useState(() => pmAgent(list)?.id ?? list[0]?.id ?? '');
  if (!visitor) return <div className="empty">{t('visitor.gone')}</div>;
  const v = visitor;
  return (
    <>
      <h2>{v.kind === 'pr' ? '🔀' : '🐞'} #{v.number} {v.title}</h2>
      <div className="hint">{t(v.kind === 'pr' ? 'visitor.pr' : 'visitor.issue', { author: v.author || '?' })} · <a href={v.url} target="_blank" rel="noreferrer">{t('visitor.open')}</a></div>
      {v.body.trim() && <div className="visitor-body"><Markdown text={v.body} /></div>}
      {v.status === 'waiting' ? (
        <>
          <label className="f">{t('visitor.assign')}
            <select value={agentId} onChange={e => setAgentId(e.target.value)}>
              {list.map(a => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
            </select>
          </label>
          <div className="row end">
            <button className="danger" onClick={() => rejectVisitor(v.id)}>{t('visitor.reject')}</button>
            <button className="primary" disabled={!agentId} onClick={() => acceptVisitor(v.id, agentId)}>{t('visitor.accept')}</button>
          </div>
        </>
      ) : <div className="hint">{t(v.status === 'accepted' ? 'visitor.wasAccepted' : 'visitor.wasRejected')}</div>}
    </>
  );
}

/** The CEO's emoji on a message or task; clicking one again takes it back. */
export function Reactions({ taskId, reactions = [] }: { taskId: string; reactions?: string[] }) {
  const { react } = useActions();
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span className="reactions">
      {reactions.map(e => <button key={e} type="button" className="reaction" title={t('react.remove')} onClick={() => react(taskId, e)}>{e}</button>)}
      <span className="react-pick">
        <button type="button" className="ghost sm react-add" title={t('react.add')} onClick={() => setOpen(!open)}>☺+</button>
        {open && (
          <span className="react-menu" onPointerLeave={() => setOpen(false)}>
            {REACTIONS.map(e => <button key={e} type="button" className={reactions.includes(e) ? 'on' : ''} onClick={() => { react(taskId, e); setOpen(false); }}>{e}</button>)}
          </span>
        )}
      </span>
    </span>
  );
}

export function Morale({ agentId }: { agentId: string }) {
  const morale = useOffice(s => moraleOf(s.fun, agentId));
  const t = useT();
  const level = morale >= 45 ? 'ok' : morale >= 20 ? 'low' : 'out';
  return (
    <div className={`morale ${level}`} title={t('fun.morale')}>
      <span>{moodEmoji(morale)}</span><i><b style={{ width: `${Math.round(morale)}%` }} /></i><small>{Math.round(morale)}</small>
    </div>
  );
}

export function Badges({ agentId }: { agentId: string }) {
  const tasks = useOffice(s => s.tasks);
  const t = useT();
  const badges = useMemo(() => badgesOf(Object.values(tasks).filter(x => x.agentId === agentId)), [tasks, agentId]);
  if (!badges.length) return null;
  return <div className="badges">{badges.map(b => <span key={b} title={t(`badge.${b}`)}>{BADGE_EMOJI[b]}</span>)}</div>;
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function Leaderboard() {
  const agents = useOffice(s => s.agents);
  const tasks = useOffice(s => s.tasks);
  const { select } = useActions();
  const t = useT();
  const rows = useMemo(() => leaderboard(Object.values(agents), Object.values(tasks)), [agents, tasks]);
  if (!rows.length) return <div className="leaders"><div className="empty">{t('lead.empty')}</div></div>;
  return (
    <div className="leaders">
      <table>
        <thead><tr><th>#</th><th>{t('lead.agent')}</th><th>{t('lead.done')}</th><th>{t('lead.rate')}</th><th>{t('lead.cost')}</th><th>{t('lead.badges')}</th><th>{t('lead.score')}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.agent.id} onClick={() => select(r.agent.id, true)}>
              <td>{(r.score > 0 && MEDALS[i]) || i + 1}</td>
              <td><Who id={r.agent.id} /></td>
              <td>{r.done}</td>
              <td>{r.done + r.failed ? `${Math.round(r.rate * 100)}%` : '–'}</td>
              <td>${r.cost.toFixed(2)}</td>
              <td className="badges">{r.badges.map(b => <span key={b} title={t(`badge.${b}`)}>{BADGE_EMOJI[b]}</span>)}</td>
              <td><b>{r.score}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="legend">{(Object.keys(BADGE_EMOJI) as BadgeId[]).map(b => <span key={b}>{BADGE_EMOJI[b]} {t(`badge.${b}`)}</span>)}</div>
    </div>
  );
}
