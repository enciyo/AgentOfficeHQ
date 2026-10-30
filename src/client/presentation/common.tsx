import { Fragment, useState, type ReactNode } from 'react';
import type { PublicAgent } from '../../shared/types.ts';
import { initials } from '../domain/format.ts';
import { useOffice, useT } from './store.tsx';

export const Avatar = ({ agent }: { agent: Pick<PublicAgent, 'name' | 'color' | 'status'> }) => (
  <div className="avatar" style={{ background: agent.color }} data-status={agent.status}>{initials(agent.name)}<span className="st" /></div>
);

/** Colored agent name by id (`user` is the CEO). */
export function Who({ id }: { id: string }) {
  const agent = useOffice(s => s.agents[id]);
  const t = useT();
  if (!agent) return <span className="who">{id === 'user' ? `🧑‍💼 ${t('ui.you')}` : '?'}</span>;
  return <span className="who"><i style={{ background: agent.color }} />{agent.name}</span>;
}

export function CopyButton({ text, className = 'copy' }: { text: string; className?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return <button type="button" className={`ghost sm ${className}`} onClick={copy}>{done ? t('chat.copied') : t('chat.copy')}</button>;
}

/** ```fenced code``` blocks with a copy button; the rest goes through inline formatting. */
export function RichText({ text }: { text: string }) {
  return <>{text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((chunk, i) => {
    const fence = /^```[^\n]*\n([\s\S]*?)```$/.exec(chunk);
    return fence
      ? <div key={i} className="codeblock"><CopyButton text={fence[1]!.replace(/\n$/, '')} /><pre>{fence[1]!.replace(/\n$/, '')}</pre></div>
      : <Inline key={i} text={chunk} />;
  })}</>;
}

/** `**bold**`, `code` and line breaks in plain text. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\n)/g).map((part, i) =>
    part === '\n' ? <br key={i} /> : part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>);
  return <>{parts}</>;
}

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s)]+)/g;

function InlineMd({ text }: { text: string }) {
  return <>{text.split(INLINE).map((part, i) =>
    part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b>
      : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code>
      : /^https?:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>
      : <Fragment key={i}>{part}</Fragment>)}</>;
}

type Block = { kind: 'p' | 'h' | 'ul' | 'ol' | 'table'; lines: string[] };

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { blocks.push({ kind: 'p', lines: [] }); continue; } // blank line: paragraph break
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'table') last.lines.push(line.trim());
      else blocks.push({ kind: 'table', lines: [line.trim()] });
      continue;
    }
    const heading = /^#{1,4}\s+(.*)/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)/.exec(line);
    const kind = heading ? 'h' : bullet ? 'ul' : number ? 'ol' : 'p';
    const content = (heading ?? bullet ?? number)?.[1] ?? line;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind !== 'h' && last.lines.length) last.lines.push(content);
    else if (last && last.kind === 'p' && !last.lines.length && kind === 'p') last.lines.push(content);
    else blocks.push({ kind, lines: [content] });
  }
  return blocks.filter(b => b.lines.length);
}

/** Chat-bubble markdown: paragraphs, headings, bullet/numbered lists, **bold**, `code`, links and fenced code. */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((chunk, i) => {
    const fence = /^```[^\n]*\n([\s\S]*?)```$/.exec(chunk);
    if (fence) {
      const code = fence[1]!.replace(/\n$/, '');
      return <div key={i} className="codeblock"><CopyButton text={code} /><pre>{code}</pre></div>;
    }
    return blocksOf(chunk).map((b, j) => {
      const items = b.lines.map((l, k) => b.kind === 'p' && k ? <Fragment key={k}><br /><InlineMd text={l} /></Fragment> : <InlineMd key={k} text={l} />);
      if (b.kind === 'h') return <div key={`${i}-${j}`} className="md-h"><InlineMd text={b.lines[0]!} /></div>;
      if (b.kind === 'p') return <p key={`${i}-${j}`}>{items}</p>;
      if (b.kind === 'table') return <MdTable key={`${i}-${j}`} lines={b.lines} />;
      const List = b.kind === 'ul' ? 'ul' : 'ol';
      return <List key={`${i}-${j}`}>{b.lines.map((l, k) => <li key={k}><InlineMd text={l} /></li>)}</List>;
    });
  })}</div>;
}

/** `| a | b |` rows; a `|---|` line right after the first row makes it the header. */
function MdTable({ lines }: { lines: string[] }) {
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const hasHead = lines.length > 1 && /^[\s|:-]+$/.test(lines[1]!);
  const head = hasHead ? cells(lines[0]!) : null;
  const rows = (hasHead ? lines.slice(2) : lines).map(cells);
  return (
    <div className="md-table">
      <table>
        {head && <thead><tr>{head.map((c, k) => <th key={k}><InlineMd text={c} /></th>)}</tr></thead>}
        <tbody>{rows.map((r, k) => <tr key={k}>{r.map((c, m) => <td key={m}><InlineMd text={c} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
