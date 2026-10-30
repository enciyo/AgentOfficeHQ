import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DrawerTab } from '../application/officeStore.ts';
import type { OutputFile } from '../application/ports.ts';
import type { TKey } from '../../shared/i18n/index.ts';
import type { Approval } from '../../shared/types.ts';
import { formatBytes, formatDateTime, formatDuration, formatTime, taskStatusLabel } from '../domain/format.ts';
import { chainActive, chainFiles, costBreakdown, fileOwners, fileTree, filterTrees, kanbanColumns, taskCostText, taskTrees, treeCostText, type FileNode, type FlowFilter, type TaskNode } from '../domain/views.ts';
import { CopyButton, Markdown, Who } from './common.tsx';
import { Leaderboard } from './Fun.tsx';
import { KnowledgeTab } from './Knowledge.tsx';
import { ChainHold, HeldReport, MergeNotice, MergePill, RetryButton, TaskCard } from './TaskCard.tsx';
import { TaskChanges } from './TaskChanges.tsx';
import { TaskTranscript } from './TaskTranscript.tsx';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

const TABS: [DrawerTab, `drawer.${DrawerTab}`][] = [['board', 'drawer.board'], ['flow', 'drawer.flow'], ['activity', 'drawer.activity'], ['files', 'drawer.files'], ['approvals', 'drawer.approvals'], ['knowledge', 'drawer.knowledge'], ['leaders', 'drawer.leaders']];

/** Bottom drawer: kanban board, delegation flow with spend, and the files agents produced. */
export function Drawer() {
  const open = useOffice(s => s.kanbanOpen);
  const tab = useOffice(s => s.drawerTab);
  const full = useOffice(s => s.drawerFull);
  const { toggleKanban, setDrawerTab, setDrawerFull } = useActions();
  const pending = useOffice(s => s.approvals.filter(a => a.status === 'pending').length);
  const t = useT();
  return (
    <section id="kanban" className={`drawer ${open ? '' : 'hidden'} ${full ? 'fullscreen' : ''}`}>
      <div className="drawer-head">
        <div className="seg" role="tablist">
          {TABS.map(([id, key]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setDrawerTab(id)}>{t(key)}{id === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}</button>)}
        </div>
        <div className="drawer-tools">
          <button className="sm" title={t(full ? 'files.exitFullscreenHint' : 'files.fullscreen')} onClick={() => setDrawerFull(!full)}>{t(full ? 'files.exitFullscreen' : 'files.fullscreen')}</button>
          <button className="icon" title={t('ui.close')} aria-label={t('ui.close')} onClick={() => toggleKanban(false)}>✕</button>
        </div>
      </div>
      {open && tab === 'board' && <Board />}
      {open && tab === 'flow' && <Flow />}
      {open && tab === 'activity' && <Activity />}
      {open && tab === 'files' && <Files />}
      {open && tab === 'approvals' && <ApprovalsTab />}
      {open && tab === 'knowledge' && <KnowledgeTab />}
      {open && tab === 'leaders' && <Leaderboard />}
    </section>
  );
}

const ActorChip = ({ actor }: { actor: { name: string; color?: string } }) =>
  actor.color ? <span className="who"><i style={{ background: actor.color }} />{actor.name}</span> : <b>{actor.name}</b>;

function Activity() {
  const feed = useOffice(s => s.feed);
  const t = useT();
  const locale = useLocale();
  if (!feed.length) return <div className="empty">{t('drawer.activityEmpty')}</div>;
  return (
    <div id="feed" className="feed">
      {feed.map(item => (
        <div key={item.id}>
          <span className="ts">{formatTime(item.ts, locale)}</span>{' '}
          {item.actors.map((a, i) => <span key={i}>{i > 0 && ' → '}<ActorChip actor={a} /></span>)} {item.text}
        </div>
      ))}
    </div>
  );
}

