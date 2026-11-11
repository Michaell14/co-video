import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT,
  applyEdits,
  clipEnd,
  clipsOnTrack,
  closeGap,
  deleteClips,
  makeClip,
  makeTrack,
  rippleCloseGap,
  rippleDelete,
  rippleTrim,
  rippleTrimTo,
  trackLabel,
  trimClips,
  trimRange,
} from '../src';
import type { Clip, Edit, ID, Project, RippleResult, Track } from '../src';
import { fixture, overlaps } from './helpers';

interface Scene {
  p: Project;
  v1: Track;
  /** Titles. */
  v2: Track;
  a1: Track;
  /** Music. */
  a2: Track;
}

function scene(): Scene {
  const f = fixture();
  const a2 = makeTrack('audio', 1);
  return { p: applyEdits(f.p, [{ op: 'addTrack', track: a2 }]), v1: f.v1, v2: f.v2, a1: f.a1, a2 };
}

function add(s: Scene, clip: Clip): Clip {
  s.p = applyEdits(s.p, [{ op: 'addClip', clip }]);
  return clip;
}

/** A video clip on V1 with its linked audio on A1. `sourceIn` is given in frames of head handle. */
function pair(s: Scene, start: number, duration: number, head = 0): { v: Clip; a: Clip } {
  const linkId = `link-${start}`;
  const init = { assetId: 'asset1', start, duration, sourceIn: head / 30, linkId };
  return { v: add(s, makeClip('video', s.v1.id, init)), a: add(s, makeClip('audio', s.a1.id, init)) };
}

const title = (s: Scene, start: number, duration: number): Clip =>
  add(s, makeClip('text', s.v2.id, { start, duration, text: { ...DEFAULT_TEXT } }));

const music = (s: Scene, start: number, duration: number): Clip =>
  add(s, makeClip('audio', s.a2.id, { assetId: 'asset1', start, duration }));

const starts = (p: Project, ...clips: Clip[]): number[] => clips.map((c) => p.clips[c.id].start);

const lock = (t: Track): Edit => ({ op: 'updateTrack', id: t.id, patch: { locked: true } });
const unlock = (t: Track): Edit => ({ op: 'updateTrack', id: t.id, patch: { locked: false } });

/** Where on the timeline each linked clip's source media begins, relative to its first partner. */
function syncOffsets(p: Project): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const fps = p.settings.fpsNum / p.settings.fpsDen;
  for (const c of Object.values(p.clips).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (c.linkId) (out[c.linkId] ??= []).push(Math.round(c.start - c.sourceIn * fps));
  }
  for (const list of Object.values(out)) {
    const first = list[0];
    list.forEach((v, i) => (list[i] = v - first));
  }
  return out;
}

/** Three linked pairs back to back, a title over the third, music under everything. */
function cut() {
  const s = scene();
  const one = pair(s, 0, 100);
  const two = pair(s, 100, 100, 60);
  const three = pair(s, 200, 100);
  const caption = title(s, 220, 60);
  const bed = music(s, 0, 300);
  return { s, one, two, three, caption, bed };
}

