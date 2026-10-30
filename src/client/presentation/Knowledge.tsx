import { useMemo, useState } from 'react';
import { MAX_NOTE_CHARS } from '../../shared/knowledge.ts';
import type { Note } from '../../shared/types.ts';
import { formatDateTime } from '../domain/format.ts';
import { knowledgeView } from '../domain/knowledge.ts';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

/** The team's shared notes: the CEO reads what agents wrote and pins what should become a standing instruction. */
export function KnowledgeTab() {
  const notes = useOffice(s => s.notes);
  const t = useT();
  const view = useMemo(() => knowledgeView(notes), [notes]);
  return (
    <div className="approvals">
      <div className="sec-label">{t('know.pinned')} · {view.pinned.length}</div>
      <div className="hint">{t('know.pinnedHint', { used: view.used, budget: view.budget })}</div>
      {view.pinned.length ? view.pinned.map(({ note, inPrompt }) => <NoteCard key={note.id} note={note} inPrompt={inPrompt} />) : <div className="empty">{t('know.pinnedEmpty')}</div>}
      <div className="sec-label">{t('know.unverified')} · {view.unverified.length}</div>
      <div className="hint">{t('know.unverifiedHint')}</div>
      {view.unverified.length ? view.unverified.map(n => <NoteCard key={n.id} note={n} inPrompt={false} />) : <div className="empty">{t('know.empty')}</div>}
    </div>
  );
}

function NoteCard({ note, inPrompt }: { note: Note; inPrompt: boolean }) {
  const { updateNote, deleteNote } = useActions();
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => { if (await updateNote(note.id, { text: draft! })) setDraft(null); };
  return (
    <div className={`appr ${note.pinned ? '' : 'pending'}`}>
      <div className="appr-head">
        <span className="who">{note.authorName}</span>
        <span className="meta">{formatDateTime(note.createdAt, locale)}{note.taskId ? ` · #${note.taskId}` : ''}</span>
        {!note.pinned && <span className="pill queued">{t('know.unverifiedPill')}</span>}
        {note.pinned && !inPrompt && <span className="pill error">{t('know.notInPrompt')}</span>}
      </div>
      {draft === null ? <div className="note-text">{note.text}</div> : <textarea rows={3} maxLength={MAX_NOTE_CHARS} value={draft} onChange={e => setDraft(e.target.value)} />}
      <div className="appr-actions">
        {draft === null ? (
          <>
            <button className={note.pinned ? 'sm' : 'primary sm'} onClick={() => updateNote(note.id, { pinned: !note.pinned })}>{t(note.pinned ? 'know.unpin' : 'know.pin')}</button>
            <button className="sm" onClick={() => setDraft(note.text)}>{t('know.edit')}</button>
            <button className="danger sm" onClick={() => confirm(t('know.confirmDelete')) && deleteNote(note.id)}>{t('know.delete')}</button>
          </>
        ) : (
          <>
            <button className="primary sm" disabled={!draft.trim()} onClick={save}>{t('know.save')}</button>
            <button className="sm" onClick={() => setDraft(null)}>{t('know.cancel')}</button>
          </>
        )}
      </div>
    </div>
  );
}
