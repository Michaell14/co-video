import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  frameOfMedia,
  handles,
  hasSourceTime,
  linkedIds,
  makeClip,
  meanSpeed,
  mediaAt,
  mediaToStream,
  newId,
  rampTable,
  shapeRamp,
  slipClips,
  sourcePerFrame,
  sourceSpan,
  sourceTimeAt,
  speedAt,
  speedRange,
  streamIn,
  streamSpeed,
  streamToMedia,
  timeMap,
  tidyRamp,
  withLinked,
} from '../src';
import type { Asset, Clip, Edit, Project } from '../src';
import { FRAME_RATES, addClip, atRate, fixture, random, randomRamp } from './helpers';

describe('linked clips', () => {
  it('finds the partners of a clip', () => {
    const f = fixture();
    const v = makeClip('video', f.v1.id, { start: 0, duration: 10, linkId: 'pair' });
    const a = makeClip('audio', f.a1.id, { start: 0, duration: 10, linkId: 'pair' });
    let p = applyEdits(f.p, [
      { op: 'addClip', clip: v },
      { op: 'addClip', clip: a },
    ]);
    const solo = addClip(p, f.v2.id, 0, 10);
    p = solo.p;
    expect(linkedIds(p, v.id)).toEqual([v.id, a.id]);
    expect(linkedIds(p, a.id)).toEqual([v.id, a.id]);
    expect(linkedIds(p, solo.clip.id)).toEqual([solo.clip.id]);
    expect(linkedIds(p, 'missing')).toEqual([]);
    expect(withLinked(p, [a.id, solo.clip.id, 'missing', a.id])).toEqual([v.id, a.id, solo.clip.id]);

    // The result is the caller's to change, and the index follows the snapshot.
    linkedIds(p, v.id).push('junk');
    expect(linkedIds(p, v.id)).toEqual([v.id, a.id]);
    const q = applyEdits(p, [{ op: 'updateClip', id: a.id, patch: { linkId: null } }]);
    expect(linkedIds(q, v.id)).toEqual([v.id]);
    expect(linkedIds(q, a.id)).toEqual([a.id]);
    expect(linkedIds(p, a.id)).toEqual([v.id, a.id]);
  });

  it('expands a selection of thousands of linked clips without scanning the project per clip', () => {
    const f = fixture();
    const edits: Edit[] = [];
    const pairs = 10000;
    for (let i = 0; i < pairs; i++) {
      const linkId = newId();
      edits.push({
        op: 'addClip',
        clip: makeClip('video', f.v1.id, { start: i * 10, duration: 10, linkId }),
      });
      edits.push({
        op: 'addClip',
        clip: makeClip('audio', f.a1.id, { start: i * 10, duration: 10, linkId }),
      });
    }
    const p = applyEdits(f.p, edits);
    const videos = Object.values(p.clips)
      .filter((c) => c.type === 'video')
      .map((c) => c.id);
    const t0 = performance.now();
    const all = withLinked(p, videos);
    const elapsed = performance.now() - t0;
    expect(all).toHaveLength(pairs * 2);
    expect(new Set(all).size).toBe(pairs * 2);
    // A scan per clip took minutes at this size; the index takes a few milliseconds.
    expect(elapsed).toBeLessThan(1000);
  });
});

/** `sourcePerFrame`, `sourceTimeAt` and `handles` as they were before there were ramps, kept word for word. */
const before = {
  sourcePerFrame: (clip: Clip, p: Project): number =>
    clip.freeze ? 0 : (clip.speed * p.settings.fpsDen) / p.settings.fpsNum,
  sourceTimeAt(clip: Clip, localFrame: number, p: Project): number {
    const per = before.sourcePerFrame(clip, p);
    if (per === 0) return clip.sourceIn;
    if (clip.reverse) return clip.sourceIn + (clip.duration - 1 - localFrame) * per;
    return clip.sourceIn + localFrame * per;
  },
  handles(clip: Clip, asset: Asset | undefined, p: Project): { head: number; tail: number } {
    if (!hasSourceTime(clip.type) || clip.freeze || !asset || asset.duration <= 0)
      return { head: Infinity, tail: Infinity };
    const per = before.sourcePerFrame(clip, p);
    const used = clip.duration * per;
    const before_ = Math.max(0, clip.sourceIn);
    const after = Math.max(0, asset.duration - (clip.sourceIn + used));
    const eps = 1e-6;
    const headSrc = clip.reverse ? after : before_;
    const tailSrc = clip.reverse ? before_ : after;
    return { head: Math.floor(headSrc / per + eps), tail: Math.floor(tailSrc / per + eps) };
  },
};