describe('ripple delete', () => {
  it('pulls every track along: linked audio, titles further down, but not a clip that spans the cut', () => {
    const { s, one, two, three, caption, bed } = cut();
    const r = rippleDelete(s.p, [two.v.id, two.a.id]);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(q.clips[two.v.id]).toBeUndefined();
    expect(q.clips[two.a.id]).toBeUndefined();
    expect(starts(q, three.v, three.a, caption)).toEqual([100, 100, 120]);
    expect(starts(q, one.v, one.a, bed)).toEqual([0, 0, 0]);
    expect(q.clips[bed.id].duration).toBe(300);
    expect(overlaps(q)).toEqual([]);
    expect(deleteClips(s.p, [two.v.id, two.a.id], true)).toEqual(r.edits);
  });

  it('leaves a track alone when it has no room, without shifting it part of the way', () => {
    const { s, two, three, caption } = cut();
    const inTheWay = title(s, 150, 50);
    const later = title(s, 400, 30);
    const q = applyEdits(s.p, rippleDelete(s.p, [two.v.id, two.a.id]).edits);
    expect(starts(q, three.v, three.a)).toEqual([100, 100]);
    // The caption cannot move 100 frames left past the title before it, so neither it nor the
    // title after it moves at all.
    expect(starts(q, inTheWay, caption, later)).toEqual([150, 220, 400]);
    expect(overlaps(q)).toEqual([]);
  });

  it('refuses rather than leave linked audio behind', () => {
    const { s, two } = cut();
    const r = rippleDelete(s.p, [two.v.id]);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(deleteClips(s.p, [two.v.id], true)).toEqual([]);
    // A plain delete is still available.
    expect(deleteClips(s.p, [two.v.id])).toEqual([{ op: 'removeClip', id: two.v.id }]);
  });

  it('refuses when the linked partner sits on a locked track, naming the track', () => {
    const s = scene();
    const opener = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    const shot = pair(s, 100, 100);
    const over = title(s, 0, 50);
    const caption = title(s, 120, 60);
    s.p = applyEdits(s.p, [{ op: 'updateTrack', id: s.a1.id, patch: { locked: true, name: 'Dialogue' } }]);
    const r = rippleDelete(s.p, [opener.id]);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Unlock Dialogue to ripple: a linked clip on it has to move too.');
    // Which is all it takes.
    const unlocked = applyEdits(s.p, [unlock(s.a1)]);
    const q = applyEdits(unlocked, rippleDelete(unlocked, [opener.id]).edits);
    expect(starts(q, shot.v, shot.a)).toEqual([0, 0]);
    // Nothing linked has to follow this one, so the lock does not matter.
    const titles = applyEdits(s.p, rippleDelete(s.p, [over.id]).edits);
    expect(titles.clips[over.id]).toBeUndefined();
    expect(starts(titles, caption, shot.v, shot.a)).toEqual([70, 100, 100]);
  });

  it('does not blame a lock when unlocking the track would not let the ripple through', () => {
    const { s, one } = cut();
    s.p = applyEdits(s.p, [{ op: 'updateTrack', id: s.a1.id, patch: { locked: true, name: 'Dialogue' } }]);
    // The sound of the deleted picture stays where it is, in the way of the sound that would follow.
    const r = rippleDelete(s.p, [one.v.id]);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on Dialogue would fall out of sync.');
    expect(rippleDelete(applyEdits(s.p, [unlock(s.a1)]), [one.v.id]).refused).toBe(r.refused);
  });

  it('names the locks in the way one at a time, and none when another clip could not follow anyway', () => {
    const s = scene();
    const opener = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    const first = pair(s, 100, 100);
    const linkId = 'second';
    const second = {
      v: add(s, makeClip('video', s.v1.id, { assetId: 'asset1', start: 200, duration: 100, linkId })),
      a: add(s, makeClip('audio', s.a2.id, { assetId: 'asset1', start: 200, duration: 100, linkId })),
    };
    const locked = applyEdits(s.p, [lock(s.a1), lock(s.a2)]);
    expect(rippleDelete(locked, [opener.id]).refused).toBe(
      'Unlock A1 to ripple: a linked clip on it has to move too.',
    );
    const halfway = applyEdits(locked, [unlock(s.a1)]);
    expect(rippleDelete(halfway, [opener.id]).refused).toBe(
      'Unlock A2 to ripple: a linked clip on it has to move too.',
    );
    const open = applyEdits(halfway, [unlock(s.a2)]);
    const q = applyEdits(open, rippleDelete(open, [opener.id]).edits);
    expect(starts(q, first.v, first.a, second.v, second.a)).toEqual([0, 0, 100, 100]);
    // With music right in front of the second sound, opening A1 would get nobody anywhere.
    music(s, 0, 200);
    const r = rippleDelete(applyEdits(s.p, [lock(s.a1)]), [opener.id]);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A2 would fall out of sync.');
  });

  it('leaves a linked pair on other tracks alone when only half of it could follow', () => {
    const s = scene();
    const opener = title(s, 0, 100);
    const caption = title(s, 100, 50);
    const shot = pair(s, 100, 100);
    // Something unrelated sits in front of the audio, so the audio cannot move left.
    const sting = add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 0, duration: 100 }));
    const r = rippleDelete(s.p, [opener.id]);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    // The title track closes up. The picture could have followed, but not without its sound.
    expect(starts(q, caption, shot.v, shot.a, sting)).toEqual([0, 100, 100, 0]);
    expect(overlaps(q)).toEqual([]);
  });

  it('closes a split edit by what picture and sound have in common', () => {
    const s = scene();
    const linkId = 'lcut';
    const v = add(s, makeClip('video', s.v1.id, { assetId: 'asset1', start: 100, duration: 100, linkId }));
    const a = add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 100, duration: 120, linkId }));
    const next = { assetId: 'asset1', linkId: 'next' };
    const nv = add(s, makeClip('video', s.v1.id, { ...next, start: 200, duration: 100 }));
    const na = add(s, makeClip('audio', s.a1.id, { ...next, start: 220, duration: 80, sourceIn: 20 / 30 }));
    const before = syncOffsets(s.p);
    const r = rippleDelete(s.p, [v.id, a.id]);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(starts(q, nv, na)).toEqual([100, 120]);
    expect(syncOffsets(q)).toEqual({ next: before.next });
  });

  it('closes each hole of a scattered selection once', () => {
    const { s, one, two, three, caption } = cut();
    const four = pair(s, 300, 50);
    const q = applyEdits(s.p, rippleDelete(s.p, [one.v.id, one.a.id, three.v.id, three.a.id]).edits);
    expect(starts(q, two.v, two.a, four.v, four.a)).toEqual([0, 0, 100, 100]);
    // The caption sat over the third pair; that time is gone, so it only follows the first hole.
    expect(starts(q, caption)).toEqual([120]);
    expect(overlaps(q)).toEqual([]);
    expect(rippleDelete(s.p, [])).toEqual({ edits: [], refused: null });
    expect(rippleDelete(s.p, ['missing'])).toEqual({ edits: [], refused: null });
  });

  it('lets each track close its own hole when unrelated clips of different lengths go together', () => {
    const s = scene();
    const x = add(s, makeClip('image', s.v1.id, { start: 100, duration: 100 }));
    const afterX = add(s, makeClip('image', s.v1.id, { start: 200, duration: 200 }));
    const t = title(s, 150, 150);
    const afterT = title(s, 300, 50);
    const q = applyEdits(s.p, rippleDelete(s.p, [x.id, t.id]).edits);
    // The picture after X closes up; the title follows by the same amount and no further.
    expect(starts(q, afterX, afterT)).toEqual([100, 200]);
    expect(overlaps(q)).toEqual([]);
  });
});

