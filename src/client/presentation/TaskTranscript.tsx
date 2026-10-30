import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '../../shared/types.ts';
import { formatTime } from '../domain/format.ts';
import { LOG_PREFIX, entryKey, filterEntries, kindCounts, visibleLogEntries, type KindFilter } from '../domain/transcript.ts';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

/** Everything one task did, live: the whole log of the task with a filter by kind and expandable tool calls. */
export function TaskTranscript({ taskId, status }: { taskId: string; status: string }) {
  const t = useT();
  const shown = useOffice(s => s.transcript);
  const { watchTranscript, unwatchTranscript, reloadTranscript } = useActions();
  const [kind, setKind] = useState<KindFilter>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const body = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  // A status change means the run moved on: read the log again, in case the live feed dropped something meanwhile
  useEffect(() => { watchTranscript(taskId); }, [taskId, status, watchTranscript]);
  useEffect(() => () => unwatchTranscript(taskId), [taskId, unwatchTranscript]);

  const transcript = shown?.taskId === taskId ? shown : null;
  const entries = transcript?.entries;
  const displayEntries = useMemo(() => visibleLogEntries(entries ?? []), [entries]);
  const kinds = useMemo(() => kindCounts(displayEntries), [displayEntries]);
  const visible = useMemo(() => filterEntries(displayEntries, kind), [displayEntries, kind]);
  const displayTotal = transcript ? Math.max(displayEntries.length, transcript.total - ((entries?.length ?? 0) - displayEntries.length)) : 0;

  useEffect(() => {
    const el = body.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const toggle = (entry: LogEntry) => {
    const key = entryKey(entry);
    const next = new Set(expanded);
    if (!next.delete(key)) {
      next.add(key);
      // Live entries come without their detail
      if (entry.detail === undefined) reloadTranscript(taskId);
    }
    setExpanded(next);
  };

  return (
    <>
      <div className="sec-label">{t('flow.transcript')}</div>
      {!transcript?.loaded ? <div className="hint">{t('flow.transcriptLoading')}</div>
        : !transcript.total ? <div className="hint">{t('flow.transcriptEmpty')}</div> : (
          <>
            <div className="td-kinds">
              <button className={`sm ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>{t('flow.kind.all')} {displayEntries.length}</button>
              {kinds.map(k => <button key={k.kind} className={`sm ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(k.kind)}>{t(`flow.kind.${k.kind}`)} {k.count}</button>)}
            </div>
            {displayTotal > displayEntries.length && <div className="hint">{t('flow.transcriptCut', { n: displayEntries.length, total: displayTotal })}</div>}
            <div className="td-log log" ref={body} onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
              {visible.length ? visible.map((e, i) => <Entry key={i} entry={e} open={expanded.has(entryKey(e))} onToggle={toggle} />) : <div className="hint">{t('flow.transcriptNoKind')}</div>}
            </div>
          </>
        )}
    </>
  );
}

function Entry({ entry, open, onToggle }: { entry: LogEntry; open: boolean; onToggle: (e: LogEntry) => void }) {
  const t = useT();
  const locale = useLocale();
  const line = <><span className="ts">{formatTime(entry.ts, locale)}</span>{LOG_PREFIX[entry.kind] ?? ''}{entry.text}</>;
  if (entry.detail === undefined && !entry.hasDetail) return <div className={`e ${entry.kind}`}>{line}</div>;
  return (
    <div className={`e ${entry.kind}`}>
      <button type="button" className="e-toggle" aria-expanded={open} title={t(open ? 'flow.detailHide' : 'flow.detailShow')} onClick={() => onToggle(entry)}>
        <span className="tw">{open ? '▾' : '▸'}</span>{line}
      </button>
      {open && (entry.detail === undefined ? <div className="hint">{t('flow.transcriptLoading')}</div> : <pre className="e-detail">{entry.detail}</pre>)}
    </div>
  );
}
