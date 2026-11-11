import { ASSET_DEFAULTS, emptyProject, makeClip, makeTrack, applyEdits } from '../src';
import type { Asset, Clip, Project, Track } from '../src';

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