describe('ripple trim', () => {
  it('shortening the tail pulls picture, sound and titles after it left together', () => {
    const { s, one, two, three, caption, bed } = cut();
    const r = rippleTrim(s.p, [one.v.id, one.a.id], 'end', -40);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect([q.clips[one.v.id].duration, q.clips[one.a.id].duration]).toEqual([60, 60]);
    expect(starts(q, two.v, two.a, three.v, three.a, caption, bed)).toEqual([60, 60, 160, 160, 180, 0]);
    expect(overlaps(q)).toEqual([]);
    expect(trimClips(s.p, [one.v.id, one.a.id], 'end', -40, true)).toEqual(r.edits);
  });

  it('extending the tail pushes everything after it right', () => {
    const { s, one, two, three, caption, bed } = cut();
    const q = applyEdits(s.p, rippleTrim(s.p, [one.v.id, one.a.id], 'end', 30).edits);
    expect([q.clips[one.v.id].duration, q.clips[one.a.id].duration]).toEqual([130, 130]);
    expect(starts(q, two.v, two.a, three.v, three.a, caption, bed)).toEqual([130, 130, 230, 230, 250, 0]);
    expect(overlaps(q)).toEqual([]);
  });

  it('shortening the head keeps the clip in place and pulls what follows', () => {
    const { s, two, three, caption } = cut();
    const overHead = title(s, 100, 10);
    const overBody = title(s, 140, 30);
    const before = syncOffsets(s.p);
    const q = applyEdits(s.p, rippleTrim(s.p, [two.v.id, two.a.id], 'start', 30).edits);
    for (const c of [two.v, two.a]) {
      expect([q.clips[c.id].start, q.clips[c.id].duration]).toEqual([100, 70]);
      expect(q.clips[c.id].sourceIn).toBeCloseTo(3);
    }
    expect(starts(q, three.v, three.a, caption)).toEqual([170, 170, 190]);
    // A title over the part that was cut stays; one over what is left moves with the picture.
    expect(starts(q, overHead, overBody)).toEqual([100, 110]);
    expect(syncOffsets(q)).toEqual(before);
    expect(overlaps(q)).toEqual([]);
  });

  it('extending the head pushes the content under it and everything after right', () => {
    const { s, one, two, three, caption } = cut();
    const overBody = title(s, 140, 30);
    const before = syncOffsets(s.p);
    const q = applyEdits(s.p, rippleTrim(s.p, [two.v.id, two.a.id], 'start', -20).edits);
    for (const c of [two.v, two.a]) {
      expect([q.clips[c.id].start, q.clips[c.id].duration]).toEqual([100, 120]);
      expect(q.clips[c.id].sourceIn).toBeCloseTo(40 / 30);
    }
    expect(starts(q, one.v, three.v, three.a, overBody, caption)).toEqual([0, 220, 220, 160, 240]);
    expect(syncOffsets(q)).toEqual(before);
    expect(overlaps(q)).toEqual([]);
  });

  it('refuses to ripple one half of a linked pair out of sync, and stops a drag there', () => {
    const { s, one, two } = cut();
    // Tail of the picture only: the audio of the next clip has nowhere to go.
    const tail = rippleTrim(s.p, [one.v.id], 'end', -40);
    expect(tail.edits).toEqual([]);
    expect(tail.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(trimClips(s.p, [one.v.id], 'end', -40, true)).toEqual([]);
    expect(trimRange(s.p, [one.v.id], 'end', true).min).toBe(0);
    // Extending is fine: the sound after it moves right with its picture.
    expect(trimRange(s.p, [one.v.id], 'end', true).max).toBeGreaterThan(0);
    // Cutting into the head of the picture only: its own audio would no longer match it.
    const head = rippleTrim(s.p, [two.v.id], 'start', 30);
    expect(head.edits).toEqual([]);
    expect(head.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(trimRange(s.p, [two.v.id], 'start', true)).toEqual({ min: -60, max: 0 });
    // Letting the picture start earlier is fine: its sound moves right by as much and still matches.
    const before = syncOffsets(s.p);
    const q = applyEdits(s.p, rippleTrim(s.p, [two.v.id], 'start', -20).edits);
    expect([q.clips[two.v.id].start, q.clips[two.v.id].duration]).toEqual([100, 120]);
    expect([q.clips[two.a.id].start, q.clips[two.a.id].duration]).toEqual([120, 100]);
    expect(syncOffsets(q)).toEqual(before);
    expect(overlaps(q)).toEqual([]);
    // Both halves together are not limited by any of this.
    expect(trimRange(s.p, [two.v.id, two.a.id], 'start', true)).toEqual({ min: -60, max: 99 });
  });

  it('limits a ripple to the room a linked partner has', () => {
    const s = scene();
    const still = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    const next = pair(s, 100, 100);
    const sting = add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 0, duration: 85 }));
    expect(trimRange(s.p, [still.id], 'end', true).min).toBe(-15);
    const q = applyEdits(s.p, trimClips(s.p, [still.id], 'end', -15, true));
    expect(starts(q, next.v, next.a, sting)).toEqual([85, 85, 0]);
    expect(overlaps(q)).toEqual([]);
    expect(rippleTrim(s.p, [still.id], 'end', -16).refused).toMatch(/A1/);
    expect(trimClips(s.p, [still.id], 'end', -16, true)).toEqual([]);
  });

  it('trims a clip with nothing after it even when a linked pair elsewhere could only half follow', () => {
    const s = scene();
    add(s, makeClip('image', s.v1.id, { start: 0, duration: 360 }));
    const shot = pair(s, 360, 120);
    const bed = music(s, 0, 360);
    // Cutting the music back leaves the picture at 360 nowhere to go, so its sound stays with it.
    const r = rippleTrim(s.p, [bed.id], 'end', -300);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(q.clips[bed.id].duration).toBe(60);
    expect(starts(q, shot.v, shot.a)).toEqual([360, 360]);
    expect(trimRange(s.p, [bed.id], 'end', true).min).toBe(-359);
  });

  it('refuses to extend two clips that sit back to back into each other', () => {
    const s = scene();
    const first = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    const second = add(s, makeClip('image', s.v1.id, { start: 100, duration: 100 }));
    const after = add(s, makeClip('image', s.v1.id, { start: 200, duration: 50 }));
    const r = rippleTrim(s.p, [first.id, second.id], 'end', 10);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: there is no room on V1.');
    expect(trimRange(s.p, [first.id, second.id], 'end', true).max).toBe(0);
    // Shortening both is fine and never overlaps.
    const q = applyEdits(s.p, rippleTrim(s.p, [first.id, second.id], 'end', -10).edits);
    expect(starts(q, first, second, after)).toEqual([0, 100, 190]);
    expect(overlaps(q)).toEqual([]);
  });

  it('refuses when a linked partner starts before the cut', () => {
    const s = scene();
    const still = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    // A J-cut: the sound of the next shot starts under the still.
    const linkId = 'jcut';
    add(s, makeClip('video', s.v1.id, { assetId: 'asset1', start: 100, duration: 100, sourceIn: 1, linkId }));
    add(
      s,
      makeClip('audio', s.a1.id, { assetId: 'asset1', start: 80, duration: 120, sourceIn: 1 / 3, linkId }),
    );
    for (const delta of [-10, 10]) {
      const r = rippleTrim(s.p, [still.id], 'end', delta);
      expect(r.edits).toEqual([]);
      expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    }
    expect(trimRange(s.p, [still.id], 'end', true)).toEqual({ min: 0, max: 0 });
  });

  it('names a locked track only when unlocking it would let the trim ripple', () => {
    const s = scene();
    const still = add(s, makeClip('image', s.v1.id, { start: 0, duration: 100 }));
    const shot = pair(s, 100, 100, 60);
    const locked = applyEdits(s.p, [lock(s.a1)]);
    // The sound behind the still could follow its picture if its track were not locked.
    expect(rippleTrim(locked, [still.id], 'end', -20).refused).toBe(
      'Unlock A1 to ripple: a linked clip on it has to move too.',
    );
    expect(rippleTrim(s.p, [still.id], 'end', -20).refused).toBeNull();
    // Cutting into the head of the picture alone leaves its sound behind, locked or not.
    for (const p of [locked, s.p]) {
      expect(rippleTrim(p, [shot.v.id], 'start', 30).refused).toBe(
        'Cannot ripple here: a linked clip on A1 would fall out of sync.',
      );
    }
  });

  it('ends the range of a head trim at the first refusal, though a longer trim would go through', () => {
    const s = scene();
    const init = { assetId: 'asset1', start: 100, duration: 100, sourceIn: 1 };
    const shot = add(s, makeClip('video', s.v1.id, init));
    const next = pair(s, 200, 100);
    add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 90, duration: 13 }));
    const sting = add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 105, duration: 45 }));
    const ripples = (d: number): boolean => rippleTrim(s.p, [shot.id], 'start', d).refused === null;
    // The sting has two frames of room to follow. From the third on it is stuck, and the sound of
    // the next shot with it. Once the cut has passed its start it no longer has to move at all.
    expect([1, 2, 3, 4, 5, 6, 50, 51].map(ripples)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(trimRange(s.p, [shot.id], 'start', true)).toEqual({ min: -30, max: 2 });
    // Trimming straight to a frame further on is still possible; only a drag does not get there.
    const q = applyEdits(s.p, rippleTrim(s.p, [shot.id], 'start', 20).edits);
    expect(starts(q, next.v, next.a, sting)).toEqual([180, 180, 105]);
    expect(overlaps(q)).toEqual([]);
  });
});

