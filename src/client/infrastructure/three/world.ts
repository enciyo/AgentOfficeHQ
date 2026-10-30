// 3D office: scene, avatars, player character, pathfinding and office editor.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CATALOG, POI_EMOJI, type OfficeItem, type PoiKind, seatPoint, solidGrid, footprint, frontPoint, frontVec, center, zoneAt } from '../../../shared/catalog.ts';
import { createT, DEFAULT_LOCALE, type Translate } from '../../../shared/i18n/index.ts';
import { TASK_DRAG_TYPE, type KeyValueStorage, type PlayerActionMode, type StageCallbacks } from '../../application/ports.ts';
import type { Attention } from '../../domain/attention.ts';
import type { Office, PublicAgent, Visitor } from '../../../shared/types.ts';
import type { Weather } from '../../domain/fun.ts';
import { QUALITY_LEVELS, defaultGraphics, type Graphics } from '../../domain/quality.ts';
import type { StandupLine } from '../../domain/views.ts';
import { Avatar, rand, type Goal } from './avatar.ts';
import { mergeParts, takeParts } from './mergeStatics.ts';
import { clearOf, findPath, nearestFree, passingPush } from './pathfinding.ts';
import { isModalOpen } from './playerControls.ts';
import { buildItemMesh, codeTexture, screenOn, screenIdle, screenOff, screenHeld } from './furniture.ts';

const PLAYER_SPEED = 2.6;
const PLAYER_RUN = 4.4;
const TALK_RANGE = 1.8;
const KICK_RANGE = 1.8;
const PLANT_RANGE = 12;
const CONFETTI_RADIUS = 3.5;
const PLAYER_ID = '__player';
const VISITOR_PREFIX = 'visitor:';
const BG = { clear: '#e2e5ea', rain: '#c4cbd5', alarm: '#f6c9c9' };
const BG_DARK = { clear: '#1a1f28', rain: '#141922', alarm: '#5c2a30' };
const pickOne = <T,>(arr: T[]) => arr[(Math.random() * arr.length) | 0];
const pickWeighted = <K,>(entries: [K, number][]) => {
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries.at(-1)?.[0];
};

const MAX_LAMP_LIGHTS = 4;
const CONFETTI_GEOMETRY = new THREE.BoxGeometry(0.065, 0.11, 0.025);
const CONFETTI_MATERIALS = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'].map(color => new THREE.MeshBasicMaterial({ color }));

interface ConfettiPiece { mesh: THREE.Mesh; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; life: number }

// ---------------------------------------------------------------- world

interface WorldCallbacks extends StageCallbacks {
  /** Where avatar positions are remembered across page reloads. */
  storage?: KeyValueStorage;
}


/** How far apart two people stay: a little more than an avatar is wide. */
const PERSONAL_SPACE = 0.62;
/** No idle spot this close to one that is taken. */
const SPOT_CLEARANCE = 0.75;
const SLIP_PAST_MS = 2500;
const COVERED_FRAME_MS = 200;
const GTAO_LOOK = { radius: 0.45, distanceExponent: 1.5, thickness: 1, scale: 1.1 };
const POSITIONS_KEY = 'agent-office:positions';
const POSITIONS_SAVE_MS = 2000;

export class World {
  private bg: typeof BG = BG;
  private mergedMeshes: THREE.Mesh[] = [];
  private level = defaultGraphics(false).level;
  private quality = QUALITY_LEVELS[this.level]!;
  private autoQuality = true;
  private framesSinceShadow = 0;
  private covered = false;
  container: HTMLElement;
  cb: StageCallbacks;
  office!: Office; // undefined until setOffice() builds it for the first time
  avatars = new Map<string, Avatar>();
  agents = new Map<string, PublicAgent>();
  attention: Record<string, Attention> = {};
  itemMeshes = new Map<string, THREE.Object3D>();
  flights: any[] = [];
  private confetti: ConfettiPiece[] = [];
  selectedAgentId: string | null = null;
  keys = new Set<string>();
  follow = true;
  nearId: string | null = null;
  actionMode: PlayerActionMode = 'none';
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  userOrbiting = false;
  camFly: any = null;
  sun: THREE.DirectionalLight;
  root: THREE.Group;
  staticGroup: THREE.Group;
  itemGroup: THREE.Group;
  agentGroup: THREE.Group;
  fxGroup: THREE.Group;
  composer: EffectComposer;
  gtao: GTAOPass;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  clock = new THREE.Clock();
  grid: Uint8Array = new Uint8Array(0);
  player!: Avatar;
  playerInfo?: { name?: string; color?: string };
  perf?: { time: number; frames: number; slow: number };
  /** Idle spots (a sofa seat, a bed, a place in front of the coffee machine) held by one avatar each. */
  private readonly spotClaims = new Map<string, string>();
  /** Where each claimed spot is: two items' spots can lie side by side, and nobody stands in someone else's place. */
  private readonly claimedPoints = new Map<string, { x: number; z: number }>();
  /** Since when two avatars have been pressed together, by pair. */
  private readonly contacts = new Map<string, number>();
  t: Translate = createT(DEFAULT_LOCALE);

  /** GitHub visitors at the door, by visitor id. */
  private readonly visitors = new Map<string, Avatar>();
  private visitorList: Visitor[] = [];
  private morale: Record<string, number> = {};
  private weather: Weather = 'clear';
  private rain: THREE.LineSegments | null = null;
  private alarmUntil = 0;
  /** Zone id the player is in; undefined until the first frame (no "entered" event at page load). */
  private roomId: string | null | undefined = undefined;
  private dropTarget: string | null = null;

  /** Last known floor position per avatar id (x, z), restored after a reload. */
  private positions: Record<string, [number, number]> = {};
  private positionsJson = '';
  private positionsSavedAt = 0;
  private storage?: KeyValueStorage;

  constructor(container: HTMLElement, { storage, ...callbacks }: WorldCallbacks) {
    this.container = container;
    this.storage = storage;
    try { this.positions = JSON.parse(storage?.get(POSITIONS_KEY) ?? '{}') ?? {}; } catch {}
    this.positionsJson = JSON.stringify(this.positions);
    addEventListener('pagehide', () => this.savePositions());
    this.cb = callbacks;
    this.avatars = new Map();
    this.agents = new Map();
    this.itemMeshes = new Map();
    this.flights = [];
    this.selectedAgentId = null;
    this.keys = new Set();
    this.follow = true;
    this.nearId = null;

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality.pixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#e2e5ea');

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.camera.position.set(14, 17, 19);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.2;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 50;
    this.controls.addEventListener('start', () => { this.userOrbiting = true; this.camFly = null; });
    this.controls.addEventListener('end', () => { this.userOrbiting = false; });

    scene.add(new THREE.HemisphereLight('#ffffff', '#d5dae3', 1.5));
    const sun = (this.sun = new THREE.DirectionalLight('#ffffff', 2.1));
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.quality.shadows, this.quality.shadows);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.08 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    scene.add(ground);

