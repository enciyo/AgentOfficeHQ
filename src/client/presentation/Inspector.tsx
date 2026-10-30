import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PublicAgent } from '../../shared/types.ts';
import type { InspectorTab } from '../application/officeStore.ts';
import { draftOf, type AgentDraft } from '../domain/agentForm.ts';
import type { Translate } from '../../shared/i18n/index.ts';
import { formatTime, statusLabel } from '../domain/format.ts';
import { LOG_PREFIX, visibleLogEntries } from '../domain/transcript.ts';
import { tasksOf } from '../domain/views.ts';
import { AgentForm } from './AgentForm.tsx';
import { Avatar, RichText } from './common.tsx';
import { Badges, Morale } from './Fun.tsx';
import { ScheduleList } from './Schedules.tsx';
import { TaskCard } from './TaskCard.tsx';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

const tabsOf = (agent: PublicAgent, t: Translate): [InspectorTab, string][] => [
  ['tasks', t(agent.kind === 'human' ? 'insp.jobs' : 'insp.tasks')],
  ...(agent.kind === 'human' ? [] : [['log', t('insp.log')] as [InspectorTab, string]]),
  ['settings', t('insp.settings')],
];

export function Inspector() {
  const agent = useOffice(s => (s.selectedId ? s.agents[s.selectedId] : undefined));
  const tab = useOffice(s => s.tab);
  const { setTab } = useActions();
  const t = useT();
  // Humans have no run log
  const activeTab = agent?.kind === 'human' && tab === 'log' ? 'tasks' : tab;

  return (
    <aside id="inspector" className={`side right ${agent ? '' : 'hidden'}`}>
      {agent && (
        <>
          <Header agent={agent} />
          <div className="tabs" role="tablist">
            {tabsOf(agent, t).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={activeTab === id} className={activeTab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {activeTab === 'tasks' && <TaskList agent={agent} />}
          {activeTab === 'log' && <LogView agentId={agent.id} />}
          {activeTab === 'settings' && <AgentSettings key={agent.id} agent={agent} />}
          <Composer agent={agent} hidden={activeTab === 'settings'} />
        </>
      )}
    </aside>
  );
}

function Header({ agent }: { agent: PublicAgent }) {
  const { select, openAttention } = useActions();
  const sign = useOffice(s => s.attention[agent.id]);
  const t = useT();
  return (
    <div className="insp-head">
      <Avatar agent={agent} />
      <div>
        <div className="nm">{agent.name}</div>
        <div className="rl">{agent.role}{sign && agent.status === 'idle' ? '' : ` · ${statusLabel(t, agent.status)}`}{agent.totalCost ? ` · $${agent.totalCost.toFixed(3)}` : ''}</div>
        {sign && <button className="why" data-tone={sign.tone} title={sign.text} onClick={() => openAttention(agent.id)}>{sign.text}</button>}
        <div className="insp-fun"><Morale agentId={agent.id} /><Badges agentId={agent.id} /></div>
      </div>
      <button className="ghost icon x" title={t('ui.close')} onClick={() => select(null)}>✕</button>
    </div>
  );
}

function TaskList({ agent }: { agent: PublicAgent }) {
  const t = useT();
  const allTasks = useOffice(s => s.tasks);
  const tasks = useMemo(() => tasksOf(Object.values(allTasks), agent.id), [allTasks, agent.id]);
  return (
    <div className="tab-body">
      <ScheduleList agent={agent} />
      {tasks.length ? tasks.map(t => <TaskCard key={t.id} task={t} />) : (
        <div className="empty-note">{t('insp.noTasks')}<br /><RichText text={t(agent.kind === 'human' ? 'insp.noTasksHuman' : 'insp.noTasksAgent')} /></div>
      )}
    </div>
  );
}

function LogView({ agentId }: { agentId: string }) {
  const t = useT();
  const locale = useLocale();
  const entries = useOffice(s => s.logs[agentId]);
  const visibleEntries = useMemo(() => visibleLogEntries(entries ?? []), [entries]);
  const { loadLogs } = useActions();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { loadLogs(agentId); }, [agentId, loadLogs]);

  // Follow new entries only while the reader is near the bottom
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = body.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries?.length]);

  return (
    <div className="tab-body" ref={body} onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      {entries && !visibleEntries.length ? <div className="empty-note">{t('insp.noLog')}</div> : (
        <div className="log">
          {visibleEntries.map((e, i) => <div key={i} className={`e ${e.kind}`}><span className="ts">{formatTime(e.ts, locale)}</span>{LOG_PREFIX[e.kind] ?? ''}{e.text}</div>)}
        </div>
      )}
    </div>
  );
}

function AgentSettings({ agent }: { agent: PublicAgent }) {
  const { saveAgent, resetMemory, fire } = useActions();
  const t = useT();
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent));
  const remove = () => { if (confirm(t('insp.fireConfirm', { name: agent.name }))) fire(agent.id); };
  return (
    <div className="tab-body">
      <form className="tab-form" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={e => { e.preventDefault(); saveAgent(agent.id, draft); }}>
        <AgentForm draft={draft} onChange={setDraft} isNew={false} />
        <div className="row end"><button className="primary sm" type="submit">{t('ui.save')}</button></div>
        <div className="sec-label">{t('insp.other')}</div>
        {agent.kind === 'agent' && (
          <>
            <div className="hint"><RichText text={t('insp.session', { id: agent.sessionId || t('insp.sessionNone') })} /></div>
            <button type="button" onClick={() => resetMemory(agent.id)}>{t('insp.reset')}</button>
          </>
        )}
        <button type="button" className="danger" onClick={remove}>{t('insp.fire')}</button>
      </form>
    </div>
  );
}

function Composer({ agent, hidden }: { agent: PublicAgent; hidden: boolean }) {
  const { assign, stopAgent } = useActions();
  const t = useT();
  const focusToken = useOffice(s => s.composerFocus);
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusToken) setTimeout(() => input.current?.focus(), 30); }, [focusToken]);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt) return;
    if (await assign(agent.id, prompt)) { setText(''); input.current?.blur(); }
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };

  return (
    <div className={`composer ${hidden ? 'hidden' : ''}`}>
      <textarea ref={input} value={text} onChange={e => setText(e.target.value)} onKeyDown={onKey} placeholder={t('insp.composer', { name: agent.name })} />
      <div className="row end">
        {agent.status === 'working' && <button className="danger sm" onClick={() => stopAgent(agent.id)}>{t('insp.stop')}</button>}
        <button className="primary sm" onClick={send}>{t('insp.assign')}</button>
      </div>
    </div>
  );
}
