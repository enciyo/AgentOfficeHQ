// The team's shared notes. Agents write them through `remember`; only the CEO pins, and only pinned notes enter prompts.
import { randomUUID } from 'node:crypto';
import { MAX_NOTE_CHARS, oneLine } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { keepNotes, recallNotes, recallText } from '../domain/knowledge.ts';
import type { StateStore } from '../domain/ports.ts';
import type { Notifier } from './notifier.ts';
import type { Translator } from './translator.ts';

export class Knowledge {
  constructor(
    private readonly store: StateStore,
    private readonly notify: Notifier,
    private readonly i18n: Translator,
  ) {}

  private get state() { return this.store.state; }
  private get t() { return this.i18n.t; }
  private get notes() { return this.state.notes ?? []; }

  /** Called by the agent's `remember` tool. A note always starts unpinned, whoever wrote it. */
  remember(agentId: string, taskId: string | undefined, text: string) {
    const agent = this.state.agents.find(a => a.id === agentId);
    if (!agent) throw notFound(this.t('err.notFound'));
    const known = this.state.tasks.some(t => t.id === taskId);
    const note: Note = { id: randomUUID().slice(0, 8), text: this.checked(text), author: agent.id, authorName: agent.name, createdAt: Date.now(), pinned: false, ...(known ? { taskId } : {}) };
    this.state.notes = keepNotes([...this.notes, note]);
    this.notify.log(agent.id, 'system', this.t('log.noteSaved', { text: oneLine(note.text).slice(0, 80) }), note.taskId ?? null);
    this.changed();
    return note;
  }

  /** Called by the agent's `recall` tool: labelled text, so what the agent reads does not depend on the MCP server. */
  recall(query: string) {
    return { text: recallText(recallNotes(this.notes, query), this.t) };
  }

  /** The CEO's edits, from the Knowledge tab. */
  update(id: string, fields: { text?: string; pinned?: boolean }) {
    const note = this.find(id);
    if (fields.text !== undefined) note.text = this.checked(fields.text);
    if (fields.pinned !== undefined) note.pinned = fields.pinned;
    this.changed();
    return note;
  }

  remove(id: string) {
    const note = this.find(id);
    this.state.notes = this.notes.filter(n => n !== note);
    this.changed();
  }

  private find(id: string) {
    const note = this.notes.find(n => n.id === id);
    if (!note) throw notFound(this.t('err.notFound'));
    return note;
  }

  private checked(text: string) {
    const clean = text.trim();
    if (!clean) throw badRequest(this.t('err.noteEmpty'));
    if (clean.length > MAX_NOTE_CHARS) throw badRequest(this.t('err.noteTooLong', { max: MAX_NOTE_CHARS }));
    return clean;
  }

  private changed() {
    this.store.save();
    this.notify.publish({ type: 'notes', notes: this.notes });
  }
}
