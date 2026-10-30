// What each agent needs from the CEO right now. Nothing here is stored: a sign lasts as long as its cause does.
import type { Translate } from '../../shared/i18n/index.ts';
import type { Approval, ProviderHold, ProviderInfo, PublicAgent, Settings, Task } from '../../shared/types.ts';
import { formatDateTime } from './format.ts';
import { reportWait, resolvable, retryable, waitLabel } from './views.ts';

export type AttentionKind = 'approval' | 'error' | 'conflict' | 'paused' | 'limited' | 'blocked' | 'report';
/** alert: only the CEO can end it. warn: work is held back. info: it ends by itself. */
export type AttentionTone = 'alert' | 'warn' | 'info';
/** Where the way out is. */
export type AttentionTarget = 'approvals' | 'tasks' | 'settings';

export interface Attention {
  kind: AttentionKind;
  tone: AttentionTone;
  icon: string;
  text: string;
  target: AttentionTarget;
  /** The failed task behind an error or conflict sign, which can be dismissed. */
  taskId?: string;
}

export interface AttentionInput {
  tasks: Task[];
  approvals: Approval[];
  settings: Settings;
  providers: Pick<ProviderInfo, 'id' | 'label'>[];
  providerHolds: Record<string, ProviderHold>;
  /** Per agent: failures that ended up to this time were dismissed. */
  acknowledged: Record<string, number>;
}

/** The last outcome that says how the agent's work went. Cancelling says nothing, and neither does a report that went well. */
function lastOutcome(tasks: Task[]) {
  const telling = (t: Task) => t.status === 'error' || t.merge === 'conflict' || (t.status === 'done' && t.kind === 'task');
  return tasks.filter(telling).reduce<Task | null>((last, t) => (!last || (t.endedAt ?? 0) >= (last.endedAt ?? 0) ? t : last), null);
}

function failureOf(mine: Task[], all: Task[], acknowledgedAt: number, t: Translate): Attention | null {
  const last = lastOutcome(mine);
  if (!last || (last.endedAt ?? 0) <= acknowledgedAt) return null;
  if (last.status === 'error' && retryable(last, all)) {
    const reason = last.result.split('\n')[0]!.trim().slice(0, 120);
    return { kind: 'error', tone: 'alert', icon: '❌', text: reason ? `❌ ${reason}` : t('flash.error'), target: 'tasks', taskId: last.id };
  }
  if (resolvable(last, all)) return { kind: 'conflict', tone: 'alert', icon: '🔀', text: t('attention.conflict'), target: 'tasks', taskId: last.id };
  return null;
}

/** Work that is queued and not starting. A CLI's hold gets its own sign unless the server found something else first. */
function holdOf(a: PublicAgent, input: AttentionInput, t: Translate, now: number): Attention | null {
  if (a.kind === 'human' || a.status === 'working' || !a.queued) return null;
  const { settings, providers, providerHolds } = input;
  if (settings.paused) return { kind: 'paused', tone: 'warn', icon: '⏸', text: t('blocked.paused'), target: 'tasks' };
  const provider = a.provider || settings.defaultProvider;
  const hold = providerHolds[provider];
  const first = a.blockedBy && a.blockedBy !== 'providerLimit' && a.blockedBy !== 'providerAuth';
  if (hold && !first && (hold.until === null || hold.until > now)) {
    const label = providers.find(p => p.id === provider)?.label ?? provider;
    return hold.until === null
      ? { kind: 'limited', tone: 'alert', icon: '🔑', text: t('blocked.providerAuth', { label }), target: 'settings' }
      : { kind: 'limited', tone: 'warn', icon: '⏳', text: t('blocked.providerLimit', { label, time: formatDateTime(hold.until, settings.language) }), target: 'settings' };
  }
  return a.activity ? { kind: 'blocked', tone: 'warn', icon: '🚧', text: a.activity, target: 'tasks' } : null;
}

function heldReportOf(a: PublicAgent, mine: Task[], { tasks, approvals }: AttentionInput, t: Translate): Attention | null {
  const waits = mine.flatMap(task => reportWait(tasks, approvals, task) ?? []);
  const stuck = waits.find(w => !w.subtasks && !w.approvals);
  if (stuck) return { kind: 'report', tone: 'alert', icon: '⚠️', text: waitLabel(stuck, t), target: 'tasks' };
  return waits[0] && a.status !== 'working' ? { kind: 'report', tone: 'info', icon: '📨', text: waitLabel(waits[0], t), target: 'tasks' } : null;
}

/** The one thing to show per agent, most urgent first; agents with nothing to show are left out. */
export function attentionOf(agents: PublicAgent[], input: AttentionInput, t: Translate, now = Date.now()): Record<string, Attention> {
  const byAgent = new Map<string, Task[]>();
  for (const task of input.tasks) {
    const mine = byAgent.get(task.agentId);
    if (mine) mine.push(task);
    else byAgent.set(task.agentId, [task]);
  }
  const signs: Record<string, Attention> = {};
  for (const a of agents) {
    const mine = byAgent.get(a.id) ?? [];
    const asked = input.approvals.find(x => x.agentId === a.id && x.status === 'pending');
    const sign = asked
      ? { kind: 'approval', tone: 'alert', icon: '🙋', text: `🙋 ${asked.action}`, target: 'approvals' } as const
      : failureOf(mine, input.tasks, input.acknowledged[a.id] ?? 0, t) ?? holdOf(a, input, t, now) ?? heldReportOf(a, mine, input, t);
    if (sign) signs[a.id] = sign;
  }
  return signs;
}
