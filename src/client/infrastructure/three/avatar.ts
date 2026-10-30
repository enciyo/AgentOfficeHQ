// Avatars: the chubby characters of agents, visitors and the player, and how they walk, sit and show signs.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Translate } from '../../../shared/i18n/index.ts';
import type { AgentKind, AgentStatus } from '../../../shared/types.ts';
import type { Attention, AttentionTone } from '../../domain/attention.ts';
import { paceOf } from '../../domain/fun.ts';
import type { Cell } from './pathfinding.ts';

const WALK_SPEED = 2.2;
const RUN_FACTOR = 1.7;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const GEO = {
  torso: new THREE.CapsuleGeometry(0.19, 0.16, 6, 14),
  head: new THREE.SphereGeometry(0.3, 24, 16),
  limbArm: new THREE.CapsuleGeometry(0.055, 0.16, 4, 8),
  limbLeg: new THREE.CapsuleGeometry(0.07, 0.1, 4, 8),
  eye: new THREE.SphereGeometry(0.062, 10, 8),
  pupil: new THREE.SphereGeometry(0.036, 8, 6),
  cheek: new THREE.CircleGeometry(0.045, 16),
  smile: new THREE.TorusGeometry(0.04, 0.009, 6, 16, Math.PI),
  shadow: new THREE.CircleGeometry(0.32, 32),
  canopy: new THREE.SphereGeometry(0.46, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2.6),
  stick: new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6),
  signRing: new THREE.RingGeometry(0.5, 0.62, 40),
};
export const MAT = {
  eye: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 }),
  pupil: new THREE.MeshStandardMaterial({ color: '#111827', roughness: 0.15 }),
  cheek: new THREE.MeshBasicMaterial({ color: '#ff8fa3', transparent: true, opacity: 0.45, depthWrite: false }),
  dark: new THREE.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.5 }),
  white: new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.55 }),
};

const TONE_COLORS: Record<AttentionTone, string> = { alert: '#ef4444', warn: '#f59e0b', info: '#3b82f6' };

/** The person an avatar draws: an agent or the player (CEO). */
export interface AvatarAgent {
  id: string;
  name: string;
  color: string;
  kind: AgentKind | 'player' | 'visitor';
  status: AgentStatus;
  /** Shown in the bubble when nothing else is (a visitor's issue title). */
  sign?: string;
  activity?: string;
  queued?: number;
  deskId?: string | null;
}

export interface Goal { x: number; z: number; face?: number; pose?: string; key?: string; emoji?: string }
/** A short trip that overrides what an agent would do otherwise (fire drill, stand-up, coffee break). */
export interface Errand { goal: Goal; until: number; run?: boolean }

export class Avatar {
  id: string;
  agent: AvatarAgent;
  phase: number;
  group: THREE.Group;
  bodyMat: THREE.MeshPhysicalMaterial;
  shadeMat: THREE.MeshPhysicalMaterial;
  rig: THREE.Group;
  head: THREE.Group;
  torso: THREE.Mesh;
  legs: THREE.Group[];
  arms: THREE.Group[];
  eyes: THREE.Group[];
  micTip?: THREE.Mesh;
  ring: THREE.Mesh;
  el: HTMLDivElement;
  label: CSS2DObject;
  path: Cell[] = [];
  goal: Goal | null = null;
  goalKey = '';
  pose = 'stand';
  visit: any = null;
  idleGoal: any = null;
  idleUntil = 0;
  flashText = '';
  flashUntil = 0;
  /** What this agent needs from the CEO; stays until it is cleared. */
  attention: Attention | null = null;
  signRing?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  nextBlink = performance.now() + rand(1500, 4000);
  manual = false;
  /** Key of the idle spot this avatar holds (see World.spotClaims). */
  spot: string | null = null;
  lastStatus?: string;
  idleSince?: number;
  justDone = false;
  emojiShown = false;
  speed?: number;
  running = false;
  kickUntil = 0;
  throwUntil = 0;
  highFiveUntil = 0;
  danceUntil = 0;
  danceStartedAt = 0;
  flinchUntil = 0;
  /** Walking speed multiplier from morale. */
  pace = 1;
  errand: Errand | null = null;
  umbrella?: THREE.Group;
  /** Visitors: where they wait, and where they go when they leave. */
  home?: Goal;
  leaving?: Goal;