describe('ripple trim to a frame', () => {
  /** Three shots, a title over the first, music under all three, then a shot with its own sound. */
  function sequence() {
    const s = scene();
    const shots = [0, 120, 240].map((start) =>
      add(s, makeClip('video', s.v1.id, { assetId: 'asset1', start, duration: 120, sourceIn: 1 })),
    );
    const caption = title(s, 18, 90);
    const bed = add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 0, duration: 360 }));
    const last = pair(s, 360, 120);
    return { s, shots, caption, bed, last };
  }
  const spans = (p: Project, ...clips: Clip[]): number[][] =>
    clips.map((c) => [p.clips[c.id].start, clipEnd(p.clips[c.id])]);

  it('cuts every clip under the playhead back to it and closes the hole they share', () => {
    const { s, shots, caption, bed, last } = sequence();
    const under = [shots[0].id, caption.id, bed.id];
    // One clip at a time this cannot be done: the last shot's sound sits right behind the music.
    expect(rippleTrim(s.p, [shots[0].id], 'end', -60).refused).not.toBeNull();
    const r = rippleTrimTo(s.p, under, 'end', 60);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(spans(q, shots[0], caption, bed)).toEqual([
      [0, 60],
      [18, 60],
      [0, 60],
    ]);
    // The picture closes up by the 60 frames it lost; the linked sound follows by the same.
    expect(starts(q, shots[1], shots[2], last.v, last.a)).toEqual([60, 180, 300, 300]);
    expect(overlaps(q)).toEqual([]);
  });

  it('cuts the heads off and moves what is left to where they began', () => {
    const { s, shots, caption, bed, last } = sequence();
    const before = syncOffsets(s.p);
    const r = rippleTrimTo(s.p, [shots[0].id, caption.id, bed.id], 'start', 60);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(spans(q, shots[0], caption, bed)).toEqual([
      [0, 60],
      [0, 48],
      [0, 300],
    ]);
    expect(q.clips[shots[0].id].sourceIn).toBeCloseTo(3);
    expect(q.clips[bed.id].sourceIn).toBeCloseTo(2);
    expect(starts(q, shots[1], shots[2], last.v, last.a)).toEqual([60, 180, 300, 300]);
    expect(syncOffsets(q)).toEqual(before);
    expect(overlaps(q)).toEqual([]);
  });

  it('matches a plain ripple trim for a single linked pair', () => {
    const { s, two } = cut();
    const ids = [two.v.id, two.a.id];
    expect(applyEdits(s.p, rippleTrimTo(s.p, ids, 'end', 160).edits)).toEqual(
      applyEdits(s.p, rippleTrim(s.p, ids, 'end', -40).edits),
    );
    expect(applyEdits(s.p, rippleTrimTo(s.p, ids, 'start', 130).edits)).toEqual(
      applyEdits(s.p, rippleTrim(s.p, ids, 'start', 30).edits),
    );
  });

  it('refuses as a whole, and ignores clips the frame does not cross', () => {
    const { s, shots, caption, last } = sequence();
    const r = rippleTrimTo(s.p, [shots[0].id, caption.id], 'end', 60);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(rippleTrimTo(s.p, [shots[0].id, last.v.id], 'end', 120)).toEqual({ edits: [], refused: null });
    expect(rippleTrimTo(s.p, [shots[1].id, 'missing'], 'start', 120)).toEqual({ edits: [], refused: null });
  });
});

