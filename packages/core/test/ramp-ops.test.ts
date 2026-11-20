import { describe, expect, it } from 'vitest';
import {
  RAMP_SHAPES,
  applyEdits,
  changeFrameRate,
  clamp,
  clearRegions,
  clipAt,
  clipAtRate,
  clipEnd,
  deleteRange,
  evalKeyframes,
  frameOfMedia,
  freezeFrame,
  handles,
  hasSourceTime,
  makeClip,
  mediaAt,
  neighbors,
  openGap,
  retime,
  rippleTrim,
  rippleTrimTo,
  rollEdit,
  scaleKeyframes,
  setRamp,
  setSpeed,
  shapeOf,
  shapeRamp,
  shiftKeyframes,
  shiftRamp,
  slipClips,
  sourceSpan,
  sourceTimeAt,
  speedAt,
  splitClips,
  tidyRamp,
  trimClips,
  trimRange,
} from '../src';
import type { Clip, Edit, ID, Keyframe, Project, RampPoint, RampShape } from '../src';
import { FRAME_RATES, atRate, fixture, overlaps, random, randomRamp, type Fixture } from './helpers';

const SHAPES = Object.keys(RAMP_SHAPES) as RampShape[];

/** The rates of `FRAME_RATES` and 25 fps, which the lengths of linked clips are checked at as well. */
const RATES: readonly (readonly [number, number])[] = [...FRAME_RATES, [25, 1]];

const shows = (p: Project, c: Clip, frame: number): number => sourceTimeAt(c, frame - c.start, p);

/** The furthest apart, in seconds of media, two clips are on a frame they share. Null when they share none. */
function apart(p: Project, a: Clip, b: Clip): number | null {
  const from = Math.max(a.start, b.start);
  const to = Math.min(clipEnd(a), clipEnd(b));
  if (to <= from) return null;
  let worst = 0;
  for (let frame = from; frame < to; frame++) {
    worst = Math.max(worst, Math.abs(shows(p, a, frame) - shows(p, b, frame)));
  }
  return worst;
}

const put = (p: Project, ...clips: Clip[]): Project =>
  applyEdits(
    p,
    clips.map((clip): Edit => ({ op: 'addClip', clip })),
  );

const picture = (f: Fixture, init: Partial<Clip>): Clip =>
  makeClip('video', f.v1.id, { assetId: 'asset1', ...init });

const sound = (f: Fixture, init: Partial<Clip>): Clip =>
  makeClip('audio', f.a1.id, { assetId: 'asset1', ...init });

const dtOf = (p: Project): number => p.settings.fpsDen / p.settings.fpsNum;

/** The ramp change that lays `shape` over the stretch a clip plays. */
const shaped = (p: Project, c: Clip, shape: RampShape): { ramps: Record<ID, RampPoint[] | null> } => {
  const { in: a, out: b } = sourceSpan(c, p);
  return { ramps: { [c.id]: shapeRamp(shape, a, b, c.reverse) } };
};

/** `retime`, `slipClips` and `setSpeed` as they were before there were ramps, kept word for word. */
const before = {
  sourcePerFrame: (clip: Clip, p: Project): number =>
    clip.freeze ? 0 : (clip.speed * p.settings.fpsDen) / p.settings.fpsNum,
  retime(clip: Clip, newStart: number, newEnd: number, p: Project): Partial<Clip> {
    const headDelta = newStart - clip.start;
    const tailDelta = clipEnd(clip) - newEnd;
    const duration = Math.max(1, newEnd - newStart);
    const patch: Partial<Clip> = { start: newStart, duration };
    if (hasSourceTime(clip.type)) {
      const per = before.sourcePerFrame(clip, p);
      const delta = clip.reverse ? tailDelta : headDelta;
      if (delta !== 0) patch.sourceIn = Math.max(0, clip.sourceIn + delta * per);
    }
    if (headDelta !== 0 && Object.keys(clip.keyframes).length) {
      patch.keyframes = shiftKeyframes(clip.keyframes, headDelta);
    }
    if (clip.fadeIn > duration) patch.fadeIn = duration;
    if (clip.fadeOut > duration) patch.fadeOut = duration;
    return patch;
  },
  slipClips(p: Project, ids: ID[], delta: number): Edit[] {
    const edits: Edit[] = [];
    for (const id of ids) {
      const c = p.clips[id];
      if (!c || !hasSourceTime(c.type)) continue;
      const asset = c.assetId ? p.assets[c.assetId] : undefined;
      const per = before.sourcePerFrame(c, p);
      const used = c.duration * per;
      const maxIn = asset && asset.duration > 0 ? Math.max(0, asset.duration - used) : Infinity;
      const sourceIn = clamp(c.sourceIn + (c.reverse ? -delta : delta) * per, 0, maxIn);
      if (sourceIn !== c.sourceIn) edits.push({ op: 'updateClip', id, patch: { sourceIn } });
    }
    return edits;
  },
  setSpeed(p: Project, ids: ID[], speed: number, reverse?: boolean): Edit[] {
    const sp = clamp(speed, 0.05, 100);
    const edits: Edit[] = [];
    for (const id of new Set(ids)) {
      const c = p.clips[id];
      if (!c || !hasSourceTime(c.type) || c.freeze) continue;
      const natural = Math.max(1, Math.round((c.duration * c.speed) / sp));
      let duration = natural;
      const { next } = neighbors(p, c);
      if (next) duration = Math.min(duration, Math.max(1, next.start - c.start));
      const patch: Partial<Clip> = { speed: sp, duration };
      if (reverse !== undefined) patch.reverse = reverse;
      if (duration < natural && (reverse ?? c.reverse)) {
        const per = (sp * p.settings.fpsDen) / p.settings.fpsNum;
        patch.sourceIn = c.sourceIn + (natural - duration) * per;
      }
      if (Object.keys(c.keyframes).length) patch.keyframes = scaleKeyframes(c.keyframes, c.speed / sp);
      if (c.fadeIn > duration) patch.fadeIn = duration;
      if (c.fadeOut > duration) patch.fadeOut = duration;
      edits.push({ op: 'updateClip', id, patch });
    }
    return edits;
  },
};

describe('clips without a ramp', () => {
  it('are trimmed, slipped and set to a speed by the very numbers they were before there were ramps', () => {
    const rnd = random(11);
    let sounds = 0;
    for (let r = 0; r < 2000; r++) {
      const f = atRate(FRAME_RATES[r % FRAME_RATES.length]);
      const keyframes: Record<string, Keyframe[]> =
        r % 4 === 0
          ? {
              x: [
                { t: 3, v: 0, e: 'linear' },
                { t: 41, v: 1, e: 'ease' },
              ],
            }
          : {};
      const init: Partial<Clip> = {
        assetId: r % 13 === 0 ? null : 'asset1',
        start: 100 + Math.floor(rnd() * 500),
        duration: 1 + Math.floor(rnd() * 400),
        sourceIn: r % 11 === 0 ? 0 : rnd() * 50,
        speed: r % 5 === 0 ? [1, 2, 0.5, 0.05, 100][(r / 5) % 5] : 0.05 * Math.pow(2000, rnd()),
        reverse: r % 3 === 1,
        freeze: r % 17 === 16,
        fadeIn: r % 6 === 0 ? 50 : 0,
        fadeOut: r % 8 === 0 ? 70 : 0,
        keepPitch: [null, null, true, false][r % 4],
        keyframes,
      };
      const clip = r % 2 ? sound(f, init) : picture(f, init);
      const neighbour = { ...clip, id: 'next', start: clipEnd(clip) + Math.floor(rnd() * 300) };
      const p = put(f.p, clip, neighbour);

      for (let k = 0; k < 6; k++) {
        const newStart = clip.start + Math.floor(rnd() * 80) - 40;
        const newEnd = Math.max(newStart + 1, clipEnd(clip) + Math.floor(rnd() * 80) - 40);
        expect(retime(clip, newStart, newEnd, p)).toStrictEqual(before.retime(clip, newStart, newEnd, p));
        const delta = Math.floor(rnd() * 400) - 200;
        expect(slipClips(p, [clip.id], delta)).toStrictEqual(before.slipClips(p, [clip.id], delta));
      }
      const speed = r % 7 === 0 ? clip.speed : 0.03 * Math.pow(5000, rnd());
      const turn = [undefined, true, false][r % 3];
      const then = before.setSpeed(p, [clip.id, 'next'], speed, turn);
      // All that is new for such clips: sound whose speed changes keeps its pitch from then on.
      const changes = clamp(speed, 0.05, 100) !== clip.speed;
      for (const e of then) {
        if (e.op === 'updateClip' && clip.type === 'audio' && clip.keepPitch === null && changes) {
          e.patch.keepPitch = true;
          sounds++;
        }
      }
      expect(setSpeed(p, [clip.id, 'next'], speed, turn)).toStrictEqual(then);
    }
    expect(sounds).toBeGreaterThan(400);
  });
});

/**
 * A clip on a ramp of its own, alone on V1, with media for forty-five frames and more either side
 * of it in its sixty-second file.
 */
function rampedClip(rnd: () => number, r: number, init: Partial<Clip> = {}) {
  const f = atRate(FRAME_RATES[r % FRAME_RATES.length]);
  let clip = picture(f, {
    start: 200,
    duration: 20 + Math.floor(rnd() * 120),
    sourceIn: 20 + rnd() * 5,
    ramp: randomRamp(rnd).map((q) => ({ ...q, m: q.m + 18 })),
    reverse: r % 2 === 1,
    ...init,
  });
  while (mediaAt(clip, clip.duration + 45, f.p) > 59.5) clip = { ...clip, duration: clip.duration >> 1 };
  return { f, clip, p: put(f.p, clip) };
}

