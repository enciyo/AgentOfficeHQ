import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatTime } from '../domain/format.ts';
import type { PlayerActionMode } from '../application/ports.ts';
import { chatItems, pmAgent, zonesOf } from '../domain/views.ts';
import { browserStorage } from '../infrastructure/httpGateway.ts';
import type { StageHolder } from '../infrastructure/stageHolder.ts';
import { unreadOf } from '../application/officeStore.ts';
import { Avatar, CopyButton, Markdown, RichText } from './common.tsx';
import { Drawer } from './Drawer.tsx';
import { Reactions, StandupPanel } from './Fun.tsx';
import { useActions, useLocale, useOffice, useT } from './store.tsx';

/** The 3D scene plus everything floating over it. */
export function StagePanel({ holder }: { holder: StageHolder }) {
  const container = useRef<HTMLDivElement>(null);
  const actions = useActions();
  const t = useT();
  const [actionMode, setActionMode] = useState<PlayerActionMode>('none');

  useEffect(() => {
    const a = actions;
    let live = true;
    // three.js is most of the code: the UI does not wait for it
    import('../infrastructure/three/world.ts').then(({ World }) => live && holder.attach(new World(container.current!, {
      storage: browserStorage,
      onSelectAgent: id => a.select(id),
      onInteract: a.interact,
      onEnterRoom: a.enterRoom,
      onCoffeeMachine: a.coffeeBreak,
      onCoffee: a.drank,
      onSelectVisitor: a.openVisitor,
      onAttention: a.openAttention,
      onDropTask: a.handoff,
      onDropFile: (file, agentId) => a.dropFile(agentId, file),
    })));
    return () => { live = false; };
  }, [holder, actions]);

  useEffect(() => { holder.setActionMode(actionMode); }, [holder, actionMode]);

  return (
    <main id="stage-wrap">
      <div id="stage" ref={container} />
      <Rooms />
      <div className="player-tools" role="toolbar" aria-label={t('hud.actions')}>
        {([
          ['none', '🚶', 'hud.freeMode'],
          ['plant', '🪴', 'hud.plantMode'],
          ['kick', '🥾', 'hud.kickMode'],
          ['kiss', '💋', 'hud.kissMode'],
          ['clap', '👏', 'hud.clapMode'],
          ['highfive', '🖐️', 'hud.highfiveMode'],
          ['coffee', '☕', 'hud.coffeeMode'],
          ['confetti', '🎉', 'hud.confettiMode'],
          ['dance', '🕺', 'hud.danceMode'],
          ['thumbs', '👍', 'hud.thumbsMode'],
        ] as const).map(([mode, icon, key]) => (
          <button key={mode} type="button" className={actionMode === mode ? 'active' : ''} aria-pressed={actionMode === mode}
            aria-label={t(key)} title={t(key)}
            onClick={() => setActionMode(actionMode === mode && mode !== 'none' ? 'none' : mode)}>
            <span aria-hidden="true">{icon}</span><span className="sr-only">{t(key)}</span>
          </button>
        ))}
        <span className="space-hint" title={t('hud.useMode')} aria-label={`Space: ${t('hud.useMode')}`}><kbd>Space</kbd></span>
      </div>
      <StandupPanel />
      <div className="hud"><span className="k">W A S D</span> {t('hud.walk')} <span className="k">Shift</span> {t('hud.run')} <span className="k">E</span> {t('hud.talk')} <span className="k">F</span> {t('hud.follow')} · {t('hud.click')}</div>
      <Drawer />
      <Chat />
    </main>
  );
}

function Rooms() {
  const office = useOffice(s => s.office);
  const zones = useMemo(() => zonesOf(office), [office]);
  const { focusZone } = useActions();
  const t = useT();
  return (
    <nav id="rooms" className="rooms">
      <button onClick={() => focusZone('')}>{t('rooms.all')}</button>
      {zones.map(z => (
        <button key={z.id} onClick={() => focusZone(z.id)}>
          <i style={{ background: z.tint, boxShadow: 'inset 0 0 0 1px rgba(15,23,42,.15)' }} />{z.label}
        </button>
      ))}
    </nav>
  );
}

