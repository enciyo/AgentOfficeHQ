// Clay-look furniture models. Catalog and grid geometry live in catalog.ts.
// Each model is built centered in local space with its front facing +z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CATALOG, center, type OfficeItem } from '../../../shared/catalog.ts';

// ---------------------------------------------------------------- materials

const PALETTE = {
  white: '#f6f7f9',
  light: '#e4e7ec',
  mid: '#c5cbd4',
  dark: '#2a2f38',
  ink: '#1b1f26',
  leaf: '#69b578',
  leafDark: '#4f9a60',
  accent: '#3b82f6',
};

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, opts: THREE.MeshStandardMaterialParameters = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0, ...opts }));
  return matCache.get(key)!;
}

const geoCache = new Map<string, RoundedBoxGeometry>();
function rgeo(w: number, h: number, d: number, r: number) {
  r = Math.min(r, w / 2, h / 2, d / 2);
  const key = [w, h, d, r].map(v => v.toFixed(3)).join();
  if (!geoCache.has(key)) geoCache.set(key, new RoundedBoxGeometry(w, h, d, r >= 0.08 ? 2 : 1, r));
  return geoCache.get(key)!;
}

type Color = string | THREE.Material;

function add(g: THREE.Object3D, geo: THREE.BufferGeometry, color: Color, x: number, y: number, z: number, opts?: THREE.MeshStandardMaterialParameters) {
  const m = new THREE.Mesh(geo, typeof color === 'string' ? mat(color, opts) : color);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

// Rounded box; y is measured from the base
const rbox = (g: THREE.Object3D, w: number, h: number, d: number, color: Color, x = 0, y = 0, z = 0, r = 0.04, opts?: THREE.MeshStandardMaterialParameters) => add(g, rgeo(w, h, d, r), color, x, y + h / 2, z, opts);
const cyl = (g: THREE.Object3D, rt: number, rb: number, h: number, color: Color, x = 0, y = 0, z = 0, seg = 14) => add(g, new THREE.CylinderGeometry(rt, rb, h, seg), color, x, y + h / 2, z);

// Screen: shared texture showing scrolling code lines while working
export const codeTexture = (() => {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 128, 256);
  const colors = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#e2e8f0', '#f472b6'];
  for (let y = 6; y < 256; y += 9) {
    let x = 6 + ((Math.random() * 3) | 0) * 8;
    while (x < 110 && Math.random() > 0.15) {
      const w = 6 + Math.random() * 26;
      ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y, Math.min(w, 122 - x), 4);
      x += w + 4;
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 0.5);
  return t;
})();
export const screenOn = new THREE.MeshBasicMaterial({ map: codeTexture, toneMapped: false });
export const screenIdle = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.25, emissive: '#1d4ed8', emissiveIntensity: 0.08 });
export const screenOff = new THREE.MeshStandardMaterial({ color: '#151a21', roughness: 0.25 });
/** The owner has something waiting for the CEO. */
export const screenHeld = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.25, emissive: '#f59e0b', emissiveIntensity: 0.55 });

// Mercedes three-pointed star inside a ring; in the XY plane, facing +z
function mercedesStar(material: THREE.Material, R: number) {
  const star = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.1, 10, 40), material);
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3; // tips at 90°, 210°, 330°; narrow waist in between
    const r = i % 2 ? R * 0.17 : R * 0.96;
    const [x, y] = [Math.cos(a) * r, Math.sin(a) * r];
    i ? shape.lineTo(x, y) : shape.moveTo(x, y);
  }
  const blades = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: R * 0.12, bevelEnabled: false }), material);
  for (const m of [ring, blades]) { m.castShadow = true; star.add(m); }
  return star;
}