describe('window edits on a clip on a ramp', () => {
  it('splits into two halves that go on showing what the clip showed, handles included', () => {
    const rnd = random(21);
    let worst = 0;
    for (let r = 0; r < 12; r++) {
      const { clip, p } = rampedClip(rnd, r);
      for (let k = 1; k < clip.duration; k++) {
        const split = splitClips(p, [clip.id], clip.start + k);
        const q = applyEdits(p, split.edits);
        const left = q.clips[clip.id];
        const right = q.clips[split.created[0]];
        expect([left.duration, right.start, right.duration]).toEqual([k, clip.start + k, clip.duration - k]);
        // The ramp is not written: both halves hold the very array, and with it the table made for it.
        expect(left.ramp).toBe(clip.ramp);
        expect(right.ramp).toBe(clip.ramp);
        for (const half of [left, right]) {
          for (let frame = half.start - 15; frame < clipEnd(half) + 15; frame++) {
            worst = Math.max(worst, Math.abs(shows(q, half, frame) - shows(p, clip, frame)));
          }
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('comes back from a trim in and out again with its in point where it was', () => {
    const rnd = random(22);
    for (let r = 0; r < 200; r++) {
      const { clip, p } = rampedClip(rnd, r, { fadeIn: 3 });
      for (const edge of ['start', 'end'] as const) {
        const by = (edge === 'start' ? 1 : -1) * (1 + Math.floor(rnd() * (clip.duration - 8)));
        const trimmed = applyEdits(p, trimClips(p, [clip.id], edge, by));
        expect(trimmed.clips[clip.id].duration).toBe(clip.duration - Math.abs(by));
        expect(trimmed.clips[clip.id].ramp).toBe(clip.ramp);
        const back = applyEdits(trimmed, trimClips(trimmed, [clip.id], edge, -by)).clips[clip.id];
        expect(Math.abs(back.sourceIn - clip.sourceIn)).toBeLessThan(1e-9);
        expect({ ...back, sourceIn: clip.sourceIn }).toEqual(clip);
        // Trimmed, what is left shows what it showed.
        const kept = trimmed.clips[clip.id];
        for (let frame = kept.start; frame < clipEnd(kept); frame++) {
          expect(Math.abs(shows(trimmed, kept, frame) - shows(p, clip, frame))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('can be trimmed out as far as its handles say, and no further', () => {
    const rnd = random(23);
    for (let r = 0; r < 300; r++) {
      const { f, clip, p } = rampedClip(rnd, r, { start: 5000, sourceIn: 0.3 + rnd() * 3 });
      // The edge that leads back to the start of the file: the head, or played backwards the tail.
      const edge = clip.reverse ? 'end' : 'start';
      const h = handles(clip, f.asset, p);
      const by = clip.reverse ? h.tail : -h.head;
      expect(Math.abs(by)).toBeGreaterThan(0);
      const range = trimRange(p, [clip.id], edge, false);
      expect(clip.reverse ? range.max : range.min).toBe(by);
      const out = applyEdits(p, trimClips(p, [clip.id], edge, by)).clips[clip.id];
      expect(out.duration).toBe(clip.duration + Math.abs(by));
      expect(out.sourceIn).toBeGreaterThanOrEqual(0);
      expect(out.sourceIn).toBeLessThan(10 * dtOf(p));
      // Nothing was clamped on the way: the frames it had show what they showed.
      for (let frame = clip.start; frame < clipEnd(clip); frame += 5) {
        expect(Math.abs(shows(p, out, frame) - shows(p, clip, frame))).toBeLessThan(1e-9);
      }
      expect(handles(out, f.asset, p)[clip.reverse ? 'tail' : 'head']).toBe(0);
      // One frame more is not there to be had.
      expect(trimClips(p, [clip.id], edge, by + Math.sign(by))).toEqual(trimClips(p, [clip.id], edge, by));
    }
  });

  /** Two takes cut together, picture on V1 and sound on A1, each pair linked, in step and on a ramp of its own. */
  function cutOfTwo(reverse = false) {
    const f = fixture();
    const first = { start: 100, duration: 120, sourceIn: 8, reverse, linkId: 'one' };
    const second = { start: 220, duration: 150, sourceIn: 30, reverse, linkId: 'two' };
    const rampOne = shapeRamp('hero', 6, 18, reverse)!;
    const rampTwo = shapeRamp('flashIn', 27, 41, reverse)!;
    const clips = {
      v1: picture(f, { ...first, ramp: rampOne }),
      a1: sound(f, { ...first, ramp: rampOne }),
      v2: picture(f, { ...second, ramp: rampTwo }),
      a2: sound(f, { ...second, ramp: rampTwo }),
    };
    return { f, ...clips, p: put(f.p, ...Object.values(clips)) };
  }

  /** What a track shows on a frame: the media second, or null where it is empty. */
  const onTrack = (p: Project, trackId: ID, frame: number): number | null => {
    const c = clipAt(p, trackId, frame);
    return c ? shows(p, c, frame) : null;
  };

  /**
   * After an edit, every frame of both tracks shows what `was` says it showed before (a frame of
   * the timeline as it was, or null for a frame that is now empty), and every linked picture and
   * sound show the same media on every frame they share.
   */
  function expectKept(p: Project, q: Project, f: Fixture, was: (frame: number) => number | null): void {
    for (const track of [f.v1, f.a1]) {
      for (let frame = 0; frame < 450; frame++) {
        const from = was(frame);
        const now = onTrack(q, track.id, frame);
        if (from === null) expect(now).toBeNull();
        else expect(Math.abs(now! - onTrack(p, track.id, from)!)).toBeLessThan(1e-9);
      }
    }
    const linked = new Map<ID, Clip[]>();
    for (const c of Object.values(q.clips)) {
      if (c.linkId) linked.set(c.linkId, [...(linked.get(c.linkId) ?? []), c]);
    }
    expect(linked.size).toBeGreaterThan(1);
    for (const [a, b] of linked.values()) {
      expect(b).toBeDefined();
      expect(apart(q, a, b)).toBeLessThan(1e-9);
      expect(a.ramp).toBe(b.ramp);
    }
    expect(overlaps(q)).toEqual([]);
  }

  for (const reverse of [false, true]) {
    const way = reverse ? 'played backwards' : 'played forwards';

    it(`keeps every frame it keeps through a roll, ${way}`, () => {
      const c = cutOfTwo(reverse);
      for (const by of [-25, 17]) {
        const q = applyEdits(c.p, [
          ...rollEdit(c.p, c.v1.id, c.v2.id, by),
          ...rollEdit(c.p, c.a1.id, c.a2.id, by),
        ]);
        expect(q.clips[c.v1.id].duration).toBe(120 + by);
        expect([q.clips[c.v2.id].start, q.clips[c.v2.id].duration]).toEqual([220 + by, 150 - by]);
        // Either side of the cut each clip shows what it showed there, or would have shown had it run on.
        for (const [now, then] of [
          [q.clips[c.v1.id], c.v1],
          [q.clips[c.v2.id], c.v2],
          [q.clips[c.a1.id], c.a1],
          [q.clips[c.a2.id], c.a2],
        ]) {
          for (let frame = now.start; frame < clipEnd(now); frame++) {
            expect(Math.abs(shows(q, now, frame) - shows(c.p, then, frame))).toBeLessThan(1e-9);
          }
        }
        expect(apart(q, q.clips[c.v1.id], q.clips[c.a1.id])).toBeLessThan(1e-9);
        expect(apart(q, q.clips[c.v2.id], q.clips[c.a2.id])).toBeLessThan(1e-9);
      }
    });

    it(`keeps every frame it keeps through ripple trims and a trim to the playhead, ${way}`, () => {
      const c = cutOfTwo(reverse);
      const tail = rippleTrim(c.p, [c.v1.id, c.a1.id], 'end', -30);
      expect(tail.refused).toBeNull();
      expectKept(c.p, applyEdits(c.p, tail.edits), c.f, (frame) =>
        frame < 100 ? null : frame < 190 ? frame : frame < 340 ? frame + 30 : null,
      );
      const head = rippleTrim(c.p, [c.v2.id, c.a2.id], 'start', 40);
      expect(head.refused).toBeNull();
      expectKept(c.p, applyEdits(c.p, head.edits), c.f, (frame) =>
        frame < 100 ? null : frame < 220 ? frame : frame < 330 ? frame + 40 : null,
      );
      const to = rippleTrimTo(c.p, [c.v1.id, c.a1.id], 'start', 133);
      expect(to.refused).toBeNull();
      expectKept(c.p, applyEdits(c.p, to.edits), c.f, (frame) =>
        frame < 100 ? null : frame < 337 ? frame + 33 : null,
      );
      const from = rippleTrimTo(c.p, [c.v2.id, c.a2.id], 'end', 300);
      expect(from.refused).toBeNull();
      expectKept(c.p, applyEdits(c.p, from.edits), c.f, (frame) =>
        frame < 100 ? null : frame < 300 ? frame : null,
      );
    });

    it(`keeps every frame it keeps through an overwrite, an insert and a range delete, ${way}`, () => {
      const c = cutOfTwo(reverse);
      const tracks = [c.f.v1.id, c.f.a1.id];
      // Overwritten across the cut: two pieces of each clip are left, and nothing else moves.
      const over = tracks.flatMap((id) => clearRegions(c.p, id, [[150, 260]]));
      expectKept(c.p, applyEdits(c.p, over), c.f, (frame) =>
        frame < 100 || frame >= 370 ? null : frame >= 150 && frame < 260 ? null : frame,
      );
      // Overwritten in the middle of the first clip: it is in two pieces, linked as the halves of a split are.
      const hole = tracks.flatMap((id) => clearRegions(c.p, id, [[130, 160]]));
      const holed = applyEdits(c.p, hole);
      expect(Object.keys(holed.clips)).toHaveLength(6);
      expectKept(c.p, holed, c.f, (frame) =>
        frame < 100 || frame >= 370 ? null : frame >= 130 && frame < 160 ? null : frame,
      );
      const opened = applyEdits(c.p, openGap(c.p, tracks, 171, 60));
      expectKept(c.p, opened, c.f, (frame) =>
        frame < 100 || frame >= 430 ? null : frame < 171 ? frame : frame < 231 ? null : frame - 60,
      );
      expectKept(c.p, applyEdits(c.p, deleteRange(c.p, tracks, 180, 250, false)), c.f, (frame) =>
        frame < 100 || frame >= 370 ? null : frame >= 180 && frame < 250 ? null : frame,
      );
      expectKept(c.p, applyEdits(c.p, deleteRange(c.p, tracks, 180, 250, true)), c.f, (frame) =>
        frame < 100 || frame >= 300 ? null : frame < 180 ? frame : frame + 70,
      );
    });
  }

  it('slips along its ramp: every frame shows what the frame that many on showed', () => {
    const rnd = random(24);
    for (let r = 0; r < 300; r++) {
      const { clip, p } = rampedClip(rnd, r);
      const n = Math.floor(rnd() * 60) - 30;
      const [edit] = slipClips(p, [clip.id], n);
      if (n === 0) {
        expect(edit).toBeUndefined();
        continue;
      }
      expect(edit).toMatchObject({ op: 'updateClip', id: clip.id });
      expect(Object.keys((edit as { patch: object }).patch)).toEqual(['sourceIn']);
      const q = applyEdits(p, [edit]);
      const slipped = q.clips[clip.id];
      for (let u = -10; u < clip.duration + 10; u++) {
        expect(Math.abs(sourceTimeAt(slipped, u, q) - sourceTimeAt(clip, u + n, p))).toBeLessThan(1e-9);
      }
      // Played backwards, the in point goes the other way along the media.
      expect(Math.sign(slipped.sourceIn - clip.sourceIn)).toBe(clip.reverse ? -Math.sign(n) : Math.sign(n));
      // And back again it is where it was.
      const back = applyEdits(q, slipClips(q, [clip.id], -n)).clips[clip.id];
      expect(Math.abs(back.sourceIn - clip.sourceIn)).toBeLessThan(1e-9);
    }
  });

  it('stops slipping at both ends of its file', () => {
    const rnd = random(25);
    for (let r = 0; r < 300; r++) {
      const { f, clip, p } = rampedClip(rnd, r);
      for (const far of [1e7, -1e7]) {
        const q = applyEdits(p, slipClips(p, [clip.id], far));
        const stopped = q.clips[clip.id];
        const atTop = far > 0 !== clip.reverse;
        if (atTop) {
          // Its last frame of media ends where the file does.
          expect(Math.abs(sourceSpan(stopped, q).out - f.asset.duration)).toBeLessThan(1e-9);
          expect(handles(stopped, f.asset, q)[clip.reverse ? 'head' : 'tail']).toBe(0);
        } else {
          expect(stopped.sourceIn).toBe(0);
          expect(handles(stopped, f.asset, q)[clip.reverse ? 'tail' : 'head']).toBe(0);
        }
        expect(stopped.duration).toBe(clip.duration);
        expect(slipClips(q, [clip.id], far)).toEqual([]);
        expect(slipClips(q, [clip.id], Math.sign(far))).toEqual([]);
      }
    }
  });

  it('keeps a linked picture and sound in step when both are slipped', () => {
    for (const reverse of [false, true]) {
      const c = cutOfTwo(reverse);
      for (const n of [-40, 13, 200]) {
        const q = applyEdits(c.p, slipClips(c.p, [c.v1.id, c.a1.id], n));
        expect(q.clips[c.v1.id].sourceIn).not.toBe(c.v1.sourceIn);
        expect(apart(q, q.clips[c.v1.id], q.clips[c.a1.id])).toBeLessThan(1e-9);
      }
    }
  });

  it('freezes a frame of it into a still that has no ramp, and carries on after it', () => {
    for (const reverse of [false, true]) {
      const c = cutOfTwo(reverse);
      // Both clips of the take keep their pitch, as far as that is said of a picture.
      const p = applyEdits(
        c.p,
        [c.v1.id, c.a1.id].map((id): Edit => ({ op: 'updateClip', id, patch: { keepPitch: true } })),
      );
      const shot = p.clips[c.v1.id];
      const frozen = freezeFrame(p, shot.id, 147, 45);
      const q = applyEdits(p, frozen.edits);
      const still = q.clips[frozen.created[0]];
      expect(still).toMatchObject({ freeze: true, ramp: null, keepPitch: null, start: 147, duration: 45 });
      expect(still.sourceIn).toBe(shows(p, shot, 147));
      for (const frame of [147, 170, 191]) expect(shows(q, still, frame)).toBe(shows(p, shot, 147));
      // The halves go on from where they were cut, picture and sound alike, on the ramp they had.
      const pieces = Object.values(q.clips).filter((x) => x.id !== still.id && x.linkId !== 'two');
      expect(pieces).toHaveLength(4);
      for (const piece of pieces) {
        expect(piece.ramp).toBe(shot.ramp);
        expect(piece.keepPitch).toBe(true);
        const then = piece.type === 'audio' ? p.clips[c.a1.id] : shot;
        const moved = piece.start >= 192 ? 45 : 0;
        for (let frame = piece.start; frame < clipEnd(piece); frame++) {
          expect(Math.abs(shows(q, piece, frame) - shows(p, then, frame - moved))).toBeLessThan(1e-9);
        }
      }
      // A still has no speed to set a ramp on.
      expect(setRamp(q, [still.id], shaped(q, still, 'bullet'))).toEqual([]);
    }
  });

  it('keeps its ramp through a change of frame rate, which counts frames and nothing else', () => {
    const rnd = random(26);
    const keys = ['start', 'duration', 'fadeIn', 'fadeOut', 'keyframes', 'transIn', 'transOut', 'text'];
    for (let r = 0; r < 100; r++) {
      const { clip, p } = rampedClip(rnd, 2, {
        start: 7 + Math.floor(rnd() * 500),
        fadeIn: 3,
        reverse: false,
      });
      expect(Object.keys(clipAtRate(clip, 24 / 30))).toEqual(keys);
      const to24 = changeFrameRate(p, 24, 1);
      for (const e of to24) if (e.op === 'updateClip') expect(Object.keys(e.patch)).toEqual(keys);
      const at24 = applyEdits(p, to24);
      const slow = at24.clips[clip.id];
      expect(slow.ramp).toBe(clip.ramp);
      expect(slow.sourceIn).toBe(clip.sourceIn);
      const at30 = applyEdits(at24, changeFrameRate(at24, 30, 1));
      const again = at30.clips[clip.id];
      expect(again.ramp).toBe(clip.ramp);
      // The same real time after its first frame is the same second of the media at any rate.
      for (let k = 0; k <= 40; k++) {
        const seconds = (k / 40) * (slow.duration / 24);
        const forwards = (c: Clip, q: Project, fps: number): number => mediaAt(c, seconds * fps, q);
        expect(Math.abs(forwards(slow, at24, 24) - forwards(clip, p, 30))).toBeLessThan(1e-9);
        expect(Math.abs(forwards(again, at30, 30) - forwards(clip, p, 30))).toBeLessThan(1e-9);
      }
      // On the timeline its start is rounded to the new frames: what a moment of real time shows
      // moves by no more than half a new frame of media at the fastest the ramp goes.
      const fastest = Math.max(...clip.ramp!.map((q) => q.v));
      for (const [now, q, fps, then, was, rate] of [
        [slow, at24, 24, clip, p, 30],
        [again, at30, 30, slow, at24, 24],
      ] as const) {
        for (let frame = now.start; frame < clipEnd(now); frame++) {
          const before = (frame / fps) * rate - then.start;
          if (before < 0 || before > then.duration - 1) continue;
          const moved = Math.abs(shows(q, now, frame) - sourceTimeAt(then, before, was));
          expect(moved).toBeLessThanOrEqual((0.5 / fps) * fastest + 1e-9);
        }
      }
    }
  });
});

describe('setRamp', () => {
  /** A ten-second stretch from second 5, at frames 100 to 400 of V1. */
  const tenSeconds = (init: Partial<Clip> = {}) => {
    const f = fixture();
    const clip = picture(f, { start: 100, duration: 300, sourceIn: 5, ...init });
    return { f, clip, p: put(f.p, clip) };
  };

  it('gives each shape the length its speeds add up to, over the stretch the clip played', () => {
    const lengths: Record<string, number> = {};
    for (const shape of SHAPES) {
      for (const reverse of [false, true]) {
        const { clip, p } = tenSeconds({ reverse });
        const edits = setRamp(p, [clip.id], shaped(p, clip, shape));
        expect(edits).toHaveLength(1);
        const q = applyEdits(p, edits);
        const now = q.clips[clip.id];
        expect(now.start).toBe(100);
        expect(shapeOf(now.ramp!, reverse)).toBe(shape);
        expect(now.speed).toBe(1);
        // The same stretch of media, to half a frame of timeline at the speed the clip ends on in its media.
        const span = sourceSpan(now, q);
        expect(span.in).toBe(5);
        expect(Math.abs(span.out - 15)).toBeLessThanOrEqual(
          (0.5 / 30) * speedAt(now, now.duration, q) + 1e-9,
        );
        if (reverse) expect(now.duration).toBe(lengths[shape]);
        else lengths[shape] = now.duration;
      }
    }
    expect(lengths).toEqual({
      rampUp: 240,
      rampDown: 240,
      montage: 246,
      hero: 302,
      bullet: 69,
      flashIn: 230,
      flashOut: 230,
    });
  });

  it('writes the ramp with the length and the in point it was worked out with', () => {
    const { clip, p } = tenSeconds();
    const ramp = shapeRamp('bullet', 5, 15, false)!;
    expect(setRamp(p, [clip.id], { ramps: { [clip.id]: ramp } })).toEqual([
      { op: 'updateClip', id: clip.id, patch: { ramp, duration: 69, sourceIn: 5 } },
    ]);
    // Points are tidied on the way in, so two people who mean the same ramp write the same bytes.
    const loose = [
      { m: 15.0000001, v: 2 },
      { m: 4.9999999, v: 0.50004 },
    ];
    const [edit] = setRamp(p, [clip.id], { ramps: { [clip.id]: loose } });
    expect(edit).toMatchObject({ patch: { ramp: shapeRamp('rampUp', 5, 15, false), duration: 240 } });
  });

  it('stops at the next clip, unless it is told that room will be made', () => {
    const { f, clip, p: alone } = tenSeconds();
    const p = put(alone, picture(f, { start: 400, duration: 50, sourceIn: 40 }));
    const slow = {
      ramps: {
        [clip.id]: tidyRamp([
          { m: 5, v: 0.5 },
          { m: 15, v: 0.5 },
        ]),
      },
    };
    for (const [change, natural] of [
      [shaped(p, clip, 'hero'), 302],
      [slow, 600],
    ] as const) {
      const held = applyEdits(p, setRamp(p, [clip.id], change));
      expect(held.clips[clip.id].duration).toBe(300);
      expect(held.clips[clip.id].sourceIn).toBe(5);
      expect(overlaps(held)).toEqual([]);
      const free = applyEdits(p, setRamp(p, [clip.id], change, true));
      expect(free.clips[clip.id].duration).toBe(natural);
      expect(applyEdits(alone, setRamp(alone, [clip.id], change)).clips[clip.id].duration).toBe(natural);
      // Cut short, it plays the head of what it would play; with room made by a trim it plays the rest too.
      const cut = held.clips[clip.id];
      const whole = free.clips[clip.id];
      for (let u = 0; u < 300; u++) expect(sourceTimeAt(cut, u, held)).toBe(sourceTimeAt(whole, u, free));
      const lengthened = { ...cut, ...retime(cut, cut.start, cut.start + natural, held) };
      for (let u = 0; u < natural; u++) {
        expect(Math.abs(sourceTimeAt(lengthened, u, held) - sourceTimeAt(whole, u, free))).toBeLessThan(1e-9);
      }
    }
    // A faster shape leaves a gap, as a faster speed does.
    const fast = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, 'bullet')));
    expect(fast.clips[clip.id].duration).toBe(69);
  });

  it('keeps the first frame of a clip that plays backwards when the next clip cuts it short', () => {
    const { f, clip, p: alone } = tenSeconds({ reverse: true });
    const p = put(alone, picture(f, { start: 400, duration: 50, sourceIn: 40 }));
    const slow = {
      ramps: {
        [clip.id]: tidyRamp([
          { m: 5, v: 1 },
          { m: 10, v: 0.4 },
          { m: 15, v: 0.5 },
        ]),
      },
    };
    const held = applyEdits(p, setRamp(p, [clip.id], slow));
    const free = applyEdits(p, setRamp(p, [clip.id], slow, true));
    const cut = held.clips[clip.id];
    const whole = free.clips[clip.id];
    expect(whole.duration).toBeGreaterThan(500);
    expect(cut.duration).toBe(300);
    // What no longer fits comes off the bottom of the stretch: the in point moves up.
    expect(cut.sourceIn).toBeGreaterThan(8);
    expect(whole.sourceIn).toBe(5);
    for (let u = 0; u < 300; u++) {
      expect(Math.abs(sourceTimeAt(cut, u, held) - sourceTimeAt(whole, u, free))).toBeLessThan(1e-9);
    }
    // Its first frame is still the top of the stretch it played, to within the frame of media it showed.
    expect(Math.abs(sourceTimeAt(cut, 0, held) - sourceTimeAt(clip, 0, p))).toBeLessThan(1 / 30);
    // With room made by a trim of its tail the bottom of the stretch is back.
    const lengthened = { ...cut, ...retime(cut, cut.start, cut.start + whole.duration, held) };
    expect(Math.abs(lengthened.sourceIn - 5)).toBeLessThan(1e-9);
    for (let u = 0; u < whole.duration; u++) {
      expect(Math.abs(sourceTimeAt(lengthened, u, held) - sourceTimeAt(whole, u, free))).toBeLessThan(1e-9);
    }
  });

  it('takes keyframes to the frames that now show what theirs showed, and cuts fades to the new length', () => {
    const rnd = random(31);
    for (let r = 0; r < 60; r++) {
      const reverse = r % 2 === 1;
      const times = [-20, 0, 37, 150, 156, 299, 340].map((t) => t + Math.floor(rnd() * 5));
      const keyframes = {
        x: times.map((t, i): Keyframe => ({ t, v: i, e: 'linear' })),
        opacity: [{ t: 150, v: 0.5, e: 'hold' as const }],
      };
      const { f, clip, p: alone } = tenSeconds({ reverse, keyframes, fadeIn: 200, fadeOut: 90 });
      const p = r % 3 === 0 ? put(alone, picture(f, { start: 400, duration: 50, sourceIn: 40 })) : alone;
      const shape = SHAPES[r % SHAPES.length];
      const q = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, shape)));
      const now = q.clips[clip.id];
      expect(now.keyframes.x.map((k) => k.v)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      now.keyframes.x.forEach((k, i) => {
        expect(Number.isInteger(k.t)).toBe(true);
        // Half a frame of the timeline, in media at the speed the clip has there.
        const u = reverse ? now.duration - 1 - k.t : k.t;
        const half = (0.5 / 30) * Math.max(speedAt(now, u - 0.5, q), speedAt(now, u + 0.5, q));
        expect(Math.abs(sourceTimeAt(now, k.t, q) - sourceTimeAt(clip, times[i], p))).toBeLessThanOrEqual(
          half + 1e-9,
        );
        if (i) expect(k.t).toBeGreaterThanOrEqual(now.keyframes.x[i - 1].t);
      });
      expect(now.fadeIn).toBe(Math.min(200, now.duration));
      expect(now.fadeOut).toBe(Math.min(90, now.duration));
      // The value a frame had is the value the frame that shows the same media has, to the rounding.
      if (shape === 'rampUp' && !reverse) {
        expect(evalKeyframes(now.keyframes.x, now.keyframes.x[3].t)).toBe(3);
      }
    }
  });

  it('changes nothing when the clip has that ramp already', () => {
    for (const reverse of [false, true]) {
      const keyframes = { x: [{ t: 12.5, v: 1, e: 'linear' as const }] };
      const { f, clip, p: alone } = tenSeconds({ reverse, keyframes, fadeIn: 500 });
      const p = put(alone, picture(f, { start: 400, duration: 50, sourceIn: 40 }));
      const slow = {
        ramps: {
          [clip.id]: tidyRamp([
            { m: 5, v: 0.5 },
            { m: 15, v: 0.5 },
          ]),
        },
      };
      for (const change of [shaped(p, clip, 'montage'), slow]) {
        const q = applyEdits(p, setRamp(p, [clip.id], change));
        const now = q.clips[clip.id];
        // The same points in a list of their own: equal, not the same array.
        const again = setRamp(q, [clip.id], { ramps: { [clip.id]: now.ramp!.map((x) => ({ ...x })) } });
        expect(again).toEqual([
          { op: 'updateClip', id: clip.id, patch: { ramp: now.ramp, duration: now.duration } },
        ]);
        expect((again[0] as { patch: Partial<Clip> }).patch.ramp).toBe(now.ramp);
        expect(applyEdits(q, again).clips[clip.id]).toEqual(now);
      }
      // No ramp on a clip that has none.
      const none = setRamp(p, [clip.id], { ramps: { [clip.id]: null } });
      expect(none).toEqual([{ op: 'updateClip', id: clip.id, patch: { ramp: null, duration: 300 } }]);
      expect(applyEdits(p, none).clips[clip.id]).toEqual(clip);
    }
  });

  it('takes a clip off its ramp, back to the speed it has stored, over the stretch it plays', () => {
    for (const [shape, within] of [
      ['bullet', 3],
      ['hero', 1],
      ['montage', 1],
      ['flashOut', 3],
    ] as const) {
      for (const reverse of [false, true]) {
        for (const speed of [1, 2.5]) {
          const { clip, p } = tenSeconds({ reverse, speed, duration: Math.round(300 / speed) });
          const q = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, shape)));
          expect(q.clips[clip.id].speed).toBe(speed);
          const edits = setRamp(q, [clip.id], { ramps: { [clip.id]: null } });
          expect(Object.keys((edits[0] as { patch: object }).patch).sort()).toEqual([
            'duration',
            'ramp',
            'sourceIn',
          ]);
          const back = applyEdits(q, edits).clips[clip.id];
          expect(back).toMatchObject({ ramp: null, speed, start: 100, sourceIn: 5 });
          // The ramp's own length was rounded to a frame, at up to 500% where "Bullet" ends: that is not undone.
          expect(Math.abs(back.duration - clip.duration)).toBeLessThanOrEqual(within);
          expect(Math.abs(sourceSpan(back, q).out - sourceSpan(q.clips[clip.id], q).out)).toBeLessThanOrEqual(
            (0.5 / 30) * speed + 1e-9,
          );
        }
      }
    }
    // Fewer than two points are no ramp either.
    const { clip, p } = tenSeconds();
    const q = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, 'hero')));
    const one = setRamp(q, [clip.id], { ramps: { [clip.id]: [{ m: 7, v: 3 }] } });
    expect(applyEdits(q, one).clips[clip.id]).toMatchObject({ ramp: null, speed: 1, duration: 300 });
  });

  it('leaves alone what has no speed, and what it is given no ramp for', () => {
    const f = fixture();
    const clip = picture(f, { start: 100, duration: 300, sourceIn: 5 });
    const still = picture(f, { start: 500, duration: 30, sourceIn: 5, freeze: true });
    const title = makeClip('text', f.v2.id, { start: 0, duration: 90 });
    const image = makeClip('image', f.v2.id, { start: 100, duration: 90, assetId: 'asset1' });
    const p = put(f.p, clip, still, title, image);
    const ramp = shapeRamp('hero', 5, 15, false);
    const ramps = { [clip.id]: ramp, [still.id]: ramp, [title.id]: ramp, [image.id]: ramp, missing: ramp };
    const edits = setRamp(p, [still.id, title.id, image.id, 'missing', clip.id], { ramps });
    expect(edits.map((e) => (e as { id: ID }).id)).toEqual([clip.id]);
    expect(setRamp(p, [clip.id], { ramps: {} })).toEqual([]);
    expect(setRamp(p, [clip.id], { ramps: { [still.id]: ramp } })).toEqual([]);
    expect(setRamp(p, [], { ramps })).toEqual([]);
  });

  it('gives the same answer for clips named in any order, once or twice', () => {
    const f = fixture();
    const clips = [0, 1, 2, 3].map((i) =>
      picture(f, { start: 100 + i * 300, duration: 300, sourceIn: 2 + i * 11, reverse: i === 2 }),
    );
    const p = put(f.p, ...clips);
    const ramps: Record<ID, RampPoint[] | null> = {};
    clips.forEach((c, i) => Object.assign(ramps, shaped(p, c, SHAPES[i + 2]).ramps));
    const ids = clips.map((c) => c.id);
    const edits = setRamp(p, ids, { ramps });
    expect(edits.map((e) => (e as { id: ID }).id)).toEqual(ids);
    const q = applyEdits(p, edits);
    // "Hero" would be two frames longer, and the clip after it stands there.
    expect(ids.map((id) => q.clips[id].duration)).toEqual([246, 300, 69, 230]);
    expect(overlaps(q)).toEqual([]);
    const shuffled = setRamp(p, [ids[2], ids[0], ids[3], ids[0], ids[1], ids[2]], { ramps });
    expect(shuffled).toEqual(edits);
    // Each is what it is by itself: none of these stands in another's way.
    expect(ids.flatMap((id) => setRamp(p, [id], { ramps }))).toEqual(edits);
  });

  it('writes no number that is not finite, and nothing where a clock does not resolve the clip', () => {
    const finite = (edits: Edit[]): void => {
      for (const e of edits) {
        const { keyframes, ...patch } = (e as { patch: Partial<Clip> }).patch;
        const times = Object.values(keyframes ?? {}).flatMap((list) => list.map((k) => k.t));
        const numbers = [...Object.values(patch), ...times].filter((n) => typeof n === 'number');
        expect(numbers.filter((n) => !Number.isFinite(n))).toEqual([]);
      }
    };
    const keyframes = { x: [{ t: 40, v: 1, e: 'linear' as const }] };
    // One that ends on 100%, and one that ends on 10%, where the clock overflows soonest.
    const ramps = [
      shapeRamp('hero', 5, 15, false)!,
      tidyRamp([
        { m: 5, v: 10 },
        { m: 15, v: 0.1 },
      ])!,
    ];
    for (const sourceIn of [1e308, -1e308, 2e307, -2e307, 1e300, NaN, Infinity, -Infinity]) {
      for (const ramp of ramps) {
        for (const reverse of [false, true]) {
          const { clip, p } = tenSeconds({ sourceIn, reverse, keyframes });
          const on = setRamp(p, [clip.id], { ramps: { [clip.id]: ramp } });
          finite(on);
          const q = put(p, { ...clip, id: 'on', ramp, start: 1000 });
          const off = [setSpeed(q, ['on'], 2), setSpeed(q, ['on'], 0.05, !reverse)];
          off.push(
            setRamp(q, ['on'], { ramps: { on: null } }),
            setRamp(q, ['on'], { ramps: { on: ramps[0] } }),
          );
          off.forEach(finite);
          if (!Number.isFinite(sourceIn)) expect([on, ...off]).toEqual([[], [], [], [], []]);
          // Whatever came of it, a slip and a trim of the clip on its ramp write finite numbers too.
          for (const edits of [on, ...off]) {
            const after = applyEdits(q, edits);
            finite(slipClips(after, ['on'], 12));
            finite(slipClips({ ...after, assets: {} }, ['on'], -12));
            const c = after.clips.on;
            finite([{ op: 'updateClip', id: 'on', patch: retime(c, c.start + 5, clipEnd(c) - 3, after) }]);
          }
        }
      }
    }
    // Where the clock of the slow end gives out, nothing is written at all.
    const { clip, p } = tenSeconds({ sourceIn: 1e308 });
    expect(setRamp(p, [clip.id], { ramps: { [clip.id]: ramps[1] } })).toEqual([]);
    // A speed nobody could set, left in a document: going back to it gives no length either.
    const stuck = tenSeconds({ speed: 5e-324, ramp: ramps[0] });
    expect(setRamp(stuck.p, [stuck.clip.id], { ramps: { [stuck.clip.id]: null } })).toEqual([]);
    // One clip of a link group that cannot be resolved, and none of the group is changed.
    const f = fixture();
    const v = picture(f, { start: 100, duration: 300, sourceIn: 5, linkId: 'L' });
    const a = sound(f, { start: 100, duration: 300, sourceIn: NaN, linkId: 'L' });
    const linked = put(f.p, v, a);
    expect(setRamp(linked, [v.id], { ramps: { [v.id]: ramps[0] } })).toEqual([]);
    expect(setRamp(put(f.p, v), [v.id], { ramps: { [v.id]: ramps[0] } })).toHaveLength(1);
    const ramped = put(f.p, { ...v, ramp: ramps[0] }, { ...a, ramp: ramps[0] });
    expect(setSpeed(ramped, [v.id], 2)).toEqual([]);
  });
});