function Chat() {
  const agents = useOffice(s => s.agents);
  const tasks = useOffice(s => s.tasks);
  const open = useOffice(s => s.chatOpen);
  const unread = useOffice(unreadOf);
  const clearedAt = useOffice(s => s.chatClearedAt);
  const { toggleChat, markChatSeen, sendChat, stopAgent, clearChat } = useActions();
  const pm = useMemo(() => pmAgent(Object.values(agents)), [agents]);
  const t = useT();
  const locale = useLocale();
  const items = useMemo(() => (pm ? chatItems(pm, Object.values(tasks), id => (id === 'user' ? t('ui.you') : agents[id]?.name ?? '?'), t).filter(m => m.ts > clearedAt) : []), [pm, tasks, agents, t, clearedAt]);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [away, setAway] = useState(false); // scrolled up while new messages arrive

  // Reading the open chat counts as seeing it
  useEffect(() => { if (open && pm) markChatSeen(); }, [open, pm, items.length, markChatSeen]);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 30); }, [open]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    if (nearBottom.current) el.scrollTop = el.scrollHeight;
    else setAway(true);
  }, [items.length, pm?.status, open]);
  // Grow the textarea with its content, up to a limit
  useEffect(() => {
    const el = input.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
  }, [text]);

  const jump = () => { const el = body.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const send = async (resend?: string) => {
    const prompt = (resend ?? text).trim();
    if (!prompt || sending) return;
    setSending(true);
    if (await sendChat(prompt) && resend === undefined) setText('');
    setSending(false);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  const sub = !pm ? '' : pm.status === 'working' ? pm.activity || t('chat.working') : pm.queued ? t('chat.queued', { n: pm.queued }) : t('chat.idle');

  return (
    <>
      <section id="chat" className={`chat ${open ? '' : 'hidden'}`} aria-label={t('chat.title')}>
        {!pm ? (
          <div className="chat-empty"><RichText text={t('chat.noPm')} /></div>
        ) : (
          <>
            <div className="chat-head">
              <Avatar agent={pm} />
              <div><div className="nm">{pm.name}</div><div className="sub">{sub}</div></div>
              {items.length > 0 && <button className="ghost sm clear" title={t('chat.clearHint')} onClick={clearChat}>{t('chat.clear')}</button>}
              <button className="icon ghost x" title={t('ui.close')} onClick={() => toggleChat(false)}>✕</button>
            </div>
            <div className="chat-body" ref={body} onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (nearBottom.current) setAway(false); }}>
              {items.length ? items.map((m, i) => m.kind === 'sys'
                ? <div key={i} className="chat-sys">{m.text}</div>
                : (
                  <div key={i} className={`msg ${m.kind === 'me' ? 'me' : m.kind === 'err' ? 'pm err' : 'pm'}`}>
                    {m.ctx && <span className="ctx">{m.ctx}</span>}
                    <Markdown text={m.text} />
                    <span className="foot">
                      {m.taskId && m.kind !== 'me' && <Reactions taskId={m.taskId} reactions={m.reactions} />}
                      <span className="acts">
                        {m.retry && <button type="button" className="ghost sm" disabled={sending} onClick={() => send(m.retry)}>{t('chat.retry')}</button>}
                        {m.kind !== 'me' && <CopyButton text={m.text} />}
                      </span>
                      <span className="t">{formatTime(m.ts, locale)}</span>
                    </span>
                  </div>
                )) : <div className="chat-empty"><RichText text={t('chat.intro')} /></div>}
              {pm.status === 'working' && <div className="typing"><div className="dots"><i /><i /><i /></div><span>{pm.activity || ''}</span></div>}
              {away && <button type="button" className="chat-jump" onClick={jump}>{t('chat.jump')}</button>}
            </div>
            <div className="chat-input">
              <textarea id="chat-input" ref={input} rows={1} value={text} disabled={sending} onChange={e => setText(e.target.value)} onKeyDown={onKey} placeholder={t('chat.placeholder')} />
              {pm.status === 'working' && <button className="danger" onClick={() => stopAgent(pm.id)}>{t('chat.stop')}</button>}
              <button className="primary" onClick={() => send()}>{t('chat.send')}</button>
            </div>
          </>
        )}
      </section>
      <button id="chat-fab" className={`chat-fab ${pm ? '' : 'hidden'} ${open ? 'open' : ''}`} title={t('chat.open')} aria-label={t('chat.open')} onClick={() => toggleChat()}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 3C6.9 3 3 6.5 3 10.8c0 2.4 1.2 4.5 3.2 5.9L5.5 21l4.3-2.5c.7.1 1.4.2 2.2.2 5.1 0 9-3.5 9-7.9S17.1 3 12 3Z" /></svg>
        <span className={`badge ${unread ? '' : 'hidden'}`}>{unread > 9 ? '9+' : unread}</span>
      </button>
    </>
  );
}