function Board() {
  const tasks = useOffice(s => s.tasks);
  const t = useT();
  const columns = useMemo(() => kanbanColumns(Object.values(tasks), t), [tasks, t]);
  return (
    <div className="columns" id="kanban-cols">
      {columns.map(c => (
        <div className="col" key={c.title}>
          <h3><span>{c.title}</span><span>{c.tasks.length}</span></h3>
          <div className="cards">
            {c.tasks.length ? c.tasks.slice(0, 60).map(t => <TaskCard key={t.id} task={t} showAgent />) : <div className="empty">{t('kanban.empty')}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- flow: delegation chains, what each step did and wrote, and spend

const FLOW_FILTERS: [FlowFilter, TKey][] = [['all', 'flow.fAll'], ['active', 'flow.fActive'], ['done', 'flow.fDone'], ['failed', 'flow.fFailed']];

function Flow() {
  const tasks = useOffice(s => s.tasks);
  const agents = useOffice(s => s.agents);
  const selected = useOffice(s => s.flowTaskId);
  const hidden = useOffice(s => s.flowHidden);
  const { showTask, restoreFlow } = useActions();
  const t = useT();
  const [filter, setFilter] = useState<FlowFilter>('all');
  const [query, setQuery] = useState('');
  const all = useMemo(() => Object.values(tasks), [tasks]);
  const allTrees = useMemo(() => taskTrees(all), [all]);
  const hiddenRoots = useMemo(() => new Set(hidden), [hidden]);
  const nameOf = useCallback((id: string) => agents[id]?.name ?? '', [agents]);
  const visibleTrees = useMemo(() => allTrees.filter(n => !hiddenRoots.has(n.task.id) || (!!selected && (n.task.id === selected || containsTask(n, selected)))), [allTrees, hiddenRoots, selected]);
  const trees = useMemo(() => filterTrees(visibleTrees, filter, query, nameOf), [visibleTrees, filter, query, nameOf]);
  const shown = trees.slice(0, FLOW_LIMIT);
  const hasVisibleRoots = allTrees.some(n => !hiddenRoots.has(n.task.id));
  return (
    <div className="flow">
      <div className="flow-trees">
        <div className="flow-bar">
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('flow.search')} />
          <div className="seg">{FLOW_FILTERS.map(([id, key]) => <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{t(key)}</button>)}</div>
          <div className="flow-actions">
            {hidden.length > 0 && <button className="sm" title={t('flow.restoreHint')} onClick={restoreFlow}>{t('flow.restore')}</button>}
          </div>
        </div>
        {shown.length ? shown.map(n => <ChainNode key={n.task.id} node={n} root selected={selected} />) : <div className="empty">{t(!all.length ? 'flow.empty' : !hasVisibleRoots ? 'flow.hiddenEmpty' : 'flow.noMatch')}</div>}
        {trees.length > FLOW_LIMIT && <div className="hint">{t('flow.more', { n: trees.length - FLOW_LIMIT })}</div>}
      </div>
      <aside className="flow-side">
        {selected && tasks[selected] ? <TaskDetail taskId={selected} onBack={() => showTask(null)} /> : <Spend />}
      </aside>
    </div>
  );
}
const FLOW_LIMIT = 40;

function Spend() {
  const tasks = useOffice(s => s.tasks);
  const agents = useOffice(s => s.agents);
  const t = useT();
  const spend = useMemo(() => costBreakdown(Object.values(agents), Object.values(tasks), t), [agents, tasks, t]);
  const max = Math.max(...spend.agents.map(r => r.cost), 0.0001);
  return (
    <div className="flow-cost">
      <div className="hint">{t('flow.pickHint')}</div>
      <div className="sec-label">{t('flow.total')}</div>
      <div className="big">${spend.total.toFixed(2)}</div>
      {spend.unknown > 0 && <div className="hint">{t('flow.unknownCost', { n: spend.unknown })}</div>}
      <div className="sec-label">{t('flow.byTeam')}</div>
      {spend.teams.map(r => <div key={r.key} className="cost-row"><span>{r.label}</span><b>${r.cost.toFixed(2)}</b></div>)}
      <div className="sec-label">{t('flow.byAgent')}</div>
      {spend.agents.map(r => (
        <div key={r.key} className="cost-row bar">
          <i style={{ width: `${(r.cost / max) * 100}%`, background: r.color }} />
          <span>{r.label} <small>{t('flow.tasks', { n: r.tasks })}</small></span><b>${r.cost.toFixed(2)}</b>
        </div>
      ))}
    </div>
  );
}

function ChainNode({ node, root = false, selected }: { node: TaskNode; root?: boolean; selected: string | null }) {
  const t = useT();
  const locale = useLocale();
  const tasks = useOffice(s => s.tasks);
  const { showTask, showOutputs, cancelChain, clearFlow } = useActions();
  const { task, children } = node;
  // A step picked from elsewhere (e.g. a file's author) is revealed inside its chain
  const holdsSelected = useMemo(() => !!selected && selected !== task.id && containsTask(node, selected), [node, selected, task.id]);
  const [open, setOpen] = useState((root && node.open) || holdsSelected);
  useEffect(() => { if (holdsSelected) setOpen(true); }, [holdsSelected]);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected === task.id) rowRef.current?.scrollIntoView({ block: 'nearest' }); }, [selected, task.id]);
  const files = useMemo(() => chainFiles(Object.values(tasks), task.id), [tasks, task.id]);
  const took = node.end ? formatDuration(node.end - node.start) : t('flow.running');
  return (
    <div className={`chain ${root ? 'root' : ''}`}>
      <div ref={rowRef} className={`chain-row ${selected === task.id ? 'on' : ''}`} role="button" tabIndex={0}
        onClick={() => showTask(task.id)} onKeyDown={e => e.key === 'Enter' && showTask(task.id)}>
        <button type="button" className="tw" disabled={!children.length} title={t(open ? 'flow.collapse' : 'flow.expand')}
          onClick={e => { e.stopPropagation(); setOpen(!open); }}>{children.length ? (open ? '▾' : '▸') : '·'}</button>
        <Who id={task.agentId} />
        {task.kind === 'report' && <span className="kind">{t('task.report')}</span>}
        <span className="pr">{task.prompt.replace(/\s+/g, ' ').slice(0, 140)}</span>
        {files.length > 0 && (
          <button type="button" className="files-chip" title={t('flow.openFiles')}
            onClick={e => { e.stopPropagation(); showOutputs(t('files.ofTask', { id: task.id }), files); }}>📄 {files.length}</button>
        )}
        {root && chainActive(node) && (
          <button type="button" className="danger sm" onClick={e => { e.stopPropagation(); if (confirm(t('task.cancelChainConfirm'))) cancelChain(task.id); }}>{t('task.cancelChain')}</button>
        )}
        {root && !chainActive(node) && (
          <button type="button" className="ghost sm flow-clear" title={t('flow.clearOneHint')} onClick={e => { e.stopPropagation(); clearFlow([task.id]); }}>{t('flow.clearOne')}</button>
        )}
        <MergePill task={task} />
        <span className={`pill ${task.status}`}>{taskStatusLabel(t, task.status)}</span>
        <span className="meta">{root && `${formatDateTime(task.createdAt, locale)} · `}{[took, treeCostText(node, t)].filter(Boolean).join(' · ')}</span>
      </div>
      {open && children.length > 0 && <div className="chain-kids">{children.map(c => <ChainNode key={c.task.id} node={c} selected={selected} />)}</div>}
    </div>
  );
}

const containsTask = (n: TaskNode, id: string): boolean => n.children.some(c => c.task.id === id || containsTask(c, id));

/** One step of a chain: what was asked, what came back, what it wrote. */
function TaskDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const task = useOffice(s => s.tasks[taskId])!;
  const tasks = useOffice(s => s.tasks);
  const { showOutputs, select, cancelTask, cancelChain } = useActions();
  const t = useT();
  const locale = useLocale();
  const chain = useMemo(() => chainFiles(Object.values(tasks), task.id), [tasks, task.id]);
  const open = task.status === 'queued' || task.status === 'running';
  const hasKids = useMemo(() => Object.values(tasks).some(x => x.parentId === task.id), [tasks, task.id]);
  const took = task.startedAt && task.endedAt ? formatDuration(task.endedAt - task.startedAt) : '';
  return (
    <div className="task-detail">
      <div className="td-head">
        <button className="ghost sm" onClick={onBack}>{t('flow.back')}</button>
        <span className="pills"><MergePill task={task} /><span className={`pill ${task.status}`}>{taskStatusLabel(t, task.status)}</span></span>
      </div>
      <div className="td-who">
        <Who id={task.agentId} /> <span className="meta">#{task.id} · {formatDateTime(task.createdAt, locale)}{[took, taskCostText(task, t)].filter(Boolean).map(s => ` · ${s}`).join('')}</span>
      </div>
      <div className="td-actions">
        {chain.length > 0 && <button className="primary sm" onClick={() => showOutputs(t('files.ofTask', { id: task.id }), chain)}>{t('flow.openFiles')} ({chain.length})</button>}
        <button className="sm" onClick={() => select(task.agentId, true)}>{t('flow.openAgent')}</button>
        <RetryButton task={task} />
        {open && <button className="danger sm" onClick={() => cancelTask(task.id)}>{t('task.cancel')}</button>}
        {open && hasKids && <button className="danger sm" onClick={() => confirm(t('task.cancelChainConfirm')) && cancelChain(task.id)}>{t('task.cancelChain')}</button>}
      </div>
      <MergeNotice task={task} detailed />
      {task.awaiting && <HeldReport task={task} />}
      {task.status === 'queued' && <ChainHold task={task} />}
      <div className="sec-label">{t('flow.asked')}</div>
      <div className="td-text">{task.prompt}</div>
      {task.result && <><div className="sec-label">{t('flow.answer')}</div><div className="td-text doc"><Markdown text={task.result} /></div></>}
      <TaskChanges task={task} />
      <TaskTranscript key={task.id} taskId={task.id} status={task.status} />
    </div>
  );
}

// ---- files: what the agents wrote in the shared working directory

const PREVIEWABLE = /\.(html?|svg|png|jpe?g|gif|webp|pdf)$/i;
const IMAGE = /\.(svg|png|jpe?g|gif|webp)$/i;

function Files() {
  const { listFiles, readFile, deleteFile, fileUrl, clearOutputsFocus, openOutput, showTask } = useActions();
  const t = useT();
  const locale = useLocale();
  const focus = useOffice(s => s.outputsFocus);
  const currentPath = useOffice(s => s.outputPath);
  const version = useOffice(s => s.filesVersion);
  const tasks = useOffice(s => s.tasks);
  const doneCount = useMemo(() => Object.values(tasks).filter(x => x.status === 'done').length, [tasks]);
  const owners = useMemo(() => fileOwners(Object.values(tasks)), [tasks]);
  const [list, setList] = useState<{ root: string; files: OutputFile[] } | null>(null);
  const [filter, setFilter] = useState('');
  const [current, setCurrent] = useState<{ path: string; text: string; truncated: boolean; binary: boolean } | null>(null);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [full, setFull] = useState(false);
  const fullscreen = full && !!current;

  // While it covers the office, keys belong to the reader: Esc leaves full screen only, and nothing walks the player
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') setFull(false);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [fullscreen]);

  const refresh = useCallback(() => { listFiles().then(r => r && setList(r)); }, [listFiles]);
  // New results usually mean new files
  useEffect(refresh, [doneCount, version, refresh]);
  useEffect(() => {
    if (!currentPath) return setCurrent(null);
    let live = true;
    readFile(currentPath).then(f => live && setCurrent(f ?? null));
    return () => { live = false; };
  }, [currentPath, version, readFile]);

  const present = useMemo(() => new Set(list?.files.map(f => f.path)), [list]);
  const visible = useMemo(() => {
    const files = list?.files ?? [];
    const scoped = focus ? files.filter(f => focus.paths.includes(f.path)) : files;
    return scoped.filter(f => f.path.toLowerCase().includes(filter.toLowerCase()));
  }, [list, focus, filter]);
  const tree = useMemo(() => fileTree(visible), [visible]);
  const recent = useMemo(() => (focus || filter ? [] : (list?.files ?? []).slice(0, 6)), [list, focus, filter]);
  const missing = focus ? focus.paths.filter(p => list && !present.has(p)).length : 0;

  const remove = async (path: string, dir: boolean) => {
    if (!confirm(t(dir ? 'files.confirmDir' : 'files.confirm', { path }))) return;
    if (await deleteFile(path)) refresh();
  };

  const owner = current && owners.get(current.path);
  const canPreview = !!current && PREVIEWABLE.test(current.path);
  const isMd = !!current && /\.(md|markdown|txt)$/i.test(current.path);
  return (
    <div className="files">
      <div className="files-side">
        <div className="files-bar">
          <input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('files.filter')} />
          <button className="sm" onClick={refresh}>{t('files.refresh')}</button>
        </div>
        {focus ? (
          <div className="files-focus">
            <span>🔎 {focus.title} · {visible.length}{missing > 0 && ` · ${t('files.missing', { n: missing })}`}</span>
            <button className="icon ghost" title={t('files.showAll')} onClick={clearOutputsFocus}>✕</button>
          </div>
        ) : <div className="files-root" title={list?.root}>{list?.root}</div>}
        <div className="files-tree">
          {list && !visible.length && <div className="empty">{t(focus ? 'files.focusEmpty' : 'files.empty')}</div>}
          {recent.length > 0 && (
            <div className="recent">
              {recent.map(f => <button key={f.path} className={current?.path === f.path ? 'on' : ''} onClick={() => openOutput(f.path)}>🕑 {f.path} <small>{formatDateTime(f.mtime, locale)}</small></button>)}
            </div>
          )}
          {tree.map(n => <FileRow key={n.path} node={n} depth={0} current={current?.path} onPick={openOutput} onDelete={remove} forceOpen={!!filter || !!focus} />)}
        </div>
      </div>
      <div className={`files-view${fullscreen ? ' fullscreen' : ''}`}>
        {!current ? <div className="empty">{t(currentPath ? 'files.gone' : 'files.pick')}</div> : (
          <>
            <div className="files-head">
              <div className="files-path" title={current.path}>{current.path}</div>
              {owner && <button className="ghost sm owner" title={t('files.ownerHint')} onClick={() => showTask(owner.id)}>✍️ <Who id={owner.agentId} /> #{owner.id}</button>}
              <div className="files-actions">
                {(canPreview || isMd) && (
                  <div className="seg">
                    <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>{t('files.preview')}</button>
                    <button className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')}>{t('files.source')}</button>
                  </div>
                )}
                {(canPreview || !current.binary) && <button className="sm" title={t(fullscreen ? 'files.exitFullscreenHint' : 'files.fullscreen')} onClick={() => setFull(!fullscreen)}>{t(fullscreen ? 'files.exitFullscreen' : 'files.fullscreen')}</button>}
                {canPreview && <a className="button-link sm" href={fileUrl(current.path)} target="_blank" rel="noreferrer">{t('files.newTab')}</a>}
                <a className="button-link sm" href={fileUrl(current.path, true)} download>{t('files.download')}</a>
                <CopyButton text={current.path} className="sm" />
                <button className="danger sm" onClick={() => remove(current.path, false)}>{t('files.delete')}</button>
              </div>
            </div>
            {current.truncated && mode === 'source' && <div className="hint">{t('files.truncated')}</div>}
            {mode === 'preview' && canPreview ? (
              IMAGE.test(current.path)
                ? <div className="files-img"><img src={fileUrl(current.path)} alt={current.path} /></div>
                // Agent-written pages run sandboxed (also enforced by the server's CSP header)
                : <iframe className="files-frame" title={current.path} src={fileUrl(current.path)} sandbox="allow-scripts allow-forms allow-popups" />
            ) : current.binary ? <div className="empty">{t('files.binary')}</div>
              : mode === 'preview' && isMd ? <div className="doc"><Markdown text={current.text} /></div>
              : <pre className="code">{current.text}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({ node, depth, current, onPick, onDelete, forceOpen }: { node: FileNode; depth: number; current?: string; onPick: (p: string) => void; onDelete: (p: string, dir: boolean) => void; forceOpen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(depth < 1);
  const expanded = open || forceOpen;
  const del = <span className="row-del" role="button" aria-label={t('files.delete')} title={t('files.delete')} onClick={e => { e.stopPropagation(); onDelete(node.path, node.dir); }}>🗑</span>;
  if (!node.dir) {
    return <button className={`file ${current === node.path ? 'on' : ''}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onPick(node.path)}><span className="nm">{node.name}</span><small>{formatBytes(node.size)}</small>{del}</button>;
  }
  return (
    <>
      <button className="file dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setOpen(!open)}><span className="nm">{expanded ? '▾' : '▸'} {node.name}</span>{del}</button>
      {expanded && node.children.map(c => <FileRow key={c.path} node={c} depth={depth + 1} current={current} onPick={onPick} onDelete={onDelete} forceOpen={forceOpen} />)}
    </>
  );
}

// ---- approvals: agents asking before risky steps

function ApprovalsTab() {
  const all = useOffice(s => s.approvals);
  const t = useT();
  const pending = useMemo(() => all.filter(a => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt), [all]);
  const decided = useMemo(() => all.filter(a => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 30), [all]);
  return (
    <div className="approvals">
      <div className="sec-label">{t('appr.pending')} · {pending.length}</div>
      {pending.length ? pending.map(a => <ApprovalCard key={a.id} approval={a} />) : <div className="empty">{t('appr.empty')}</div>}
      {decided.length > 0 && <div className="sec-label">{t('appr.history')}</div>}
      {decided.map(a => <ApprovalCard key={a.id} approval={a} />)}
    </div>
  );
}

function ApprovalCard({ approval: a }: { approval: Approval }) {
  const { decide, showTask } = useActions();
  const t = useT();
  const locale = useLocale();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (approve: boolean) => { setBusy(true); await decide(a.id, approve, note); setBusy(false); };
  return (
    <div className={`appr ${a.status}`}>
      <div className="appr-head">
        <Who id={a.agentId} />
        <span className="meta">{formatDateTime(a.createdAt, locale)}{a.taskId ? ` · #${a.taskId}` : ''}</span>
        {a.status !== 'pending' && <span className={`pill ${a.status === 'approved' ? 'done' : 'error'}`}>{t(a.status === 'approved' ? 'appr.approved' : 'appr.rejected')}</span>}
      </div>
      <div className="appr-action">{a.action}</div>
      {a.details && <div className="appr-details"><Markdown text={a.details} /></div>}
      {a.kind === 'merge' && a.taskId && <div className="row"><button className="sm" onClick={() => showTask(a.taskId)}>{t('appr.showChanges')}</button></div>}
      {a.status === 'pending' ? (
        <div className="appr-actions">
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder={t('appr.notePh')} />
          <button className="danger sm" disabled={busy} onClick={() => answer(false)}>{t('appr.reject')}</button>
          <button className="primary sm" disabled={busy} onClick={() => answer(true)}>{t('appr.approve')}</button>
        </div>
      ) : a.note && <div className="appr-note">“{a.note}”</div>}
    </div>
  );
}
