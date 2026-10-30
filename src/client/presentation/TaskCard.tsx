import { useMemo, useState } from 'react';
import { chainBlock } from '../../shared/chain.ts';
import type { Task } from '../../shared/types.ts';
import { TASK_DRAG_TYPE } from '../application/ports.ts';
import { formatTime, taskStatusLabel } from '../domain/format.ts';
import { chainHoldLabel, mergeBadge, reportWait, resolvable, retryable, taskCostText, waitLabel } from '../domain/views.ts';
import { Who } from './common.tsx';
import { Reactions } from './Fun.tsx';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

/** Why a held report has not gone out; when nothing will ever release it, it can be sent or dropped by hand. */
export function HeldReport({ task }: { task: Task }) {
  const { cancelChain, releaseReport } = useActions();
  const t = useT();
  const tasks = useOffice(s => s.tasks);
  const approvals = useOffice(s => s.approvals);
  const wait = useMemo(() => reportWait(Object.values(tasks), approvals, task), [tasks, approvals, task]);
  if (!wait) return null;
  const stuck = !wait.subtasks && !wait.approvals;
  return (
    <div className={`held ${stuck ? 'stuck' : ''}`}>
      <span>{waitLabel(wait, t)}</span>
      <span className="row end">
        {stuck && <button className="primary sm" title={t('task.releaseHint')} onClick={() => releaseReport(task.id)}>{t('task.release')}</button>}
        <button className="sm" onClick={() => confirm(t('task.cancelChainConfirm')) && cancelChain(task.id)}>{t('task.cancelChain')}</button>
      </span>
    </div>
  );
}

/** Why a queued task waits for its chain; only raising the limit or cancelling the chain ends that. */
export function ChainHold({ task }: { task: Task }) {
  const { cancelChain } = useActions();
  const t = useT();
  const tasks = useOffice(s => s.tasks);
  const limits = useOffice(s => s.settings.limits);
  const block = useMemo(() => chainBlock(limits, Object.values(tasks), task), [limits, tasks, task]);
  if (!block) return null;
  return (
    <div className="held stuck">
      <span>{chainHoldLabel(block, t)}</span>
      <span className="row end"><button className="sm" onClick={() => confirm(t('task.cancelChainConfirm')) && cancelChain(block.rootId)}>{t('task.cancelChain')}</button></span>
    </div>
  );
}

export function RetryButton({ task }: { task: Task }) {
  const { retryTask } = useActions();
  const t = useT();
  const tasks = useOffice(s => s.tasks);
  const can = useMemo(() => retryable(task, Object.values(tasks)), [task, tasks]);
  return can ? <button className="primary sm" title={t('task.retryHint')} onClick={() => retryTask(task.id)}>{t('task.retry')}</button> : null;
}

/** Leaves a failure as it is: the sign over the agent goes, the card stays. */
function DismissSign({ task }: { task: Task }) {
  const { dismissAttention } = useActions();
  const t = useT();
  const signed = useOffice(s => s.attention[task.agentId]?.taskId === task.id);
  return signed ? <div className="row end"><button className="sm" title={t('attention.dismissHint')} onClick={() => dismissAttention(task)}>{t('attention.dismiss')}</button></div> : null;
}

export function MergePill({ task }: { task: Task }) {
  const t = useT();
  const badge = mergeBadge(task);
  return badge && <span className={`pill ${badge.tone}`}>{t(badge.label)}</span>;
}

/** A run that ended well but whose work is not in the shared checkout: why, and for a conflict the way out. */
export function MergeNotice({ task, detailed = false }: { task: Task; detailed?: boolean }) {
  const { resolveConflict } = useActions();
  const t = useT();
  const tasks = useOffice(s => s.tasks);
  const can = useMemo(() => resolvable(task, Object.values(tasks)), [task, tasks]);
  if (task.merge === 'pending') return <div className="held">{t('merge.pendingNotice')}</div>;
  if (task.merge === 'rejected') return <div className="held stuck">{t('merge.rejectedNotice')}{task.mergeNote && ` “${task.mergeNote}”`}</div>;
  if (task.merge !== 'conflict') return null;
  return (
    <>
      <div className="held stuck">
        <span>{t('merge.conflictNotice', { branch: task.branch ?? '' })}</span>
        {can && <span className="row end"><button className="primary sm" title={t('task.resolveHint')} onClick={() => resolveConflict(task.id)}>{t('task.resolve')}</button></span>}
      </div>
      {detailed && task.mergeNote && <pre className="e-detail">{task.mergeNote}</pre>}
    </>
  );
}

