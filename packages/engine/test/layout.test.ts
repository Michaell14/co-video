import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  emptyProject,
  IDENTITY_ANIM,
  makeClip,
  makeTrack,
  makeTransition,
  resolveFrame,
  DEFAULT_TEXT,
  type ClipLayer,
  type Layer,
  type Project,
} from '@tandem/core';
import { layerAtRest, layoutLayer, withClipAtRest } from '../src/gl/layout';

/** Two titles that fade in over a second, the second coming in through a dissolve, and a shape below. */
function fixture(): { p: Project; first: string; second: string; shape: string } {
  const v1 = makeTrack('video', 0);
  const v2 = makeTrack('video', 1);
  const text = { ...DEFAULT_TEXT, animIn: { type: 'slideUp', duration: 30 } };
  const first = makeClip('text', v2.id, { start: 0, duration: 60, text });
  const second = makeClip('text', v2.id, {
    start: 60,
    duration: 60,
    text,
    transIn: makeTransition('crossDissolve', 20),
  });
  const shape = makeClip('shape', v1.id, { start: 0, duration: 120 });
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    { op: 'addTrack', track: v2 },
    { op: 'addClip', clip: shape },
    { op: 'addClip', clip: first },
    { op: 'addClip', clip: second },
  ]);
  return { p, first: first.id, second: second.id, shape: shape.id };
}

const sides = (layer: Layer): (ClipLayer | null)[] =>
  layer.kind === 'clip' ? [layer.layer] : [layer.a, layer.b];
const find = (layers: Layer[], id: string): ClipLayer =>
  layers.flatMap(sides).find((L) => L?.clip.id === id)!;

describe('a layer at rest', () => {
  it('is the layer without the animation it comes in with, and nothing else about it changed', () => {
    const { p, first } = fixture();
    const moving = find(resolveFrame(p, 5).layers, first);
    expect(moving.anim.dy).toBeGreaterThan(0);
    expect(moving.anim.opacity).toBeLessThan(1);
    const rest = layerAtRest(moving);
    expect(rest.anim).toBe(IDENTITY_ANIM);
    expect({ ...rest, anim: moving.anim }).toEqual(moving);
    // It is laid out where it stands once it has arrived.
    const settled = find(resolveFrame(p, 45).layers, first);
    expect(layoutLayer(rest, 400, 100, 1920, 1080, 1)).toEqual(layoutLayer(settled, 400, 100, 1920, 1080, 1));
    expect(layoutLayer(moving, 400, 100, 1920, 1080, 1).py).toBeGreaterThan(
      layoutLayer(rest, 400, 100, 1920, 1080, 1).py,
    );
  });

  it('is the same object for a layer that is at rest already', () => {
    const { p, first } = fixture();
    const settled = find(resolveFrame(p, 45).layers, first);
    expect(layerAtRest(settled)).toBe(settled);
  });
});

describe('withClipAtRest', () => {
  it('puts the one clip at rest and hands every other layer back as it is', () => {
    const { p, first, shape } = fixture();
    const layers = resolveFrame(p, 5).layers;
    const held = layers.map((layer) => withClipAtRest(layer, first));
    expect(find(held, first).anim).toBe(IDENTITY_ANIM);
    const below = layers.find((layer) => sides(layer).some((L) => L?.clip.id === shape))!;
    expect(held).toContain(below);
    expect(layers.map((layer) => withClipAtRest(layer, 'nobody'))).toEqual(layers);
  });

  it('reaches a clip on either side of a transition', () => {
    const { p, second } = fixture();
    const layers = resolveFrame(p, 62).layers;
    const transition = layers.find((layer) => layer.kind === 'transition')!;
    expect(find([transition], second).anim).not.toBe(IDENTITY_ANIM);
    const held = withClipAtRest(transition, second);
    expect(held.kind).toBe('transition');
    expect(find([held], second).anim).toBe(IDENTITY_ANIM);
    // The other side, and the transition itself, are untouched.
    expect({ ...held, a: null, b: null }).toEqual({ ...transition, a: null, b: null });
    for (const L of sides(transition)) {
      if (L && L.clip.id !== second) expect(sides(held)).toContain(L);
    }
  });
});
