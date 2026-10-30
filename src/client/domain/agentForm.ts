import type { Translate } from '../../shared/i18n/index.ts';
import type { PublicAgent } from '../../shared/types.ts';

export const COLORS = ['#f59e0b', '#38bdf8', '#22c55e', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1'];

export const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'plan', 'default'] as const;

/** Editable fields of an agent, as the hiring/settings form holds them. */
export interface AgentDraft {
  kind: PublicAgent['kind'];
  name: string; team: string; role: string; color: string;
  prompt: string; provider: string; model: string; permissionMode: string; cwd: string; allowedTools: string;
}

export const draftOf = (a: PublicAgent): AgentDraft => ({
  kind: a.kind, name: a.name, team: a.team, role: a.role, color: a.color, prompt: a.prompt,
  provider: a.provider, model: a.model, permissionMode: a.permissionMode, cwd: a.cwd, allowedTools: a.allowedTools,
});

/** A blank hire form; the CLI is left to the office default. */
export function newDraft(agents: PublicAgent[]): AgentDraft {
  const color = COLORS.find(c => !agents.some(a => a.color === c)) ?? COLORS[0]!;
  return {
    kind: 'agent', name: '', team: '', role: '', color, prompt: '', provider: '',
    model: '', permissionMode: 'acceptEdits', cwd: '', allowedTools: '',
  };
}

/** Fields sent to the server: humans only have identity fields. */
export function draftPayload(d: AgentDraft, t: Translate) {
  const role = d.role || t(d.kind === 'human' ? 'role.member' : 'role.assistant');
  const { name, team, color, kind } = d;
  return d.kind === 'human' ? { kind, name, team, color, role } : { ...d, role };
}
