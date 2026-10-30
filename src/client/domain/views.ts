// Pure derivations of what the UI shows, from the raw state.
import type { Locale, TKey, Translate } from '../../shared/i18n/index.ts';
import { teamColors } from '../../shared/layout.ts';
import type { ChainBlock } from '../../shared/chain.ts';
import type { Approval, Office, ProviderHold, ProviderInfo, PublicAgent, Task } from '../../shared/types.ts';
import { formatDateTime } from './format.ts';

export const pmAgent = (agents: PublicAgent[]) =>
  agents.find(a => a.name === 'Product Manager') || agents.find(a => a.role === 'Product Manager');

export interface TeamGroup { name: string | null; dot?: string; members: PublicAgent[] }

/** Members ordered by hire time. With teams, grouped by team (color matches the room floor); teamless last. */
export function teamGroups(agents: PublicAgent[], t: Translate): TeamGroup[] {
  const sorted = [...agents].sort((a, b) => (a.hiredAt || 0) - (b.hiredAt || 0));
  const colors = teamColors(sorted);
  if (!colors.size) return [{ name: null, members: sorted }];
  const inTeam = (name: string) => sorted.filter(a => a.team.trim() === name);
  const groups = [...new Set(sorted.map(a => a.team.trim()).filter(Boolean))].map(name => ({ name, dot: colors.get(name)!.dot, members: inTeam(name) }));
  const rest = sorted.filter(a => !a.team.trim());
  return rest.length ? [...groups, { name: t('side.noTeam'), dot: 'var(--faint)', members: rest }] : groups;
}

export function stats(agents: PublicAgent[], tasks: Task[]) {
  return {
    working: agents.filter(a => a.status === 'working').length,
    queued: tasks.filter(t => t.status === 'queued').length,
    done: tasks.filter(t => t.status === 'done' && t.kind !== 'report').length,
    cost: agents.reduce((sum, a) => sum + (a.totalCost || 0), 0),
  };
}

export const zonesOf = (office: Office | null) =>
  (office?.items ?? []).filter(i => i.type === 'zone').map(i => ({ id: i.id!, label: i.label ?? '', tint: i.tint ?? '' }));

export const tasksOf = (tasks: Task[], agentId: string) => tasks.filter(t => t.agentId === agentId).sort((a, b) => b.createdAt - a.createdAt);

const KANBAN_COLUMNS: [TKey, (task: Task) => boolean][] = [
  ['kanban.queued', task => task.status === 'queued'],
  ['kanban.running', task => task.status === 'running'],
  ['kanban.done', task => task.status === 'done'],
  ['kanban.failed', task => task.status === 'error' || task.status === 'cancelled'],
];

export function kanbanColumns(tasks: Task[], t: Translate) {
  const visible = tasks.filter(t => t.kind !== 'report').sort((a, b) => b.createdAt - a.createdAt);
  return KANBAN_COLUMNS.map(([title, match]) => ({ title: t(title), tasks: visible.filter(match) }));
}

export interface ChatItem { ts: number; kind: 'me' | 'pm' | 'err' | 'sys'; text: string; ctx?: string; /** Prompt of a failed task, so the CEO can resend it. */ retry?: string; /** The task a reply belongs to (reactions go there). */ taskId?: string; reactions?: string[] }

/** Chat stream: tasks the CEO gave the PM, the PM's reply each turn, and tasks the PM gave to teams. */
export function chatItems(pm: PublicAgent, tasks: Task[], nameOf: (id: string) => string, t: Translate): ChatItem[] {
  const items: ChatItem[] = [];
  for (const task of tasks) {
    if (task.agentId === pm.id && task.from === 'user') items.push({ ts: task.createdAt, kind: 'me', text: task.prompt });
    if (task.agentId === pm.id && (task.status === 'done' || task.status === 'error') && task.result) {
      items.push({ ts: task.endedAt ?? task.createdAt, kind: task.status === 'error' ? 'err' : 'pm', text: task.result, taskId: task.id, reactions: task.reactions ?? [], ctx: task.kind === 'report' ? t('chat.report', { name: nameOf(task.from) }) : '', ...(task.status === 'error' && task.from === 'user' ? { retry: task.prompt } : {}) });
    }
    if (task.from === pm.id && task.kind === 'task') items.push({ ts: task.createdAt, kind: 'sys', text: t('chat.assigned', { name: nameOf(task.agentId) }) });
  }
  return items.sort((a, b) => a.ts - b.ts);
}