function officeChair(g: THREE.Object3D, x: number, z: number, rotY = 0) {
  const c = new THREE.Group();
  rbox(c, 0.46, 0.08, 0.44, PALETTE.dark, 0, 0.42, 0, 0.04);
  rbox(c, 0.44, 0.48, 0.07, PALETTE.dark, 0, 0.52, 0.2, 0.035).rotation.x = -0.12;
  cyl(c, 0.025, 0.025, 0.36, PALETTE.mid, 0, 0.07, 0, 10);
  for (let i = 0; i < 5; i++) {
    const leg = rbox(c, 0.04, 0.03, 0.26, PALETTE.mid, 0, 0.04, 0, 0.012);
    leg.geometry = leg.geometry.clone().translate(0, 0, 0.13);
    leg.rotation.y = (i / 5) * Math.PI * 2;
  }
  c.position.set(x, 0, z);
  c.rotation.y = rotY;
  g.add(c);
  return c;
}

// w/d are always set for items that carry their own size (teamdesk, zone, parking).
type Sized = OfficeItem & { w: number; d: number };
type Builder = (g: THREE.Group, c: { w: number; d: number }, item: Sized) => void;
const BUILDERS: Record<string, Builder> = {
  desk(g, c) {
    const W = c.w * 0.9, D = 0.72;
    rbox(g, W, 0.045, D, PALETTE.white, 0, 0.71, -0.08, 0.02);
    for (const sx of [-1, 1]) rbox(g, 0.045, 0.71, D * 0.92, PALETTE.light, sx * (W / 2 - 0.06), 0, -0.08, 0.02);
    rbox(g, W - 0.16, 0.32, 0.03, PALETTE.light, 0, 0.36, -0.4, 0.012);
    // Monitor
    rbox(g, 0.22, 0.015, 0.14, PALETTE.mid, 0, 0.755, -0.27, 0.007);
    rbox(g, 0.035, 0.2, 0.03, PALETTE.mid, 0, 0.76, -0.3, 0.012);
    rbox(g, 0.78, 0.46, 0.035, PALETTE.ink, 0, 0.88, -0.28, 0.02);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.73, 0.41), screenOff);
    scr.position.set(0, 1.11, -0.26);
    g.add(scr);
    g.userData.screen = scr;
    // Keyboard, mouse, mug, notebook
    rbox(g, 0.44, 0.018, 0.14, PALETTE.light, 0, 0.755, 0.04, 0.008);
    rbox(g, 0.06, 0.02, 0.09, PALETTE.light, 0.33, 0.755, 0.06, 0.02);
    cyl(g, 0.038, 0.034, 0.09, PALETTE.white, -0.62, 0.755, -0.05, 16);
    rbox(g, 0.18, 0.012, 0.24, '#fde68a', -0.42, 0.755, 0.02, 0.005).rotation.y = 0.2;
    officeChair(g, 0, c.d / 2 + 0.42);
  },
  // Long shared desk; a laptop and chair at every seat. The seat group carries itemId so clicking selects its owner.
  teamdesk(g, _c, item) {
    const W = item.w - 0.1, D = item.d * 0.85;
    rbox(g, W, 0.05, D, PALETTE.white, 0, 0.71, 0, 0.04);
    rbox(g, W - 0.3, 0.3, 0.04, PALETTE.light, 0, 0.38, 0, 0.015);
    for (const sx of [-1, 1]) rbox(g, 0.06, 0.71, D - 0.2, PALETTE.light, sx * (W / 2 - 0.12), 0, 0, 0.02);
    g.userData.screens = new Map();
    for (const s of item.seats!) {
      const seat = new THREE.Group();
      const top = s.dz < item.d / 2;
      seat.position.set(s.dx - item.w / 2, 0, top ? -item.d / 2 : item.d / 2);
      seat.rotation.y = top ? Math.PI : 0;
      seat.userData.itemId = s.id;
      // Laptop: base + screen facing the sitter
      rbox(seat, 0.42, 0.018, 0.3, PALETTE.mid, 0, 0.755, -0.38, 0.01);
      const lid = new THREE.Group();
      lid.position.set(0, 0.77, -0.53);
      lid.rotation.x = -0.25;
      rbox(lid, 0.42, 0.28, 0.015, PALETTE.ink, 0, 0, 0, 0.01);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), screenOff);
      scr.position.set(0, 0.14, 0.009);
      lid.add(scr);
      seat.add(lid);
      g.userData.screens.set(s.id, scr);
      cyl(seat, 0.038, 0.034, 0.09, PALETTE.white, 0.3, 0.755, -0.3, 16);
      officeChair(seat, 0, 0.42);
      g.add(seat);
    }
  },
  // Executive desk: dark walnut, large monitor, leather chair; two visitor chairs on the opposite side
  ceodesk(g, c) {
    const W = c.w * 0.92, D = 0.9, top = '#7a5a43', body = '#5b4332';
    rbox(g, W, 0.06, D, top, 0, 0.7, -0.05, 0.025);
    for (const sx of [-1, 1]) rbox(g, 0.5, 0.7, D - 0.06, body, sx * (W / 2 - 0.25), 0, -0.05, 0.02);
    rbox(g, W - 1, 0.5, 0.04, body, 0, 0.2, -0.47, 0.015);
    rbox(g, 0.3, 0.015, 0.18, PALETTE.mid, 0, 0.76, -0.33, 0.007);
    rbox(g, 0.04, 0.24, 0.03, PALETTE.mid, 0, 0.76, -0.36, 0.012);
    rbox(g, 1.05, 0.58, 0.035, PALETTE.ink, 0, 0.9, -0.34, 0.02);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.53), screenIdle);
    scr.position.set(0, 1.19, -0.32);
    g.add(scr);
    rbox(g, 0.46, 0.018, 0.15, PALETTE.light, 0, 0.76, 0.05, 0.008);
    rbox(g, 0.34, 0.03, 0.24, '#1f2937', 0.85, 0.76, -0.05, 0.01); // leather notebook
    cyl(g, 0.04, 0.036, 0.1, '#ffffff', -0.85, 0.76, 0.0, 16);
    cyl(g, 0.06, 0.05, 0.05, '#c9a227', -0.55, 0.76, -0.25, 16); // gold pen holder
    // Leather executive chair (high back)
    const chair = new THREE.Group();
    const leather = '#2b2522';
    rbox(chair, 0.62, 0.12, 0.56, leather, 0, 0.42, 0, 0.06);
    rbox(chair, 0.6, 0.85, 0.12, leather, 0, 0.5, 0.26, 0.06).rotation.x = -0.1;
    for (const sx of [-1, 1]) rbox(chair, 0.08, 0.2, 0.42, leather, sx * 0.31, 0.54, 0.02, 0.03);
    cyl(chair, 0.03, 0.03, 0.36, PALETTE.mid, 0, 0.07, 0, 10);
    for (let i = 0; i < 5; i++) {
      const leg = rbox(chair, 0.05, 0.035, 0.3, PALETTE.mid, 0, 0.04, 0, 0.015);
      leg.geometry = leg.geometry.clone().translate(0, 0, 0.15);
      leg.rotation.y = (i / 5) * Math.PI * 2;
    }
    chair.position.set(0, 0, c.d / 2 + 0.45);
    g.add(chair);
    for (const x of [-0.55, 0.55]) officeChair(g, x, -c.d / 2 - 0.65, Math.PI);
  },
  // Parking floor: dark gray asphalt, white lines, "CEO" lettering
  parking(g, _c, item) {
    const cv = document.createElement('canvas');
    cv.width = item.w * 64;
    cv.height = item.d * 64;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#c3c8d0';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 10, cv.width - 20, cv.height - 20);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '700 46px ui-sans-serif, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('CEO', cv.width - 22, cv.height - 18);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const pad = add(g, new THREE.PlaneGeometry(item.w - 0.1, item.d - 0.1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }), 0, 0.005, 0);
    pad.rotation.x = -Math.PI / 2;
    pad.castShadow = false;
  },
  // Boxy luxury SUV (G-Class inspired): upright windshield, round headlights, spare tire on the rear door.
  // Length runs along local z, front is +z. Built at 80% scale to fit in 3 cells.
  gclass(root) {
    const g = new THREE.Group();
    g.scale.setScalar(0.8);
    root.add(g);
    // Without an environment map, metalness darkens the paint; slightly metallic, clearly dark gray
    const paint = mat('#2a2f37', { roughness: 0.38, metalness: 0.12 });
    const black = mat('#111316', { roughness: 0.75 });
    const glass = mat('#3b4a60', { roughness: 0.1, metalness: 0.2 });
    const chrome = mat('#d4d9e1', { roughness: 0.2, metalness: 0.85 });
    const lamp = mat('#f8fafc', { emissive: '#e0f2fe', emissiveIntensity: 0.9 });
    const L = 3.8, W = 1.78;
    // Body, hood and cabin
    add(g, rgeo(W, 0.78, L, 0.08), paint, 0, 0.78, 0);
    add(g, rgeo(W - 0.04, 0.08, 1.2, 0.04), paint, 0, 1.2, L / 2 - 0.62);
    const cabZ = -0.55, cabL = 2.55;
    add(g, rgeo(W - 0.06, 0.62, cabL, 0.06), glass, 0, 1.5, cabZ);
    add(g, rgeo(W - 0.02, 0.1, cabL + 0.04, 0.05), paint, 0, 1.85, cabZ);
    for (const z of [cabZ + cabL / 2 - 0.04, cabZ + 0.15, cabZ - cabL / 2 + 0.05]) add(g, rgeo(W - 0.01, 0.62, 0.1, 0.02), paint, 0, 1.5, z);
    for (const sx of [-1, 1]) add(g, rgeo(0.06, 0.05, cabL - 0.3, 0.02), black, sx * (W / 2 - 0.18), 1.92, cabZ); // roof rails
    // Front: grille, round headlights, indicators, bumper
    const front = L / 2;
    add(g, rgeo(0.95, 0.42, 0.05, 0.02), black, 0, 0.88, front + 0.01);
    // Grille slats are cut on both sides of the central star
    for (const y of [0.76, 0.88, 1.0]) for (const sx of [-1, 1]) add(g, rgeo(0.25, 0.025, 0.02, 0.005), chrome, sx * 0.3, y, front + 0.04);
    const badge = mercedesStar(chrome, 0.15);
    badge.position.set(0, 0.88, front + 0.05);
    g.add(badge);
    for (const sx of [-1, 1]) {
      const hl = add(g, new THREE.CylinderGeometry(0.13, 0.13, 0.06, 24), chrome, sx * 0.64, 0.9, front + 0.02);
      hl.rotation.x = Math.PI / 2;
      const lens = add(g, new THREE.CylinderGeometry(0.1, 0.1, 0.02, 24), lamp, sx * 0.64, 0.9, front + 0.06);
      lens.rotation.x = Math.PI / 2;
      add(g, rgeo(0.18, 0.06, 0.12, 0.02), mat('#fbbf24', { emissive: '#f59e0b', emissiveIntensity: 0.3 }), sx * 0.7, 1.19, front - 0.1); // fender indicator
      add(g, rgeo(0.06, 0.12, 0.2, 0.02), paint, sx * (W / 2 + 0.06), 1.33, front - 1.3); // mirror
      add(g, rgeo(0.16, 0.14, 0.05, 0.02), mat('#dc2626', { emissive: '#b91c1c', emissiveIntensity: 0.4 }), sx * 0.72, 0.95, -front - 0.01); // taillight
      add(g, rgeo(0.08, 0.05, 2.1, 0.02), black, sx * (W / 2 + 0.05), 0.32, -0.15); // running board
    }
    add(g, rgeo(W + 0.08, 0.22, 0.22, 0.06), black, 0, 0.45, front + 0.06);
    add(g, rgeo(W + 0.08, 0.22, 0.2, 0.06), black, 0, 0.45, -front - 0.05);
    // Wheels and wide fenders
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (W / 2 - 0.08), z = sz * 1.22;
      add(g, rgeo(0.16, 0.42, 0.92, 0.05), black, sx * (W / 2 + 0.03), 0.78, z);
      const tire = add(g, new THREE.CylinderGeometry(0.37, 0.37, 0.3, 28), black, x, 0.37, z);
      tire.rotation.z = Math.PI / 2;
      const rim = add(g, new THREE.CylinderGeometry(0.22, 0.22, 0.31, 20), chrome, x + sx * 0.01, 0.37, z);
      rim.rotation.z = Math.PI / 2;
    }
    // Spare tire on the rear door
    const spare = add(g, new THREE.CylinderGeometry(0.36, 0.36, 0.24, 28), black, 0.1, 1.05, -front - 0.14);
    spare.rotation.x = Math.PI / 2;
    const cover = add(g, new THREE.CylinderGeometry(0.27, 0.27, 0.02, 28), paint, 0.1, 1.05, -front - 0.27);
    cover.rotation.x = Math.PI / 2;
    const rearBadge = mercedesStar(chrome, 0.15);
    rearBadge.position.set(0.1, 1.05, -front - 0.28);
    rearBadge.rotation.y = Math.PI;
    g.add(rearBadge);
  },
  meeting(g, c) {
    rbox(g, c.w * 0.82, 0.05, c.d * 0.62, PALETTE.white, 0, 0.71, 0, 0.12);
    rbox(g, 0.5, 0.7, 0.3, PALETTE.light, 0, 0.01, 0, 0.06);
    for (const [x, z, r] of [[-0.45, 0.85, 0], [0.45, 0.85, 0], [-0.45, -0.85, Math.PI], [0.45, -0.85, Math.PI]]) officeChair(g, x, z, r);
  },
  whiteboard(g, c) {
    const W = c.w * 0.86;
    rbox(g, W, 0.95, 0.04, '#ffffff', 0, 0.85, -0.3, 0.02);
    rbox(g, W + 0.05, 0.04, 0.08, PALETTE.mid, 0, 0.82, -0.27, 0.015);
    for (const sx of [-1, 1]) rbox(g, 0.04, 1.85, 0.04, PALETTE.mid, sx * (W / 2 + 0.01), 0, -0.3, 0.015);
    const notes = [['#fde68a', -0.55, 1.5], ['#bfdbfe', -0.3, 1.5], ['#fbcfe8', -0.55, 1.25], ['#bbf7d0', 0.1, 1.45]] as const;
    for (const [col, x, y] of notes) rbox(g, 0.18, 0.18, 0.01, col, x, y, -0.275, 0.004);
    rbox(g, 0.5, 0.012, 0.005, PALETTE.dark, 0.45, 1.6, -0.275, 0.002);
    rbox(g, 0.36, 0.012, 0.005, PALETTE.dark, 0.38, 1.5, -0.275, 0.002);
    rbox(g, 0.42, 0.012, 0.005, PALETTE.accent, 0.42, 1.4, -0.275, 0.002);
  },
  sofa(g, c) {
    const W = c.w * 0.94;
    rbox(g, W, 0.22, 0.78, PALETTE.mid, 0, 0.06, 0, 0.08);
    rbox(g, W - 0.34, 0.14, 0.6, PALETTE.light, 0, 0.26, 0.06, 0.07);
    rbox(g, W, 0.42, 0.2, PALETTE.mid, 0, 0.26, -0.29, 0.09);
    for (const sx of [-1, 1]) rbox(g, 0.18, 0.3, 0.78, PALETTE.mid, sx * (W / 2 - 0.09), 0.2, 0, 0.08);
    rbox(g, 0.3, 0.26, 0.1, '#fca5a5', -0.5, 0.36, -0.12, 0.05).rotation.z = 0.15;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, 0.03, 0.03, 0.06, PALETTE.dark, sx * (W / 2 - 0.1), 0, sz * 0.3, 8);
  },
  coffee(g) {
    rbox(g, 0.9, 0.86, 0.6, PALETTE.white, 0, 0, -0.12, 0.03);
    rbox(g, 0.92, 0.04, 0.62, PALETTE.light, 0, 0.86, -0.12, 0.015);
    rbox(g, 0.32, 0.42, 0.3, PALETTE.ink, -0.12, 0.9, -0.2, 0.05);
    rbox(g, 0.12, 0.05, 0.1, PALETTE.mid, -0.12, 1.12, -0.03, 0.015);
    cyl(g, 0.035, 0.03, 0.08, PALETTE.white, -0.12, 0.9, -0.04, 14);
    cyl(g, 0.035, 0.03, 0.08, '#fca5a5', 0.22, 0.9, -0.08, 14);
    cyl(g, 0.035, 0.03, 0.08, '#bfdbfe', 0.32, 0.9, -0.22, 14);
  },
  cooler(g) {
    rbox(g, 0.38, 0.95, 0.38, PALETTE.white, 0, 0, 0, 0.05);
    rbox(g, 0.12, 0.05, 0.04, PALETTE.mid, 0, 0.62, 0.19, 0.015);
    const bottle = cyl(g, 0.15, 0.15, 0.42, PALETTE.accent, 0, 0.95, 0, 24);
    bottle.material = new THREE.MeshPhysicalMaterial({ color: '#93c5fd', roughness: 0.1, transmission: 0.6, thickness: 0.3, transparent: true, opacity: 0.85 });
  },
  pingpong(g, c) {
    rbox(g, c.w * 0.86, 0.05, c.d * 0.76, '#3b82f6', 0, 0.7, 0, 0.02);
    rbox(g, c.w * 0.86, 0.052, 0.015, '#ffffff', 0, 0.7, 0, 0.005);
    rbox(g, 0.02, 0.14, c.d * 0.8, PALETTE.white, 0, 0.75, 0, 0.008);
    for (const [x, z] of [[-1, -0.55], [1, -0.55], [-1, 0.55], [1, 0.55]]) rbox(g, 0.06, 0.7, 0.06, PALETTE.light, x, 0, z, 0.02);
    cyl(g, 0.02, 0.02, 0.04, '#fb923c', 0.4, 0.75, 0.2, 10);
  },
  bookshelf(g, c) {
    const W = c.w * 0.88, H = 1.75, D = 0.36;
    rbox(g, W, 0.04, D, PALETTE.white, 0, 0, -0.26, 0.015);
    rbox(g, W, 0.04, D, PALETTE.white, 0, H - 0.04, -0.26, 0.015);
    for (const sx of [-1, 1]) rbox(g, 0.04, H, D, PALETTE.white, sx * (W / 2 - 0.02), 0, -0.26, 0.015);
    rbox(g, W, H, 0.02, PALETTE.light, 0, 0, -0.43, 0.01);
    const tones = [PALETTE.mid, PALETTE.light, '#93c5fd', '#fca5a5', PALETTE.dark, '#fde68a'];
    for (let s = 0; s < 4; s++) {
      const y = 0.04 + s * 0.42;
      if (s) rbox(g, W - 0.06, 0.03, D, PALETTE.white, 0, y - 0.03, -0.26, 0.01);
      let x = -W / 2 + 0.08;
      const end = W / 2 - 0.12 - Math.random() * 0.35;
      while (x < end) {
        const bw = 0.05 + Math.random() * 0.05, bh = 0.26 + Math.random() * 0.08;
        rbox(g, bw, bh, 0.24, tones[(Math.random() * tones.length) | 0], x + bw / 2, y, -0.24, 0.008);
        x += bw + 0.008;
      }
    }
  },
  plant(g) {
    cyl(g, 0.19, 0.14, 0.34, PALETTE.white, 0, 0, 0, 24);
    cyl(g, 0.17, 0.17, 0.02, '#8b6b4a', 0, 0.32, 0, 20);
    const leaves = [mat(PALETTE.leaf, { flatShading: true }), mat(PALETTE.leafDark, { flatShading: true })];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16 + Math.random() * 0.07, 0), leaves[i % 2]);
      const a = (i / 6) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.1, 0.5 + (i % 3) * 0.13, Math.sin(a) * 0.1);
      m.rotation.set(Math.random(), Math.random(), Math.random());
      m.castShadow = true;
      g.add(m);
    }
  },
  lamp(g) {
    cyl(g, 0.18, 0.18, 0.03, PALETTE.white, 0, 0, 0, 24);
    cyl(g, 0.018, 0.018, 1.45, PALETTE.mid, 0, 0, 0, 10);
    const shade = cyl(g, 0.13, 0.22, 0.26, PALETTE.white, 0, 1.4, 0, 28);
    shade.material = mat('#fff7e6', { emissive: '#ffe4b5', emissiveIntensity: 0.35 });
    const light = new THREE.PointLight('#ffe2b0', 1.6, 4.5, 1.8);
    light.position.set(0, 1.35, 0);
    g.add(light);
  },
  // Room wall: arms extend from the cell center toward neighboring wall cells. A single-link end (door edge) continues straight.
  wall(g, _c, item) {
    const H = 1.05, T = 0.12;
    let links = item.links || '';
    if (links.length === 1) links += ({ n: 's', s: 'n', e: 'w', w: 'e' } as Record<string, string>)[links];
    rbox(g, T, H, T, PALETTE.white, 0, 0, 0, 0.03);
    const arm: Record<string, number[]> = { n: [0, -0.25, T, 0.5], s: [0, 0.25, T, 0.5], e: [0.25, 0, 0.5, T], w: [-0.25, 0, 0.5, T] };
    for (const k of links) {
      const [x, z, w, d] = arm[k] as [number, number, number, number];
      rbox(g, w + 0.02, H, d + 0.02, PALETTE.white, x, 0, z, 0.03);
    }
  },
  // Floor zone: lightly tinted base and the zone name written on the lower corridor
  zone(g, _c, item) {
    const floor = add(g, new THREE.PlaneGeometry(item.w - 0.1, item.d - 0.1), mat(item.tint || PALETTE.light, { roughness: 0.95 }), 0, 0.004, 0);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;
    if (!item.label) return;
    const text = item.label.toLocaleUpperCase('tr-TR');
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d')!;
    const font = '600 44px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.font = font;
    cv.width = Math.ceil(ctx.measureText(text).width) + 16;
    cv.height = 64;
    ctx.font = font;
    ctx.fillStyle = 'rgba(15,23,42,0.42)';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const h = 0.36, w = (h * cv.width) / cv.height;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    label.rotation.x = -Math.PI / 2;
    label.position.set(-item.w / 2 + w / 2 + 0.1, 0.006, item.d / 2 + 0.35);
    label.userData.focusZone = item.id; // clicking sends the camera to the room
    g.add(label);
  },
  dining(g, c) {
    const W = c.w * 0.9, wood = '#e7d3b5';
    rbox(g, W, 0.05, 0.95, wood, 0, 0.72, 0, 0.03);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) rbox(g, 0.06, 0.72, 0.06, '#c9b08c', sx * (W / 2 - 0.12), 0, sz * 0.36, 0.02);
    for (const x of [-0.9, 0, 0.9]) for (const sz of [-1, 1]) {
      cyl(g, 0.17, 0.17, 0.05, PALETTE.dark, x, 0.44, sz * 0.75, 20);
      cyl(g, 0.025, 0.025, 0.44, PALETTE.mid, x, 0, sz * 0.75, 8);
      cyl(g, 0.13, 0.13, 0.012, '#ffffff', x, 0.77, sz * 0.25, 20);
    }
    cyl(g, 0.05, 0.04, 0.16, '#86efac', 0, 0.77, 0, 12);
  },
  kitchen(g, c) {
    const W = c.w * 0.94;
    rbox(g, W, 0.86, 0.6, PALETTE.white, 0, 0, -0.12, 0.03);
    rbox(g, W + 0.02, 0.04, 0.62, PALETTE.mid, 0, 0.86, -0.12, 0.015);
    for (const x of [-0.45, 0.45]) rbox(g, 0.86, 0.74, 0.01, PALETTE.light, x, 0.06, 0.185, 0.01);
    rbox(g, 0.5, 0.02, 0.36, '#cbd5e1', -0.4, 0.9, -0.12, 0.04);
    cyl(g, 0.015, 0.015, 0.22, PALETTE.mid, -0.4, 0.9, -0.33, 8);
    rbox(g, 0.5, 0.3, 0.36, PALETTE.ink, 0.45, 0.9, -0.16, 0.03);
    rbox(g, 0.3, 0.2, 0.01, '#334155', 0.4, 0.95, 0.025, 0.01);
  },
  fridge(g) {
    rbox(g, 0.8, 1.85, 0.66, '#f8fafc', 0, 0, -0.1, 0.06);
    rbox(g, 0.78, 0.012, 0.01, PALETTE.mid, 0, 1.2, 0.235, 0.004);
    for (const y of [0.55, 1.35]) rbox(g, 0.03, 0.3, 0.04, PALETTE.mid, 0.3, y, 0.25, 0.012);
    rbox(g, 0.12, 0.12, 0.01, '#fde68a', -0.15, 1.45, 0.236, 0.004);
  },
  bed(g, c) {
    const W = c.w * 0.9, L = c.d * 0.94;
    rbox(g, W, 0.28, L, PALETTE.mid, 0, 0.06, 0, 0.06);
    rbox(g, W - 0.06, 0.16, L - 0.08, '#ffffff', 0, 0.32, 0, 0.07);
    rbox(g, W, 0.75, 0.1, PALETTE.light, 0, 0.06, -L / 2 + 0.05, 0.05);
    rbox(g, W - 0.24, 0.12, 0.3, '#ffffff', 0, 0.46, -L / 2 + 0.3, 0.06);
    rbox(g, W - 0.02, 0.06, L * 0.6, '#93c5fd', 0, 0.45, L * 0.18, 0.04);
  },
  arcade(g) {
    const body = '#312e81';
    rbox(g, 0.7, 1.55, 0.62, body, 0, 0, -0.06, 0.05);
    rbox(g, 0.72, 0.18, 0.66, '#f472b6', 0, 1.55, -0.06, 0.04);
    rbox(g, 0.66, 0.08, 0.34, '#1e1b4b', 0, 0.95, 0.18, 0.02).rotation.x = 0.25;
    for (const [x, col] of [[-0.15, '#ef4444'], [0.05, '#facc15'], [0.17, '#22c55e']] as const) cyl(g, 0.03, 0.03, 0.04, col, x, 1.0, 0.2, 10);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.42), new THREE.MeshBasicMaterial({ map: codeTexture, toneMapped: false }));
    scr.position.set(0, 1.27, 0.255);
    scr.rotation.x = -0.12;
    g.add(scr);
  },
  rug(g, c) {
    const m = add(g, rgeo(c.w * 0.94, 0.02, c.d * 0.92, 0.01), mat('#dbe3ee', { roughness: 1 }), 0, 0.01, 0);
    m.castShadow = false;
    const inner = add(g, rgeo(c.w * 0.8, 0.022, c.d * 0.72, 0.01), mat('#c9d5e5', { roughness: 1 }), 0, 0.012, 0);
    inner.castShadow = false;
  },
};

export function buildItemMesh(item: OfficeItem) {
  const c = CATALOG[item.type];
  const g = new THREE.Group();
  BUILDERS[item.type]?.(g, c, { ...item, w: item.w ?? c.w, d: item.d ?? c.d });
  const ctr = center(item);
  g.position.set(ctr.x, 0, ctr.z);
  g.rotation.y = ((item.rot || 0) * Math.PI) / 180;
  g.userData.itemId = item.id;
  return g;
}