describe('a clip without a ramp', () => {
  it('maps its frames to its media by the very numbers it did before there were ramps', () => {
    const rnd = random(1);
    let compared = 0;
    for (let r = 0; r < 2000; r++) {
      const f = atRate(FRAME_RATES[r % FRAME_RATES.length]);
      const duration = 1 + Math.floor(rnd() * 400);
      const clip = makeClip(r % 9 === 8 ? 'audio' : 'video', f.v1.id, {
        assetId: 'asset1',
        start: Math.floor(rnd() * 1000),
        duration,
        sourceIn: r % 11 === 0 ? 0 : rnd() * 50,
        speed: r % 5 === 0 ? [1, 2, 0.5, 0.05, 100][(r / 5) % 5] : 0.05 * Math.pow(2000, rnd()),
        reverse: r % 3 === 1,
        freeze: r % 7 === 6,
        // Sound that keeps its pitch is mapped like any other.
        keepPitch: [null, true, false][r % 3],
      });
      const p = f.p;
      const per = before.sourcePerFrame(clip, p);
      expect(Object.is(sourcePerFrame(clip, p), per)).toBe(true);
      for (let k = 0; k < 40; k++) {
        const u = k < 20 ? -30 + Math.floor(rnd() * (duration + 61)) : -30 + rnd() * (duration + 60);
        expect(Object.is(sourceTimeAt(clip, u, p), before.sourceTimeAt(clip, u, p))).toBe(true);
        if (!clip.freeze) {
          expect(Object.is(mediaAt(clip, u, p), clip.sourceIn + u * per)).toBe(true);
          const m = rnd() * 60;
          expect(Object.is(frameOfMedia(clip, m, p), (m - clip.sourceIn) / per)).toBe(true);
        }
        compared++;
      }
      for (const u of [0, duration - 1, duration]) {
        expect(Object.is(sourceTimeAt(clip, u, p), before.sourceTimeAt(clip, u, p))).toBe(true);
      }
      expect(Object.is(sourceSpan(clip, p).in, clip.sourceIn)).toBe(true);
      expect(Object.is(sourceSpan(clip, p).out, clip.sourceIn + duration * per)).toBe(true);
      for (const asset of [f.asset, { ...f.asset, duration: 7.3 }, { ...f.asset, duration: 0 }, undefined]) {
        const now = handles(clip, asset, p);
        const then = before.handles(clip, asset, p);
        expect(Object.is(now.head, then.head) && Object.is(now.tail, then.tail)).toBe(true);
      }
    }
    expect(compared).toBe(80000);
  });

  it('has one speed wherever it is asked', () => {
    const f = fixture();
    const clip = makeClip('video', f.v1.id, { assetId: 'asset1', duration: 90, sourceIn: 4, speed: 2.5 });
    expect(speedAt(clip, -10, f.p)).toBe(2.5);
    expect(speedAt(clip, 500, f.p)).toBe(2.5);
    expect(meanSpeed(clip, f.p)).toBe(2.5);
    expect(speedRange(clip, f.p)).toEqual({ lo: 2.5, hi: 2.5 });
    const still = { ...clip, freeze: true };
    expect([speedAt(still, 3, f.p), meanSpeed(still, f.p)]).toEqual([0, 0]);
    expect(speedRange(still, f.p)).toEqual({ lo: 0, hi: 0 });
    expect(mediaAt(still, 40, f.p)).toBe(4);
  });

  it('has the clock of its one speed', () => {
    const f = fixture();
    const clip = makeClip('audio', f.a1.id, { assetId: 'asset1', duration: 90, sourceIn: 4, speed: 2.5 });
    const map = timeMap(clip);
    for (const x of [-3, 0, 0.7, 4, 123.456]) {
      expect(map.stream(x)).toBe(x / 2.5);
      expect(map.media(x)).toBe(x * 2.5);
      expect(map.speed(x)).toBe(2.5);
    }
    expect(streamIn(clip)).toBe(map.stream(clip.sourceIn));
    // The stream starts where the clip does and runs as long as it lasts.
    const length = clip.duration / 30;
    expect(map.media(streamIn(clip) + length)).toBeCloseTo(sourceSpan(clip, f.p).out, 12);
    // A speed outside what can be set is what the mixer can play.
    expect(timeMap({ ...clip, speed: 1e308 }).speed(0)).toBe(100);
    expect(timeMap({ ...clip, speed: 5e-324 }).stream(1)).toBe(20);
  });
});

/** A clip on a ramp of its own, somewhere in the fixture's sixty seconds of media. */
function ramped(rnd: () => number, r: number) {
  const f = atRate(FRAME_RATES[r % FRAME_RATES.length]);
  const clip = makeClip('video', f.v1.id, {
    assetId: 'asset1',
    start: Math.floor(rnd() * 1000),
    duration: 1 + Math.floor(rnd() * 300),
    sourceIn: rnd() * 40,
    ramp: randomRamp(rnd),
    reverse: r % 3 === 1,
  });
  return { f, p: f.p, clip, dt: f.p.settings.fpsDen / f.p.settings.fpsNum };
}

