export interface Point {
  x: number;
  y: number;
}

type Ease = (u: number) => number;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

const easeInOut: Ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** A value keyframe. `ease` shapes the segment that *arrives* at this key. */
export interface Key {
  t: number;
  v: number;
  ease?: Ease;
}

/** Sample a keyframe track at time `t`. Keys must be sorted by `t`. */
export function sampleTrack(keys: readonly Key[], t: number): number {
  const first = keys[0];
  if (t <= first.t) return first.v;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b.t) {
      const a = keys[i - 1];
      const span = b.t - a.t;
      const u = span <= 0 ? 1 : (t - a.t) / span;
      return lerp(a.v, b.v, (b.ease ?? easeInOut)(u));
    }
  }
  return keys[keys.length - 1].v;
}

/** True while `t` falls inside any of the `[from, to]` spans. */
export function inSpans(spans: readonly (readonly [number, number])[], t: number): boolean {
  for (const [from, to] of spans) if (t >= from && t <= to) return true;
  return false;
}

/** Small, smooth, deterministic wander so a resting cursor still looks hand-held. */
export function wobble(t: number, seed: number, amount: number): Point {
  return {
    x: (Math.sin(t * 0.9 + seed) + Math.sin(t * 1.7 + seed * 2.3) * 0.5) * amount,
    y: (Math.cos(t * 1.1 + seed * 1.7) + Math.sin(t * 2.1 + seed * 0.7) * 0.5) * amount,
  };
}

/** Deterministic PRNG (mulberry32) for generated waveforms and thumbnails. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `HH:MM:SS:FF` timecode for a time in seconds. */
export function timecode(seconds: number, fps = 24): string {
  const total = Math.max(0, Math.floor(seconds * fps + 1e-6));
  const f = total % fps;
  const s = Math.floor(total / fps) % 60;
  const m = Math.floor(total / (fps * 60)) % 60;
  const h = Math.floor(total / (fps * 3600));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}
