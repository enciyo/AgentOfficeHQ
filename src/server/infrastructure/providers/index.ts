// Provider registry. To add a CLI: create providers/<name>.ts and add it to PROVIDERS (see CONTRIBUTING.md).
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { opencode } from './opencode.ts';
import type { Provider } from './types.ts';

export const PROVIDERS: Provider[] = [claude, codex, cursor, opencode];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Unknown or missing ids (e.g. agents saved before providers existed) fall back to Claude. */
export const getProvider = (id: unknown): Provider => byId.get(id as string) ?? claude;
