import { describe, expect, it } from 'vitest';
import {
  addAssetToTimeline,
  applyEdits,
  makeClip,
  makeTransition,
  setRamp,
  setSpeed,
  shapeRamp,
  toEdl,
  trimClips,
} from '../src';
import { addClip, fixture } from './helpers';

describe('EDL export', () => {
  it('lists picture and sound events with source and record timecode', () => {
    const { p, asset } = fixture();
    let q = applyEdits(p, [{ op: 'settings', patch: { name: 'Low Tide' } }]);
    q = applyEdits(q, addAssetToTimeline(q, asset, { frame: 0, sourceIn: 2, sourceOut: 6 }).edits);
    q = applyEdits(q, addAssetToTimeline(q, asset, { frame: 120, sourceIn: 10, sourceOut: 12 }).edits);
    const lines = toEdl(q).split('\r\n');
    expect(lines[0]).toBe('TITLE: Low Tide');
    expect(lines[1]).toBe('FCM: NON-DROP FRAME');
    const events = lines.filter((l) => /^\d{3} /.test(l));
    expect(events).toEqual([
      '001  CLIP     A     C        00:00:02:00 00:00:06:00 01:00:00:00 01:00:04:00',
      '002  CLIP     V     C        00:00:02:00 00:00:06:00 01:00:00:00 01:00:04:00',
      '003  CLIP     A     C        00:00:10:00 00:00:12:00 01:00:04:00 01:00:06:00',
      '004  CLIP     V     C        00:00:10:00 00:00:12:00 01:00:04:00 01:00:06:00',
    ]);
    expect(lines.filter((l) => l === '* FROM CLIP NAME: clip.mp4')).toHaveLength(4);
  });

  it('records speed changes, reverse and transitions', () => {
    const f = fixture();
    let { p, clip } = addClip(f.p, f.v1.id, 0, 60, { sourceIn: 4 });
    p = applyEdits(p, setSpeed(p, [clip.id], 2, true));
    p = applyEdits(p, [
      { op: 'updateClip', id: clip.id, patch: { transIn: makeTransition('crossDissolve', 12) } },
    ]);
    const out = toEdl(p);
    // 30 frames on the timeline at 200 % consume 60 source frames, played backwards.
    expect(out).toContain('001  CLIP     V     C        00:00:04:00 00:00:06:00 01:00:00:00 01:00:01:00');
    expect(out).toMatch(/M2 {3}CLIP {11}-060\.0 {16}00:00:06:00/);
    expect(out).toContain('* TRANSITION IN: crossDissolve 12 FRAMES (EXPORTED AS A CUT)');
  });

  it('starts the programme at one hour of timecode at every frame rate', () => {
    const f = fixture();
    const first = (fpsNum: number, fpsDen: number, frames: number): string => {
      let p = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum, fpsDen } }]);
      p = addClip(p, f.v1.id, 0, frames).p;
      return toEdl(p)
        .split('\r\n')
        .find((l) => l.startsWith('001'))!;
    };
    // 23.976 counts 24 frames to the timecode second, so ten seconds on the counter are 240 frames.
    expect(first(24000, 1001, 240)).toMatch(/ 01:00:00:00 01:00:10:00$/);
    expect(first(24, 1, 240)).toMatch(/ 01:00:00:00 01:00:10:00$/);
    expect(first(25, 1, 250)).toMatch(/ 01:00:00:00 01:00:10:00$/);
    expect(first(48000, 1001, 480)).toMatch(/ 01:00:00:00 01:00:10:00$/);
    expect(first(30000, 1001, 300)).toMatch(/ 01:00:00;00 01:00:10;00$/);
    expect(first(60000, 1001, 600)).toMatch(/ 01:00:00;00 01:00:10;00$/);
    // An explicit start still wins.
    let p = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum: 24000, fpsDen: 1001 } }]);
    p = addClip(p, f.v1.id, 0, 24).p;
    expect(toEdl(p, { startTimecodeFrames: 0 })).toMatch(/ 00:00:00:00 00:00:01:00\r\n/);
  });

  it('uses drop-frame timecode for 29.97 and skips disabled clips and generators', () => {
    const f = fixture();
    let p = applyEdits(f.p, [{ op: 'settings', patch: { fpsNum: 30000, fpsDen: 1001 } }]);
    p = addClip(p, f.v1.id, 0, 30).p;
    p = addClip(p, f.v1.id, 30, 30, { enabled: false }).p;
    const out = toEdl(p);
    expect(out).toContain('FCM: DROP FRAME');
    expect(out.split('\r\n').filter((l) => /^\d{3} /.test(l))).toHaveLength(1);
    expect(out).toMatch(/01:00:00;00 01:00:01;00/);
    expect(
      toEdl(f.p)
        .split('\r\n')
        .filter((l) => /^\d{3} /.test(l)),
    ).toHaveLength(0);
  });

  /** A sync clip from second 4 of its file, ten seconds long from frame 30, on Bullet. */
  function onBullet(reverse: boolean) {
    const f = fixture();
    const init = { sourceIn: 4, reverse, linkId: 'take' };
    const { p, clip } = addClip(f.p, f.v1.id, 30, 300, init);
    const sound = makeClip('audio', f.a1.id, { assetId: 'asset1', start: 30, duration: 300, ...init });
    const q = applyEdits(p, [{ op: 'addClip', clip: sound }]);
    const ramp = shapeRamp('bullet', 4, 14, reverse);
    return { p: applyEdits(q, setRamp(q, [clip.id], { ramps: { [clip.id]: ramp } })), ids: [clip.id, sound.id] };
  }

  it('lists a clip on a speed ramp at its average speed, and says what the ramp runs between', () => {
    const { p } = onBullet(false);
    // Ten seconds of media in 69 frames: 4.37 times the speed on average, 131.1 frames a second.
    expect(toEdl(p).split('\r\n').slice(3)).toEqual([
      '001  CLIP     A     C        00:00:04:00 00:00:14:02 01:00:01:00 01:00:03:09',
      'M2   CLIP           131.1                00:00:04:00',
      '* SPEED RAMP: 25% TO 500% (EXPORTED AT ITS AVERAGE SPEED)',
      '* FROM CLIP NAME: clip.mp4',
      '002  CLIP     V     C        00:00:04:00 00:00:14:02 01:00:01:00 01:00:03:09',
      'M2   CLIP           131.1                00:00:04:00',
      '* SPEED RAMP: 25% TO 500% (EXPORTED AT ITS AVERAGE SPEED)',
      '* FROM CLIP NAME: clip.mp4',
      '',
    ]);
  });

  it('lists it backwards from the top of what it covers, with the rate below zero', () => {
    const { p } = onBullet(true);
    expect(toEdl(p).split('\r\n').slice(3, 7)).toEqual([
      '001  CLIP     A     C        00:00:04:00 00:00:14:02 01:00:01:00 01:00:03:09',
      'M2   CLIP           -131.1                00:00:14:02',
      '* SPEED RAMP: 25% TO 500% (EXPORTED AT ITS AVERAGE SPEED)',
      '* FROM CLIP NAME: clip.mp4',
    ]);
  });

  it('takes the source range and the speeds of a trimmed piece from the part of the ramp it plays', () => {
    const { p, ids } = onBullet(false);
    // The first second of the clip is the fast run-in: 147 frames of the file.
    const late = applyEdits(p, trimClips(p, ids, 'start', 30));
    expect(toEdl(late).split('\r\n').slice(3, 6)).toEqual([
      '001  CLIP     A     C        00:00:08:25 00:00:14:01 01:00:02:00 01:00:03:09',
      'M2   CLIP           120.2                00:00:08:25',
      '* SPEED RAMP: 25% TO 500% (EXPORTED AT ITS AVERAGE SPEED)',
    ]);
    // Only the fast run-in: one speed all through, and still a ramp.
    const early = applyEdits(p, trimClips(p, ids, 'end', -45));
    expect(toEdl(early).split('\r\n').slice(3, 6)).toEqual([
      '001  CLIP     A     C        00:00:04:00 00:00:08:00 01:00:01:00 01:00:01:24',
      'M2   CLIP           150.0                00:00:04:00',
      '* SPEED RAMP: 500% TO 500% (EXPORTED AT ITS AVERAGE SPEED)',
    ]);
  });

  it('lists a clip taken off its ramp like any clip at one speed', () => {
    const { p, ids } = onBullet(false);
    const off = applyEdits(p, setSpeed(p, ids, 2));
    const out = toEdl(off);
    expect(out).not.toContain('SPEED RAMP');
    expect(out).toMatch(/M2 {3}CLIP {11}060\.0 {16}00:00:04:00/);
  });
});