/**
 * A picture on V1 and its sound on A1, linked and in step at 100%: a split edit. The sound starts
 * `lead` frames after the picture (before it, where that is less than 0) and ends `tail` frames
 * after it.
 */
function splitEdit(
  f: Fixture,
  o: { start: number; duration: number; sourceIn: number; lead: number; tail: number; reverse?: boolean },
) {
  const dt = dtOf(f.p);
  const reverse = !!o.reverse;
  const v = picture(f, {
    start: o.start,
    duration: o.duration,
    sourceIn: o.sourceIn,
    reverse,
    linkId: 'take',
  });
  const a = sound(f, {
    start: o.start + o.lead,
    duration: o.duration - o.lead + o.tail,
    // A clip is anchored in its media where it begins, and played backwards where it ends.
    sourceIn: reverse ? o.sourceIn - o.tail * dt : o.sourceIn + o.lead * dt,
    reverse,
    linkId: 'take',
  });
  return { v, a, p: put(f.p, v, a) };
}

/** Half a frame of the timeline, in media, at the fastest a clip goes within a frame of `u` frames after its in point. */
const halfFrameAt = (p: Project, c: Clip, u: number): number =>
  0.5 * dtOf(p) * Math.max(speedAt(c, u - 1, p), speedAt(c, u, p), speedAt(c, u + 1, p));

