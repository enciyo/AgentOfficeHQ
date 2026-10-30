import { randomUUID } from 'node:crypto';
import { TEAM_FILE_FORMAT, TEAM_FILE_VERSION } from '../../shared/types.ts';
import type { Agent, TeamFile } from '../../shared/types.ts';

/** The CLI used when neither the agent nor the settings name one. */
export const FALLBACK_PROVIDER = 'claude';

export function createAgent(fields: Partial<Agent>, defaultRole: string): Agent {
  const agent: Agent = {
    id: randomUUID().slice(0, 8), name: '', kind: 'agent', provider: '', role: defaultRole, color: '#60a5fa', prompt: '', model: '',
    cwd: '', permissionMode: 'acceptEdits', allowedTools: '', team: '', sessionId: null, totalCost: 0, hiredAt: Date.now(),
    ...fields,
  };
  agent.name = agent.name.trim();
  agent.team = (agent.team || '').trim();
  return agent;
}

/** The team as a file: setup only, so it can be shared and restored on another machine. */
export function toTeamFile(agents: Agent[], exportedAt: number): TeamFile {
  const members = [...agents].sort((a, b) => a.hiredAt - b.hiredAt).map(({ name, kind, role, provider, color, prompt, model, permissionMode, allowedTools, team }) =>
    ({ name, kind, role, provider, color, prompt, model, permissionMode, allowedTools, team }));
  return { format: TEAM_FILE_FORMAT, version: TEAM_FILE_VERSION, exportedAt, agents: members };
}

/** Branch-safe ASCII slug ("Baş Analist" → "bas-analist"). */
export const slugify = (s: string) =>
  s.replace(/ı/g, 'i').replace(/İ/g, 'I').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';

/** Stable name of an agent's isolated checkout and branch (`agent/<key>`). */
export const workcellKey = (a: Agent) => `${slugify(a.name)}-${a.id}`;

export const sameTeam = (a: Agent, b: Agent) => !!a.team.trim() && a.team.trim() === b.team.trim();

/** Finds an agent by name (case-insensitive) or id. */
export function findAgent(agents: Agent[], nameOrId: string) {
  const n = nameOrId.trim().toLowerCase();
  return agents.find(a => a.name.toLowerCase() === n) || agents.find(a => a.id === nameOrId);
}

/** The CLI an agent actually runs on: its own, else the office default. */
export const providerOf = (agent: Pick<Agent, 'provider'>, defaultProvider?: string) => agent.provider || defaultProvider || FALLBACK_PROVIDER;