/** A failed task can run again until a retry of it is open or over; a cancelled retry leaves it failed. */
export const retryable = (task: Task, tasks: Task[]) => task.status === 'error' && !tasks.some(x => x.retryOf === task.id && x.status !== 'cancelled');

/** A conflict can go to its agent until a resolver of it is open. */
export const resolvable = (task: Task, tasks: Task[]) => task.merge === 'conflict' && !tasks.some(x => x.resolves === task.id && (x.status === 'queued' || x.status === 'running'));

/** The merge outcomes worth a badge; nothing for work that needed no merge. */
export const mergeBadge = (task: Task) => (task.merge && task.merge !== 'unchanged' ? { label: `merge.${task.merge}` as const, tone: task.merge === 'merged' ? 'done' : task.merge === 'pending' ? 'queued' : 'error' } : null);

export type PatchLineKind = 'add' | 'del' | 'hunk' | 'file' | 'context';
export interface PatchLine { kind: PatchLineKind; text: string }

/** A unified diff line by line. The headers of a file come before its first hunk, so `---`/`+++` in a hunk stay changes. */
export function patchLines(patch: string): PatchLine[] {
  let inHunk = false;
  return (patch ? patch.split('\n') : []).map((text) => {
    if (text.startsWith('diff --git ')) inHunk = false;
    if (text.startsWith('@@')) { inHunk = true; return { kind: 'hunk', text }; }
    if (!inHunk) return { kind: 'file', text };
    return { kind: text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'context', text };
  });
}

export function chainHoldLabel({ kind, spent, cap }: Pick<ChainBlock, 'kind' | 'spent' | 'cap'>, t: Translate) {
  return kind === 'chainTurns' ? t('blocked.chainTurns', { spent, cap }) : t('blocked.chainBudget', { spent: spent.toFixed(2), cap: cap.toFixed(2) });
}

export const unreadCount = (items: ChatItem[], seenAt: number) => items.filter(m => (m.kind === 'pm' || m.kind === 'err') && m.ts > seenAt).length;

/** A closed run whose CLI reported nothing. Open work can still report a cost. */
export const costUnknown = (task: Task) => task.cost === null && task.status !== 'queued' && task.status !== 'running';

/** The cost shown for one task: unknown says so, a real $0 shows, and work that never ran shows nothing. */
export function taskCostText(task: Task, t: Translate, digits = 3) {
  if (costUnknown(task)) return t('cost.unknown');
  if (task.cost === null || (!task.cost && task.startedAt === null)) return '';
  return `$${task.cost.toFixed(digits)}`;
}

export interface TaskNode { task: Task; children: TaskNode[]; cost: number; unknown: boolean; start: number; end: number | null; open: boolean }

/** The cost shown for a chain: its sum is only a floor once a task in it has an unknown cost. */
export function treeCostText({ cost, unknown }: TaskNode, t: Translate) {
  if (unknown) return cost ? t('cost.partial', { cost: cost.toFixed(2) }) : t('cost.unknown');
  return cost ? `$${cost.toFixed(2)}` : '';
}

/** Delegation trees: each task the CEO (or anyone outside the chain) gave, with everything it spawned. Newest first. */
export function taskTrees(tasks: Task[]): TaskNode[] {
  const ids = new Set(tasks.map(t => t.id));
  const kids = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId && ids.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const build = (task: Task): TaskNode => {
    const children = (kids.get(task.id) ?? []).sort((a, b) => a.createdAt - b.createdAt).map(build);
    const open = task.status === 'queued' || task.status === 'running' || children.some(c => c.open);
    const ends = [task.endedAt, ...children.map(c => c.end)];
    return {
      task, children, open,
      cost: (task.cost ?? 0) + children.reduce((s, c) => s + c.cost, 0),
      unknown: costUnknown(task) || children.some(c => c.unknown),
      start: task.startedAt ?? task.createdAt,
      end: open || ends.some(e => e === null) ? null : Math.max(...(ends as number[])),
    };
  };
  return tasks.filter(t => !t.parentId || !ids.has(t.parentId)).sort((a, b) => b.createdAt - a.createdAt).map(build);
}