describe('a ramp on linked clips', () => {
  it('keeps a J cut and an L cut in step, on the stretch of sound they played', () => {
    for (const shape of SHAPES) {
      for (const [lead, tail] of [
        [-30, 0],
        [0, 45],
        [-30, 45],
      ]) {
        const f = fixture();
        const { v, a, p } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead, tail });
        expect(apart(p, v, a)).toBeLessThan(1e-12);
        const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
        const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
        expect(apart(q, pic, snd)).toBeLessThan(1e-9);
        expect(snd.ramp).toBe(pic.ramp);
        expect(pic.start).toBe(100);
        // The sound still begins and ends on the words it did, to the frame they now fall in.
        const was = sourceSpan(a, p);
        expect(Math.abs(frameOfMedia(snd, was.in, q))).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(Math.abs(frameOfMedia(snd, was.out, q) - snd.duration)).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(snd.sourceIn).toBeGreaterThanOrEqual(0);
        // Where the two ended together they still do.
        if (tail === 0) expect(clipEnd(snd)).toBe(clipEnd(pic));
        if (lead === 0) expect([snd.start, snd.sourceIn]).toEqual([a.start, a.sourceIn]);
      }
    }
  });

  it('gives a J cut the lead-in its second of sound now takes, not thirty frames of whatever is there', () => {
    const f = fixture();
    const { v, a, p } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: -30, tail: 0 });
    const edits = setRamp(p, [v.id], shaped(p, v, 'flashIn'));
    const q = applyEdits(p, edits);
    // The picture now begins at 500%: the second of sound before it goes by in six frames.
    expect([q.clips[a.id].start, q.clips[a.id].duration]).toEqual([94, 236]);
    expect(Math.abs(q.clips[a.id].sourceIn - 4)).toBeLessThan(1e-9);
    expect([q.clips[v.id].start, q.clips[v.id].duration]).toEqual([100, 230]);
    // Each edit is written whole: the ramp with the length and the in point it was worked out with,
    // and for the clip that was placed by the other, its start.
    const ramp = shapeRamp('flashIn', 5, 15, false);
    expect(edits).toEqual([
      { op: 'updateClip', id: v.id, patch: { ramp, duration: 230, sourceIn: 5 } },
      {
        op: 'updateClip',
        id: a.id,
        patch: { ramp, duration: 236, sourceIn: q.clips[a.id].sourceIn, start: 94, keepPitch: true },
      },
    ]);
    // Slower at the head, the same second takes longer and the sound begins earlier.
    const up = applyEdits(p, setRamp(p, [v.id], shaped(p, v, 'rampUp')));
    expect([up.clips[a.id].start, up.clips[a.id].duration]).toEqual([40, 300]);
    expect(Math.abs(up.clips[a.id].sourceIn - 4)).toBeLessThan(1e-9);
  });

  it('moves a sound that starts after its picture with its words', () => {
    for (const [shape, start, duration] of [
      ['bullet', 118, 51],
      ['rampUp', 217, 123],
    ] as const) {
      const f = fixture();
      const { v, a, p } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: 90, tail: 0 });
      const edits = setRamp(p, [v.id], shaped(p, v, shape));
      const q = applyEdits(p, edits);
      const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
      expect([snd.start, snd.duration]).toEqual([start, duration]);
      expect((edits[1] as { patch: Partial<Clip> }).patch.start).toBe(start);
      expect(apart(q, pic, snd)).toBeLessThan(1e-9);
      expect(clipEnd(snd)).toBe(clipEnd(pic));
      // It plays the stretch it played, from second 8 to second 15, and nothing that was trimmed off.
      const now = sourceSpan(snd, q);
      expect(Math.abs(now.in - 8)).toBeLessThanOrEqual(halfFrameAt(q, snd, 0));
      expect(Math.abs(now.out - 15)).toBeLessThanOrEqual(halfFrameAt(q, snd, snd.duration));
    }
  });

  it('cuts the head of a sound where the clip before it stands, and keeps it in step', () => {
    const f = fixture();
    const { v, a, p: bare } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: 90, tail: 0 });
    const other = sound(f, { start: 60, duration: 80, sourceIn: 40 });
    const p = put(bare, other);
    for (const free of [false, true]) {
      const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, 'bullet'), free));
      const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
      // Its words begin at frame 118, where the other clip plays until 140.
      expect([snd.start, snd.duration]).toEqual([140, 29]);
      expect(snd.sourceIn).toBeGreaterThan(8 + 1);
      expect(apart(q, pic, snd)).toBeLessThan(1e-9);
      expect(clipEnd(snd)).toBe(clipEnd(pic));
      expect(overlaps(q)).toEqual([]);
    }
  });

  it('leaves one frame of a sound that the clip before it leaves no room for, on its own last frame of media', () => {
    const f = fixture();
    const { v, a, p: bare } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: 90, tail: 0 });
    // The picture will end at frame 169, and this clip plays until 185.
    const p = put(bare, sound(f, { start: 60, duration: 125, sourceIn: 40 }));
    const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, 'bullet')));
    const snd = q.clips[a.id];
    expect([snd.start, snd.duration]).toEqual([185, 1]);
    const now = sourceSpan(snd, q);
    expect(now.out).toBeLessThanOrEqual(15 + 1e-9);
    expect(now.in).toBeGreaterThan(14);
    expect(overlaps(q)).toEqual([]);
  });

  it('leaves one frame of a sound whose words now fall where the next clip stands, unless room will be made', () => {
    const f = fixture();
    // Ten frames of sound, three seconds into the picture, and another sound right after them.
    const { v, a, p: bare } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: 90, tail: -200 });
    const p = put(bare, sound(f, { start: 200, duration: 60, sourceIn: 40 }));
    const slow = {
      ramps: {
        [v.id]: tidyRamp([
          { m: 5, v: 0.2 },
          { m: 15, v: 0.2 },
        ]),
      },
    };
    const held = applyEdits(p, setRamp(p, [v.id], slow));
    // At 20% its words come at frame 550. It keeps one frame of them where it has room.
    expect(held.clips[a.id]).toMatchObject({ start: 199, duration: 1, sourceIn: 8 });
    expect(overlaps(held)).toEqual([]);
    const free = applyEdits(p, setRamp(p, [v.id], slow, true));
    expect(free.clips[a.id]).toMatchObject({ start: 550, duration: 50 });
    expect(free.clips[v.id].duration).toBe(1500);
    expect(apart(free, free.clips[v.id], free.clips[a.id])).toBeLessThan(1e-9);
  });

  it('begins a lead-in on the first frame its file has sound for, and never before the file', () => {
    // Sound from a fifth of a second into its file, a second before its picture.
    const f = fixture();
    const first = splitEdit(f, { start: 100, duration: 300, sourceIn: 1.2, lead: -30, tail: 0 });
    const q = applyEdits(first.p, setRamp(first.p, [first.v.id], shaped(first.p, first.v, 'flashIn')));
    expect(q.clips[first.a.id].start).toBe(94);
    expect(q.clips[first.a.id].sourceIn).toBeGreaterThanOrEqual(0);
    expect(Math.abs(q.clips[first.a.id].sourceIn - 0.2)).toBeLessThan(1e-9);
    expect(apart(q, q.clips[first.v.id], q.clips[first.a.id])).toBeLessThan(1e-9);

    // Sound from the very start of its file. At 394.7% its second takes 7.6 frames: eight would
    // begin before the file, so it begins on the seventh before the picture, exactly in step.
    const second = splitEdit(f, { start: 100, duration: 300, sourceIn: 1, lead: -30, tail: 0 });
    const ramp = tidyRamp([
      { m: 1, v: 3.947 },
      { m: 11, v: 1 },
    ])!;
    const r = applyEdits(second.p, setRamp(second.p, [second.v.id], { ramps: { [second.v.id]: ramp } }));
    const snd = r.clips[second.a.id];
    expect(snd.start).toBe(93);
    expect(snd.sourceIn).toBeGreaterThan(0);
    expect(snd.sourceIn).toBeLessThan(3.947 / 30);
    expect(mediaAt(snd, -1, r)).toBeLessThan(0);
    expect(apart(r, r.clips[second.v.id], snd)).toBeLessThan(1e-9);
    expect(clipEnd(snd)).toBe(clipEnd(r.clips[second.v.id]));
    // Slower at the head, the lead-in is longer than there are frames before it: it begins at frame 0.
    const early = splitEdit(f, { start: 40, duration: 300, sourceIn: 5, lead: -30, tail: 0 });
    const s = applyEdits(early.p, setRamp(early.p, [early.v.id], shaped(early.p, early.v, 'rampUp')));
    expect(s.clips[early.a.id].start).toBe(0);
    expect(s.clips[early.a.id].sourceIn).toBeGreaterThan(4);
    expect(apart(s, s.clips[early.v.id], s.clips[early.a.id])).toBeLessThan(1e-9);
  });

  for (const reverse of [false, true]) {
    it(`keeps two thousand split edits in step, ${reverse ? 'played backwards' : 'played forwards'}`, () => {
      const rnd = random(reverse ? 31 : 77);
      let checked = 0;
      let worst = 0;
      for (let r = 0; r < 2000; r++) {
        const f = atRate(RATES[r % RATES.length]);
        const o = {
          start: 400,
          duration: 30 + Math.floor(rnd() * 300),
          sourceIn: 2.5 + rnd() * 20,
          lead: Math.floor(rnd() * 120) - 60,
          tail: Math.floor(rnd() * 60) - 30,
          reverse,
        };
        // Two frames and more of sound, some of them under the picture.
        if (o.duration - o.lead + o.tail < 2 || o.lead >= o.duration) continue;
        const { v, a, p } = splitEdit(f, o);
        expect(apart(p, v, a)).toBeLessThan(1e-9);
        // The shape, and then another over what came of it: the second finds a clip the first placed.
        let q = p;
        for (const shape of [SHAPES[r % 7], SHAPES[(r + 3) % 7]]) {
          q = applyEdits(q, setRamp(q, [r % 2 ? v.id : a.id], shaped(q, q.clips[v.id], shape)));
          const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
          expect(snd.ramp).toBe(pic.ramp);
          expect(Math.min(pic.sourceIn, snd.sourceIn)).toBeGreaterThanOrEqual(0);
          expect(snd.start).toBeGreaterThanOrEqual(0);
          expect(overlaps(q)).toEqual([]);
          const off = apart(q, pic, snd);
          // A sound whose words now all come after its picture shares no frame with it any more.
          // From then on it is a clip by itself.
          if (off === null) break;
          worst = Math.max(worst, off);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(3800);
      expect(worst).toBeLessThan(1e-9);
    });
  }

  it('keeps split edits in step among other clips, and never puts one clip on another', () => {
    const rnd = random(404);
    let cut = 0;
    let checked = 0;
    for (let r = 0; r < 1500; r++) {
      const f = atRate(RATES[r % RATES.length]);
      const reverse = r % 3 === 2;
      const o = {
        start: 400,
        duration: 30 + Math.floor(rnd() * 300),
        sourceIn: 2.5 + rnd() * 20,
        lead: Math.floor(rnd() * 120) - 60,
        tail: Math.floor(rnd() * 60) - 30,
        reverse,
      };
      if (o.duration - o.lead + o.tail < 2 || o.lead >= o.duration) continue;
      const { v, a, p: bare } = splitEdit(f, o);
      // Sound before and after it on its track, and a picture after its picture, each up to eighty frames away.
      const before = sound(f, { start: 0, duration: a.start - Math.floor(rnd() * rnd() * 80), sourceIn: 40 });
      const after = sound(f, {
        start: clipEnd(a) + Math.floor(rnd() * rnd() * 80),
        duration: 90,
        sourceIn: 50,
      });
      const next = picture(f, { start: clipEnd(v) + Math.floor(rnd() * 80), duration: 90, sourceIn: 50 });
      const p = put(bare, before, after, next);
      const ramp =
        r % 4 === 3
          ? {
              ramps: {
                [v.id]: tidyRamp([
                  { m: v.sourceIn, v: 0.3 + rnd() * 3 },
                  { m: v.sourceIn + 9, v: 0.2 + rnd() },
                ]),
              },
            }
          : shaped(p, v, SHAPES[r % 7]);
      for (const free of [false, true]) {
        const q = applyEdits(p, setRamp(p, [v.id], ramp, free));
        const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
        expect(Math.min(pic.sourceIn, snd.sourceIn)).toBeGreaterThanOrEqual(0);
        expect(Math.min(pic.duration, snd.duration)).toBeGreaterThanOrEqual(1);
        // Whatever room will be made after it, nothing lands on the clip before it.
        expect(snd.start).toBeGreaterThanOrEqual(clipEnd(before));
        if (!free) expect(overlaps(q)).toEqual([]);
        if (snd.start > Math.max(a.start, clipEnd(before)) || snd.sourceIn > a.sourceIn + 1e-6) cut++;
        // One frame is what is left of a clip that has no room where its media plays: only then
        // does it give up being in step.
        const off = apart(q, pic, snd);
        if (off === null || snd.duration === 1) continue;
        expect(off).toBeLessThan(1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2400);
    expect(cut).toBeGreaterThan(200);
  });

  it('ends a sound with its picture when it did, at every length and frame rate', () => {
    let checked = 0;
    const apartAt: unknown[] = [];
    for (const rate of RATES) {
      const f = atRate(rate);
      for (const [sourceIn, reverse] of [
        [12.345678, false],
        [100 / 7, false],
        [100 / 7, true],
      ] as const) {
        for (let duration = 2; duration <= 600; duration++) {
          // The plain pair, a J cut and a sound that starts late, turn about.
          const lead = [0, -10, Math.min(7, duration - 1)][duration % 3];
          const { v, a, p } = splitEdit(f, { start: 300, duration, sourceIn, lead, tail: 0, reverse });
          for (const shape of SHAPES) {
            const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
            expect(q.clips[v.id].ramp).not.toBeNull();
            if (clipEnd(q.clips[a.id]) !== clipEnd(q.clips[v.id]))
              apartAt.push([rate, shape, duration, lead, reverse]);
            checked++;
          }
        }
      }
    }
    expect(apartAt).toEqual([]);
    expect(checked).toBe(RATES.length * 3 * 599 * SHAPES.length);
  });

  it('gives the picture and the sound of one take the very same ramp, and moves neither', () => {
    for (const reverse of [false, true]) {
      const f = fixture();
      const { v, a, p } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: 0, tail: 0, reverse });
      for (const shape of SHAPES) {
        const edits = setRamp(p, [v.id, a.id], shaped(p, v, shape));
        const ramp = shapeRamp(shape, 5, 15, reverse);
        const duration = (edits[0] as { patch: Partial<Clip> }).patch.duration;
        // Equal inputs, equal edits: but for what only one of them has to say.
        expect(edits).toEqual([
          { op: 'updateClip', id: v.id, patch: { ramp, duration, sourceIn: 5 } },
          { op: 'updateClip', id: a.id, patch: { ramp, duration, sourceIn: 5, start: 100, keepPitch: true } },
        ]);
        const q = applyEdits(p, edits);
        expect(q.clips[a.id].ramp).toBe(q.clips[v.id].ramp);
        expect(apart(q, q.clips[v.id], q.clips[a.id])).toBe(0);
      }
    }
  });

  it('keeps sound from another file as far from the picture as it was, on the ramp moved by as much', () => {
    for (const offset of [2.25, -1.4000003, 31.123456789]) {
      const f = fixture();
      const { v, a, p: same } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: -20, tail: 10 });
      const p = applyEdits(same, [
        { op: 'addAsset', asset: { ...f.asset, id: 'recorder', duration: 90 } },
        { op: 'updateClip', id: a.id, patch: { assetId: 'recorder', sourceIn: a.sourceIn + offset } },
      ]);
      for (const shape of SHAPES) {
        const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
        const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
        expect(snd.ramp).toEqual(shiftRamp(pic.ramp!, offset));
        expect(snd.ramp).not.toBe(pic.ramp);
        for (
          let frame = Math.max(pic.start, snd.start);
          frame < Math.min(clipEnd(pic), clipEnd(snd));
          frame++
        ) {
          // As far apart as they were, to the microsecond a ramp is placed to, and no further at any frame.
          const off = shows(q, snd, frame) - shows(q, pic, frame);
          expect(Math.abs(off - offset)).toBeLessThan(1e-6);
          expect(Math.abs(off - Math.round(offset * 1e6) / 1e6)).toBeLessThan(1e-9);
        }
        // Set again, nothing changes: the moved ramp it has is the one it would get.
        const again = setRamp(q, [v.id], { ramps: { [v.id]: pic.ramp } });
        expect(applyEdits(q, again).clips).toEqual(q.clips);
        expect((again[1] as { patch: Partial<Clip> }).patch.ramp).toBe(snd.ramp);
      }
    }
  });

  it('stays in step through a trim, a split and a slip afterwards', () => {
    for (const reverse of [false, true]) {
      for (const shape of SHAPES) {
        const f = fixture();
        const { v, a, p } = splitEdit(f, {
          start: 100,
          duration: 300,
          sourceIn: 8,
          lead: -30,
          tail: 20,
          reverse,
        });
        const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
        const trimmed = applyEdits(q, trimClips(q, [a.id], 'start', 11));
        expect(trimmed.clips[a.id].start).toBe(q.clips[a.id].start + 11);
        expect(apart(trimmed, trimmed.clips[v.id], trimmed.clips[a.id])).toBeLessThan(1e-9);
        const at = q.clips[v.id].start + 20;
        const split = splitClips(q, [v.id, a.id], at);
        const halves = applyEdits(q, split.edits);
        expect(apart(halves, halves.clips[v.id], halves.clips[a.id])).toBeLessThan(1e-9);
        expect(apart(halves, halves.clips[split.created[0]], halves.clips[split.created[1]])).toBeLessThan(
          1e-9,
        );
        const slipped = applyEdits(q, slipClips(q, [v.id, a.id], 12));
        expect(slipped.clips[a.id].sourceIn).not.toBe(q.clips[a.id].sourceIn);
        expect(apart(slipped, slipped.clips[v.id], slipped.clips[a.id])).toBeLessThan(1e-9);
      }
    }
  });

  it('changes no clip of a group that has the ramp already', () => {
    for (const reverse of [false, true]) {
      for (const shape of SHAPES) {
        const f = fixture();
        const { v, a, p } = splitEdit(f, {
          start: 100,
          duration: 300,
          sourceIn: 8,
          lead: -30,
          tail: 20,
          reverse,
        });
        const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
        const [pic, snd] = [q.clips[v.id], q.clips[a.id]];
        const copy = pic.ramp!.map((x) => ({ ...x }));
        for (const ramps of [{ [v.id]: copy }, { [v.id]: copy, [a.id]: copy }]) {
          const again = setRamp(q, [a.id], { ramps });
          expect(again).toEqual([
            { op: 'updateClip', id: v.id, patch: { ramp: pic.ramp, duration: pic.duration } },
            { op: 'updateClip', id: a.id, patch: { ramp: snd.ramp, duration: snd.duration } },
          ]);
          const same = applyEdits(q, again);
          expect(same.clips).toEqual(q.clips);
          expect(same.clips[a.id].ramp).toBe(snd.ramp);
          expect(same.clips[a.id].sourceIn).toBe(snd.sourceIn);
        }
      }
    }
  });

  it('reaches the whole group from any clip of it, and leaves a group alone that it has no ramp for', () => {
    const f = fixture();
    const { v, a, p } = splitEdit(f, { start: 100, duration: 300, sourceIn: 5, lead: -30, tail: 0 });
    const change = shaped(p, v, 'hero');
    const fromPicture = setRamp(p, [v.id], change);
    expect(fromPicture).toHaveLength(2);
    expect(setRamp(p, [a.id], change)).toEqual(fromPicture);
    expect(setRamp(p, [a.id, v.id, a.id], change)).toEqual(fromPicture);
    expect(setRamp(p, [v.id, a.id], { ramps: { elsewhere: change.ramps[v.id] } })).toEqual([]);
    // The picture's ramp is the group's, whatever is named for a sound that is in step with it.
    const both = { ramps: { [a.id]: shapeRamp('bullet', 4, 15, false), [v.id]: change.ramps[v.id] } };
    expect(setRamp(p, [a.id], both)).toEqual(fromPicture);
    // Named alone, the sound leads and the picture is placed by it.
    const bySound = applyEdits(
      p,
      setRamp(p, [v.id], { ramps: { [a.id]: shapeRamp('flashIn', 4, 15, false) } }),
    );
    expect(bySound.clips[a.id]).toMatchObject({ start: 70, sourceIn: 4, duration: 253 });
    expect(bySound.clips[v.id].ramp).toBe(bySound.clips[a.id].ramp);
    expect(bySound.clips[v.id].start).toBe(76);
    expect(apart(bySound, bySound.clips[v.id], bySound.clips[a.id])).toBeLessThan(1e-9);
  });

  it("takes a clip of the group that is not in step by itself, on the ramp named for it or else the group's", () => {
    const f = fixture();
    // Linked to a picture that plays forwards: its sound played backwards, and a cutaway at half
    // speed from further on in the file.
    const v = picture(f, { start: 100, duration: 300, sourceIn: 5, linkId: 'take' });
    const turned = sound(f, { start: 100, duration: 300, sourceIn: 5, reverse: true, linkId: 'take' });
    const cutaway = makeClip('video', f.v2.id, {
      assetId: 'asset1',
      start: 130,
      duration: 90,
      sourceIn: 30,
      speed: 0.5,
      linkId: 'take',
    });
    const p = put(f.p, v, turned, cutaway);
    const ramp = shapeRamp('rampUp', 5, 15, false)!;
    const own = shapeRamp('flashOut', 30, 31.5, false)!;
    const q = applyEdits(p, setRamp(p, [v.id], { ramps: { [v.id]: ramp, [cutaway.id]: own } }));
    expect(q.clips[v.id]).toMatchObject({ start: 100, duration: 240, sourceIn: 5 });
    // The same array, as given: its shape lies the other way for a clip that plays the other way.
    expect(q.clips[turned.id].ramp).toBe(q.clips[v.id].ramp);
    expect(q.clips[turned.id]).toMatchObject({ start: 100, duration: 240, sourceIn: 5, keepPitch: true });
    // "Flash out" takes 76.67% of the time its stretch takes at 100%: of 45 frames, 34.5.
    expect(q.clips[cutaway.id]).toMatchObject({
      start: 130,
      ramp: own,
      duration: 35,
      sourceIn: 30,
      speed: 0.5,
    });
    // Not named, it gets the group's ramp as it is: at second 30 that is the 200% it ends on.
    const r = applyEdits(p, setRamp(p, [v.id], { ramps: { [v.id]: ramp } }));
    expect(r.clips[cutaway.id]).toMatchObject({ start: 130, duration: 23, sourceIn: 30 });
    expect(r.clips[cutaway.id].ramp).toBe(r.clips[v.id].ramp);
    // Off the ramp again, each goes back to its own speed over the stretch it plays.
    const fast = applyEdits(r, [{ op: 'updateClip', id: cutaway.id, patch: { speed: 4 } }]);
    const edits = setRamp(fast, [v.id], { ramps: { [v.id]: null } });
    const off = applyEdits(fast, edits);
    expect(off.clips[cutaway.id]).toMatchObject({ ramp: null, speed: 4, duration: 12 });
    expect(off.clips[turned.id]).toMatchObject({ ramp: null, speed: 1, duration: 300 });
    for (const e of edits) expect('speed' in (e as { patch: object }).patch).toBe(false);
  });

  it('retimes several groups in one go without putting a clip on another', () => {
    const rnd = random(606);
    for (let r = 0; r < 200; r++) {
      const f = atRate(RATES[r % RATES.length]);
      const dt = dtOf(f.p);
      // Three takes cut together, the sound cut a few frames before or after the picture each time.
      const cuts = [100, 250 + Math.floor(rnd() * 60), 480 + Math.floor(rnd() * 60), 700];
      const offs = [0, Math.floor(rnd() * 40) - 20, Math.floor(rnd() * 40) - 20, 0];
      const clips: Clip[] = [];
      for (let i = 0; i < 3; i++) {
        const sourceIn = 3 + i * 17 + rnd();
        const lead = offs[i];
        clips.push(
          picture(f, { start: cuts[i], duration: cuts[i + 1] - cuts[i], sourceIn, linkId: `take${i}` }),
        );
        clips.push(
          sound(f, {
            start: cuts[i] + lead,
            duration: cuts[i + 1] + offs[i + 1] - cuts[i] - lead,
            sourceIn: sourceIn + lead * dt,
            linkId: `take${i}`,
          }),
        );
      }
      const p = put(f.p, ...clips);
      expect(overlaps(p)).toEqual([]);
      const ramps: Record<ID, RampPoint[] | null> = {};
      for (let i = 0; i < 3; i++)
        Object.assign(ramps, shaped(p, clips[i * 2], SHAPES[(r + i * 2) % 7]).ramps);
      const ids = clips.map((c) => c.id);
      const edits = setRamp(p, ids, { ramps });
      const q = applyEdits(p, edits);
      expect(overlaps(q)).toEqual([]);
      expect(new Set(edits.map((e) => (e as { id: ID }).id)).size).toBe(6);
      for (let i = 0; i < 3; i++) {
        const [pic, snd] = [q.clips[clips[i * 2].id], q.clips[clips[i * 2 + 1].id]];
        expect(pic.start).toBe(cuts[i]);
        const off = apart(q, pic, snd);
        if (off !== null && snd.duration > 1) expect(off).toBeLessThan(1e-9);
      }
      // In whatever order the clips are named, the same timeline comes of it.
      const shuffled = setRamp(p, [ids[5], ids[2], ids[0], ids[3], ids[1], ids[4], ids[2]], { ramps });
      expect(applyEdits(p, shuffled).clips).toEqual(q.clips);
    }
  });
});