describe('close gap', () => {
  it('closes the gap on every track that can follow', () => {
    const s = scene();
    const one = pair(s, 0, 100);
    const two = pair(s, 160, 100);
    const caption = title(s, 180, 40);
    const bed = music(s, 0, 260);
    const r = rippleCloseGap(s.p, s.v1.id, 120);
    expect(r.refused).toBeNull();
    const q = applyEdits(s.p, r.edits);
    expect(starts(q, one.v, one.a, two.v, two.a, caption, bed)).toEqual([0, 0, 100, 100, 120, 0]);
    expect(overlaps(q)).toEqual([]);
    expect(closeGap(s.p, s.v1.id, 120)).toEqual(r.edits);
    // Asking again from the audio track finds the same gap and the same answer.
    expect(applyEdits(s.p, closeGap(s.p, s.a1.id, 120)).clips).toEqual(q.clips);
    // No gap under the playhead, or nothing after it: nothing to do.
    expect(rippleCloseGap(s.p, s.v1.id, 50)).toEqual({ edits: [], refused: null });
    expect(rippleCloseGap(s.p, s.v1.id, 999)).toEqual({ edits: [], refused: null });
  });

  it('refuses when linked audio cannot follow its picture', () => {
    const s = scene();
    pair(s, 160, 100);
    add(s, makeClip('audio', s.a1.id, { assetId: 'asset1', start: 20, duration: 120 }));
    const r = rippleCloseGap(s.p, s.v1.id, 100);
    expect(r.edits).toEqual([]);
    expect(r.refused).toBe('Cannot ripple here: a linked clip on A1 would fall out of sync.');
    expect(closeGap(s.p, s.v1.id, 100)).toEqual([]);
  });
});

