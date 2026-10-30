// The stage waiting for three.js: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Stage } from '../application/ports.ts';
import { StageHolder } from './stageHolder.ts';

const recorder = (calls: string[]) => ({
  setLanguage: () => void calls.push('language'), setAgents: () => void calls.push('agents'), removeAgent: (id: string) => void calls.push(`remove:${id}`),
}) as unknown as Stage;

test('what is said before the world loads reaches it in order, and later calls go straight through', () => {
  const holder = new StageHolder();
  const calls: string[] = [];
  holder.setAgents([]);
  holder.removeAgent('a');
  assert.equal(holder.watched(), false);
  holder.attach(recorder(calls));
  assert.deepEqual(calls, ['agents', 'remove:a']);
  holder.setLanguage((() => '') as never);
  assert.deepEqual(calls, ['agents', 'remove:a', 'language']);
});
