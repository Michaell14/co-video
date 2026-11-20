import * as Y from 'yjs';
import { ASSET_DEFAULTS, emptyProject, makeClip, makeTrack, applyEdits } from '../src';
import type { Asset, Clip, Project, RampPoint, Track } from '../src';

/** Wire two docs together like a (perfect) network would. */
export function connect(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, u, 'remote');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, u, 'remote');
  });
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'remote');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), 'remote');
}

export interface Fixture {
  p: Project;
  v1: Track;
  v2: Track;
  a1: Track;
  asset: Asset;
}

/** A 30 fps project with V1, V2, A1 and one 60-second video asset with audio. */
export function fixture(): Fixture {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const a1 = makeTrack('audio', 0);
  const asset: Asset = {
    ...ASSET_DEFAULTS,
    id: 'asset1',
    name: 'clip.mp4',
    kind: 'video',
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
  };
  let p = emptyProject();
  p = applyEdits(p, [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: v2 },
    { op: 'addTrack', track: a1 },
    { op: 'addAsset', asset },
  ]);
  return { p, v1, v2, a1, asset };
}

export function addClip(
  p: Project,
  trackId: string,
  start: number,
  duration: number,
  init: Partial<Clip> = {},
): { p: Project; clip: Clip } {
  const clip = makeClip('video', trackId, { assetId: 'asset1', start, duration, ...init });
  return { p: applyEdits(p, [{ op: 'addClip', clip }]), clip };
}

/** Assert no two clips on any track overlap. */
export function overlaps(p: Project): string[] {
  const out: string[] = [];
  const byTrack = new Map<string, Clip[]>();
  for (const c of Object.values(p.clips)) {
    const l = byTrack.get(c.trackId) ?? [];
    l.push(c);
    byTrack.set(c.trackId, l);
  }
  for (const [t, list] of byTrack) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].start + list[i - 1].duration)
        out.push(`${t}: ${list[i - 1].id} / ${list[i].id}`);
    }
  }
  return out;
}

/** Numbers from 0 up to 1 that are the same on every run. */
export function random(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/**
 * A ramp as an operation would write it: two to nine points, speeds from 10% to 1000% spread evenly
 * over the ratios, the first point in the first five seconds and each next one a millisecond to
 * four seconds on.
 */
export function randomRamp(rnd: () => number): RampPoint[] {
  const n = 2 + Math.floor(rnd() * 8);
  const ramp: RampPoint[] = [];
  let micros = Math.round(rnd() * 5e6);
  for (let i = 0; i < n; i++) {
    ramp.push({ m: micros / 1e6, v: Math.round(0.1 * Math.pow(100, rnd()) * 1e3) / 1e3 });
    micros += 1000 + Math.floor(rnd() * rnd() * 4e6);
  }
  return ramp;
}

/** The frame rates the mapping is checked at, as [fpsNum, fpsDen]: 24, 29.97, 30 and 60. */
export const FRAME_RATES: readonly (readonly [number, number])[] = [
  [24, 1],
  [30000, 1001],
  [30, 1],
  [60, 1],
];

/** `fixture()` at another frame rate. */
export function atRate([fpsNum, fpsDen]: readonly [number, number]): Fixture {
  const f = fixture();
  return { ...f, p: applyEdits(f.p, [{ op: 'settings', patch: { fpsNum, fpsDen } }]) };
}
