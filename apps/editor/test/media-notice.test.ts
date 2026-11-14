import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  ASSET_DEFAULTS,
  emptyProject,
  makeClip,
  makeTrack,
  makeTransition,
  type Asset,
  type Clip,
  type Project,
  type Track,
} from '@tandem/core';
import { missingPictureAt, pictureNotice, type PictureFault } from '../src/features/viewer/mediaNotice';

const asset = (id: string, kind: Asset['kind'] = 'video'): Asset => ({
  ...ASSET_DEFAULTS,
  id,
  name: `${id}.mp4`,
  kind,
  duration: 10,
});

interface Fixture {
  p: Project;
  v1: Track;
  v2: Track;
}

function fixture(): Fixture {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: v2 },
    ...['fine', 'away', 'odd'].map((id) => ({ op: 'addAsset' as const, asset: asset(id) })),
  ]);
  return { p, v1, v2 };
}

function add(p: Project, track: Track, assetId: string | null, start: number, init: Partial<Clip> = {}) {
  const clip = makeClip(assetId ? 'video' : 'solid', track.id, {
    start,
    duration: 60,
    assetId,
    name: assetId ? `${assetId}.mp4` : 'Solid',
    ...init,
  });
  return applyEdits(p, [{ op: 'addClip', clip }]);
}

/** `away` is on neither this device nor a server, and `odd` is in a format nothing here decodes. */
const faultOf = (a: Asset): PictureFault | null =>
  a.id === 'away' ? 'offline' : a.id === 'odd' ? 'undecodable' : null;

/** What the viewer says on a page that has a video decoder, as the test browser does. */
const said = (p: Project, frame: number): string | null => {
  const missing = missingPictureAt(p, frame, faultOf);
  return missing && pictureNotice(missing, null);
};

describe('missingPictureAt', () => {
  it('names the file of the clip under the frame and says what is wrong with it', () => {
    const f = fixture();
    let p = add(f.p, f.v1, 'fine', 0);
    p = add(p, f.v1, 'away', 60);
    p = add(p, f.v1, 'odd', 120);
    expect(said(p, 30)).toBeNull();
    expect(said(p, 60)).toBe('Media offline: away.mp4');
    expect(said(p, 119)).toBe('Media offline: away.mp4');
    expect(said(p, 120)).toBe('This browser cannot decode odd.mp4');
    expect(said(p, 180)).toBeNull();
  });

  it('speaks for the topmost of several, and looks past clips that have a picture or need no file', () => {
    const f = fixture();
    let p = add(f.p, f.v1, 'odd', 0);
    p = add(p, f.v2, 'away', 0);
    expect(said(p, 10)).toBe('Media offline: away.mp4');
    // Under a healthy clip, or under a title or a solid, the one below is still the one to name.
    let q = add(f.p, f.v1, 'odd', 0);
    q = add(q, f.v2, 'fine', 0, { duration: 30 });
    q = add(q, f.v2, null, 30, { duration: 30 });
    expect(said(q, 10)).toBe('This browser cannot decode odd.mp4');
    expect(said(q, 40)).toBe('This browser cannot decode odd.mp4');
  });

  it('says nothing of what is not on screen: a hidden track, a disabled clip, a sound', () => {
    const f = fixture();
    const shown = add(f.p, f.v1, 'away', 0);
    expect(said(shown, 10)).toBe('Media offline: away.mp4');
    const hidden = applyEdits(shown, [{ op: 'updateTrack', id: f.v1.id, patch: { hidden: true } }]);
    expect(said(hidden, 10)).toBeNull();
    expect(said(add(f.p, f.v1, 'away', 0, { enabled: false }), 10)).toBeNull();
    const a1 = makeTrack('audio', 0);
    const sound = applyEdits(f.p, [
      { op: 'addTrack', track: a1 },
      { op: 'addClip', clip: makeClip('audio', a1.id, { start: 0, duration: 60, assetId: 'away' }) },
    ]);
    expect(said(sound, 10)).toBeNull();
  });

  it('counts a clip whose file the project no longer lists as offline, under the name it had', () => {
    const f = fixture();
    const p = add(f.p, f.v1, 'gone', 0, { name: 'holiday.mov' });
    expect(said(p, 10)).toBe('Media offline: holiday.mov');
  });

  it('does not put a picture down to its file where the page has no video decoder at all', () => {
    const odd = { name: 'odd.mp4', why: 'undecodable' } as const;
    expect(pictureNotice(odd, null)).toBe('This browser cannot decode odd.mp4');
    expect(pictureNotice(odd, 'absent')).toBe('This browser has no video decoder to play odd.mp4');
    expect(pictureNotice(odd, 'insecure')).toBe('This page needs HTTPS to play odd.mp4');
    // A file that is nowhere to be had is offline whatever the page can decode.
    const away = { name: 'away.mp4', why: 'offline' } as const;
    for (const gap of [null, 'absent', 'insecure'] as const) {
      expect(pictureNotice(away, gap)).toBe('Media offline: away.mp4');
    }
  });

  it('sees both clips of a transition, the incoming one first', () => {
    const f = fixture();
    let p = add(f.p, f.v1, 'odd', 0);
    p = add(p, f.v1, 'fine', 60, { transIn: makeTransition('crossDissolve', 20) });
    // The outgoing clip is still on screen after the cut, for as long as the transition runs.
    expect(said(p, 65)).toBe('This browser cannot decode odd.mp4');
    expect(said(p, 100)).toBeNull();
    let q = add(f.p, f.v1, 'odd', 0);
    q = add(q, f.v1, 'away', 60, { transIn: makeTransition('crossDissolve', 20) });
    expect(said(q, 55)).toBe('Media offline: away.mp4');
    expect(said(q, 20)).toBe('This browser cannot decode odd.mp4');
  });
});
