// Furniture catalog and grid geometry. Pure module (no three): shared by the server, tests and browser.
// Grid space: 1 cell = 1 unit. An item's (x, z) is its top-left cell; the footprint extends toward +x/+z.
// An item's front faces +z at rot 0.

// poi: the kind of spot idle agents go to; sit: can be sat on
interface CatalogEntry { w: number; d: number; solid: boolean; poi?: PoiKind; sit?: boolean }
export type PoiKind = 'meeting' | 'lounge' | 'coffee' | 'game' | 'dining' | 'sleep';

const CATALOG_DEF = {
  desk:       { w: 2, d: 1, solid: true },
  meeting:    { w: 2, d: 2, solid: true, poi: 'meeting' },
  whiteboard: { w: 2, d: 1, solid: true, poi: 'meeting' },
  sofa:       { w: 2, d: 1, solid: true, poi: 'lounge', sit: true },
  coffee:     { w: 1, d: 1, solid: true, poi: 'coffee' },
  cooler:     { w: 1, d: 1, solid: true, poi: 'coffee' },
  pingpong:   { w: 3, d: 2, solid: true, poi: 'game' },
  bookshelf:  { w: 2, d: 1, solid: true, poi: 'lounge' },
  plant:      { w: 1, d: 1, solid: true },
  lamp:       { w: 1, d: 1, solid: true },
  wall:       { w: 1, d: 1, solid: true },
  rug:        { w: 3, d: 2, solid: false },
  dining:     { w: 3, d: 2, solid: true, poi: 'dining' },
  kitchen:    { w: 2, d: 1, solid: true, poi: 'dining' },
  fridge:     { w: 1, d: 1, solid: true, poi: 'dining' },
  bed:        { w: 1, d: 2, solid: true, poi: 'sleep', sit: true },
  arcade:     { w: 1, d: 1, solid: true, poi: 'game' },
  teamdesk:   { w: 2, d: 2, solid: true }, // size and seats live on the item itself
  ceodesk:    { w: 3, d: 1, solid: true }, // the CEO's (player's) desk
  gclass:     { w: 2, d: 3, solid: true }, // the CEO's car; front faces +z
  parking:    { w: 1, d: 1, solid: false }, // parking floor; size lives on the item itself
  zone:       { w: 1, d: 1, solid: false }, // size, name and color live on the item itself
} satisfies Record<string, CatalogEntry>;

export type ItemType = keyof typeof CATALOG_DEF;
export const CATALOG: Record<ItemType, CatalogEntry> = CATALOG_DEF;

interface Seat { id: string; dx: number; dz: number; face: number }

/** What a zone is for; the 3D view reacts when the player walks into one (CEO room, meeting room, coffee...). */
export type RoomKind = 'ceo' | 'team' | 'workspace' | 'coffee' | 'meeting' | 'lounge' | 'dining' | 'games' | 'sleep';

/** An item on the office grid; w/d are only present on items that keep their own size (teamdesk, zone, parking). */
export interface OfficeItem {
  id?: string;
  type: ItemType;
  x: number;
  z: number;
  rot?: number;
  w?: number;
  d?: number;
  seats?: Seat[];
  label?: string;
  tint?: string;
  room?: RoomKind;
  links?: string;
  private?: boolean;
}

export interface Point { x: number; z: number; face: number }

export const POI_EMOJI: Record<PoiKind, string> = { coffee: '☕', lounge: '😌', meeting: '💡', dining: '🍽️', game: '🎮', sleep: '💤' };

export function footprint(item: OfficeItem) {
  const c = item.w ? item : CATALOG[item.type];
  const r = ((item.rot || 0) % 360 + 360) % 360;
  return r === 90 || r === 270 ? { w: c.d!, d: c.w! } : { w: c.w!, d: c.d! };
}

export function cellsOf(item: OfficeItem) {
  const { w, d } = footprint(item);
  const out: [number, number][] = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) out.push([item.x + i, item.z + j]);
  return out;
}

export function center(item: OfficeItem) {
  const { w, d } = footprint(item);
  return { x: item.x + w / 2, z: item.z + d / 2 };
}

export function frontVec(rot = 0) {
  const a = (rot * Math.PI) / 180;
  return { x: Math.round(Math.sin(a)), z: Math.round(Math.cos(a)) };
}

// Point to stand/sit in front of an item (grid space) and the facing angle there
export function frontPoint(item: OfficeItem, dist = 0.55) {
  const c = center(item);
  const f = frontVec(item.rot);
  const { w, d } = footprint(item);
  const half = f.x !== 0 ? w / 2 : d / 2;
  return {
    x: c.x + f.x * (half + dist),
    z: c.z + f.z * (half + dist),
    face: Math.atan2(-f.x, -f.z), // facing the item
  };
}

// Point where a desk owner sits: in front of a single desk, their own spot at a team desk
export function seatPoint(items: OfficeItem[], id: string): Point | null {
  for (const item of items) {
    if (item.type === 'desk' && item.id === id) return frontPoint(item, 0.45);
    const s = item.type === 'teamdesk' && item.seats?.find(x => x.id === id);
    if (s) return { x: item.x + s.dx, z: item.z + s.dz, face: s.face };
  }
  return null;
}

/** The zone (room) a floor point is in, if any; a point on a walled room's wall line counts as outside. */
export function zoneAt(items: OfficeItem[], x: number, z: number): OfficeItem | null {
  for (const item of items) {
    if (item.type !== 'zone') continue;
    const { w, d } = footprint(item);
    if (x > item.x && z > item.z && x < item.x + w && z < item.z + d) return item;
  }
  return null;
}

// Cells filled by solid items (1 = impassable)
export function solidGrid(items: OfficeItem[], W: number, D: number) {
  const grid = new Uint8Array(W * D);
  for (const item of items) {
    if (!CATALOG[item.type]?.solid) continue;
    for (const [x, z] of cellsOf(item)) if (x >= 0 && z >= 0 && x < W && z < D) grid[z * W + x] = 1;
  }
  return grid;
}
