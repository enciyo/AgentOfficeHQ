// Keeps docs/<request-code>/journal.md up to date in the shared working directory when the setting is on, so the
// handoffs of a chain can be read in one place by people and agents alike.
import { chainRootId } from '../../shared/chain.ts';
import { chainJournal, journalMarkdown } from '../../shared/journal.ts';
import type { Task } from '../../shared/types.ts';
import type { FileTree, StateStore } from '../domain/ports.ts';
import type { Translator } from './translator.ts';

export class Journals {
  private readonly due = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: StateStore,
    private readonly files: FileTree,
    private readonly i18n: Translator,
    /** A run changes its task many times in a row; the file is written once things settle. */
    private readonly delayMs = 1000,
  ) {}

  private get state() { return this.store.state; }

  /** A task changed: its chain's journal is written again shortly. */
  touch(task: Task) {
    if (!this.state.settings.journalFile) return;
    const rootId = chainRootId(this.state.tasks, task);
    if (this.due.has(rootId)) return;
    const timer = setTimeout(() => { this.due.delete(rootId); this.write(rootId); }, this.delayMs);
    timer.unref?.();
    this.due.set(rootId, timer);
  }

  /** Writes the journal of the chain `rootId` starts; the path written, or null when it has no request code or the write failed. */
  write(rootId: string): string | null {
    if (!this.state.settings.journalFile) return null;
    const journal = chainJournal(this.state.tasks, rootId);
    if (!journal?.code) return null;
    const rel = `docs/${journal.code}/journal.md`;
    const text = journalMarkdown(journal, this.nameOf, this.i18n.t);
    return this.files.write(this.state.settings.defaultCwd, rel, text) ? rel : null;
  }

  private nameOf = (id: string) =>
    id === 'user' ? this.state.settings.playerName || 'CEO' : this.state.agents.find(a => a.id === id)?.name ?? id;
}
