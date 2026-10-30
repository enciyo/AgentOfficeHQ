// What each step of the performance/quality slider costs. The 3D world applies these; the numbers live here to be read and tested.
export interface QualityLevel {
  /** Highest device pixel ratio drawn. */
  pixelRatio: number;
  /** Shadow map size; 0 turns shadows off. */
  shadows: number;
  /** Shadows are redrawn every this many frames. */
  shadowEvery: number;
  softShadows: boolean;
  /** Ambient occlusion samples; 0 turns it off. */
  occlusion: number;
  /** Multisampling of edges. */
  msaa: number;
  /** Frames per second at most; 0 is the display's own rate. */
  fps: number;
  rainDrops: number;
}

export const QUALITY_LEVELS: QualityLevel[] = [
  { pixelRatio: 1, shadows: 0, shadowEvery: 1, softShadows: false, occlusion: 0, msaa: 0, fps: 30, rainDrops: 300 },
  { pixelRatio: 1, shadows: 1024, shadowEvery: 3, softShadows: false, occlusion: 0, msaa: 0, fps: 0, rainDrops: 500 },
  { pixelRatio: 1.5, shadows: 2048, shadowEvery: 1, softShadows: true, occlusion: 8, msaa: 4, fps: 0, rainDrops: 1000 },
  { pixelRatio: 2, shadows: 2048, shadowEvery: 1, softShadows: true, occlusion: 16, msaa: 4, fps: 0, rainDrops: 1400 },
];

export const MAX_QUALITY = QUALITY_LEVELS.length - 1;

export interface Graphics {
  level: number;
  /** Steps down by itself while the frame rate stays low. */
  auto: boolean;
}

/** Phones, tablets and small screens start lower. */
export const defaultGraphics = (light: boolean): Graphics => ({ level: light ? 1 : 2, auto: true });

/** Saved graphics settings, or the default for anything missing or out of range. */
export function readGraphics(saved: string | null, light: boolean): Graphics {
  const fallback = defaultGraphics(light);
  try {
    const { level, auto } = JSON.parse(saved ?? '{}') as Partial<Graphics>;
    return {
      level: Number.isInteger(level) && level! >= 0 && level! <= MAX_QUALITY ? level! : fallback.level,
      auto: typeof auto === 'boolean' ? auto : fallback.auto,
    };
  } catch { return fallback; }
}
