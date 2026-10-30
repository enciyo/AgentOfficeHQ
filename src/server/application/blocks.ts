// Why a queue is not starting: what the office says about a block, and the holds put on a CLI that hit a limit.
import type { Agent, ProviderHold } from '../../shared/types.ts';
import { startOfDay, type Block } from '../domain/limits.ts';
import type { Runner, StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { PresenceBoard } from './presence.ts';
import type { Translator } from './translator.ts';

export class Blocks {
  /** Budget warnings already sent today (one per cap, not one per queued task). */
  private announced = new Set<string>();

  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly runner: Runner,
    private readonly presence: PresenceBoard,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }

  /** Leaves the task queued and says why; budget caps are announced once a day. */
  hold(agent: Agent, block: Block, provider: string) {
    const p = this.presence.of(agent.id);
    p.activity = this.text(block, provider);
    p.blockedBy = block.kind;
    this.notify.agent(agent);
    // A held provider was announced when the hold began, and whoever paused the office knows
    if (block.kind === 'paused' || block.kind === 'concurrency' || block.kind === 'providerLimit' || block.kind === 'providerAuth') return;
    const chain = block.kind === 'chainTurns' || block.kind === 'chainBudget';
    const key = `${startOfDay(Date.now())}:${block.kind}:${chain ? block.rootId : block.kind === 'agentBudget' ? agent.id : ''}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
    if (chain) this.notify.log(agent.id, 'system', p.activity, null);
    this.notify.publish({ type: 'blocked', agentId: agent.id, kind: block.kind, spent: block.spent, cap: block.cap });
  }

  private text(block: Block, provider: string) {
    const label = this.runner.label(provider);
    switch (block.kind) {
      case 'paused': return this.t('blocked.paused');
      case 'chainTurns': return this.t('blocked.chainTurns', { spent: block.spent, cap: block.cap });
      case 'concurrency': return this.t('blocked.concurrency', { max: block.max });
      case 'providerLimit': return this.t('blocked.providerLimit', { label, time: this.clock(block.until) });
      case 'providerAuth': return this.t('blocked.providerAuth', { label });
      case 'minutes': return this.t('blocked.minutes', { spent: Math.round(block.spent), cap: block.cap });
      default: return this.t(`blocked.${block.kind}`, { spent: block.spent.toFixed(2), cap: block.cap.toFixed(2) });
    }
  }

  private clock(at: number) {
    const today = startOfDay(at) === startOfDay(Date.now());
    return new Date(at).toLocaleString(this.i18n.locale, { ...(today ? {} : { day: 'numeric', month: 'short' }), hour: '2-digit', minute: '2-digit' });
  }

  dropExpired() {
    const holds = this.state.providerHolds ?? {};
    const over = Object.keys(holds).filter(id => (holds[id]!.until ?? Infinity) <= Date.now());
    if (!over.length) return;
    for (const id of over) delete holds[id];
    this.changed();
  }

  private changed() {
    this.store.save();
    this.notify.publish({ type: 'providerHolds', holds: this.state.providerHolds ?? {} });
  }

  /** Whether there was a hold to lift. */
  lift(id: string) {
    if (!this.state.providerHolds?.[id]) return false;
    delete this.state.providerHolds[id];
    this.changed();
    return true;
  }

  holdProvider(agent: Agent, provider: string, until: number | null, message: string) {
    const holds = (this.state.providerHolds ??= {});
    const now = Date.now();
    const current = holds[provider];
    const held = current && (current.until ?? Infinity) > now ? current : undefined;
    if (held?.until === null && until !== null) return; // a login to fix outlasts any limit
    const hold: ProviderHold = {
      kind: until === null ? 'auth' : 'limit', since: held?.since ?? now,
      until: until === null ? null : Math.max(until, held?.until ?? 0), message: message.slice(0, 300),
    };
    holds[provider] = hold;
    this.changed();
    if (held && held.kind === hold.kind) return;
    const block: Block = hold.until === null ? { kind: 'providerAuth' } : { kind: 'providerLimit', until: hold.until };
    this.notify.log(agent.id, 'system', this.text(block, provider), null);
    this.notify.publish({ type: 'blocked', agentId: agent.id, kind: block.kind, label: this.runner.label(provider), until: hold.until });
  }
}
