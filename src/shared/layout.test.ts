// Automatic office layout tests: `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOffice, tierFor, teamColors } from './layout.ts';
import { CATALOG, cellsOf, frontPoint, seatPoint, solidGrid, zoneAt, type OfficeItem } from './catalog.ts';

const agents = (n: number, teamOf: (i: number) => string = () => '') => Array.from({ length: n }, (_, i) => ({ id: 'a' + i, hiredAt: i, team: teamOf(i) }));

// Different sizes and team distributions
const CASES: [string, ReturnType<typeof agents>][] = [];
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 15, 20, 24, 25, 31, 40]) {
  CASES.push([`${n} people, no teams`, agents(n)]);
  CASES.push([`${n} people, 3 teams`, agents(n, i => ['Frontend', 'Backend', ''][i % 3])]);
}
CASES.push(['single 14-person team (two tables)', agents(18, i => (i < 14 ? 'Büyük' : ''))]);
CASES.push(['one-person teams get no room', agents(4, i => 'T' + i)]);

// Free cells reachable from the entrance (bottom edge center) with a 4-neighbor BFS
function reachable(grid: Uint8Array, W: number, D: number) {
  const start: [number, number] = [Math.floor(W / 2), D - 1];
  assert.equal(grid[start[1] * W + start[0]], 0, 'entrance cell must be free');
  const seen = new Uint8Array(W * D);
  const q = [start];
  seen[start[1] * W + start[0]] = 1;
  while (q.length) {
    const [x, z] = q.pop()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz, k = nz * W + nx;
      if (nx < 0 || nz < 0 || nx >= W || nz >= D || seen[k] || grid[k]) continue;
      seen[k] = 1;
      q.push([nx, nz]);
    }
  }
  return (x: number, z: number) => !!seen[Math.floor(z) * W + Math.floor(x)];
}

for (const [name, list] of CASES) {
  test(name, () => {
    const p = planOffice(list);
    const { width: W, depth: D, items } = p;

    const ids = new Set<string | undefined>();
    for (const it of items) {
      assert.ok(CATALOG[it.type], `unknown type ${it.type}`);
      assert.ok(!ids.has(it.id), `duplicate id ${it.id}`);
      ids.add(it.id);
    }

    const taken = new Map<string, string | undefined>();
    for (const it of items) {
      for (const [x, z] of cellsOf(it)) {
        assert.ok(x >= 0 && z >= 0 && x < W && z < D, `${it.id} overflows the office`);
        if (!CATALOG[it.type].solid) continue;
        const k = x + ',' + z;
        assert.ok(!taken.has(k), `${it.id} overlaps ${taken.get(k)}`);
        taken.set(k, it.id);
      }
    }

    const grid = solidGrid(items, W, D);
    const ok = reachable(grid, W, D);
    for (const a of list) {
      const seat = seatPoint(items, p.desks[a.id]!);
      assert.ok(seat, `no seat for ${a.id}`);
      assert.ok(ok(seat!.x, seat!.z), `${a.id} cannot walk to their seat`);
    }
    // Beds and sofas are approached from the nearest free cell; the front of the other spots must be reachable
    for (const it of items.filter(i => CATALOG[i.type].poi)) {
      const f = frontPoint(it, 0.5);
      assert.ok(ok(f.x, f.z), `front of ${it.id} is unreachable`);
    }
  });
}

test('tiers', () => {
  assert.deepEqual([1, 3, 4, 5, 6, 7, 8, 10, 11, 21, 25, 26].map(tierFor), [3, 3, 5, 5, 7, 7, 10, 10, 15, 25, 25, 30]);
});

test('zones by tier', () => {
  const types = (n: number) => new Set(planOffice(agents(n)).items.map(i => i.type));
  const labels = (n: number) => new Set(planOffice(agents(n)).items.filter(i => i.type === 'zone').map(i => i.label));
  assert.ok(labels(3).has('Toplantı köşesi') && !labels(3).has('Toplantı odası'), 'open meeting corner at 3 people');
  assert.ok(labels(5).has('Toplantı odası'), 'walled meeting room at 5 people');
  assert.ok(!types(5).has('dining') && types(7).has('dining') && types(7).has('pingpong'));
  assert.ok(!types(7).has('bed') && types(10).has('bed') && types(10).has('arcade'));
});

test('team room and single shared table', () => {
  const list = agents(7, i => (i < 4 ? 'Backend' : ''));
  const p = planOffice(list);
  const tables = p.items.filter(i => i.type === 'teamdesk');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0]!.seats!.map(s => s.id).sort(), list.slice(0, 4).map(a => p.desks[a.id]!).sort());
  assert.ok(p.items.some(i => i.type === 'zone' && i.label === 'Backend'));
});

test('layout and colors are stable', () => {
  const list = agents(9, i => ['Ön', 'Arka', ''][i % 3]);
  assert.deepEqual(planOffice(list), planOffice([...list].reverse()));
  const c = teamColors(list);
  const room = planOffice(list).items.find(i => i.type === 'zone' && i.label === 'Arka');
  assert.equal(room?.tint, c.get('Arka')?.tint);
});

test('CEO room and the car behind it', () => {
  for (const n of [0, 3, 10, 25]) {
    const { items, width: W, depth: D } = planOffice(agents(n, i => (i % 2 ? 'Ekip' : '')));
    const room = items.find(i => i.type === 'zone' && i.label === 'CEO odası');
    const [desk, car] = ['ceodesk', 'gclass'].map(t => items.filter(i => i.type === t)) as [OfficeItem[], OfficeItem[]];
    assert.ok(room?.z !== undefined && room.x !== undefined && room.w !== undefined, 'CEO room exists at every tier');
    assert.equal(desk.length, 1);
    assert.equal(car.length, 1);
    // The car is right behind the room's back (top) wall, within the room width
    const c = cellsOf(car[0]!);
    const carBottom = Math.max(...c.map(([, z]) => z));
    assert.ok(carBottom < room.z && room.z - carBottom <= 2, 'car is not adjacent to the back wall');
    assert.ok(c.every(([x]) => x >= room.x! && x < room.x! + room.w!), 'car is outside the room width');
    // The CEO seat must be reachable; CEO items are closed to agents
    const ok = reachable(solidGrid(items, W, D), W, D);
    const seat = frontPoint(desk[0]!, 0.45);
    assert.ok(ok(seat.x, seat.z), 'CEO seat is unreachable');
    assert.ok(items.filter(i => ['ceodesk', 'gclass', 'parking'].includes(i.type)).every(i => i.private));
  }
});

test('every zone says what kind of room it is, and zoneAt finds the room a point is in', () => {
  const agents = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, team: i < 4 ? 'Dev' : '', hiredAt: i }));
  const { items } = planOffice(agents);
  const zones = items.filter(i => i.type === 'zone');
  assert.ok(zones.every(z => z.room), 'all zones have a room kind');
  for (const room of ['ceo', 'team', 'workspace', 'coffee', 'meeting'] as const) assert.ok(zones.some(z => z.room === room), room);
  const ceo = zones.find(z => z.room === 'ceo')!;
  assert.equal(zoneAt(items, ceo.x + 2.5, ceo.z + 2.5)?.id, ceo.id);
  assert.equal(zoneAt(items, -5, -5), null);
});
