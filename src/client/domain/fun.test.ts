// Coffee, morale and random office events: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COFFEE_MAX, CUP, coffeeBreak, drinkCoffee, freshFun, moraleOf, paceOf, rollEvents, tickFun } from './fun.ts';

const MIN = 60_000;

test('work drains morale, rest restores it, and an empty machine drains everyone', () => {
  const start = freshFun(0);
  const after = tickFun(start, [{ id: 'w', status: 'working' }, { id: 'r', status: 'idle' }], 5 * MIN);
  assert.ok(moraleOf(after, 'w') < moraleOf(start, 'w'));
  assert.ok(moraleOf(after, 'r') > moraleOf(start, 'r'));
  assert.ok(after.coffee < COFFEE_MAX, 'working people drink coffee');

  const empty = { ...after, coffee: 0 };
  const later = tickFun(empty, [{ id: 'r', status: 'idle' }], empty.updatedAt + 5 * MIN);
  assert.ok(moraleOf(later, 'r') < moraleOf(empty, 'r'), 'no coffee: even resting people get grumpy');
  assert.deepEqual(Object.keys(later.morale), ['r'], 'people who left are forgotten');
});

test('a long gap counts as at most ten minutes and morale stays within 0..100', () => {
  const fun = tickFun(freshFun(0), [{ id: 'w', status: 'working' }], 24 * 60 * MIN);
  assert.ok(moraleOf(fun, 'w') > 0 && moraleOf(fun, 'w') < 80);
  const rested = tickFun({ ...fun, morale: { w: 99 } }, [{ id: 'w', status: 'idle' }], fun.updatedAt + 10 * MIN);
  assert.equal(moraleOf(rested, 'w'), 100);
});

test('a cup needs coffee in the machine and counts once per ten minutes; a break refills it and lifts everyone', () => {
  const low = { ...freshFun(0), coffee: CUP - 1, morale: { a: 10 } };
  assert.equal(drinkCoffee(low, 'a', 0), low, 'not enough for a cup');
  const cup = drinkCoffee({ ...low, coffee: CUP * 2 }, 'a', 0);
  assert.equal(cup.coffee, CUP);
  assert.ok(moraleOf(cup, 'a') > 10);
  assert.equal(drinkCoffee(cup, 'a', 5 * MIN), cup, 'walking past again soon does not count');
  assert.equal(drinkCoffee(cup, 'a', 11 * MIN).coffee, 0);
  const brk = coffeeBreak(low, ['a', 'b']);
  assert.equal(brk.coffee, COFFEE_MAX);
  assert.ok(moraleOf(brk, 'a') > 10 && moraleOf(brk, 'b') === 100);
});

test('tired agents walk slower', () => {
  assert.ok(paceOf(10) < paceOf(90));
  assert.equal(paceOf(100), 1);
});

test('random events follow their odds', () => {
  const never = () => 0.999999, always = () => 0;
  assert.deepEqual(rollEvents(never, 5000, 'clear'), { drill: false, weather: 'clear' });
  assert.deepEqual(rollEvents(always, 5000, 'clear'), { drill: true, weather: 'rain' });
  assert.equal(rollEvents(never, 5000, 'rain').weather, 'rain', 'rain keeps going');
  assert.equal(rollEvents(always, 5000, 'rain').weather, 'clear');
});