    this.root = new THREE.Group(); // grid space
    scene.add(this.root);
    this.staticGroup = new THREE.Group();
    this.itemGroup = new THREE.Group();
    this.agentGroup = new THREE.Group();
    this.fxGroup = new THREE.Group();
    this.root.add(this.staticGroup, this.itemGroup, this.agentGroup, this.fxGroup);

    // Final pass: soft ambient occlusion (GTAO) gives the "clay" look
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.quality.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.gtao = new GTAOPass(scene, this.camera, 1, 1);
    this.gtao.updateGtaoMaterial({ ...GTAO_LOOK, samples: this.quality.occlusion });
    this.gtao.blendIntensity = 0.85;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.bindInput();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.clock = new THREE.Clock();
    requestAnimationFrame(this.loop);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------ office

  setOffice(office: Office) {
    const first = !this.office;
    const sizeChanged = !first && (office.width !== this.office.width || office.depth !== this.office.depth);
    this.office = structuredClone(office);
    const { width: W, depth: D } = office;
    const oldRoot = this.root.position.clone();
    this.root.position.set(-W / 2, 0, -D / 2);

    this.staticGroup.clear();
    // Floor: light tile with a fine grid
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = office.floorColor;
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = 'rgba(15,23,42,0.07)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, 62.5, 62.5);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(W, D);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    floor.receiveShadow = true;
    this.staticGroup.add(floor);

    // Floor plinth and thin accent edge
    const slab = new THREE.Mesh(new RoundedBoxGeometry(W + 0.4, 0.3, D + 0.4, 4, 0.1), new THREE.MeshStandardMaterial({ color: office.wallColor, roughness: 0.7 }));
    slab.position.set(W / 2, -0.152, D / 2);
    slab.receiveShadow = slab.castShadow = true;
    this.staticGroup.add(slab);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(W, 0.012, 0.06), new THREE.MeshBasicMaterial({ color: '#3b82f6' }));
    edge.position.set(W / 2, 0.006, D - 0.03);
    this.staticGroup.add(edge);

