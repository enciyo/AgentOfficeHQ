import { useCallback, useMemo } from 'react';
import { chainJournal, journalMarkdown, STATE_ICON, stateLabel, type JournalEntry } from '../../shared/journal.ts';
import { formatDateTime } from '../domain/format.ts';
import { CopyButton, Who } from './common.tsx';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

/** A chain's handoffs in order on one screen, what needs the CEO first. `taskId` is any task of the chain. */
export function JournalView({ taskId, onClose }: { taskId: string; onClose?: () => void }) {
  const tasks = useOffice(s => s.tasks);
  const agents = useOffice(s => s.agents);
  const player = useOffice(s => s.settings.playerName);
  const t = useT();
  const journal = useMemo(() => chainJournal(Object.values(tasks), taskId), [tasks, taskId]);
  const nameOf = useCallback((id: string) => agents[id]?.name ?? (id === 'user' ? player || t('ui.you') : id), [agents, player, t]);
  const markdown = useMemo(() => (journal ? journalMarkdown(journal, nameOf, t) : ''), [journal, nameOf, t]);
  if (!journal) return null;
  return (
    <div className="task-detail journal">
      <div className="td-head">
        {onClose ? <button className="ghost sm" onClick={onClose}>{t('flow.back')}</button> : <span />}
        <span title={t('journal.copy')}><CopyButton text={markdown} className="sm" /></span>
      </div>
      <div className="journal-title">📒 {t('journal.title')}{journal.code && <code>{journal.code}</code>}</div>
      <div className="sec-label">{t('journal.needsYou')} · {journal.flagged.length}</div>
      {journal.flagged.length
        ? <div className="journal-list flagged">{journal.flagged.map(e => <EntryRow key={e.taskId} entry={e} />)}</div>
        : <div className="hint">{t('journal.allIn')}</div>}
      <div className="sec-label">{t('journal.handoffs')} · {journal.entries.length}</div>
      <ol className="journal-list">{journal.entries.map(e => <li key={e.taskId}><EntryRow entry={e} /></li>)}</ol>
    </div>
  );
}

function EntryRow({ entry: e }: { entry: JournalEntry }) {
  const { showTask, openOutput } = useActions();
  const t = useT();
  const locale = useLocale();
  return (
    <div className={`journal-entry ${e.state} ${e.flagged ? 'flag' : ''}`}>
      <button type="button" className="journal-head" onClick={() => showTask(e.taskId)}>
        <span className="ic" aria-hidden>{STATE_ICON[e.state]}</span>
        <span className="who-line"><Who id={e.from} /> → <Who id={e.to} /></span>
        {e.kind === 'report' && <span className="kind">{t('journal.report')}</span>}
        <span className="meta">#{e.taskId} · {formatDateTime(e.at, locale)}</span>
      </button>
      <div className="journal-state">{stateLabel(t, e.state)}{e.followedBy && <> · {t('journal.followedBy', { id: e.followedBy })}</>}</div>
      {e.summary && <div className="journal-sum">{e.summary}</div>}
      {(e.branch || e.repo) && (
        <div className="journal-meta">
          {e.repo && <span title={t('journal.repo')}>📁 <code>{e.repo}</code></span>}
          {e.branch && <span title={t('journal.branch')}>🌿 <code>{e.branch}</code></span>}
        </div>
      )}
      {e.files.length > 0 && (
        <div className="journal-files" title={t('journal.files')}>
          {e.files.map(f => <button key={f} type="button" className="files-chip" onClick={() => openOutput(f)}>📄 {f}</button>)}
        </div>
      )}
    </div>
  );
}
