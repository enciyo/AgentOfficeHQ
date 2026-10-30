import { useMemo, useState, type DragEvent } from 'react';
import { TASK_DRAG_TYPE } from '../application/ports.ts';
import type { PublicAgent } from '../../shared/types.ts';
import { teamGroups } from '../domain/views.ts';
import { Avatar, RichText } from './common.tsx';
import { useActions, useOffice, useT } from './store.tsx';

export function Sidebar() {
  const agents = useOffice(s => s.agents);
  const t = useT();
  const list = useMemo(() => Object.values(agents), [agents]);
  const groups = useMemo(() => teamGroups(list, t), [list, t]);

  return (
    <aside id="team" className="side">
      <div className="sec-title"><span>{t('side.team')}</span><span id="team-count">{list.length || ''}</span></div>
      <div id="team-list" className="team-list">
        {!list.length && <div className="empty-note"><RichText text={t('side.empty')} /></div>}
        {groups.map(g => (
          <div key={g.name ?? ''}>
            {g.name && <div className="team-head"><i style={{ background: g.dot }} />{g.name}<span>{g.members.length}</span></div>}
            {g.members.map(a => <Member key={a.id} agent={a} />)}
          </div>
        ))}
      </div>
    </aside>
  );
}

function Member({ agent: a }: { agent: PublicAgent }) {
  const t = useT();
  const selected = useOffice(s => s.selectedId === a.id);
  const sign = useOffice(s => s.attention[a.id]);
  const { select, handoff, dropFile, openAttention } = useActions();
  const [over, setOver] = useState(false);
  // Task cards and files can be dropped on a member to give them the work
  const droppable = (e: DragEvent) => [...e.dataTransfer.types].some(x => x === TASK_DRAG_TYPE || x === 'Files');
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE);
    const file = e.dataTransfer.files[0];
    if (taskId) handoff(taskId, a.id);
    else if (file) dropFile(a.id, file);
  };
  return (
    <div className={`member ${selected ? 'selected' : ''} ${over ? 'drop' : ''}`} data-status={a.status} data-tone={sign?.tone} onClick={() => select(a.id, true)}
      role="button" tabIndex={0} aria-pressed={selected} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(a.id, true); } }}
      onDragOver={e => { if (droppable(e)) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <Avatar agent={a} />
      <div className="meta">
        <div className="nm">{a.name}</div>
        {a.status === 'working' && <div className="act">{a.activity}</div>}
        {a.status !== 'working' && !sign && <div className="rl">{a.role}{a.kind === 'human' ? ` · ${t('side.human')}` : ''}</div>}
        {sign && <button className="why" title={sign.text} onClick={e => { e.stopPropagation(); select(a.id, true); openAttention(a.id); }}>{sign.text}</button>}
      </div>
      <div className="q">{a.queued ? `+${a.queued}` : ''}</div>
    </div>
  );
}

