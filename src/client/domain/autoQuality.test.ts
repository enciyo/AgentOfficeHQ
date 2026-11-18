// Automatic quality steps: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_QUALITY, AutoQuality, type QualityStep } from './autoQuality.ts';

/** Feeds `seconds` of frames at `fps`, each taking `workMs`, and returns the steps taken. */
function run(q: AutoQuality, clock: { now: number }, seconds: number, fps: number | ((level: number) => number), workMs: number | ((level: number) => number) = 5) {
  const steps: QualityStep[] = [];
  const end = clock.now + seconds;
  while (clock.now < end) {
    const rate = typeof fps === 'function' ? fps(q.current) : fps;
    const dt = 1 / rate;
    clock.now += dt;
    const step = q.frame(clock.now, dt, typeof workMs === 'function' ? workMs(q.current) : workMs);
    if (step) steps.push(step);
  }
  return steps;
}

test('a steady low frame rate steps down once, and a step that helps stays', () => {
  const q = new AutoQuality(2);
  const clock = { now: 0 };
  // Level 2 runs at 20 fps, level 1 at 40
  const steps = run(q, clock, 12, level => (level === 2 ? 20 : 40));
  assert.deepEqual(steps, [{ level: 1, reason: 'slow' }]);
  assert.equal(q.current, 1);
});

test('a step down that gains less than 3% is undone and not tried again right away (CPU-bound)', () => {
  const q = new AutoQuality(2);
  const clock = { now: 0 };
  // Every level runs at 20 fps: the bottleneck is not the GPU
  const steps = run(q, clock, 30, 20);
  assert.deepEqual(steps, [{ level: 1, reason: 'slow' }, { level: 2, reason: 'noGain' }]);
  assert.equal(q.current, 2, 'shadows and AO are kept, since giving them up bought nothing');
  // After the block it may check again, and the next block is longer
  const later = run(q, clock, AUTO_QUALITY.cooldown + 10, 20);
  assert.deepEqual(later, [{ level: 1, reason: 'slow' }, { level: 2, reason: 'noGain' }]);
  assert.deepEqual(run(q, clock, AUTO_QUALITY.cooldown * 2 - 30, 20), []);
});

test('after a temporary dip it steps back up to the chosen level, never above it', () => {
  const q = new AutoQuality(2);
  const clock = { now: 0 };
  // A background load: 20 fps for a while, then the GPU has plenty of room again
  assert.deepEqual(run(q, clock, 7, 20), [{ level: 1, reason: 'slow' }]);
  run(q, clock, 3, 60); // the step down is measured: it helped
  const back = run(q, clock, 15, 60);
  assert.deepEqual(back, [{ level: 2, reason: 'room' }]);
  assert.deepEqual(run(q, clock, 60, 60), [], 'the chosen level is the ceiling');
});

test('level 0 is capped at 30 fps, so it steps up on the time each frame takes, not on the frame rate', () => {
  const q = new AutoQuality(2, 0);
  const clock = { now: 0 };
  assert.deepEqual(run(q, clock, 30, 30, 25), [], 'a busy 30 fps shows no room');
  assert.deepEqual(run(q, clock, 12, 30, 4), [{ level: 1, reason: 'room' }], 'a light 30 fps does');
});

test('a borderline GPU does not bounce: a failed step up blocks the next one for longer each time', () => {
  const q = new AutoQuality(2, 1);
  const clock = { now: 0 };
  // Level 1 has room (55 fps), level 2 is too slow (24 fps)
  const fps = (level: number) => (level === 2 ? 24 : 55);
  const first = run(q, clock, 40, fps);
  assert.deepEqual(first.map(s => s.reason), ['room', 'slow']);
  assert.equal(q.current, 1);
  // Inside the first block nothing changes
  assert.deepEqual(run(q, clock, AUTO_QUALITY.cooldown - 30, fps), []);
  // Each later try waits twice as long as the one before
  const tries: number[] = [];
  const end = clock.now + 20 * 60;
  while (clock.now < end) for (const s of run(q, clock, 1, fps)) if (s.reason === 'room') tries.push(clock.now);
  const gaps = tries.slice(1).map((t, i) => t - tries[i]!);
  assert.ok(tries.length >= 3 && tries.length <= 5, `tries: ${tries.length}`);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! > gaps[i - 1]! * 1.5, `gaps grow: ${gaps.map(Math.round)}`);
});

test('the frames right after a change are not counted', () => {
  const q = new AutoQuality(2);
  const clock = { now: 0 };
  run(q, clock, 7, 20);
  assert.equal(q.current, 1);
  // A one-second hitch right after the step, then fast frames: the hitch does not make it look like no gain
  run(q, clock, 0.9, 2);
  assert.deepEqual(run(q, clock, 3, 60), []);
  assert.equal(q.current, 1);
});
