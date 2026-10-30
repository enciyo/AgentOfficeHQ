import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskDiff } from '../../shared/types.ts';
import { patchLines } from '../domain/views.ts';
import { useActions, useT } from './store.tsx';

/** What a run changed: its diff with worktrees on, otherwise (or when the commits are gone) the files it wrote. */
export function TaskChanges({ task }: { task: Task }) {
  const { loadTaskDiff } = useActions();
  const t = useT();
  const reviewable = !!task.commit && !!task.baseCommit;
  const key = `${task.id}:${task.commit}`;
  const [loaded, setLoaded] = useState<{ key: string; diff: TaskDiff | null } | null>(null);
  const [showPatch, setShowPatch] = useState(false);
  useEffect(() => {
    if (!reviewable) return;
    let live = true;
    loadTaskDiff(task.id).then(diff => live && setLoaded({ key, diff: diff ?? null }));
    return () => { live = false; };
  }, [key, reviewable, task.id, loadTaskDiff]);

  const current = loaded?.key === key ? loaded : null;
  const lines = useMemo(() => (showPatch ? patchLines(current?.diff?.patch ?? '') : []), [showPatch, current]);
  if (!reviewable || (current && !current.diff)) return <WrittenFiles task={task} />;
  const diff = current?.diff;
  return (
    <>
      <div className="sec-label">{t('flow.changes')}</div>
      {!diff ? <div className="hint">{t('flow.changesLoading')}</div>
        : !diff.files.length ? <div className="hint">{t('flow.changesNone')}</div> : (
          <>
            {diff.files.map(f => (
              <div key={f.path} className="diff-file">
                <span className="st">{f.status}</span>
                <span className="path">{f.path}</span>
                {f.binary ? <span className="st">{t('flow.binary')}</span> : <><span className="plus">+{f.additions}</span><span className="minus">−{f.deletions}</span></>}
              </div>
            ))}
            {diff.truncated && <div className="hint">{t('flow.changesCut')}</div>}
            {diff.patch && <div className="row"><button className="sm" onClick={() => setShowPatch(!showPatch)}>{t(showPatch ? 'flow.patchHide' : 'flow.patchShow')}</button></div>}
            {showPatch && <div className="diff-patch">{lines.map((l, i) => <div key={i} className={l.kind}>{l.text || ' '}</div>)}</div>}
          </>
        )}
    </>
  );
}

function WrittenFiles({ task }: { task: Task }) {
  const { openOutput } = useActions();
  const t = useT();
  const own = task.files ?? [];
  const open = task.status === 'queued' || task.status === 'running';
  return (
    <>
      <div className="sec-label">{t('flow.wrote')}</div>
      {own.length ? own.map(f => <button key={f} className="file-link" onClick={() => openOutput(f)}>📄 {f}</button>)
        : <div className="hint">{t(open ? 'flow.wroteSoFar' : 'flow.wroteNone')}</div>}
    </>
  );
}