/** The prompt of a task that has not started yet, rewritten in place. */
function PromptEditor({ task, onClose }: { task: Task; onClose: () => void }) {
  const { editTask } = useActions();
  const t = useT();
  const [text, setText] = useState(task.prompt);
  const save = async () => { if (await editTask(task.id, text)) onClose(); };
  return (
    <>
      <textarea rows={4} value={text} autoFocus onChange={e => setText(e.target.value)} />
      <div className="row end">
        <button className="sm" onClick={onClose}>{t('ui.cancel')}</button>
        <button className="primary sm" disabled={!text.trim()} onClick={save}>{t('ui.save')}</button>
      </div>
    </>
  );
}

export function TaskCard({ task, showAgent = false }: { task: Task; showAgent?: boolean }) {
  const { completeTask, cancelTask, openPullRequest } = useActions();
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState(false);
  // It left the queue under the editor: nothing is left to save, and going back to the queue opens nothing by itself
  if (editing && task.status !== 'queued') setEditing(false);
  const t = useT();
  const locale = useLocale();
  const agentKind = useOffice(s => s.agents[task.agentId]?.kind);
  const open = task.status === 'queued' || task.status === 'running';
  // A running task stays with its agent; queued work moves, finished work is given again
  const movable = task.status !== 'running';

  const complete = () => {
    const result = prompt(t('task.completePrompt'), t('task.completedDefault'));
    if (result !== null) completeTask(task.id, result);
  };

  return (
    <div className="task-card" draggable={movable && !editing} title={movable ? t('handoff.hint') : undefined}
      onDragStart={e => { e.dataTransfer.setData(TASK_DRAG_TYPE, task.id); e.dataTransfer.effectAllowed = 'move'; }}>
      <div className="meta">
        <span>{showAgent && <><Who id={task.agentId} /> · </>}{task.kind === 'report' ? t('task.report') : '#' + task.id} · <Who id={task.from} /></span>
        <span className="pills"><MergePill task={task} /><span className={`pill ${task.status}`}>{taskStatusLabel(t, task.status)}</span></span>
      </div>
      {task.retryOf && <div className="hint">{t('task.retryOf', { id: task.retryOf })}</div>}
      {task.resolves && <div className="hint">{t('task.resolves', { id: task.resolves })}</div>}
      {editing && task.status === 'queued' ? <PromptEditor task={task} onClose={() => setEditing(false)} /> : <div className="p">{task.prompt}</div>}
      {task.result && <div className="res">{task.result}</div>}
      <MergeNotice task={task} />
      {task.awaiting && <HeldReport task={task} />}
      {task.status === 'queued' && <ChainHold task={task} />}
      {task.status === 'error' && <div className="row end"><RetryButton task={task} /></div>}
      <DismissSign task={task} />
      {task.status === 'done' && (task.pr || task.commit) && (
        <div className="row end">
          {task.pr
            ? <a className="button-link sm" href={task.pr} target="_blank" rel="noreferrer">{t('pr.view')}</a>
            : <button className="sm" disabled={opening} onClick={async () => { setOpening(true); await openPullRequest(task.id); setOpening(false); }}>{opening ? t('pr.opening') : t('pr.open')}</button>}
        </div>
      )}
      {open && (
        <div className="row end">
          {agentKind === 'human' && <button className="primary sm" onClick={complete}>{t('task.complete')}</button>}
          {task.status === 'queued' && !editing && <button className="sm" onClick={() => setEditing(true)}>{t('task.edit')}</button>}
          <button className="sm" onClick={() => cancelTask(task.id)}>{t('task.cancel')}</button>
        </div>
      )}
      {task.status !== 'queued' && <Reactions taskId={task.id} reactions={task.reactions} />}
      <div className="meta"><span>{formatTime(task.createdAt, locale)}</span><span>{taskCostText(task, t)}</span></div>
    </div>
  );
}