    // Shadow camera should cover the office
    const m = Math.max(W, D);
    const r = m * 0.75;
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 80 });
    this.sun.shadow.camera.updateProjectionMatrix();

    this.rebuildItems();
    if (first) {
      this.camera.position.set(m * 0.42, m * 0.72, m * 0.82);
      this.controls.target.set(0, 0, 0);
    } else if (sizeChanged) {
      // When the office grows the root is re-centered; shift the camera the same amount so the view does not jump
      const shift = this.root.position.clone().sub(oldRoot);
      this.camera.position.add(shift);
      this.controls.target.add(shift);
    }
    for (const av of this.allAvatars()) {
      av.goalKey = '';
      av.idleGoal = null;
      if (av.x > W || av.z > D) av.group.position.set(W / 2, 0, D - 0.5);
      // When the layout changes, step out to the nearest free cell if inside an item/wall
      const cx = Math.floor(av.x), cz = Math.floor(av.z);
      if (this.grid[cz * W + cx]) {
        const free = nearestFree(this.grid, W, D, cx, cz);
        if (free) av.group.position.set(free[0] + 0.5, 0, free[1] + 0.5);
      }
      av.path = [];
    }
    if (!this.player) this.spawnPlayer();
    this.setVisitors(this.visitorList);
  }

  rebuildItems() {
    const { width: W, depth: D } = this.office;
    // CSS2D labels stay in the DOM when the parent is removed; clean them up manually
    this.itemGroup.traverse(o => o instanceof CSS2DObject && o.element.remove());
    this.itemGroup.clear();
    this.itemMeshes.clear();
    this.grid = solidGrid(this.office.items, W, D);
    // Hundreds of small parts become one mesh per material: far fewer draw calls, and fewer again for each shadow pass
    this.mergedMeshes.forEach(m => m.geometry.dispose());
    const parts: ReturnType<typeof takeParts>['parts'] = [];
    for (const item of this.office.items) {
      const mesh = buildItemMesh(item);
      const screens = new Set<THREE.Object3D>([mesh.userData.screen, ...(mesh.userData.screens?.values() ?? [])].filter(Boolean));
      const taken = takeParts(mesh, screens);
      parts.push(...taken.parts);
      if (item.type === 'wall') continue; // nothing of a wall is left, and walls take no clicks
      this.itemGroup.add(mesh, ...taken.hits);
      this.itemMeshes.set(item.id!, mesh);
    }
    this.mergedMeshes = mergeParts(parts);
    this.itemGroup.add(...this.mergedMeshes);
    // Lamp lights are expensive: at most MAX_LAMP_LIGHTS stay lit, the rest only have a bright shade
    const lights: THREE.PointLight[] = [];
    this.itemGroup.traverse(o => o instanceof THREE.PointLight && lights.push(o));
    const keep = new Set(lights.filter((_, i) => lights.length <= MAX_LAMP_LIGHTS || i % Math.ceil(lights.length / MAX_LAMP_LIGHTS) === 0));
    for (const l of lights) if (!keep.has(l)) l.removeFromParent();
    this.refreshDesks();
  }

  // Desk monitors follow their owner's state
  refreshDesks() {
    const owners = new Map([...this.agents.values()].filter(a => a.deskId).map(a => [a.deskId, a]));
    const screenFor = (owner?: PublicAgent) => (owner?.status === 'working' ? screenOn : owner && this.attention[owner.id] ? screenHeld : owner ? screenIdle : screenOff);
    for (const item of this.office?.items || []) {
      const mesh = this.itemMeshes.get(item.id!);
      if (!mesh) continue;
      if (item.type === 'desk') mesh.userData.screen.material = screenFor(owners.get(item.id));
      if (item.type === 'teamdesk') for (const [id, scr] of mesh.userData.screens) scr.material = screenFor(owners.get(id));
    }
  }

  // ------------------------------------------------ player

  spawnPlayer() {
    const { width: W, depth: D } = this.office;
    this.player = new Avatar({ id: PLAYER_ID, name: this.playerInfo?.name || this.t('world.you'), color: this.playerInfo?.color || '#ff7a59', kind: 'player', status: 'idle' }, () => this.t);
    this.player.speed = PLAYER_SPEED * 1.2;
    this.agentGroup.add(this.player.group);
    const spot = this.rememberedSpot(PLAYER_ID);
    // The CEO starts the day where they left off, else at their own seat
    const seat = this.ceoSeat();
    if (spot) {
      this.player.group.position.set(spot[0], 0, spot[1]);
    } else if (seat) {
      this.player.group.position.set(seat.x, 0, seat.z);
      this.route(this.player, seat);
    } else {
      this.player.group.position.set(W / 2, 0, D - 1);
      this.player.group.rotation.y = Math.PI;
    }
  }

  ceoSeat() {
    const desk = this.office.items.find(i => i.type === 'ceodesk');
    return desk && { ...frontPoint(desk, 0.45), pose: 'sit', key: 'ceo' };
  }

  setLanguage(t: Translate) {
    this.t = t;
    for (const av of this.allAvatars()) av.relabel();
  }

  setPlayer(info: { name?: string; color?: string }) {
    this.playerInfo = info;
    if (this.player) this.player.setAgent({ ...this.player.agent, ...info });
  }

  allAvatars() {
    return this.player ? [...this.avatars.values(), this.player] : [...this.avatars.values()];
  }

  // Is there an obstacle at a point (within a radius)?
  blocked(x: number, z: number, r = 0.22) {
    const { width: W, depth: D } = this.office;
    for (const [px, pz] of [[x - r, z - r], [x + r, z - r], [x - r, z + r], [x + r, z + r]]) {
      if (px < 0.05 || pz < 0.05 || px > W - 0.05 || pz > D - 0.05) return true;
      if (this.grid[Math.floor(pz) * W + Math.floor(px)]) return true;
    }
    return false;
  }

  updatePlayer(dt: number) {
    const p = this.player;
    const k = this.keys;
    const ix = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const iz = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    p.manual = !!(ix || iz);
    p.running = k.has('shift');
    if (p.manual) {
      p.path = [];
      p.goal = null;
      p.goalKey = '';
      // Direction relative to the camera
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      fwd.y = 0;
      fwd.normalize();
      const mx = -fwd.z * ix + fwd.x * iz, mz = fwd.x * ix + fwd.z * iz;
      const len = Math.hypot(mx, mz) || 1;
      const step = (p.running ? PLAYER_RUN : PLAYER_SPEED) * dt;
      const dx = (mx / len) * step, dz = (mz / len) * step;
      const stuck = this.blocked(p.x, p.z);
      if (stuck || !this.blocked(p.x + dx, p.z)) p.group.position.x += dx;
      if (stuck || !this.blocked(p.x, p.z + dz)) p.group.position.z += dz;
      p.turnTo(Math.atan2(dx, dz), dt * 14);
      this.follow = true;
    }

    // Walking into a room (the CEO room, the meeting room, the coffee corner...)
    const zone = zoneAt(this.office.items, p.x, p.z);
    const roomId = zone?.id ?? null;
    if (roomId !== this.roomId) {
      const first = this.roomId === undefined;
      this.roomId = roomId;
      if (!first && zone?.room) this.cb.onEnterRoom(zone.room);
    }

    // Nearby agent → "E · Talk"
    let near = null, best = TALK_RANGE;
    for (const av of this.avatars.values()) {
      const d = Math.hypot(av.x - p.x, av.z - p.z);
      if (d < best) { best = d; near = av.id; }
    }
    if (near !== this.nearId) {
      if (this.nearId) this.avatars.get(this.nearId)?.el.classList.remove('near');
      if (near) this.avatars.get(near)!.el.classList.add('near');
      this.nearId = near;
    }

    // Camera follow
    if (this.follow && !this.userOrbiting) {
      const target = p.group.getWorldPosition(new THREE.Vector3());
      const delta = target.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 4));
      delta.y = 0;
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
  }

  interact() {
    const av = this.nearId && this.avatars.get(this.nearId);
    if (!av) return;
    const p = this.player;
    p.turnTo(Math.atan2(av.x - p.x, av.z - p.z), 1);
    if (av.pose !== 'sit') av.turnTo(Math.atan2(p.x - av.x, p.z - av.z), 1);
    av.flash(this.t(av.agent.status === 'working' ? 'world.listening' : 'world.hello'), 2500);
    this.cb.onInteract?.(av.id);
  }

  setActionMode(mode: PlayerActionMode) {
    this.actionMode = mode;
  }

  private nearestAgent(range: number) {
    let nearest: Avatar | null = null;
    let best = range;
    for (const av of this.avatars.values()) {
      const distance = Math.hypot(av.x - this.player.x, av.z - this.player.z);
      if (distance < best) { best = distance; nearest = av; }
    }
    return nearest;
  }

  private performAction() {
    const player = this.player;
    if (!player || this.actionMode === 'none') return;
    if (this.actionMode === 'dance') {
      player.dance();
      player.flash('🕺', 2400);
      return;
    }
    const range = this.actionMode === 'plant' || this.actionMode === 'confetti' ? PLANT_RANGE : KICK_RANGE;
    const target = this.nearestAgent(range);
    if (!target) {
      const hint = this.actionMode === 'plant' ? 'hud.plantNoTarget' : this.actionMode === 'confetti' ? 'hud.confettiNoTarget' : this.actionMode === 'kick' ? 'hud.kickNear' : 'hud.gestureNear';
      player.flash(this.t(hint), 1800);
      return;
    }
    player.turnTo(Math.atan2(target.x - player.x, target.z - player.z), 1);
    target.turnTo(Math.atan2(player.x - target.x, player.z - target.z), 1);
    if (this.actionMode === 'kiss' || this.actionMode === 'clap' || this.actionMode === 'coffee' || this.actionMode === 'thumbs') {
      const emoji = this.actionMode === 'kiss' ? '💋' : this.actionMode === 'clap' ? '👏' : this.actionMode === 'coffee' ? '☕' : '👍';
      this.cheer(target.id, emoji);
      return;
    }
    if (this.actionMode === 'highfive') {
      player.highFive();
      target.highFive();
      player.flash('🙌', 1400);
      target.flash('🙌', 1400);
      return;
    }
    if (this.actionMode === 'confetti') {
      this.confettiBurst(target);
      return;
    }
    if (this.actionMode === 'kick') {
      player.kick();
      target.flinch();
      target.flash('😵', 2200);
      return;
    }

    player.throwPlant();
    const pot = new THREE.Group();
    const potMaterial = new THREE.MeshStandardMaterial({ color: '#b86f53', roughness: 0.8 });
    const soilMaterial = new THREE.MeshStandardMaterial({ color: '#5b4637', roughness: 1 });
    const leafMaterial = new THREE.MeshStandardMaterial({ color: '#4e9b65', roughness: 0.7 });
    const potBody = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 0.2, 10), potMaterial);
    potBody.position.y = 0.13;
    potBody.castShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.025, 6, 12), potMaterial);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.24;
    const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.025, 10), soilMaterial);
    soil.position.y = 0.23;
    pot.add(potBody, rim, soil);
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.065, 0.24, 5), leafMaterial);
      const angle = (i / 5) * Math.PI * 2;
      leaf.position.set(Math.cos(angle) * 0.08, 0.4 + (i % 2) * 0.04, Math.sin(angle) * 0.08);
      leaf.rotation.z = Math.cos(angle) * 0.45;
      leaf.rotation.x = Math.sin(angle) * 0.45;
      leaf.castShadow = true;
      pot.add(leaf);
    }
    this.fxGroup.add(pot);
    this.flights.push({ mesh: pot, from: player, to: target, t: 0, done: () => {
      target.flinch();
      target.flash('🤕', 2400);
      pot.traverse(obj => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(material => material.dispose());
      });
    } });
  }

  private confettiBurst(center: Avatar) {
    const nearby = [...this.avatars.values()].filter(av => Math.hypot(av.x - center.x, av.z - center.z) <= CONFETTI_RADIUS);
    for (const av of nearby) {
      av.flash('🎉', 2200);
      for (let i = 0; i < 12; i++) {
        const mesh = new THREE.Mesh(CONFETTI_GEOMETRY, pickOne(CONFETTI_MATERIALS));
        mesh.position.set(av.x + rand(-0.2, 0.2), 1.1 + rand(-0.1, 0.25), av.z + rand(-0.2, 0.2));
        this.fxGroup.add(mesh);
        this.confetti.push({
          mesh,
          vx: rand(-1.8, 1.8), vy: rand(1.2, 2.8), vz: rand(-1.8, 1.8),
          rx: rand(-9, 9), ry: rand(-9, 9), rz: rand(-9, 9), life: rand(1.2, 2.1),
        });
      }
    }
  }

  // When the user assigns a task, an envelope flies from the player to the agent
  handoff(agentId: string) {
    const av = this.avatars.get(agentId);
    if (av && this.player) this.launchEnvelope(this.player, av);
  }

  // ------------------------------------------------ office life

  setMorale(morale: Record<string, number>) {
    this.morale = morale;
    for (const av of this.avatars.values()) av.setMood(morale[av.id] ?? 80);
  }

  /** A free floor point near (x, z), as a goal. */
  private spotNear(x: number, z: number, extra: Partial<Goal> = {}): Goal {
    const { width: W, depth: D } = this.office;
    const cx = Math.max(0, Math.min(W - 1, Math.floor(x))), cz = Math.max(0, Math.min(D - 1, Math.floor(z)));
    const free = this.grid[cz * W + cx] ? nearestFree(this.grid, W, D, cx, cz) : null;
    return { pose: 'stand', ...extra, ...(free ? { x: free[0] + 0.5, z: free[1] + 0.5 } : { x, z }) };
  }

  /** Sends avatars on a trip: the i-th one goes to `at(i)` until `until`. */
  private sendOff(people: Avatar[], until: number, at: (i: number) => Goal, run = false) {
    people.forEach((av, i) => {
      this.releaseSpot(av);
      av.visit = null;
      av.errand = { goal: { ...at(i), key: 'errand' + until + ':' + i }, until, run };
    });
  }

  fireDrill(ms: number) {
    if (!this.office) return;
    const { width: W, depth: D } = this.office;
    this.alarmUntil = performance.now() + ms;
    const people = [...this.avatars.values()];
    const perRow = 8;
    // Assembly point: the open strip along the front of the office
    this.sendOff(people, this.alarmUntil, i => this.spotNear(W / 2 + ((i % perRow) - (perRow - 1) / 2) * 0.75, D - 0.8 - Math.floor(i / perRow) * 0.8, { face: 0 }), true);
    for (const av of people) av.flash('🚨', 3000);
  }

  standup(lines: StandupLine[]) {
    if (!this.office) return;
    const now = performance.now();
    const room = this.office.items.find(i => i.type === 'zone' && i.room === 'meeting');
    const c = room ? center(room) : { x: this.office.width / 2, z: this.office.depth / 2 };
    const idle = this.freeAvatars();
    this.sendOff(idle, now + 20_000, i => {
      const a = (i / Math.max(1, idle.length)) * Math.PI * 2;
      const x = c.x + Math.sin(a) * 1.3, z = c.z + Math.cos(a) * 1.3;
      return this.spotNear(x, z, { face: Math.atan2(c.x - x, c.z - z) });
    });
    // Everyone says their line; people walking over speak once they are there
    lines.forEach((l, i) => setTimeout(() => this.avatars.get(l.agentId)?.flash('🗣️ ' + l.text, 7000), 2500 + i * 1200));
  }

  /** Who can leave their desk: someone with a sign is not idle, whatever their status says. */
  private freeAvatars() {
    return [...this.avatars.values()].filter(av => av.agent.status === 'idle' && !av.attention);
  }

  coffeeBreak() {
    if (!this.office) return;
    const machines = this.office.items.filter(i => CATALOG[i.type].poi === 'coffee' && !i.private);
    if (!machines.length) return;
    const idle = this.freeAvatars();
    this.sendOff(idle, performance.now() + 15_000, i => {
      const m = machines[i % machines.length]!;
      const p = frontPoint(m, 0.7 + Math.floor(i / machines.length) * 0.6);
      return this.spotNear(p.x + ((i % 3) - 1) * 0.3, p.z, { face: p.face });
    });
    for (const av of idle) av.flash('☕', 3000);
  }

  watched() {
    return !document.hidden;
  }

  setCovered(paused: boolean) {
    this.covered = paused;
    if (paused) this.keys.clear();
  }

  setDark(dark: boolean) {
    this.bg = dark ? BG_DARK : BG;
    (this.scene.background as THREE.Color).set(this.bg[this.weather]);
  }

  setWeather(weather: Weather) {
    this.weather = weather;
    if (weather === 'rain' && !this.rain && this.office) {
      const { width: W, depth: D } = this.office;
      const n = this.quality.rainDrops;
      const pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const x = rand(-2, W + 2), y = rand(0, 9), z = rand(-2, D + 2);
        pos.set([x, y, z, x, y + 0.35, z], i * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#6f93b8', transparent: true, opacity: 0.5 }));
      this.fxGroup.add(this.rain);
    } else if (weather === 'clear' && this.rain) {
      this.fxGroup.remove(this.rain);
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
      this.rain = null;
    }
    this.sun.intensity = weather === 'rain' ? 1.2 : 2.1;
    (this.scene.background as THREE.Color).set(this.bg[weather]);
  }

  private updateRain(dt: number) {
    if (!this.rain) return;
    const attr = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    for (let i = 0; i < a.length; i += 6) {
      let y = a[i + 1]! - dt * 11;
      if (y < 0) y += 9;
      a[i + 1] = y;
      a[i + 4] = y + 0.35;
    }
    attr.needsUpdate = true;
  }

  private updateConfetti(dt: number) {
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const piece = this.confetti[i]!;
      piece.life -= dt;
      piece.vy -= 3.8 * dt;
      piece.mesh.position.x += piece.vx * dt;
      piece.mesh.position.y += piece.vy * dt;
      piece.mesh.position.z += piece.vz * dt;
      piece.mesh.rotation.x += piece.rx * dt;
      piece.mesh.rotation.y += piece.ry * dt;
      piece.mesh.rotation.z += piece.rz * dt;
      if (piece.life <= 0 || piece.mesh.position.y < 0) {
        this.fxGroup.remove(piece.mesh);
        this.confetti.splice(i, 1);
      }
    }
  }

  /** An emoji flies from the player to the agent, who then shows it. */
  cheer(agentId: string, emoji: string) {
    const to = this.avatars.get(agentId);
    if (!to) return;
    if (!this.player) return to.flash(emoji, 2500);
    const el = document.createElement('div');
    el.className = 'fly-emoji';
    el.textContent = emoji;
    const obj = new CSS2DObject(el);
    this.fxGroup.add(obj);
    this.flights.push({ mesh: obj, from: this.player, to, t: 0, done: () => { el.remove(); to.flash(emoji, 2500); } });
  }

  // ------------------------------------------------ GitHub visitors

  setVisitors(list: Visitor[]) {
    this.visitorList = list;
    if (!this.office) return;
    const { width: W, depth: D } = this.office;
    const waiting = list.filter(v => v.status === 'waiting');
    const ids = new Set(waiting.map(v => v.id));
    for (const [id, av] of this.visitors) if (!ids.has(id) && !av.leaving) this.dismissVisitor(id, av, list.find(v => v.id === id));
    waiting.forEach((v, i) => {
      let av = this.visitors.get(v.id);
      if (!av) {
        av = new Avatar({ id: VISITOR_PREFIX + v.id, name: `${v.kind === 'pr' ? 'PR' : 'Issue'} #${v.number}`, color: v.kind === 'pr' ? '#8b5cf6' : '#f59e0b', kind: 'visitor', status: 'idle' }, () => this.t);
        av.group.position.set(W / 2 + rand(-0.5, 0.5), 0, D - 0.4);
        av.group.rotation.y = Math.PI;
        this.visitors.set(v.id, av);
        this.agentGroup.add(av.group);
      }
      av.setAgent({ ...av.agent, sign: `${v.kind === 'pr' ? '🔀' : '🐞'} ${v.title.slice(0, 48)}` });
      // They queue up beside the entrance, alternating sides
      const side = i % 2 ? -1 : 1, slot = Math.floor(i / 2);
      av.home = this.spotNear(W / 2 + side * (2.2 + slot * 0.8), D - 0.7, { face: Math.PI, key: 'door' });
    });
  }

  private dismissVisitor(id: string, av: Avatar, v?: Visitor) {
    const host = v?.status === 'accepted' && v.agentId ? this.avatars.get(v.agentId) : undefined;
    av.agent.sign = '';
    av.flash(host ? '🤝' : '👋', 3000);
    av.leaving = host ? this.spotNear(host.x + 0.6, host.z + 0.6, { key: 'leave' }) : this.spotNear(this.office.width / 2, this.office.depth - 0.3, { key: 'leave' });
    setTimeout(() => {
      av.group.traverse(o => o instanceof CSS2DObject && o.element.remove());
      this.agentGroup.remove(av.group);
      this.visitors.delete(id);
    }, host ? 5000 : 3500);
  }

  // ------------------------------------------------ agents

  setAgents(list: PublicAgent[]) {
    const ids = new Set(list.map(a => a.id));
    for (const id of [...this.avatars.keys()]) if (!ids.has(id)) this.removeAgent(id);
    for (const a of list) this.upsertAgent(a);
  }

  upsertAgent(agent: PublicAgent) {
    this.agents.set(agent.id, agent);
    let av = this.avatars.get(agent.id);
    if (!av || av.agent.kind !== agent.kind) {
      if (av) this.removeAgent(agent.id);
      av = new Avatar(agent, () => this.t);
      const { width: W, depth: D } = this.office;
      const spot = this.rememberedSpot(agent.id);
      if (spot) av.group.position.set(spot[0], 0, spot[1]);
      else {
        // Enter from the front edge
        av.group.position.set(W / 2 + rand(-1, 1), 0, D - 0.5);
        av.group.rotation.y = Math.PI;
      }
      this.avatars.set(agent.id, av);
      this.agentGroup.add(av.group);
      av.setMood(this.morale[agent.id] ?? 80);
      av.ring.visible = agent.id === this.selectedAgentId;
      av.setAttention(this.attention[agent.id] ?? null);
      av.el.querySelector('.sign')!.addEventListener('click', e => {
        (e.currentTarget as HTMLElement).blur(); // the keyboard goes back to walking
        this.cb.onAttention(agent.id);
      });
    }
    const wasWorking = av.agent.status === 'working';
    av.setAgent(agent);
    if (wasWorking !== (agent.status === 'working')) av.idleGoal = null;
    this.refreshDesks();
  }

  removeAgent(id: string) {
    const av = this.avatars.get(id);
    if (!av) return;
    av.group.traverse(o => o instanceof CSS2DObject && o.element.remove());
    this.releaseSpot(av);
    this.agentGroup.remove(av.group);
    this.avatars.delete(id);
    this.agents.delete(id);
    delete this.positions[id];
    if (this.nearId === id) this.nearId = null;
    this.refreshDesks();
  }

  selectAgent(id: string | null) {
    this.selectedAgentId = id;
    for (const av of this.avatars.values()) av.ring.visible = av.id === id;
  }

  focusAgent(id: string) {
    const av = this.avatars.get(id);
    if (!av) return;
    this.follow = false;
    const p = av.group.getWorldPosition(new THREE.Vector3());
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(p);
    this.camera.position.copy(p).add(offset.setLength(Math.min(offset.length(), 14)));
  }

  focusPlayer() {
    this.camFly = null;
    this.follow = true;
  }

  // Smoothly move the camera to a room (floor zone), or to the whole office when there is no id
  focusZone(id?: string | null) {
    const { width: W, depth: D } = this.office;
    const z = id ? this.office.items.find(i => i.id === id && i.type === 'zone') : { x: 0, z: 0, w: W, d: D, type: 'zone' as const };
    if (!z) return;
    const zw = z.w ?? 1, zd = z.d ?? 1;
    this.follow = false;
    const c = center(z);
    const toT = new THREE.Vector3(c.x, 0, c.z).add(this.root.position);
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(Math.max(7, Math.max(zw, zd) * (id ? 1.25 : 1.05)));
    this.camFly = { t: 0, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT, toP: toT.clone().add(offset) };
  }

  zones() {
    return (this.office?.items || []).filter(i => i.type === 'zone').map(i => ({ id: i.id, label: i.label }));
  }

  flash(agentId: string, text: string, ms?: number) {
    this.avatars.get(agentId)?.flash(text, ms);
  }

  setAttention(signs: Record<string, Attention>) {
    this.attention = signs;
    for (const [id, av] of this.avatars) av.setAttention(signs[id] ?? null);
    this.refreshDesks();
  }

  // Handoff / report: one person walks next to the other and an envelope flies between them
  courier(fromId: string, toId: string, mode: string) {
    const from = this.avatars.get(fromId), to = this.avatars.get(toId);
    if (!from || !to) return;
    const walker = mode === 'delegate' ? to : from;
    const host = mode === 'delegate' ? from : to;
    const side = host.group.rotation.y + Math.PI / 2;
    const px = host.x + Math.sin(side) * 0.9, pz = host.z + Math.cos(side) * 0.9;
    walker.visit = {
      x: px, z: pz, face: Math.atan2(host.x - px, host.z - pz), host,
      text: this.t(mode === 'delegate' ? 'world.gotTask' : 'world.reporting', { name: host.agent.name }),
    };
    walker.idleGoal = null;
    this.launchEnvelope(from, to);
  }

  launchEnvelope(from: Avatar, to: Avatar) {
    const m = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.04, 0.18, 2, 0.015), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#3b82f6', emissiveIntensity: 0.25 }));
    m.castShadow = true;
    this.fxGroup.add(m);
    this.flights.push({ mesh: m, from, to, t: 0 });
  }

  // Where the agent currently wants to go
  decide(av: Avatar, now: number) {
    const a = av.agent;
    if (av.errand) {
      if (now < av.errand.until) { av.running = !!av.errand.run; return av.errand.goal; }
      av.errand = null;
      av.running = false;
      av.idleGoal = null;
    }
    if (av.visit) {
      if (!av.visit.until && av.goal?.key === 'visit' && av.atGoal()) {
        av.visit.until = now + 3200;
        av.flash(av.visit.text, 3200);
        av.visit.host.turnTo(Math.atan2(av.x - av.visit.host.x, av.z - av.visit.host.z), 1);
      }
      if (av.visit.until && now > av.visit.until) av.visit = null;
      else return { ...av.visit, pose: 'stand', key: 'visit' };
    }
    const spot = a.deskId && seatPoint(this.office.items, a.deskId);
    const seat = spot && { ...spot, pose: 'sit', key: 'desk:' + a.deskId };
    if (a.status !== av.lastStatus) {
      if (a.status === 'idle') {
        av.idleSince = now;
        av.justDone = av.lastStatus === 'working';
        av.idleGoal = null;
      }
      av.lastStatus = a.status;
    }
    // Someone with a sign waits where they can be found, instead of strolling off as if idle
    const stalled = a.status === 'idle' && !!av.attention;
    if (a.status !== 'idle' || stalled) this.releaseSpot(av);
    if (stalled) av.idleGoal = null;
    if ((a.status === 'working' || a.status === 'waiting' || stalled) && seat) return seat;
    if (a.status === 'working' || stalled) return { x: av.x, z: av.z, pose: 'stand', key: 'here' };

    // Idle: depending on state, goes to their desk, coffee, games, food or sleep
    if (!av.idleGoal || now > av.idleUntil) {
      this.releaseSpot(av);
      const pois = this.office.items.filter(i => CATALOG[i.type].poi && !i.private); // they do not enter the CEO's room
      const open = pois.filter(i => this.freeSpots(i, av.id).length); // full spots are not candidates
      const kind = pickWeighted(this.idleWeights(av, now, !!seat, open));
      let hold = rand(9000, 25000);
      if (kind === 'desk') {
        av.idleGoal = seat;
      } else if (kind) {
        if (kind === 'sleep') hold = rand(40000, 90000);
        const item = pickOne(open.filter(i => CATALOG[i.type].poi === kind));
        const spot = pickOne(this.freeSpots(item, av.id));
        this.spotClaims.set(spot.key, av.id);
        this.claimedPoints.set(spot.key, spot.goal);
        av.spot = spot.key;
        av.idleGoal = { ...spot.goal, key: 'poi:' + spot.key, emoji: POI_EMOJI[kind as PoiKind] };
      } else {
        const { width: W, depth: D } = this.office;
        av.idleGoal = { x: rand(1, W - 1), z: rand(1, D - 1), pose: 'stand', key: 'wander' + Math.random() };
      }
      av.idleUntil = now + hold;
      av.emojiShown = false;
    }
    if (av.idleGoal.emoji && !av.emojiShown && av.atGoal()) {
      av.emojiShown = true;
      av.flash(av.idleGoal.emoji, 2500);
      if (av.idleGoal.emoji === POI_EMOJI.coffee) this.cb.onCoffee(av.id);
    }
    return av.idleGoal;
  }

  /** Places an avatar can occupy at an item: one per sofa seat, per bed, per ~0.9 of standing room in front of it. */
  spotsOf(item: OfficeItem) {
    const c = CATALOG[item.type];
    const f = frontVec(item.rot), ctr = center(item), { w, d } = footprint(item);
    const spacing = c.sit ? 1 : 0.9;
    const n = Math.max(1, Math.floor((f.x ? d : w) / spacing));
    return Array.from({ length: n }, (_, i) => {
      const lat = (i - (n - 1) / 2) * spacing;
      const goal: Goal = c.sit
        ? { x: ctr.x + f.x * 0.12 + f.z * lat, z: ctr.z + f.z * 0.12 + f.x * lat, face: Math.atan2(f.x, f.z), pose: 'sit' }
        : (() => { const p = frontPoint(item, 0.7); return { x: p.x + f.z * lat, z: p.z + f.x * lat, face: p.face, pose: 'stand' }; })();
      return { key: `${item.id}#${i}`, goal };
    });
  }

  freeSpots(item: OfficeItem, avatarId: string) {
    const claimed = [...this.spotClaims].filter(([, id]) => id !== avatarId).map(([key]) => this.claimedPoints.get(key)!);
    const standing = [...this.avatars.values()].filter(a => a.id !== avatarId && !a.path.length);
    return this.spotsOf(item).filter(s => (this.spotClaims.get(s.key) ?? avatarId) === avatarId && clearOf(s.goal, [...claimed, ...standing], SPOT_CLEARANCE));
  }

  releaseSpot(av: Avatar) {
    if (av.spot && this.spotClaims.get(av.spot) === av.id) {
      this.spotClaims.delete(av.spot);
      this.claimedPoints.delete(av.spot);
    }
    av.spot = null;
  }

  /**
   * Keeps avatars from overlapping. Seated ones are held by their seat, so whoever walks by goes around them. Two who
   * meet each keep to their right, which turns a head-on meeting into passing; if a tight spot leaves no room for that,
   * they slip past after a moment rather than stand pressed together.
   */
  separate(now = performance.now()) {
    const people = [...this.avatars.values(), ...this.visitors.values(), ...(this.player ? [this.player] : [])];
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const a = people[i]!, b = people[j]!;
        if (a.pose === 'sit' && b.pose === 'sit') continue;
        const pair = `${a.id}|${b.id}`;
        let dx = b.x - a.x, dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        if (dist >= PERSONAL_SPACE) { this.contacts.delete(pair); continue; }
        const walking = a.path.length > 0 || b.path.length > 0;
        if (walking && now - (this.contacts.get(pair) ?? now) > SLIP_PAST_MS) continue;
        if (!this.contacts.has(pair)) this.contacts.set(pair, now);
        if (dist < 1e-4) { dx = Math.cos(i + j); dz = Math.sin(i + j); dist = 1; }
        const push = (PERSONAL_SPACE - Math.hypot(b.x - a.x, b.z - a.z)) / 2 + 0.001;
        const [px, pz] = passingPush(dx / dist, dz / dist, walking);
        // The player is moved only by the keyboard and a seat holds its sitter, so the other one gives way fully
        const moveA = a !== this.player && a.pose !== 'sit', moveB = b !== this.player && b.pose !== 'sit';
        const share = moveA && moveB ? 1 : 2;
        if (moveA) this.nudge(a, -px * push * share, -pz * push * share);
        if (moveB) this.nudge(b, px * push * share, pz * push * share);
      }
    }
  }

  private nudge(av: Avatar, dx: number, dz: number) {
    const x = av.x + dx, z = av.z + dz;
    if (this.blocked(x, z)) return;
    av.group.position.x = x;
    av.group.position.z = z;
  }

  // Weights of the spot kinds an idle agent may visit; kinds missing from the office are dropped
  idleWeights(av: Avatar, now: number, hasSeat: boolean, pois: OfficeItem[]) {
    const idleFor = now - (av.idleSince ?? now);
    const d = new Date(), hour = d.getHours() + d.getMinutes() / 60;
    const w: Record<string, number> = { desk: 3, coffee: 1, lounge: 0.8, meeting: 0.4, game: 0.6, dining: 0.5, sleep: 0.1 };
    if (av.justDone && idleFor < 90000) Object.assign(w, { game: 6, coffee: 2 }); // work done, break
    if (hour >= 12 && hour < 13.5) w.dining = 6; // lunch break
    if (idleFor > 5 * 60000) Object.assign(w, { sleep: 8, desk: 0.5 }); // idle for a long time
    const present = new Set<string | undefined>(pois.map(i => CATALOG[i.type].poi));
    if (hasSeat) present.add('desk');
    return Object.entries(w).filter(([k]) => present.has(k));
  }

  route(av: Avatar, goal: Goal) {
    const { width: W, depth: D } = this.office;
    const cl = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.floor(v)));
    const path = findPath(this.grid, W, D, cl(av.x, W), cl(av.z, D), cl(goal.x, W), cl(goal.z, D));
    av.path = path ? path.slice(1) : [];
    // Skip the last cell if it is close to the goal (avoids needless zigzag)
    if (av.path.length > 1) {
      const [lx, lz] = av.path.at(-1)!;
      if (Math.hypot(lx + 0.5 - goal.x, lz + 0.5 - goal.z) < 0.75) av.path.pop();
    }
    av.goal = goal;
  }

  // ------------------------------------------------ loop

  /** With `auto` on, steps quality down one level while the frame rate stays low; the chosen level stays as it is. */
  adaptQuality(rawDt: number) {
    // Startup and tab pauses should not skew the measurement
    if (!this.autoQuality || this.level === 0 || this.covered || document.hidden || rawDt > 0.25 || this.clock.elapsedTime < 4) return;
    this.perf = this.perf || { time: 0, frames: 0, slow: 0 };
    this.perf.time += rawDt;
    this.perf.frames++;
    if (this.perf.time < 3) return;
    const fps = this.perf.frames / this.perf.time;
    const slow = fps < 28 ? this.perf.slow + 1 : 0;
    this.perf = { time: 0, frames: 0, slow };
    if (slow < 2) return;
    this.perf.slow = 0;
    this.applyQuality(this.level - 1);
    console.info(`[world] FPS ${fps.toFixed(0)} — quality level ${this.level}`);
  }

  setGraphics({ level, auto }: Graphics) {
    this.autoQuality = auto;
    this.perf = undefined;
    this.applyQuality(level);
  }

  private applyQuality(level: number) {
    const q = (this.quality = QUALITY_LEVELS[level]!);
    this.level = level;
    const ratio = Math.min(devicePixelRatio, q.pixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (target.samples === q.msaa) continue;
      target.samples = q.msaa;
      target.dispose();
    }
    const { shadowMap } = this.renderer, shadow = this.sun.shadow;
    shadowMap.enabled = q.shadows > 0;
    shadowMap.type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    shadowMap.autoUpdate = q.shadowEvery === 1;
    shadowMap.needsUpdate = true;
    if (q.shadows && shadow.mapSize.x !== q.shadows) {
      shadow.mapSize.set(q.shadows, q.shadows);
      shadow.map?.dispose();
      shadow.map = null;
    }
    this.scene.traverse(o => { if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).needsUpdate = true; });
    this.gtao.enabled = q.occlusion > 0;
    if (q.occlusion) this.gtao.updateGtaoMaterial({ ...GTAO_LOOK, samples: q.occlusion });
    this.resize();
  }

  /** Saved position of an avatar if it is still inside the office and not inside a wall/item. */
  private rememberedSpot(id: string): [number, number] | null {
    const p = this.positions[id];
    const { width: W, depth: D } = this.office;
    if (!p || !(p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < D)) return null;
    if (!this.grid[Math.floor(p[1]) * W + Math.floor(p[0])]) return p;
    const free = nearestFree(this.grid, W, D, Math.floor(p[0]), Math.floor(p[1]));
    return free ? [free[0] + 0.5, free[1] + 0.5] : null;
  }

  private savePositions() {
    for (const av of this.allAvatars()) this.positions[av.id] = [Math.round(av.x * 100) / 100, Math.round(av.z * 100) / 100];
    const json = JSON.stringify(this.positions);
    if (json === this.positionsJson) return;
    this.positionsJson = json;
    this.storage?.set(POSITIONS_KEY, json);
  }

  /**
   * Waits between frames on a timer instead of skipping animation frames: a browser slows those down, to as little as
   * two a second, once they draw nothing. Hidden behind a page the office goes on at a walk, with nothing to draw;
   * in a hidden tab animation frames stop, and so does this.
   */
  private loop = () => {
    const started = performance.now();
    this.frame();
    const gap = this.covered ? COVERED_FRAME_MS : this.quality.fps ? 1000 / this.quality.fps : 0;
    const wait = gap - (performance.now() - started);
    if (wait > 1 && !document.hidden) setTimeout(this.loop, wait);
    else requestAnimationFrame(this.loop);
  };

  frame() {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    const t = this.clock.elapsedTime;
    const now = performance.now();
    this.adaptQuality(rawDt);
    if (this.office && now - this.positionsSavedAt > POSITIONS_SAVE_MS) { this.positionsSavedAt = now; this.savePositions(); }
    if (this.office) {
      for (const av of this.avatars.values()) {
        const goal = this.decide(av, now);
        const key = `${goal.key}|${goal.x.toFixed(2)},${goal.z.toFixed(2)}`;
        if (key !== av.goalKey) {
          av.goalKey = key;
          this.route(av, goal);
        }
        av.update(dt, t);
      }
      for (const av of this.visitors.values()) {
        const goal = av.leaving ?? av.home;
        const key = goal && `${goal.key}|${goal.x},${goal.z}`;
        if (goal && key !== av.goalKey) {
          av.goalKey = key!;
          this.route(av, goal);
        }
        av.update(dt, t);
      }
      if (this.player) {
        this.updatePlayer(dt);
        this.player.update(dt, t);
      }
      this.separate();
      this.updateRain(dt);
      this.updateConfetti(dt);
      const raining = this.weather === 'rain';
      for (const av of this.allAvatars()) av.setUmbrella(raining && av.pose !== 'sit');
      // Fire drill: the room light pulses red
      if (this.alarmUntil) {
        const bg = this.scene.background as THREE.Color;
        if (now < this.alarmUntil) bg.set(this.bg[this.weather]).lerp(new THREE.Color(this.bg.alarm), 0.5 + 0.5 * Math.sin(t * 9));
        else { bg.set(this.bg[this.weather]); this.alarmUntil = 0; }
      }
      codeTexture.offset.y = (codeTexture.offset.y + dt * 0.06) % 1;
      // Envelopes
      this.flights = this.flights.filter(f => {
        f.t += dt / 1.1;
        const k = Math.min(f.t, 1);
        f.mesh.position.set(f.from.x + (f.to.x - f.from.x) * k, 1.3 + Math.sin(k * Math.PI) * 1.2, f.from.z + (f.to.z - f.from.z) * k);
        f.mesh.rotation.y += dt * 8;
        if (f.t >= 1) { this.fxGroup.remove(f.mesh); f.done?.(); return false; }
        return true;
      });
    }
    if (this.camFly) {
      const f = this.camFly;
      f.t = Math.min(1, f.t + dt / 0.7);
      const k = f.t * f.t * (3 - 2 * f.t);
      this.controls.target.lerpVectors(f.fromT, f.toT, k);
      this.camera.position.lerpVectors(f.fromP, f.toP, k);
      if (f.t >= 1) this.camFly = null;
    }
    this.controls.update();
    if (this.covered) return;
    if (this.quality.shadowEvery > 1 && ++this.framesSinceShadow >= this.quality.shadowEvery) {
      this.framesSinceShadow = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }

  floorCell(e: PointerEvent | MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.floorPlane, hit)) return null;
    this.root.worldToLocal(hit);
    return { x: hit.x, z: hit.z };
  }

  pickObject(group: THREE.Object3D) {
    const hits = this.raycaster.intersectObjects(group.children, true);
    for (const h of hits) {
      for (let o: THREE.Object3D | null = h.object; o; o = o.parent) {
        if (o.userData.focusZone) return { zoneId: o.userData.focusZone };
        if (o.userData.agentId) return { agentId: o.userData.agentId };
        if (o.userData.itemId) return { itemId: o.userData.itemId };
      }
    }
    return null;
  }

  bindInput() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;

    el.addEventListener('pointerdown', e => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener('pointerup', e => {
      const click = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6;
      down = null;
      if (!click) return;
      const floor = this.floorCell(e);
      const hit = this.pickObject(this.agentGroup) || this.pickObject(this.itemGroup);
      if (hit?.agentId === PLAYER_ID) return this.focusPlayer();
      if (hit?.agentId?.startsWith(VISITOR_PREFIX)) return this.cb.onSelectVisitor(hit.agentId.slice(VISITOR_PREFIX.length));
      if (hit?.zoneId) return this.focusZone(hit.zoneId);
      if (hit?.agentId) return this.cb.onSelectAgent(hit.agentId);
      const owner = hit?.itemId && [...this.agents.values()].find(a => a.deskId === hit.itemId);
      if (owner) return this.cb.onSelectAgent(owner.id);
      // Clicking the coffee machine: the player walks over, refills it and calls a break
      const clicked = hit?.itemId ? this.office.items.find(i => i.id === hit.itemId) : undefined;
      if (clicked?.type === 'coffee' && this.player) {
        const p = frontPoint(clicked, 0.6);
        this.route(this.player, { ...p, pose: 'stand', key: 'coffee' });
        this.follow = true;
        return this.cb.onCoffeeMachine();
      }
      // Clicking the CEO desk: the player walks to the seat and sits down
      if (hit?.itemId && this.office.items.find(i => i.id === hit.itemId)?.type === 'ceodesk' && this.player) {
        const seat = this.ceoSeat();
        if (seat) this.route(this.player, seat);
        this.follow = true;
        return this.cb.onSelectAgent(null);
      }
      // Clicking the floor: the player walks there
      if (floor && this.player) {
        const { width: W, depth: D } = this.office;
        const goal = { x: Math.max(0.3, Math.min(W - 0.3, floor.x)), z: Math.max(0.3, Math.min(D - 0.3, floor.z)), pose: 'stand', key: 'click' };
        this.route(this.player, goal);
        this.follow = true;
      }
      this.cb.onSelectAgent(null);
    });

    // Dropping a task card or a file on an agent (or their desk)
    const agentAt = (e: DragEvent) => {
      this.floorCell(e);
      const hit = this.pickObject(this.agentGroup) || this.pickObject(this.itemGroup);
      if (hit?.agentId && this.avatars.has(hit.agentId)) return hit.agentId;
      return (hit?.itemId && [...this.agents.values()].find(a => a.deskId === hit.itemId)?.id) || null;
    };
    const highlight = (id: string | null) => {
      if (id === this.dropTarget) return;
      if (this.dropTarget) this.avatars.get(this.dropTarget)?.el.classList.remove('drop');
      if (id) this.avatars.get(id)?.el.classList.add('drop');
      this.dropTarget = id;
    };
    const droppable = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some(t => t === TASK_DRAG_TYPE || t === 'Files');
    this.container.addEventListener('dragover', e => {
      if (!droppable(e)) return;
      e.preventDefault();
      const id = agentAt(e);
      e.dataTransfer!.dropEffect = id ? 'move' : 'none';
      highlight(id);
    });
    this.container.addEventListener('dragleave', e => { if (!this.container.contains(e.relatedTarget as Node | null)) highlight(null); });
    this.container.addEventListener('drop', e => {
      if (!droppable(e)) return;
      e.preventDefault();
      const id = agentAt(e);
      highlight(null);
      if (!id) return;
      const taskId = e.dataTransfer!.getData(TASK_DRAG_TYPE);
      const file = e.dataTransfer!.files[0];
      if (taskId) this.cb.onDropTask(taskId, id);
      else if (file) this.cb.onDropFile(file, id);
    });

    const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') || (document.activeElement as HTMLElement | null)?.isContentEditable;
    addEventListener('keydown', e => {
      if (this.covered) return;
      if (e.code === 'Space') {
        if (typing() || isModalOpen(document.getElementById('modal')) || e.repeat) return;
        e.preventDefault();
        this.performAction();
        return;
      }
      if (typing()) return;
      const key = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(key)) {
        this.keys.add(key);
        if (key.startsWith('arrow')) e.preventDefault();
        return;
      }
      if (key === 'e') return this.interact();
      if (key === 'f') return (this.follow = !this.follow);
    });
    addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
  }
}
