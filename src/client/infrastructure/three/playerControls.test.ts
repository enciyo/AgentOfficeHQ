import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModalOpen } from './playerControls.ts';

const modal = (hidden: boolean) => ({ classList: { contains: (token: string) => token === 'hidden' && hidden } });

test('a hidden modal does not block player keyboard actions', () => {
  assert.equal(isModalOpen(null), false);
  assert.equal(isModalOpen(modal(true)), false);
  assert.equal(isModalOpen(modal(false)), true);
});