describe('a clip on a ramp', () => {
  it('is a window on the stream of its ramp', () => {
    const rnd = random(2);
    for (let r = 0; r < 300; r++) {
      const { p, clip, dt } = ramped(rnd, r);
      const t = rampTable(clip.ramp!);
      const tauIn = mediaToStream(t, clip.sourceIn);
      expect(streamIn(clip)).toBe(tauIn);
      expect(Math.abs(mediaAt(clip, 0, p) - clip.sourceIn)).toBeLessThan(1e-12);
      // Outside the clip as inside it: transitions and trims ask there.
      for (const u of [-45.5, -1, 0, 0.25, clip.duration / 2, clip.duration, clip.duration + 30]) {
        expect(mediaAt(clip, u, p)).toBe(
          streamToMedia(t, tauIn + (u * p.settings.fpsDen) / p.settings.fpsNum),
        );
        expect(speedAt(clip, u, p)).toBe(streamSpeed(t, tauIn + (u * p.settings.fpsDen) / p.settings.fpsNum));
        expect(Math.abs(frameOfMedia(clip, mediaAt(clip, u, p), p) - u)).toBeLessThan(1e-9);
        const shown = clip.reverse ? mediaAt(clip, clip.duration - 1 - u, p) : mediaAt(clip, u, p);
        expect(sourceTimeAt(clip, u, p)).toBe(shown);
      }
      // Played backwards it shows the same frames in the other order.
      const forwards = { ...clip, reverse: false };
      const backwards = { ...clip, reverse: true };
      for (let u = -3; u < clip.duration + 3; u += 7) {
        expect(sourceTimeAt(backwards, u, p)).toBe(sourceTimeAt(forwards, clip.duration - 1 - u, p));
      }
      // It runs forwards through the media, never faster or slower than a ramp goes.
      for (let u = -5; u < clip.duration + 5; u++) {
        const step = mediaAt(clip, u + 1, p) - mediaAt(clip, u, p);
        expect(step).toBeGreaterThan(0.1 * dt * (1 - 1e-9));
        expect(step).toBeLessThan(10 * dt * (1 + 1e-9));
      }
      const span = sourceSpan(clip, p);
      expect(span).toEqual({ in: clip.sourceIn, out: mediaAt(clip, clip.duration, p) });
      expect(sourcePerFrame(clip, p)).toBe((span.out - span.in) / clip.duration);
      expect(meanSpeed(clip, p)).toBeCloseTo((span.out - span.in) / (clip.duration * dt), 9);
      const map = timeMap(clip);
      expect(map.stream(clip.sourceIn)).toBe(streamIn(clip));
      expect(map.media(streamIn(clip) + clip.duration * dt)).toBeCloseTo(span.out, 9);
      expect(map.speed(streamIn(clip))).toBe(speedAt(clip, 0, p));
    }
  });

  it('does not read its stored speed', () => {
    const { p, clip } = ramped(random(3), 0);
    for (const u of [-10, 0, 17, 400]) {
      expect(sourceTimeAt({ ...clip, speed: 7 }, u, p)).toBe(sourceTimeAt(clip, u, p));
    }
    expect(handles({ ...clip, speed: 7 }, p.assets.asset1, p)).toEqual(handles(clip, p.assets.asset1, p));
  });

  it('holds its frame when it is a freeze, whatever ramp is left in the data', () => {
    const { p, clip } = ramped(random(4), 0);
    const still = { ...clip, freeze: true };
    for (const u of [-10, 0, 17, 400]) {
      expect(sourceTimeAt(still, u, p)).toBe(clip.sourceIn);
      expect(mediaAt(still, u, p)).toBe(clip.sourceIn);
      expect(speedAt(still, u, p)).toBe(0);
    }
    expect(sourcePerFrame(still, p)).toBe(0);
    expect(sourceSpan(still, p)).toEqual({ in: clip.sourceIn, out: clip.sourceIn });
    expect(handles(still, p.assets.asset1, p)).toEqual({ head: Infinity, tail: Infinity });
    expect(timeMap(still).speed(0)).toBe(1);
  });

  it('has as many frames of handle as its ramp reaches the ends of the file in', () => {
    const rnd = random(5);
    let reversed = 0;
    for (let r = 0; r < 2000; r++) {
      const { f, p, clip, dt } = ramped(rnd, r);
      const { head, tail } = handles({ ...clip, reverse: false }, f.asset, p);
      // One frame further out than the handle and the media is not there. A millionth of a frame
      // of tolerance is the handles' own.
      const slack = 10 * dt * 1e-6;
      expect(mediaAt(clip, -head, p)).toBeGreaterThanOrEqual(-slack);
      expect(mediaAt(clip, -head - 1, p)).toBeLessThan(0);
      if (sourceSpan(clip, p).out <= f.asset.duration) {
        expect(mediaAt(clip, clip.duration + tail, p)).toBeLessThanOrEqual(f.asset.duration + slack);
        expect(mediaAt(clip, clip.duration + tail + 1, p)).toBeGreaterThan(f.asset.duration);
      } else expect(tail).toBe(0);
      // Played backwards the clip begins at the top of its stretch: the two change places.
      expect(handles({ ...clip, reverse: true }, f.asset, p)).toEqual({ head: tail, tail: head });
      if (clip.reverse) reversed++;
    }
    expect(reversed).toBeGreaterThan(600);
  });

  it('has no handle before the start of its file, also from an in point before it', () => {
    const { f, p, clip } = ramped(random(6), 0);
    expect(handles({ ...clip, sourceIn: 0 }, f.asset, p).head).toBe(0);
    expect(handles({ ...clip, sourceIn: -3 }, f.asset, p).head).toBe(0);
    expect(handles({ ...clip, sourceIn: 59.99, duration: 300 }, f.asset, p).tail).toBe(0);
  });

  it('has every handle, and slips without a limit, while nothing is known of its file', () => {
    const { f, clip } = ramped(random(7), 0);
    const forwards = { ...clip, reverse: false, sourceIn: 12 };
    const unknown = [
      { ...forwards, assetId: null },
      { ...forwards, assetId: 'gone' },
      { ...forwards, assetId: 'empty' },
    ];
    const p = applyEdits(f.p, [
      { op: 'addAsset', asset: { ...f.asset, id: 'empty', duration: 0 } },
      ...unknown.map((c, i): Edit => ({ op: 'addClip', clip: { ...c, id: `u${i}`, start: i * 1000 } })),
    ]);
    for (const c of Object.values(p.clips)) {
      expect(handles(c, c.assetId ? p.assets[c.assetId] : undefined, p)).toEqual({
        head: Infinity,
        tail: Infinity,
      });
      // Far past where a sixty-second file would end, and by the ramp all the way.
      const [edit] = slipClips(p, [c.id], 9000);
      expect(edit).toEqual({ op: 'updateClip', id: c.id, patch: { sourceIn: mediaAt(c, 9000, p) } });
      expect(slipClips(p, [c.id], -9000)).toEqual([{ op: 'updateClip', id: c.id, patch: { sourceIn: 0 } }]);
    }
  });

  it('knows the slowest and the fastest it plays over the stretch it covers', () => {
    const f = fixture();
    // "Hero" over seconds 10 to 20: 100%, up to 400% at 12.5, down to 30% from 14 to 16, 400% at 17.5, 100%.
    const ramp = shapeRamp('hero', 10, 20, false)!;
    const whole = makeClip('video', f.v1.id, { assetId: 'asset1', duration: 302, sourceIn: 10, ramp });
    expect(speedRange(whole, f.p)).toEqual({ lo: 0.3, hi: 4 });
    // Trimmed into the first ease: it never reaches the point at 400%.
    const head = makeClip('video', f.v1.id, { assetId: 'asset1', duration: 12, sourceIn: 10.5, ramp });
    const range = speedRange(head, f.p);
    expect(range.lo).toBe(speedAt(head, 0, f.p));
    expect(range.hi).toBe(speedAt(head, 12, f.p));
    expect(range.lo).toBeGreaterThan(1);
    expect(range.hi).toBeLessThan(4);
    expect(sourceSpan(head, f.p).out).toBeLessThan(12.5);
    // Trimmed to the slow middle and a little of the eases either side.
    const slow = makeClip('video', f.v1.id, { assetId: 'asset1', sourceIn: 13.5, ramp });
    const middle = { ...slow, duration: Math.ceil(frameOfMedia(slow, 16, f.p)) + 3 };
    expect(sourceSpan(middle, f.p).out).toBeGreaterThan(16);
    expect(sourceSpan(middle, f.p).out).toBeLessThan(17.5);
    expect(speedRange(middle, f.p).lo).toBe(0.3);
    expect(speedRange(middle, f.p).hi).toBe(
      Math.max(speedAt(middle, 0, f.p), speedAt(middle, middle.duration, f.p)),
    );
    // Beyond the points it goes on at the outermost speed.
    const after = makeClip('video', f.v1.id, { assetId: 'asset1', duration: 30, sourceIn: 25, ramp });
    expect(speedRange(after, f.p)).toEqual({ lo: 1, hi: 1 });
    expect(sourceSpan(after, f.p).out).toBeCloseTo(26, 12);
    // The mean of the whole shape: ten seconds of media in the time the eases add up to.
    expect(meanSpeed(whole, f.p)).toBeCloseTo(10 / (302 / 30), 2);
    expect(tidyRamp(ramp)).toEqual(ramp);
  });
});
