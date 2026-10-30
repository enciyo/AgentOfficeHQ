// Human-in-the-loop: agents ask the CEO before risky steps; the decision comes back to them as a message.
import { randomUUID } from 'node:crypto';
import type { Approval } from '../../shared/types.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import type { StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Tasks } from './tasks.ts';
import type { Translator } from './translator.ts';

export class Approvals {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly tasks: Tasks,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }

  /** Called by the agent's `request_approval` tool while its task runs. */
  request(agentId: string, taskId: string | undefined, action: string, details: string) {
    if (!this.state.agents.some(a => a.id === agentId)) throw notFound(this.t('err.notFound'));
    if (!action.trim()) throw badRequest(this.t('err.approvalEmpty'));
    // The call of a run that is being stopped: nothing may wait on cancelled work
    if (this.state.tasks.find(t => t.id === taskId)?.status === 'cancelled') throw badRequest(this.t('err.taskClosed'));
    const approval: Approval = {
      id: randomUUID().slice(0, 8), agentId, taskId: this.state.tasks.some(t => t.id === taskId) ? taskId! : null,
      action: action.trim(), details: details.trim(), status: 'pending', note: '', createdAt: Date.now(), decidedAt: null,
    };
    this.state.approvals.push(approval);
    this.state.approvals = this.state.approvals.slice(-300);
    this.notify.log(agentId, 'system', this.t('log.approvalRequested', { action: approval.action }), approval.taskId);
    this.changed(approval);
    return approval;
  }

  /** The CEO's answer: recorded, then sent to the agent as a message under the task that asked. */
  decide(id: string, approve: boolean, note = '') {
    const approval = this.state.approvals.find(a => a.id === id);
    if (!approval) throw notFound(this.t('err.notFound'));
    if (approval.status !== 'pending') throw badRequest(this.t('err.approvalDecided'));
    approval.status = approve ? 'approved' : 'rejected';
    approval.note = note.trim();
    approval.decidedAt = Date.now();
    this.changed(approval);
    const asked = this.state.tasks.find(t => t.id === approval.taskId);
    if (approval.kind === 'merge') {
      if (asked) this.tasks.decideMerge(asked, approve, approval.note);
      return approval;
    }
    const message = this.t(approve ? 'approval.approvedMsg' : 'approval.rejectedMsg', {
      action: approval.action, note: approval.note ? this.t('approval.note', { note: approval.note }) : '',
    });
    if (this.state.agents.some(a => a.id === approval.agentId)) {
      // A report-kind message: it never reports upward itself; finishing it releases the held report of `asked`
      this.tasks.create(approval.agentId, message, { from: 'user', parentId: asked?.id ?? null, depth: asked?.depth ?? 0, kind: 'report' });
    } else if (asked) {
      this.tasks.settle(asked);
    }
    return approval;
  }

  private changed(approval: Approval) {
    this.store.save();
    this.notify.publish({ type: 'approval', approval });
  }
}