/** Is there anything in this chain to cancel: open work, or a report still held? */
export const chainActive = (n: TaskNode): boolean => n.open || !!n.task.awaiting || n.children.some(chainActive);

export interface ReportWait { subtasks: number; approvals: number }

/** What a held report is waiting for, null when it is not held. Nothing at all means it is stuck. */
export function reportWait(tasks: Task[], approvals: Approval[], task: Task): ReportWait | null {
  if (!task.awaiting) return null;
  const ids = new Set([task.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) if (t.parentId && ids.has(t.parentId) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
  }
  return {
    // A report held below counts: this one goes after it, as on the server
    subtasks: tasks.filter(t => t.id !== task.id && ids.has(t.id) && (t.status === 'queued' || t.status === 'running' || t.awaiting)).length,
    approvals: approvals.filter(a => a.status === 'pending' && a.taskId && ids.has(a.taskId)).length,
  };
}

export function waitLabel({ subtasks, approvals }: ReportWait, t: Translate) {
  const parts = [
    ...(subtasks ? [t(subtasks === 1 ? 'task.waitSubtask' : 'task.waitSubtasks', { n: subtasks })] : []),
    ...(approvals ? [t(approvals === 1 ? 'task.waitApproval' : 'task.waitApprovals', { n: approvals })] : []),
  ];
  return parts.length ? t('task.waiting', { what: parts.join(', ') }) : t('task.stuck');
}

/** The line under a CLI in the settings: what its health check found. */
export function cliStatus(p: ProviderInfo, t: Translate) {
  if (p.health === 'broken') return t('settings.binBroken', { path: p.path ?? '', error: p.healthError ?? '' });
  if (!p.path) return t('settings.binMissing', { label: p.label, env: `${p.id.toUpperCase()}_BIN` });
  return p.version ? t('settings.binVersion', { path: p.path, version: p.version }) : t('settings.binOk', { path: p.path });
}

/** Why a CLI is not starting runs, for the settings. */
export const holdLabel = (hold: ProviderHold, locale: Locale, t: Translate) => hold.until === null
  ? t('settings.holdAuth', { message: hold.message })
  : t('settings.holdLimit', { time: formatDateTime(hold.until, locale), message: hold.message });

export interface CostRow { key: string; label: string; color?: string; cost: number; tasks: number }

/** Spend grouped by team and by agent, largest first (from the tasks still in memory). */
export function costBreakdown(agents: PublicAgent[], tasks: Task[], t: Translate) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const add = (rows: Map<string, CostRow>, key: string, label: string, cost: number, color?: string) => {
    const row = rows.get(key) ?? { key, label, color, cost: 0, tasks: 0 };
    row.cost += cost;
    row.tasks += 1;
    rows.set(key, row);
  };
  const teams = new Map<string, CostRow>(), people = new Map<string, CostRow>();
  for (const task of tasks) {
    if (!task.cost) continue;
    const a = byId.get(task.agentId);
    add(teams, a?.team || '-', a?.team || t('side.noTeam'), task.cost);
    add(people, task.agentId, a?.name ?? '?', task.cost, a?.color);
  }
  const sorted = (m: Map<string, CostRow>) => [...m.values()].sort((a, b) => b.cost - a.cost);
  return { total: tasks.reduce((s, x) => s + (x.cost || 0), 0), unknown: tasks.filter(costUnknown).length, teams: sorted(teams), agents: sorted(people) };
}

/** Builds a folder tree from flat file paths (folders first, then files, by name). */
export interface FileNode { name: string; path: string; dir: boolean; size: number; mtime: number; children: FileNode[] }

