// Team file reading: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTeamFile } from './teamFile.ts';

const file = (agents: object[]) => JSON.stringify({ format: 'agent-office-team', version: 1, exportedAt: 1, agents });

test('a team file is read and its full-authority workers are counted', () => {
  const team = readTeamFile(file([{ name: 'A', permissionMode: 'bypassPermissions' }, { name: 'B', permissionMode: 'acceptEdits' }]));
  assert.equal(team?.file.agents.length, 2);
  assert.equal(team?.fullAuthority, 1);
});

test('anything else is refused', () => {
  for (const text of ['not json', 'null', '{}', file([]), JSON.stringify({ format: 'agent-office-team', version: 2, agents: [{ name: 'A' }] })]) {
    assert.equal(readTeamFile(text), null, text);
  }
});
