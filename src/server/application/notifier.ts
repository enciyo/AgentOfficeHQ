// Turns state changes into live events and log entries.
import type { Agent, LogEntry, LogKind, PublicAgent, Task } from '../../shared/types.ts';
import { briefEntry, capDetail } from '../domain/logs.ts';
import type { DomainEvent, LogBook, Publisher, StateStore } from '../domain/ports.ts';
import type { PresenceBoard } from './presence.ts';

export class Notifier {
  constructor(
    private readonly store: StateStore,
    private readonly presence: PresenceBoard,
    private readonly events: Publisher,
    private readonly logs: LogBook,
  ) {}

  publish(event: DomainEvent) {
    this.events.publish(event);
  }

  publicAgent(a: Agent): PublicAgent {
    const p = this.presence.of(a.id);
    const queued = this.store.state.tasks.filter(t => t.agentId === a.id && t.status === 'queued').length;
    const status = p.run ? 'working' : a.kind === 'human' && queued ? 'waiting' : 'idle';
    return { ...a, status, activity: p.activity, currentTaskId: p.taskId, queued, ...(p.blockedBy ? { blockedBy: p.blockedBy } : {}) };
  }

  agent(a: Agent) {
    this.publish({ type: 'agent', agent: this.publicAgent(a) });
  }

  task(t: Task) {
    this.publish({ type: 'task', task: t });
  }

  /** `detail` is the long form of `text`: it goes to the log on disk but not out to the live events. */
  log(agentId: string, kind: LogKind, text: unknown, taskId: string | null = null, detail?: string) {
    const entry: LogEntry = { ts: Date.now(), kind, text: String(text ?? ''), taskId, ...(detail ? { detail: capDetail(detail) } : {}) };
    this.logs.append(agentId, entry);
    this.publish({ type: 'log', agentId, entry: briefEntry(entry) });
  }
}