export function fileTree(files: { path: string; size: number; mtime: number }[]): FileNode[] {
  const root: FileNode = { name: '', path: '', dir: true, size: 0, mtime: 0, children: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((name, i) => {
      const leaf = i === parts.length - 1;
      const p = parts.slice(0, i + 1).join('/');
      let child = node.children.find(c => c.name === name && c.dir === !leaf);
      if (!child) node.children.push(child = { name, path: p, dir: !leaf, size: 0, mtime: 0, children: [] });
      child.size += f.size;
      child.mtime = Math.max(child.mtime, f.mtime);
      node = child;
    });
  }
  const order = (n: FileNode) => { n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)); n.children.forEach(order); };
  order(root);
  return root.children;
}

/** What tasks are known to have cost since local midnight, running ones included (mirrors the server's daily cap). */
export function spentToday(tasks: Task[], now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return tasks.reduce((sum, t) => ((t.endedAt ?? Infinity) >= d.getTime() ? sum + (t.cost || 0) : sum), 0);
}

export interface StandupLine { agentId: string; text: string }

/** What each agent says at the stand-up, from what the office already knows (no CLI call). */
export function standupLines(agents: PublicAgent[], tasks: Task[], t: Translate, now = Date.now()): StandupLine[] {
  const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 70);
  return [...agents].sort((a, b) => (a.hiredAt || 0) - (b.hiredAt || 0)).map(a => {
    const mine = tasks.filter(x => x.agentId === a.id && x.kind !== 'report');
    const current = mine.find(x => x.id === a.currentTaskId) ?? mine.find(x => x.status === 'running');
    const last = mine.filter(x => x.status === 'done' && (x.endedAt ?? 0) > now - 24 * 3_600_000).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))[0];
    const text = a.status === 'working' && current ? t('standup.working', { what: short(current.prompt) })
      : a.queued ? t('standup.queued', { n: a.queued })
      : last ? t('standup.done', { what: short(last.prompt) })
      : t('standup.idle');
    return { agentId: a.id, text };
  });
}

/** Largest file that can be dropped on a desk (it travels inside the task prompt). */
export const MAX_DROP_BYTES = 48 * 1024;

/** Why a dropped file cannot be given to an agent, or null when it can. */
export function dropProblem(size: number, text: string): TKey | null {
  if (size > MAX_DROP_BYTES) return 'drop.tooBig';
  if (text.includes('\u0000')) return 'drop.binary';
  return null;
}

/** Task prompt for a file dropped on an agent's desk; the content goes in as it is. */
export const dropPrompt = (name: string, text: string, t: Translate) => t('drop.prompt', { name, text });

/** Every file written anywhere in the chain under (and including) a task, first written first. */
export function chainFiles(tasks: Task[], rootId: string): string[] {
  const kids = new Map<string, Task[]>();
  for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const out = new Set<string>();
  const walk = (t: Task | undefined) => {
    if (!t) return;
    t.files?.forEach(f => out.add(f));
    (kids.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt).forEach(walk);
  };
  walk(tasks.find(t => t.id === rootId));
  return [...out];
}

/** The last task that wrote each file. */
export function fileOwners(tasks: Task[]): Map<string, Task> {
  const owners = new Map<string, Task>();
  for (const t of [...tasks].sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))) t.files?.forEach(f => owners.set(f, t));
  return owners;
}

export type FlowFilter = 'all' | 'active' | 'done' | 'failed';

/** Chains matching a status filter and a search over prompts, results, agent names and written files. */
export function filterTrees(trees: TaskNode[], filter: FlowFilter, query: string, nameOf: (id: string) => string): TaskNode[] {
  const q = query.trim().toLocaleLowerCase();
  const matches = (n: TaskNode): boolean =>
    [n.task.prompt, n.task.result, nameOf(n.task.agentId), ...(n.task.files ?? [])].some(x => x.toLocaleLowerCase().includes(q)) || n.children.some(matches);
  const failed = (n: TaskNode): boolean => n.task.status === 'error' || n.children.some(failed);
  return trees.filter(n =>
    (filter === 'all' || (filter === 'active' ? n.open : filter === 'failed' ? failed(n) : !n.open && !failed(n))) && (!q || matches(n)));
}
