// Automatic quality: when to step the 3D office down, when to step it back up, and when a step did not help.
// Pure and clock-free (times come in as seconds), so the rules can be tested; the 3D world feeds it frames.
import { QUALITY_LEVELS } from './quality.ts';

export interface AutoQualityRules {
  /** Seconds of frames one reading covers. */
  window: number;
  /** Below this many frames per second a reading is slow; this many slow readings in a row step down. */
  downFps: number;
  slowReadings: number;
  /** At or above this frame rate (on a level without a frame cap) a reading shows room to go up. */
  upFps: number;
  /**
   * On a level with a frame cap the frame rate cannot show room, so the time each frame's work takes is read instead:
   * at or below this many milliseconds a reading shows room.
   */
  upWorkMs: number;
  /** Readings with room in a row before stepping up: the gap between the two thresholds and this wait keep it from bouncing. */
  roomReadings: number;
  /** After any change, frames are not read for this long (the resize and shader rebuild hitch). */
  settle: number;
  /** After a step down, the frames of this long are compared with those before it. */
  verify: number;
  /** A step down that makes frames less than this much faster is undone. */
  minGain: number;
  /** A step up followed this soon by a step down failed. */
  probation: number;
  /** How long a failed step up or an undone step down blocks trying it again; it doubles each time, up to the max. */
  cooldown: number;
  maxCooldown: number;
}

export const AUTO_QUALITY: AutoQualityRules = {
  window: 3, downFps: 28, slowReadings: 2, upFps: 50, upWorkMs: 12, roomReadings: 3,
  settle: 1, verify: 2, minGain: 0.03, probation: 15, cooldown: 60, maxCooldown: 15 * 60,
};

/** Why the level changed: frames were slow, there was room, or a step down gained too little and was undone. */
export type QualityStepReason = 'slow' | 'room' | 'noGain';
export interface QualityStep { level: number; reason: QualityStepReason }

interface Reading { time: number; frames: number; work: number }
const empty = (): Reading => ({ time: 0, frames: 0, work: 0 });
/** Average time between frames, in milliseconds. */
const interval = (r: Reading) => (r.time / r.frames) * 1000;

export class AutoQuality {
  private reading = empty();
  private slow = 0;
  private room = 0;
  private settleUntil = 0;
  /** After a step down: the level it came from and its average frame interval. */
  private verifying: { from: number; before: number } | null = null;
  private upAt = -Infinity;
  private upBlockedUntil = -Infinity;
  private upCooldown: number;
  private downBlockedUntil = -Infinity;
  private downCooldown: number;

  /**
   * `ceiling` is the level the CEO chose: it never goes above it. `level` is where it is now.
   */
  constructor(private ceiling: number, private level = ceiling, private readonly rules: AutoQualityRules = AUTO_QUALITY) {
    this.upCooldown = rules.cooldown;
    this.downCooldown = rules.cooldown;
  }

  get current() { return this.level; }

  /**
   * One frame: `now` in seconds, `dt` the seconds since the frame before, `workMs` what the frame's own work took.
   * Returns the level to switch to, or null. Frames the caller should not count (startup, hidden, covered) are not
   * passed in at all.
   */
  frame(now: number, dt: number, workMs: number): QualityStep | null {
    if (now < this.settleUntil) return null;
    const r = this.reading;
    r.time += dt;
    r.frames += 1;
    r.work += workMs;
    if (this.verifying) return r.time >= this.rules.verify ? this.verifyStep(now) : null;
    if (r.time < this.rules.window) return null;
    this.reading = empty();
    return this.read(now, r);
  }

  private read(now: number, r: Reading): QualityStep | null {
    const { rules } = this;
    const fps = r.frames / r.time;
    this.slow = fps < rules.downFps ? this.slow + 1 : 0;
    if (this.slow >= rules.slowReadings && this.level > 0 && now >= this.downBlockedUntil) {
      if (now - this.upAt < rules.probation) this.failedUp(now);
      this.verifying = { from: this.level, before: interval(r) };
      return this.change(now, this.level - 1, 'slow');
    }
    const capped = QUALITY_LEVELS[this.level]!.fps > 0;
    const hasRoom = this.slow === 0 && (capped ? r.work / r.frames <= rules.upWorkMs : fps >= rules.upFps);
    this.room = hasRoom ? this.room + 1 : 0;
    if (this.room >= rules.roomReadings && this.level < this.ceiling && now >= this.upBlockedUntil) {
      this.upAt = now;
      return this.change(now, this.level + 1, 'room');
    }
    return null;
  }

  /** The step down is measured once the hitch has passed; one that hardly helped is undone and not tried again for a while. */
  private verifyStep(now: number): QualityStep | null {
    const { from, before } = this.verifying!;
    const after = interval(this.reading);
    this.verifying = null;
    this.reading = empty();
    if ((before - after) / before >= this.rules.minGain) {
      this.downCooldown = this.rules.cooldown;
      return null;
    }
    this.downBlockedUntil = now + this.downCooldown;
    this.downCooldown = Math.min(this.rules.maxCooldown, this.downCooldown * 2);
    return this.change(now, from, 'noGain');
  }

  private failedUp(now: number) {
    this.upBlockedUntil = now + this.upCooldown;
    this.upCooldown = Math.min(this.rules.maxCooldown, this.upCooldown * 2);
  }

  private change(now: number, level: number, reason: QualityStepReason): QualityStep {
    this.level = level;
    this.slow = 0;
    this.room = 0;
    this.reading = empty();
    this.settleUntil = now + this.rules.settle;
    return { level, reason };
  }
}
