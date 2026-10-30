// The live feed comes back by itself, and says so: `npm test`
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { sseEvents } from './httpGateway.ts';

class FakeSource {
  static CLOSED = 2;
  static made: FakeSource[] = [];
  readyState = 1;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSource.made.push(this); }
}

function feed() {
  FakeSource.made = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
  const seen = { events: [] as unknown[], reconnects: 0 };
  sseEvents.subscribe(e => seen.events.push(e), () => { seen.reconnects++; });
  return { seen, source: () => FakeSource.made.at(-1)! };
}

test('the first connection is no reconnect, and events pass through', () => {
  const { seen, source } = feed();
  source().onopen!();
  source().onmessage!({ data: '{"type":"files-changed"}' });
  assert.deepEqual(seen, { events: [{ type: 'files-changed' }], reconnects: 0 });
});

test('coming back after a lost connection is reported once', () => {
  const { seen, source } = feed();
  source().onopen!();
  source().onerror!();
  source().onerror!(); // every failed retry says so
  assert.equal(seen.reconnects, 0);
  source().onopen!();
  source().onopen!();
  assert.equal(seen.reconnects, 1);
  assert.equal(FakeSource.made.length, 1, 'the browser reconnects this one by itself');
});

test('a feed the browser gave up on is opened again', (c) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  c.after(() => mock.timers.reset());
  const { seen, source } = feed();
  source().onopen!();
  source().readyState = FakeSource.CLOSED;
  source().onerror!();
  mock.timers.tick(2000);
  assert.equal(FakeSource.made.length, 2);
  source().onopen!();
  assert.equal(seen.reconnects, 1);
});
