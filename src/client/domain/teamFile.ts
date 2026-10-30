// Reading a team file before it is imported: what the CEO is asked to confirm.
import { TEAM_FILE_FORMAT, TEAM_FILE_VERSION } from '../../shared/types.ts';
import type { TeamFile } from '../../shared/types.ts';

/** The file and how many of its workers run every command unasked, or null if it is not a team file. */
export function readTeamFile(text: string): { file: TeamFile; fullAuthority: number } | null {
  let file: Partial<TeamFile> | null;
  try { file = JSON.parse(text); } catch { return null; }
  if (file?.format !== TEAM_FILE_FORMAT || file.version !== TEAM_FILE_VERSION || !Array.isArray(file.agents) || !file.agents.length) return null;
  return { file: file as TeamFile, fullAuthority: file.agents.filter(a => a?.permissionMode === 'bypassPermissions').length };
}
