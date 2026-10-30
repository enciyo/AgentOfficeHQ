import type { BlockKind } from '../../shared/types.ts';
import type { RunHandle } from '../domain/ports.ts';

/** Ephemeral per-agent state: what it is doing right now (never persisted). */
export interface Presence { run: RunHandle | null; taskId: string | null; activity: string; timer: NodeJS.Timeout | null; blockedBy: BlockKind | null }

export class PresenceBoard {
  private readonly byAgent = new Map<string, Presence>();

  of(agentId: string): Presence {
    let p = this.byAgent.get(agentId);
    if (!p) this.byAgent.set(agentId, (p = { run: null, taskId: null, activity: '', timer: null, blockedBy: null }));
    return p;
  }

  /** Agents with a CLI process running right now. */
  running() {
    let n = 0;
    for (const p of this.byAgent.values()) if (p.run) n++;
    return n;
  }

  stopAll() {
    for (const p of this.byAgent.values()) p.run?.stop();
  }
}
