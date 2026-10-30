// Per-agent activity log: JSONL on disk plus an in-memory tail.
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { LogEntry } from '../../../shared/types.ts';
import { briefEntry } from '../../domain/logs.ts';
import type { LogBook } from '../../domain/ports.ts';

const KEEP = 300;

export class FileLogBook implements LogBook {
  private readonly tails = new Map<string, LogEntry[]>();
  /** The last write of each agent: writes go in order, and a reader can wait for them. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  append(agentId: string, entry: LogEntry) {
    const tail = this.recent(agentId);
    tail.push(briefEntry(entry));
    if (tail.length > KEEP) tail.splice(0, tail.length - KEEP);
    const line = JSON.stringify(entry) + '\n';
    this.writes.set(agentId, (this.writes.get(agentId) ?? Promise.resolve()).then(() => fs.promises.appendFile(this.fileOf(agentId), line)).catch(() => {}));
  }

  recent(agentId: string) {
    let tail = this.tails.get(agentId);
    if (!tail) {
      try {
        tail = fs.readFileSync(this.fileOf(agentId), 'utf8').trim().split('\n').slice(-KEEP).map(l => briefEntry(JSON.parse(l)));
      } catch {
        tail = [];
      }
      this.tails.set(agentId, tail!);
    }
    return tail!;
  }

  async ofTask(agentId: string, taskId: string, limit: number) {
    await this.writes.get(agentId);
    const entries: LogEntry[] = [];
    let total = 0;
    const input = fs.createReadStream(this.fileOf(agentId));
    try {
      await once(input, 'open');
      // Most lines belong to other tasks: only the ones naming this task are worth parsing
      const mark = `"taskId":${JSON.stringify(taskId)}`;
      for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
        if (!line.includes(mark)) continue;
        const entry = parsed(line);
        if (entry?.taskId !== taskId) continue;
        total++;
        entries.push(entry);
        if (entries.length >= limit * 2) entries.splice(0, entries.length - limit);
      }
    } catch {
      // No log yet, or it can not be read: what was read so far is what there is
    }
    return { entries: entries.slice(-limit), total };
  }

  /** An id is a name, never a way out of the logs folder. */
  private fileOf = (agentId: string) => path.join(this.dir, path.basename(agentId) + '.jsonl');
}

/** A line cut short by a crash is skipped, not fatal. */
function parsed(line: string): LogEntry | null {
  try { return JSON.parse(line); } catch { return null; }
}
