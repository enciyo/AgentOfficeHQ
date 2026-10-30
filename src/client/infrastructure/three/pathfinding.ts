// Walking on the office grid: A* in 8 directions, the nearest free cell, and keeping out of each other's way. Pure, no three.js.
export type Cell = [number, number];
interface PathNode { x: number; z: number; g: number; f: number; parent: PathNode | null }

export function findPath(grid: Uint8Array, W: number, D: number, sx: number, sz: number, tx: number, tz: number): Cell[] | null {
  const free = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < D && !grid[z * W + x];
  const key = (x: number, z: number) => z * W + x;
  // If the target is blocked, go to the nearest free cell
  if (!free(tx, tz)) {
    const near = nearestFree(grid, W, D, tx, tz);
    if (!near) return null;
    [tx, tz] = near;
  }
  const open = new Map<number, PathNode>([[key(sx, sz), { x: sx, z: sz, g: 0, f: 0, parent: null }]]);
  const closed = new Set<number>();
  const h = (x: number, z: number) => Math.hypot(tx - x, tz - z);
  while (open.size) {
    let cur: PathNode | null = null;
    for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
    if (!cur) break;
    if (cur.x === tx && cur.z === tz) {
      const path: Cell[] = [];
      for (let n: PathNode | null = cur; n; n = n.parent) path.unshift([n.x, n.z]);
      return path;
    }
    open.delete(key(cur.x, cur.z));
    closed.add(key(cur.x, cur.z));
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = cur.x + dx, nz = cur.z + dz, k = key(nx, nz);
      if (!free(nx, nz) || closed.has(k)) continue;
      if (dx && dz && (!free(cur.x + dx, cur.z) || !free(cur.x, cur.z + dz))) continue; // corner cutting
      const g = cur.g + (dx && dz ? 1.414 : 1);
      const ex = open.get(k);
      if (!ex || g < ex.g) open.set(k, { x: nx, z: nz, g, f: g + h(nx, nz), parent: cur });
    }
    if (closed.size > W * D) break;
  }
  return null;
}

export function nearestFree(grid: Uint8Array, W: number, D: number, x: number, z: number): Cell | null {
  const seen = new Set([z * W + x]);
  const q: Cell[] = [[x, z]];
  while (q.length) {
    const [cx, cz] = q.shift()!;
    if (cx >= 0 && cz >= 0 && cx < W && cz < D && !grid[cz * W + cx]) return [cx, cz];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < -1 || nz < -1 || nx > W || nz > D || seen.has(nz * W + nx)) continue;
      seen.add(nz * W + nx);
      q.push([nx, nz]);
    }
  }
  return null;
}

/** Whether a point keeps its distance from all the others. */
export function clearOf(point: { x: number; z: number }, others: { x: number; z: number }[], distance: number) {
  return others.every(o => Math.hypot(o.x - point.x, o.z - point.z) >= distance);
}

/**
 * The way two people pressed together are pushed apart, as a unit vector from one to the other. While someone walks it
 * leans sideways: each goes to their own right, so people who meet head-on pass instead of pushing straight at each other.
 */
export function passingPush(nx: number, nz: number, walking: boolean): [number, number] {
  if (!walking) return [nx, nz];
  const x = nx - nz, z = nz + nx; // 45° to the side
  const length = Math.hypot(x, z);
  return [x / length, z / length];
}