  constructor(agent: AvatarAgent, private readonly tr: () => Translate) {
    this.id = agent.id;
    this.agent = agent;
    const seed = [...agent.id].reduce((s, c) => s + c.charCodeAt(0), 0);
    this.phase = seed % 10;
    this.group = new THREE.Group();
    this.group.userData.agentId = agent.id;
    this.bodyMat = new THREE.MeshPhysicalMaterial({ color: agent.color, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    this.shadeMat = new THREE.MeshPhysicalMaterial({ color: agent.color, roughness: 0.5, clearcoat: 0.2 });

    const rig = (this.rig = new THREE.Group());
    this.group.add(rig);
    const mk = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = rig) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.legs = [-1, 1].map(s => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.085, 0.3, 0);
      rig.add(pivot);
      mk(GEO.limbLeg, this.shadeMat, 0, -0.15, 0, pivot);
      return pivot;
    });
    this.torso = mk(GEO.torso, this.bodyMat, 0, 0.5, 0);
    this.torso.scale.set(1, 1, 0.88);
    this.arms = [-1, 1].map(s => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.205, 0.68, 0);
      pivot.rotation.z = s * 0.12;
      rig.add(pivot);
      mk(GEO.limbArm, this.bodyMat, 0, -0.13, 0, pivot);
      return pivot;
    });

    const head = (this.head = new THREE.Group());
    head.position.set(0, 1.02, 0);
    rig.add(head);
    mk(GEO.head, this.bodyMat, 0, 0, 0, head).scale.set(1, 0.94, 0.94);
    this.eyes = [-1, 1].map(s => {
      const e = new THREE.Group();
      e.position.set(s * 0.1, 0.03, 0.255);
      head.add(e);
      mk(GEO.eye, MAT.eye, 0, 0, 0, e).scale.set(1, 1.15, 0.55);
      mk(GEO.pupil, MAT.pupil, 0, -0.005, 0.03, e).scale.set(1, 1.15, 0.6);
      return e;
    });
    for (const s of [-1, 1]) {
      const c = new THREE.Mesh(GEO.cheek, MAT.cheek);
      c.position.set(s * 0.17, -0.05, 0.235);
      c.rotation.y = s * 0.55;
      head.add(c);
    }
    const smile = new THREE.Mesh(GEO.smile, MAT.dark);
    smile.position.set(0, -0.08, 0.27);
    smile.rotation.z = Math.PI;
    head.add(smile);

    // Accessory by kind
    if (agent.kind === 'visitor') {
      // Top hat: visitors from GitHub
      mk(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 24), MAT.dark, 0, 0.26, 0, head);
      mk(new THREE.CylinderGeometry(0.13, 0.14, 0.24, 20), MAT.dark, 0, 0.39, 0, head);
    } else if (agent.kind === 'player') {
      // Cap
      const cap = mk(new THREE.SphereGeometry(0.31, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2.3), MAT.white, 0, 0.04, -0.01, head);
      cap.rotation.x = -0.18;
      const visor = mk(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 24, 1, false, -Math.PI / 2, Math.PI), MAT.white, 0, 0.12, 0.2, head);
      visor.rotation.x = 0.12;
      mk(new THREE.SphereGeometry(0.04, 12, 10), this.bodyMat, 0, 0.33, -0.02, head);
    } else if (agent.kind === 'human') {
      // Hair tuft
      for (const [x, y, z, r] of [[0, 0.29, 0.02, 0.09], [-0.08, 0.26, 0.06, 0.07], [0.08, 0.27, 0.05, 0.075]]) mk(new THREE.SphereGeometry(r, 14, 12), this.shadeMat, x, y, z, head);
    } else {
      // Headset
      const band = mk(new THREE.TorusGeometry(0.315, 0.02, 8, 32, Math.PI), MAT.dark, 0, 0, -0.02, head);
      band.rotation.y = 0;
      for (const s of [-1, 1]) {
        const cup = mk(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 20), MAT.dark, s * 0.3, -0.02, -0.02, head);
        cup.rotation.z = Math.PI / 2;
      }
      const mic = mk(new THREE.CapsuleGeometry(0.012, 0.18, 4, 8), MAT.dark, -0.27, -0.12, 0.12, head);
      mic.rotation.set(Math.PI / 2.4, 0.5, 0);
      this.micTip = mk(new THREE.SphereGeometry(0.025, 10, 8), this.bodyMat, -0.24, -0.15, 0.22, head);
    }

    // Soft ground shadow + selection ring
    const blob = new THREE.Mesh(GEO.shadow, new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.12, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    this.group.add(blob);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.45, 40), new THREE.MeshBasicMaterial({ color: agent.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.015;
    this.ring.visible = agent.kind === 'player';
    this.group.add(this.ring);

    // Name tag + speech bubble
    this.el = document.createElement('div');
    this.el.className = 'tag' + (agent.kind === 'player' ? ' me' : agent.kind === 'visitor' ? ' visitor' : '');
    this.el.innerHTML = '<div class="bubble"></div><button class="sign" tabindex="-1" hidden></button><div class="name"><span class="dot"></span><span class="label"></span></div><div class="mood"><i></i></div><div class="hint"></div>';
    this.label = new CSS2DObject(this.el);
    this.label.position.set(0, 1.5, 0);
    this.group.add(this.label);

    this.path = [];
    this.goal = null;
    this.goalKey = '';
    this.pose = 'stand';
    this.visit = null;
    this.idleGoal = null;
    this.idleUntil = 0;
    this.flashText = '';
    this.flashUntil = 0;
    this.nextBlink = performance.now() + rand(1500, 4000);
    this.manual = false;
    this.setAgent(agent);
    this.relabel();
  }

  setAgent(agent: AvatarAgent) {
    this.agent = agent;
    this.bodyMat.color.set(agent.color);
    this.shadeMat.color.set(agent.color).multiplyScalar(0.78);
    (this.ring.material as THREE.MeshBasicMaterial).color.set(agent.color);
    this.el.querySelector('.label')!.textContent = agent.name;
    this.el.querySelector<HTMLElement>('.dot')!.style.background = agent.color;
    this.el.dataset.status = agent.status;
  }

  /** (Re)applies translated static text; called on creation and when the language changes. */
  relabel() {
    this.el.querySelector('.hint')!.textContent = this.tr()('world.hint');
  }

  /** Morale bar under the name (agents only). */
  setMood(morale: number) {
    const bar = this.el.querySelector<HTMLElement>('.mood i')!;
    bar.style.width = `${Math.round(morale)}%`;
    bar.style.background = morale >= 45 ? '#22c55e' : morale >= 20 ? '#f59e0b' : '#ef4444';
    this.el.classList.toggle('tired', morale < 20);
    this.pace = paceOf(morale);
  }

  setUmbrella(on: boolean) {
    if (!on && !this.umbrella) return;
    if (!this.umbrella) {
      const u = (this.umbrella = new THREE.Group());
      const canopy = new THREE.Mesh(GEO.canopy, new THREE.MeshStandardMaterial({ color: this.agent.color, roughness: 0.6, side: THREE.DoubleSide }));
      canopy.position.y = 1.62;
      canopy.castShadow = true;
      const stick = new THREE.Mesh(GEO.stick, MAT.dark);
      stick.position.y = 1.3;
      u.add(canopy, stick);
      u.position.set(0.12, 0, 0.05);
      this.group.add(u);
    }
    this.umbrella.visible = on;
  }

  flash(text: string, ms = 4000) {
    this.flashText = text;
    this.flashUntil = performance.now() + ms;
  }

  kick() { this.kickUntil = performance.now() + 460; }
  throwPlant() { this.throwUntil = performance.now() + 520; }
  highFive() { this.highFiveUntil = performance.now() + 720; }
  dance() {
    this.danceStartedAt = performance.now();
    this.danceUntil = this.danceStartedAt + 2600;
  }
  flinch() { this.flinchUntil = performance.now() + 420; }

  /** The icon over the head and the ring on the floor. */
  setAttention(sign: Attention | null) {
    this.attention = sign;
    const icon = this.el.querySelector<HTMLButtonElement>('.sign')!;
    icon.hidden = !sign;
    if (this.signRing) this.signRing.visible = !!sign;
    if (!sign) return;
    icon.textContent = sign.icon;
    icon.title = sign.text;
    icon.dataset.tone = sign.tone;
    if (!this.signRing) {
      this.signRing = new THREE.Mesh(GEO.signRing, new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      this.signRing.rotation.x = -Math.PI / 2;
      this.signRing.position.y = 0.016;
      this.group.add(this.signRing);
    }
    this.signRing.material.color.set(TONE_COLORS[sign.tone]);
    this.signRing.material.opacity = 0.85;
    this.signRing.scale.setScalar(1);
  }

  get x() { return this.group.position.x; }
  get z() { return this.group.position.z; }

  atGoal() {
    return !!this.goal && !this.path.length && Math.hypot(this.goal.x - this.x, this.goal.z - this.z) < 0.04;
  }

  update(dt: number, t: number) {
    const now = performance.now();
    // Movement (when the player walks with the keyboard the position is updated externally)
    let moving = this.manual;
    const next = this.path[0];
    const target = next ? { x: next[0] + 0.5, z: next[1] + 0.5 } : this.goal;
    if (!this.manual && target) {
      const dx = target.x - this.x, dz = target.z - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.04) {
        moving = true;
        this.pose = 'stand';
        const step = Math.min(dist, (this.speed || WALK_SPEED) * this.pace * (this.running ? RUN_FACTOR : 1) * dt);
        this.group.position.x += (dx / dist) * step;
        this.group.position.z += (dz / dist) * step;
        this.turnTo(Math.atan2(dx, dz), dt * 12);
      } else if (this.path.length) {
        this.path.shift();
      } else {
        this.pose = this.goal?.pose || 'stand';
        if (this.goal?.face !== undefined) this.turnTo(this.goal.face, dt * 8);
      }
    }
    if (this.manual) this.pose = 'stand';

    // Animation
    const s = this.agent.status;
    const sitting = this.pose === 'sit' && !moving;
    const working = s === 'working' && sitting;
    const w = t * (this.running ? 15 : 11) + this.phase;
    const swing = moving ? Math.sin(w) * 0.75 : 0;
    const bob = moving ? Math.abs(Math.sin(w)) : 0;
    const dancing = this.danceUntil > now;
    const groove = dancing ? Math.sin((now - this.danceStartedAt) / 130 + this.phase) : 0;
    this.rig.position.y = sitting ? 0.22 : moving ? bob * 0.06 : 0;
    // Slight squash and stretch while walking
    const squash = moving ? 1 + (bob - 0.5) * 0.05 : 1 + Math.sin(t * 2.2 + this.phase) * 0.012;
    this.rig.scale.set(2 - squash, squash, 2 - squash);
    this.rig.rotation.z = moving ? Math.sin(w) * 0.05 : dancing ? groove * 0.18 : 0;
    this.legs[0]!.rotation.x = (sitting ? -Math.PI / 2 : swing) + (dancing ? groove * 0.42 : 0);
    this.legs[1]!.rotation.x = (sitting ? -Math.PI / 2 : -swing) - (dancing ? groove * 0.42 : 0);
    const kickProgress = this.kickUntil > now ? 1 - (this.kickUntil - now) / 460 : 0;
    if (kickProgress > 0) this.legs[0]!.rotation.x -= Math.sin(kickProgress * Math.PI) * 1.7;
    if (working) {
      // Typing on the keyboard
      this.arms[0]!.rotation.x = -1.1 + Math.sin(t * 22 + this.phase) * 0.12;
      this.arms[1]!.rotation.x = -1.1 + Math.sin(t * 22 + this.phase + 1.7) * 0.12;
      this.head.rotation.x = 0.1 + Math.sin(t * 1.3) * 0.04;
      this.head.rotation.y = Math.sin(t * 0.7 + this.phase) * 0.12;
    } else {
      this.arms[0]!.rotation.x = moving ? -swing * 0.9 : sitting ? -0.45 : Math.sin(t * 1.6 + this.phase) * 0.06;
      this.arms[1]!.rotation.x = moving ? swing * 0.9 : sitting ? -0.45 : -Math.sin(t * 1.6 + this.phase) * 0.06;
      this.head.rotation.x = moving ? 0.05 : 0;
      this.head.rotation.y = !moving && !sitting ? Math.sin(t * 0.5 + this.phase) * 0.3 : 0;
    }
    const throwProgress = this.throwUntil > now ? 1 - (this.throwUntil - now) / 520 : 0;
    if (throwProgress > 0) this.arms[1]!.rotation.x = -0.25 - Math.sin(throwProgress * Math.PI) * 1.5;
    const highFiveProgress = this.highFiveUntil > now ? 1 - (this.highFiveUntil - now) / 720 : 0;
    if (highFiveProgress > 0) this.arms[1]!.rotation.x = -1.7 - Math.sin(highFiveProgress * Math.PI) * 0.65;
    if (dancing) {
      this.arms[0]!.rotation.x = -1.5 + groove * 0.35;
      this.arms[1]!.rotation.x = -1.5 - groove * 0.35;
    }
    const flinchProgress = this.flinchUntil > now ? (this.flinchUntil - now) / 420 : 0;
    this.rig.rotation.x = Math.sin((1 - flinchProgress) * Math.PI) * 0.28;
    // Blinking
    const blink = now > this.nextBlink;
    if (now > this.nextBlink + 130) this.nextBlink = now + rand(2000, 5000);
    for (const e of this.eyes) e.scale.y = blink ? 0.1 : 1;
    if (this.micTip) {
      ((this.micTip.material as THREE.MeshStandardMaterial).emissive)?.set(s === 'working' ? this.agent.color : '#000000');
    }

    // What only the CEO can end pulses; the rest just stays
    if (this.attention?.tone === 'alert') {
      const beat = (Math.sin(t * 4 + this.phase) + 1) / 2;
      this.signRing!.scale.setScalar(1 + beat * 0.12);
      this.signRing!.material.opacity = 0.55 + beat * 0.4;
    }

    // Bubble
    let text = '';
    if (now < this.flashUntil) text = this.flashText;
    else if (this.attention && (s !== 'working' || this.attention.kind === 'approval')) text = this.attention.text;
    else if (s === 'working') text = this.agent.activity || this.tr()('activity.thinking');
    else if (s === 'waiting') text = this.tr()('world.waiting', { n: this.agent.queued ?? 0 });
    else if (this.agent.sign) text = this.agent.sign;
    const bubble = this.el.firstChild as HTMLElement;
    if (bubble.textContent !== text) bubble.textContent = text;
    bubble.style.display = text ? '' : 'none';
  }

  turnTo(angle: number, k: number) {
    let d = angle - this.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.group.rotation.y += d * Math.min(1, k);
  }
}
