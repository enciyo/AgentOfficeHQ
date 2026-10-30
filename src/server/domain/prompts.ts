import type { Translate } from '../../shared/i18n/index.ts';
import { officeNotesForPrompt, oneLine, pinnedForPrompt } from '../../shared/knowledge.ts';
import type { Agent, Note } from '../../shared/types.ts';
import { sameTeam } from './agent.ts';

/** Persona and team instructions appended to the agent CLI's system prompt. */
export function buildSystemPrompt(agent: Agent, teammates: Agent[], canDelegate: boolean, t: Translate, approvalPolicy = '', officeNotes = '', notes: Note[] = []) {
  const mates = teammates.filter(a => a !== agent && sameTeam(a, agent)).map(a => `${a.name} (${a.role})`);
  const team = agent.team && t('prompt.team', { team: agent.team, mates: mates.length ? t('prompt.mates', { list: mates.join(', ') }) : '' });
  const told = officeNotesForPrompt(officeNotes);
  const pinned = pinnedForPrompt(notes).included.map(n => `- ${oneLine(n.text)}`).join('\n');
  return [
    t('prompt.persona', { name: agent.name, role: agent.role }),
    agent.prompt,
    canDelegate && t('prompt.tools'),
    canDelegate && team,
    canDelegate && t('prompt.afterDelegate'),
    canDelegate && approvalPolicy.trim() && t('prompt.approval', { policy: approvalPolicy.trim() }),
    // Plain prompt text, so these reach agents without team tools too
    told && t('prompt.officeNotes', { notes: told }),
    pinned && t('prompt.pinnedNotes', { notes: pinned }),
    t('prompt.finalAnswer'),
  ].filter(Boolean).join('\n\n');
}
