import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider } from './types.ts';

export const squash = (s: unknown, max = 70) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
};

/** What a tool call was really given, for the task transcript; nothing when its summary already says it all. */
export function fullInput(input: unknown, summary?: string): { input?: string } {
  const command = (input as { command?: unknown } | null | undefined)?.command;
  const text = typeof input === 'string' ? input : typeof command === 'string' ? command : JSON.stringify(input ?? '', null, 2);
  return text && text !== '""' && text !== '{}' && text !== summary ? { input: text } : {};
}

/** Parses one JSON line; returns null for anything that is not a JSON object. */
export function parseJsonLine(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Resolves the executable: explicit path, `<ID>_BIN` env var, PATH, then provider-specific locations. */
export function findBinary(provider: Provider, configured = ''): string | null {
  const home = os.homedir();
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  const fromEnv = process.env[`${provider.id.toUpperCase()}_BIN`];
  if (fromEnv) candidates.push(fromEnv);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of provider.binaryNames) candidates.push(path.join(dir, name));
  }
  for (const name of provider.binaryNames) candidates.push(path.join(home, '.local/bin', name), path.join('/opt/homebrew/bin', name), path.join('/usr/local/bin', name));
  candidates.push(...(provider.binaryPaths ?? []));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      // the npm package's placeholder script is not a real binary
      if (fs.statSync(c).size < 2000 && fs.readFileSync(c, 'utf8').includes('native binary not installed')) continue;
      return c;
    } catch {}
  }
  return null;
}

/** Prepends the persona/team instructions for CLIs that have no system-prompt flag. */
export const withSystemPrompt = (systemPrompt: string, prompt: string) => `${systemPrompt}\n\n---\n\n${prompt}`;
