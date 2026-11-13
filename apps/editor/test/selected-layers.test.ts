import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEdits,
  emptyProject,
  makeClip,
  makeTrack,
  makeTransition,
  resolveFrame,
  type Clip,
  type Project,
  type Track,
} from '@tandem/core';
import { selectedLayers } from '../src/features/viewer/selectedLayers';

// The real function, counted: how often the frame is resolved is what this module is about.
vi.mock('@tandem/core', async (original) => {
  const core = await original<typeof import('@tandem/core')>();
  return { ...core, resolveFrame: vi.fn(core.resolveFrame) };
});

interface Fixture {
  p: Project;
  v1: Track;
  v2: Track;
  a1: Track;
}

function fixture(): Fixture {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const a1 = makeTrack('audio', 0);
  const p = applyEdits(
    emptyProject(),
    [v1, v2, a1].map((track) => ({ op: 'addTrack', track })),
  );
  return { p, v1, v2, a1 };
}

function add(p: Project, type: Clip['type'], track: Track, start: number, init: Partial<Clip> = {}) {
  const clip = makeClip(type, track.id, { start, duration: 60, ...init });
  return { p: applyEdits(p, [{ op: 'addClip', clip }]), clip };
}

const ids = (p: Project, frame: number, selection: string[]): string[] =>
  selectedLayers(p, frame, selection).map((l) => l.clip.id);

describe('selectedLayers', () => {
  beforeEach(() => {
    vi.mocked(resolveFrame).mockClear();
  });

  it('gives the selected clips under the frame in the order they were selected', () => {
    const f = fixture();
    const low = add(f.p, 'solid', f.v1, 0);
    const high = add(low.p, 'solid', f.v2, 0);
    // The frame draws v1 below v2; the gizmo goes to whichever was selected first.
    expect(ids(high.p, 10, [high.clip.id, low.clip.id])).toEqual([high.clip.id, low.clip.id]);
    expect(ids(high.p, 10, [low.clip.id, high.clip.id])).toEqual([low.clip.id, high.clip.id]);
    const [layer] = selectedLayers(high.p, 10, [low.clip.id]);
    expect(layer.clip).toBe(high.p.clips[low.clip.id]);
    expect(layer.localFrame).toBe(10);
  });

  it('leaves out what is not on screen at the frame, and ids that name nothing', () => {
    const f = fixture();
    const early = add(f.p, 'solid', f.v1, 0);
    const late = add(early.p, 'solid', f.v1, 100);
    expect(ids(late.p, 10, [late.clip.id, 'gone', early.clip.id])).toEqual([early.clip.id]);
    expect(ids(late.p, 80, [late.clip.id, early.clip.id])).toEqual([]);
  });

  it('leaves out sound, adjustment layers and clips on a locked track', () => {
    const f = fixture();
    const sound = add(f.p, 'audio', f.a1, 0);
    const adjust = add(sound.p, 'adjustment', f.v2, 0);
    const picture = add(adjust.p, 'solid', f.v1, 0);
    const all = [sound.clip.id, adjust.clip.id, picture.clip.id];
    expect(ids(picture.p, 10, all)).toEqual([picture.clip.id]);
    const locked = applyEdits(picture.p, [{ op: 'updateTrack', id: f.v1.id, patch: { locked: true } }]);
    expect(ids(locked, 10, all)).toEqual([]);
  });

  it('finds both sides of a transition', () => {
    const f = fixture();
    const a = add(f.p, 'solid', f.v1, 0);
    const b = add(a.p, 'solid', f.v1, 60, { transIn: makeTransition('crossDissolve', 20) });
    // Frame 62 is inside the dissolve: the outgoing clip is still on screen after its last frame.
    const frame = resolveFrame(b.p, 62);
    expect(frame.layers.map((l) => l.kind)).toEqual(['transition']);
    expect(ids(b.p, 62, [b.clip.id, a.clip.id])).toEqual([b.clip.id, a.clip.id]);
  });

  it('resolves the frame once for the whole selection, and not at all when nothing in it can show', () => {
    const f = fixture();
    let p = f.p;
    const pictures: string[] = [];
    const sounds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const picture = add(p, 'solid', f.v1, i * 70);
      const sound = add(picture.p, 'audio', f.a1, i * 70);
      p = sound.p;
      pictures.push(picture.clip.id);
      sounds.push(sound.clip.id);
    }
    // The playhead stands in a gap, so every selected clip has to be looked for.
    vi.mocked(resolveFrame).mockClear();
    expect(ids(p, 65, pictures)).toEqual([]);
    expect(resolveFrame).toHaveBeenCalledTimes(1);

    vi.mocked(resolveFrame).mockClear();
    expect(ids(p, 10, [...sounds, 'gone'])).toEqual([]);
    expect(ids(p, 10, [])).toEqual([]);
    expect(resolveFrame).not.toHaveBeenCalled();
  });
});