describe('setSpeed on clips that are on a ramp', () => {
  it('puts the clip on one speed, over the stretch it plays', () => {
    for (const reverse of [false, true]) {
      const f = fixture();
      const keyframes = { x: [0, 60, 150, 299].map((t, i): Keyframe => ({ t, v: i, e: 'linear' })) };
      const clip = picture(f, { start: 100, duration: 300, sourceIn: 5, reverse, keyframes, fadeOut: 120 });
      const p = put(f.p, clip);
      const q = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, 'hero')));
      const on = q.clips[clip.id];
      const edits = setSpeed(q, [clip.id], 2);
      expect(edits).toHaveLength(1);
      expect(Object.keys((edits[0] as { patch: object }).patch).sort()).toEqual(
        ['duration', 'keyframes', 'ramp', 'sourceIn', 'speed'].sort(),
      );
      const r = applyEdits(q, edits);
      const now = r.clips[clip.id];
      // Ten seconds of media at 200%: five seconds.
      expect(now).toMatchObject({
        ramp: null,
        speed: 2,
        start: 100,
        duration: 150,
        sourceIn: 5,
        fadeOut: 120,
      });
      // Keyframes went through the media both times: each is on the frame that shows what its frame showed.
      now.keyframes.x.forEach((k, i) => {
        const then = sourceTimeAt(clip, keyframes.x[i].t, p);
        expect(Math.abs(sourceTimeAt(now, k.t, r) - then)).toBeLessThanOrEqual(
          0.5 / 30 + (0.5 / 30) * 2 + 1e-9,
        );
        expect(
          Math.abs(sourceTimeAt(now, k.t, r) - sourceTimeAt(on, on.keyframes.x[i].t, q)),
        ).toBeLessThanOrEqual((0.5 / 30) * 2 + 1e-9);
      });
      // A speed outside what can be set is brought inside, as for any clip.
      expect(applyEdits(q, setSpeed(q, [clip.id], 1000)).clips[clip.id]).toMatchObject({
        speed: 100,
        duration: 3,
        fadeOut: 3,
      });
      // The direction can be given with it.
      const turned = applyEdits(q, setSpeed(q, [clip.id], 1, !reverse)).clips[clip.id];
      expect(turned).toMatchObject({ ramp: null, speed: 1, reverse: !reverse, sourceIn: 5 });
      expect(Math.abs(turned.duration - 300)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the first frame of a clip that plays backwards when the next clip cuts it short', () => {
    const f = fixture();
    const clip = picture(f, { start: 100, duration: 300, sourceIn: 5, reverse: true });
    const p = put(f.p, clip, picture(f, { start: 400, duration: 50, sourceIn: 40 }));
    const q = applyEdits(p, setRamp(p, [clip.id], shaped(p, clip, 'montage')));
    const first = sourceTimeAt(q.clips[clip.id], 0, q);
    const r = applyEdits(q, setSpeed(q, [clip.id], 0.5));
    const slow = r.clips[clip.id];
    // Ten seconds at 50% are 600 frames, and there is room for 300: the top half of the stretch.
    expect(slow).toMatchObject({ ramp: null, speed: 0.5, duration: 300 });
    expect(slow.sourceIn).toBeCloseTo(10, 1);
    expect(Math.abs(sourceTimeAt(slow, 0, r) - first)).toBeLessThan(1 / 30);
    expect(overlaps(r)).toEqual([]);
  });

  it('takes the whole link group off the ramp, whichever of its clips is named, and keeps it in step', () => {
    for (const reverse of [false, true]) {
      for (const shape of SHAPES) {
        const f = fixture();
        const { v, a, p } = splitEdit(f, {
          start: 100,
          duration: 300,
          sourceIn: 8,
          lead: -30,
          tail: 20,
          reverse,
        });
        const q = applyEdits(p, setRamp(p, [v.id], shaped(p, v, shape)));
        for (const speed of [0.5, 1, 4]) {
          const edits = setSpeed(q, [v.id], speed);
          expect(edits.map((e) => (e as { id: ID }).id)).toEqual([v.id, a.id]);
          expect(setSpeed(q, [a.id], speed)).toEqual(edits);
          expect(setSpeed(q, [a.id, v.id, a.id], speed)).toEqual(edits);
          const r = applyEdits(q, edits);
          const [pic, snd] = [r.clips[v.id], r.clips[a.id]];
          expect(pic).toMatchObject({ ramp: null, speed, start: 100 });
          expect(snd).toMatchObject({ ramp: null, speed });
          expect(apart(r, pic, snd)).toBeLessThan(1e-9);
          // As after taking the ramp off, and then the lengths that speed gives.
          const none = applyEdits(q, setRamp(q, [v.id], { ramps: { [v.id]: null } }));
          expect(apart(none, none.clips[v.id], none.clips[a.id])).toBeLessThan(1e-9);
          if (speed === 1) expect(r.clips).toEqual(none.clips);
        }
      }
    }
  });

  it('sets the speed of clips without a ramp one by one, as it always has, beside a group it takes off one', () => {
    const f = fixture();
    const { v, a, p: bare } = splitEdit(f, { start: 100, duration: 300, sourceIn: 8, lead: -30, tail: 20 });
    const plain = picture(f, { start: 500, duration: 100, sourceIn: 3 });
    const loose = sound(f, { start: 500, duration: 100, sourceIn: 3 });
    const p0 = put(bare, plain, loose);
    const p = applyEdits(p0, setRamp(p0, [v.id], shaped(p0, v, 'flashOut')));
    const edits = setSpeed(p, [plain.id, v.id, loose.id], 2);
    expect(edits.map((e) => (e as { id: ID }).id)).toEqual([v.id, a.id, plain.id, loose.id]);
    expect(edits.slice(2)).toEqual([
      { op: 'updateClip', id: plain.id, patch: { speed: 2, duration: 50 } },
      { op: 'updateClip', id: loose.id, patch: { speed: 2, duration: 50, keepPitch: true } },
    ]);
    expect(edits.slice(2)).toEqual([...setSpeed(p, [plain.id], 2), ...setSpeed(p, [loose.id], 2)]);
    expect(edits.slice(0, 2)).toEqual(setSpeed(p, [a.id], 2));
    // A sound without a ramp, named by itself, is not taken as a group: that is for clips on a ramp.
    const apartPair = splitEdit(f, { start: 100, duration: 300, sourceIn: 8, lead: -30, tail: 20 });
    const alone = setSpeed(apartPair.p, [apartPair.a.id], 2);
    expect(alone).toEqual([
      { op: 'updateClip', id: apartPair.a.id, patch: { speed: 2, duration: 175, keepPitch: true } },
    ]);
  });
});