describe('ripple invariants', () => {
  /** Small deterministic generator, so a failure can be replayed from its seed. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function randomProject(rnd: () => number): Project {
    const f = fixture();
    const a2 = makeTrack('audio', 1);
    const edits: Edit[] = [{ op: 'addTrack', track: a2 }];
    const tracks = [f.v1, f.v2, f.a1, a2];
    const byTrack: Clip[][] = [];
    for (const track of tracks) {
      const list: Clip[] = [];
      let at = Math.floor(rnd() * 40);
      const count = 2 + Math.floor(rnd() * 5);
      for (let i = 0; i < count; i++) {
        const duration = 20 + Math.floor(rnd() * 80);
        list.push(
          makeClip(track.kind === 'audio' ? 'audio' : 'video', track.id, {
            assetId: 'asset1',
            start: at,
            duration,
            sourceIn: Math.floor(rnd() * 90) / 30,
          }),
        );
        at += duration + (rnd() < 0.5 ? 0 : Math.floor(rnd() * 60));
      }
      byTrack.push(list);
    }
    // Link some pictures to some sounds, aligned or not.
    byTrack[0].forEach((v, i) => {
      const a = byTrack[2][i];
      if (a && rnd() < 0.7) v.linkId = a.linkId = `l${i}`;
    });
    byTrack[1].forEach((v, i) => {
      const a = byTrack[3][i];
      if (a && rnd() < 0.3) v.linkId = a.linkId = `m${i}`;
    });
    for (const list of byTrack) for (const clip of list) edits.push({ op: 'addClip', clip });
    if (rnd() < 0.25) {
      const locked = tracks[Math.floor(rnd() * tracks.length)];
      edits.push({ op: 'updateTrack', id: locked.id, patch: { locked: true } });
    }
    return applyEdits(f.p, edits);
  }

  /** One of the ripple edits on clips picked at random, ready to run on the project or a variant of it. */
  function randomRipple(
    p: Project,
    rnd: () => number,
  ): { op: number; edited: Set<ID>; run: (q: Project) => RippleResult } {
    const all = Object.values(p.clips);
    const pick = (): Clip => all[Math.floor(rnd() * all.length)];
    const withPartners = (c: Clip): ID[] =>
      rnd() < 0.6 && c.linkId ? all.filter((o) => o.linkId === c.linkId).map((o) => o.id) : [c.id];
    const tracksOf = (ids: ID[]): Set<ID> => new Set(ids.map((id) => p.clips[id].trackId));
    const op = Math.floor(rnd() * 4);
    if (op === 0) {
      const ids = [...withPartners(pick()), ...(rnd() < 0.5 ? withPartners(pick()) : [])];
      return { op, edited: tracksOf(ids), run: (q) => rippleDelete(q, ids) };
    }
    if (op === 1) {
      const ids = [...withPartners(pick()), ...(rnd() < 0.2 ? [pick().id] : [])];
      const edge = rnd() < 0.5 ? 'start' : 'end';
      const delta = Math.floor(rnd() * 120) - 60;
      return { op, edited: tracksOf(ids), run: (q) => rippleTrim(q, ids, edge, delta) };
    }
    const c = pick();
    if (op === 2) {
      return {
        op,
        edited: new Set([c.trackId]),
        run: (q) => rippleCloseGap(q, c.trackId, Math.max(0, c.start - 1)),
      };
    }
    const frame = c.start + 1 + Math.floor(rnd() * (c.duration - 1));
    const under = all.filter((o) => o.start < frame && frame < clipEnd(o) && rnd() < 0.8).map((o) => o.id);
    const edge = rnd() < 0.5 ? 'start' : 'end';
    return { op, edited: tracksOf(under), run: (q) => rippleTrimTo(q, under, edge, frame) };
  }

  it('never overlaps clips, never parts a linked pair, and refuses with nothing done', () => {
    let done = 0;
    let refusals = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const rnd = random(seed);
      const p = randomProject(rnd);
      const { op, edited, run } = randomRipple(p, rnd);
      const r = run(p);
      const label = `seed ${seed}, op ${op}`;
      if (r.refused) {
        refusals++;
        expect(r.edits, label).toEqual([]);
        continue;
      }
      if (r.edits.length) done++;
      const q = applyEdits(p, r.edits);
      expect(overlaps(q), label).toEqual([]);
      const before = syncOffsets(p);
      for (const [linkId, offsets] of Object.entries(syncOffsets(q))) {
        if (offsets.length === before[linkId].length) expect(offsets, label).toEqual(before[linkId]);
      }
      for (const c of Object.values(q.clips)) {
        expect(c.start, label).toBeGreaterThanOrEqual(0);
        if (p.tracks[c.trackId].locked && !edited.has(c.trackId)) expect(c, label).toBe(p.clips[c.id]);
      }
      for (const t of Object.values(p.tracks)) {
        // Clips on a track keep their order: nothing jumps over a neighbour.
        const kept = clipsOnTrack(p, t.id).filter((c) => q.clips[c.id]);
        expect(
          clipsOnTrack(q, t.id).map((c) => c.id),
          label,
        ).toEqual(kept.map((c) => c.id));
        // A track that is not being edited moves as a block from some point on, or not at all.
        if (edited.has(t.id) || op === 0 || op === 3) continue;
        const moved = kept.map((c) => q.clips[c.id].start - c.start);
        const from = moved.findIndex((d) => d !== 0);
        if (from >= 0) expect(new Set(moved.slice(from)).size, label).toBe(1);
      }
    }
    // The generator has to exercise both outcomes for the checks above to mean anything.
    expect(done).toBeGreaterThan(150);
    expect(refusals).toBeGreaterThan(50);
  });

  it('blames a lock for a refusal only when opening it gets the ripple through', () => {
    let blamed = 0;
    let spared = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const rnd = random(seed * 6151);
      const open = randomProject(rnd);
      const p = applyEdits(
        open,
        Object.values(open.tracks)
          .filter(() => rnd() < 0.4)
          .map(lock),
      );
      const { run } = randomRipple(p, rnd);
      const refused = run(p).refused;
      if (!refused) continue;
      const label = `seed ${seed}`;
      const lockedIn = (q: Project, reason: string): Track | undefined =>
        Object.values(q.tracks).find((t) => t.locked && reason.includes(` ${trackLabel(q, t)} `));
      if (refused.startsWith('Unlock')) {
        // Open the locks it names, one after the other, and the ripple goes through.
        blamed++;
        let q = p;
        for (let reason: string | null = refused; reason; reason = run(q).refused) {
          expect(reason, label).toMatch(/^Unlock /);
          q = applyEdits(q, [unlock(lockedIn(q, reason)!)]);
        }
        continue;
      }
      // Any other reason may mention a locked track, but then opening it changes nothing.
      const track = lockedIn(p, refused);
      if (!track) continue;
      spared++;
      expect(run(applyEdits(p, [unlock(track)])).refused, label).toBe(refused);
    }
    expect(blamed).toBeGreaterThan(20);
    expect(spared).toBeGreaterThan(20);
  });

  it('lets a ripple trim be dragged to every frame of its range and no further', () => {
    let stopped = 0;
    let islands = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = random(seed * 104729);
      const p = randomProject(rnd);
      const all = Object.values(p.clips);
      const c = all[Math.floor(rnd() * all.length)];
      const partners = all.filter((o) => o === c || (c.linkId && o.linkId === c.linkId));
      const ids = rnd() < 0.5 ? partners.map((o) => o.id) : [c.id];
      for (const edge of ['start', 'end'] as const) {
        /** Whether a trim of exactly `d` frames goes through: not refused, and not cut short either. */
        const lands = (d: number): boolean => {
          const r = rippleTrim(p, ids, edge, d);
          const grown = applyEdits(p, r.edits).clips[c.id].duration - c.duration;
          return r.refused === null && grown === (edge === 'end' ? d : -d);
        };
        const label = `seed ${seed}, ${edge} of ${ids.length}`;
        const range = trimRange(p, ids, edge, true);
        // A tail can be let out a long way: past the first few seconds only the far end is tried.
        for (let d = range.min; d <= range.max; d++) {
          if (d !== 0 && (Math.abs(d) <= 120 || d === range.max))
            expect(lands(d), `${label}, ${d}`).toBe(true);
        }
        if (rippleTrim(p, ids, edge, range.min - 1).refused) stopped++;
        if (rippleTrim(p, ids, edge, range.max + 1).refused) stopped++;
        // Nothing past either end goes through, with one exception: cutting into a head can be
        // refused and then be possible again further on, where a drag does not get.
        let island = false;
        for (let d = 1; d <= 120; d++) {
          expect(lands(range.min - d), `${label}, ${range.min - d}`).toBe(false);
          if (!lands(range.max + d)) continue;
          expect(d, `${label}, ${range.max + d}`).toBeGreaterThan(1);
          expect(edge, `${label}, ${range.max + d}`).toBe('start');
          island = true;
        }
        if (island) islands++;
      }
    }
    expect(stopped).toBeGreaterThan(100);
    expect(islands).toBeGreaterThan(0);
  });

  /**
   * Ripple delete worked out the slow way, one hole and one clip at a time. Returns where every
   * surviving clip ends up, or null when linked clips would end up apart.
   */
  function referenceDelete(p: Project, ids: ID[]): Record<ID, number> | null {
    const gone = Array.from(new Set(ids)).map((id) => p.clips[id]);
    const dead = new Set(gone.map((c) => c.id));
    const survivors = Object.values(p.clips).filter((c) => !dead.has(c.id));
    const holes: [number, number][] = [];
    const sorted = gone.slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length;) {
      const start = sorted[i].start;
      let end = clipEnd(sorted[i]);
      const tracks = new Set([sorted[i].trackId]);
      for (i++; i < sorted.length && sorted[i].start < end; i++) {
        end = Math.max(end, clipEnd(sorted[i]));
        tracks.add(sorted[i].trackId);
      }
      let open = -1;
      for (let f = start; f <= end; f++) {
        const free =
          f < end && !survivors.some((c) => tracks.has(c.trackId) && c.start <= f && f < clipEnd(c));
        if (free && open < 0) open = f;
        if (!free && open >= 0) {
          holes.push([open, f]);
          open = -1;
        }
      }
    }
    holes.reverse();
    const edited = new Set(gone.map((c) => c.trackId));
    const still = new Set<ID>();
    for (;;) {
      const live = survivors.map((c) => ({
        trackId: c.trackId,
        id: c.id,
        linkId: c.linkId,
        from: c.start,
        start: c.start,
        end: clipEnd(c),
      }));
      for (const [a, b] of holes) {
        for (const t of Object.values(p.tracks)) {
          if (!edited.has(t.id) && (t.locked || still.has(t.id))) continue;
          const onTrack = live.filter((c) => c.trackId === t.id);
          const movers = onTrack.filter((c) => c.start >= b);
          const rest = onTrack.filter((c) => c.start < b);
          const len = b - a;
          // Moving means staying behind everything that does not move: no overlap, no leapfrogging.
          if (movers.some((m) => rest.some((o) => m.start - len < o.end))) continue;
          for (const m of movers) {
            m.start -= len;
            m.end -= len;
          }
        }
      }
      // Tracks that are only following stand still rather than part a pair; then start over.
      let parted = false;
      let gaveWay = false;
      for (const c of live) {
        if (!c.linkId) continue;
        const partner = live.find((o) => o.linkId === c.linkId)!;
        if (partner.start - partner.from === c.start - c.from) continue;
        parted = true;
        for (const half of [partner, c]) {
          if (half.start !== half.from && !edited.has(half.trackId)) {
            still.add(half.trackId);
            gaveWay = true;
          }
        }
      }
      if (!parted) return Object.fromEntries(live.map((c) => [c.id, c.start]));
      if (!gaveWay) return null;
    }
  }

  it('ripple delete agrees with a clip-by-clip model for any selection', () => {
    let done = 0;
    let refusals = 0;
    for (let seed = 1; seed <= 800; seed++) {
      const rnd = random(seed * 7919);
      const p = randomProject(rnd);
      const density = 0.1 + rnd() * 0.5;
      const ids = Object.values(p.clips)
        .filter(() => rnd() < density)
        .map((c) => c.id);
      // Linked pairs usually go together, as they do with linked selection on.
      if (rnd() < 0.7) {
        const links = new Set(ids.map((id) => p.clips[id].linkId).filter(Boolean));
        for (const c of Object.values(p.clips))
          if (links.has(c.linkId) && !ids.includes(c.id)) ids.push(c.id);
      }
      const expected = referenceDelete(p, ids);
      const r = rippleDelete(p, ids);
      if (!expected) {
        refusals++;
        expect(r, `seed ${seed}`).toMatchObject({ edits: [] });
        expect(r.refused, `seed ${seed}`).not.toBeNull();
        continue;
      }
      done++;
      expect(r.refused, `seed ${seed}`).toBeNull();
      const q = applyEdits(p, r.edits);
      expect(Object.fromEntries(Object.values(q.clips).map((c) => [c.id, c.start])), `seed ${seed}`).toEqual(
        expected,
      );
    }
    expect(done).toBeGreaterThan(200);
    expect(refusals).toBeGreaterThan(100);
  });

  it('closes thousands of holes in one pass', () => {
    const s = scene();
    const edits: Edit[] = [];
    const doomed: ID[] = [];
    const count = 4000;
    for (let i = 0; i < count; i++) {
      const init = { assetId: 'asset1', start: i * 10, duration: 10, linkId: `p${i}` };
      const v = makeClip('video', s.v1.id, init);
      const a = makeClip('audio', s.a1.id, init);
      edits.push({ op: 'addClip', clip: v }, { op: 'addClip', clip: a });
      if (i % 2) doomed.push(v.id, a.id);
    }
    const p = applyEdits(s.p, edits);
    const t0 = performance.now();
    const r = rippleDelete(p, doomed);
    const elapsed = performance.now() - t0;
    const q = applyEdits(p, r.edits);
    expect(r.refused).toBeNull();
    expect(clipsOnTrack(q, s.v1.id).map((c) => c.start)).toEqual(
      Array.from({ length: count / 2 }, (_, i) => i * 10),
    );
    expect(clipEnd(clipsOnTrack(q, s.a1.id)[count / 2 - 1])).toBe(count * 5);
    expect(elapsed).toBeLessThan(2000);
  });
});
