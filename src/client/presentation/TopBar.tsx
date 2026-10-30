import { useMemo } from 'react';
import { spentToday, stats } from '../domain/views.ts';
import { FunMenu } from './Fun.tsx';
import { useActions, useOffice, useT } from './store.tsx';

export function TopBar() {
  const officeName = useOffice(s => s.office?.name);
  const agents = useOffice(s => s.agents);
  const tasks = useOffice(s => s.tasks);
  const kanbanOpen = useOffice(s => s.kanbanOpen);
  const { toggleKanban, openModal, setDrawerTab, setPaused } = useActions();
  const paused = useOffice(s => !!s.settings.paused);
  const pendingApprovals = useOffice(s => s.approvals.filter(a => a.status === 'pending').length);
  const cap = useOffice(s => s.settings.limits?.dailyBudgetUsd ?? 0);
  const t = useT();
  const { working, queued, done, cost } = useMemo(() => stats(Object.values(agents), Object.values(tasks)), [agents, tasks]);
  const today = useMemo(() => spentToday(Object.values(tasks)), [tasks]);

  return (
    <header className="topbar">
      <div className="brand"><span className="logo">▣</span><b>Agent Office</b><span className="sep">/</span><span id="office-name">{officeName}</span></div>
      <div className="stats" id="stats">
        <span className={`chip ${working ? 'live' : ''}`}><i /><b>{working}</b> {t('stats.working')}</span>
        <span className="chip"><b>{queued}</b> {t('stats.queued')}</span>
        <span className="chip"><b>{done}</b> {t('stats.done')}</span>
        <span className="chip">$<b>{cost.toFixed(2)}</b></span>
        {paused && <span className="chip paused">{t('blocked.paused')}</span>}
        {cap > 0 && (
          <span className={`chip budget ${today >= cap ? 'over' : today >= cap * 0.8 ? 'near' : ''}`} title={t('settings.dailyBudget')}>
            <i style={{ width: `${Math.min(100, (today / cap) * 100)}%` }} />${today.toFixed(2)} / ${cap.toFixed(0)} {t('top.today')}
          </span>
        )}
      </div>
      <div className="actions">
        <FunMenu />
        <button className={paused ? 'active' : ''} title={t(paused ? 'top.resumeHint' : 'top.pauseHint')} onClick={() => setPaused(!paused)}>{t(paused ? 'top.resume' : 'top.pause')}</button>
        <button className={`badged ${pendingApprovals ? 'alert' : ''}`} onClick={() => setDrawerTab('approvals')}>{t('top.approvals')}{pendingApprovals > 0 && <span className="badge">{pendingApprovals}</span>}</button>
        <button className={kanbanOpen ? 'active' : ''} onClick={() => toggleKanban()}>{t('top.tasks')}</button>
        <button className="icon" title={t('top.settings')} onClick={() => openModal('settings')}>⚙</button>
        <button className="primary" onClick={() => openModal('hire')}>{t('top.hire')}</button>
      </div>
    </header>
  );
}