describe('sound that keeps its pitch', () => {
  it('is switched on by a change of speed, once, on sound alone', () => {
    const f = fixture();
    const v = picture(f, { start: 0, duration: 100, sourceIn: 5 });
    const a = sound(f, { start: 0, duration: 100, sourceIn: 5 });
    const p = put(f.p, v, a);
    const patches = (edits: Edit[]): Partial<Clip>[] =>
      edits.map((e) => (e as { patch: Partial<Clip> }).patch);
    expect(patches(setSpeed(p, [v.id, a.id], 2))).toEqual([
      { speed: 2, duration: 50 },
      { speed: 2, duration: 50, keepPitch: true },
    ]);
    // Setting the speed a clip has is no change of speed.
    expect(patches(setSpeed(p, [v.id, a.id], 1))).toEqual([
      { speed: 1, duration: 100 },
      { speed: 1, duration: 100 },
    ]);
    expect(patches(setSpeed(p, [a.id], 1, true))).toEqual([{ speed: 1, duration: 100, reverse: true }]);
    // Once it has been decided, either way, it is not written again.
    for (const keepPitch of [true, false]) {
      const set = applyEdits(p, [{ op: 'updateClip', id: a.id, patch: { keepPitch } }]);
      expect(patches(setSpeed(set, [a.id], 2))).toEqual([{ speed: 2, duration: 50 }]);
      const ramped = setRamp(set, [a.id], shaped(set, a, 'bullet'));
      expect('keepPitch' in patches(ramped)[0]).toBe(false);
      expect(applyEdits(set, ramped).clips[a.id].keepPitch).toBe(keepPitch);
    }
    const fast = applyEdits(p, setSpeed(p, [a.id], 2));
    expect(fast.clips[a.id].keepPitch).toBe(true);
    expect(patches(setSpeed(fast, [a.id], 1))).toEqual([{ speed: 1, duration: 100 }]);
  });

  it('is switched on by a ramp, and by coming off one', () => {
    const f = fixture();
    const v = picture(f, { start: 0, duration: 100, sourceIn: 5 });
    const a = sound(f, { start: 0, duration: 100, sourceIn: 5 });
    const p = put(f.p, v, a);
    const on = applyEdits(p, [
      ...setRamp(p, [v.id], shaped(p, v, 'rampUp')),
      ...setRamp(p, [a.id], shaped(p, a, 'rampUp')),
    ]);
    expect([on.clips[v.id].keepPitch, on.clips[a.id].keepPitch]).toEqual([null, true]);
    // The ramp it has, set again: nothing is decided for it.
    const undecided = applyEdits(on, [{ op: 'updateClip', id: a.id, patch: { keepPitch: null } }]);
    const again = setRamp(undecided, [a.id], { ramps: { [a.id]: undecided.clips[a.id].ramp } });
    expect(applyEdits(undecided, again).clips[a.id].keepPitch).toBeNull();
    // Off the ramp by either door.
    for (const edits of [
      setRamp(undecided, [a.id], { ramps: { [a.id]: null } }),
      setSpeed(undecided, [a.id], 1),
    ]) {
      expect(applyEdits(undecided, edits).clips[a.id]).toMatchObject({ ramp: null, keepPitch: true });
    }
    expect(applyEdits(on, setSpeed(on, [v.id], 3)).clips[v.id].keepPitch).toBeNull();
  });
});
