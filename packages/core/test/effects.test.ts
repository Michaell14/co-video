import { describe, expect, it } from 'vitest';
import {
  blurScaleFor,
  defaultParams,
  EFFECTS,
  getEffectDef,
  previewParams,
  resolveParams,
  type EffectDef,
  type PassContext,
  type ResolvedParams,
} from '../src';

/** The render-target scales of the passes an effect would actually run, in order. */
function scalesRun(def: EffectDef, params: ResolvedParams, c: PassContext): number[] {
  const out: number[] = [];
  for (const pass of def.passes) {
    if (pass.skip?.(params, c)) continue;
    out.push(typeof pass.scale === 'function' ? pass.scale(params, c) : (pass.scale ?? 1));
  }
  return out;
}

const params = (id: string, values: Record<string, number>): ResolvedParams => {
  const def = getEffectDef(id)!;
  return resolveParams(def.params, { ...defaultParams(def.params), ...values });
};

describe('wide blurs', () => {
  it('shrinks the picture until the taps of the blur sit next to each other', () => {
    // 16 taps a side reach three sigma, so sigma may be at most 8 texels for a spacing of 1.5.
    for (let sigma = 0.25; sigma <= 1600; sigma *= 1.07) {
      const scale = blurScaleFor(sigma);
      expect(Number.isInteger(Math.log2(scale)), `scale for ${sigma}`).toBe(true);
      expect(scale).toBeLessThanOrEqual(1);
      expect((sigma * scale * 3) / 16, `tap spacing at sigma ${sigma}`).toBeLessThanOrEqual(1.5);
    }
    // Radius 200 on a 2160p frame: sigma 200 px, which a 1/8 picture cannot carry.
    expect(blurScaleFor(200)).toBe(1 / 64);
    expect(blurScaleFor(24)).toBe(0.25);
    expect(blurScaleFor(3)).toBe(1);
  });

  it('goes no further down than that takes', () => {
    // Past a quarter size each halving has to be needed: one step up, sigma would be over six texels.
    for (let sigma = 25; sigma <= 1500; sigma *= 1.07) {
      expect(sigma * blurScaleFor(sigma) * 2, `sigma ${sigma}`).toBeGreaterThan(6);
    }
  });

  it('halves step by step all the way down to the scale it blurs at', () => {
    for (const id of ['gaussianBlur', 'glow', 'dropShadow', 'clarity']) {
      const def = getEffectDef(id)!;
      const key = id === 'dropShadow' ? 'blur' : 'radius';
      for (const [value, px] of [
        [2, 1],
        [12, 1],
        [40, 1],
        [120, 2],
        [120, 4],
        [120, 15],
      ]) {
        const c: PassContext = { px, width: 1920 * px, height: 1080 * px };
        const p = params(id, { [key]: value });
        const target = blurScaleFor(value * 0.5 * px);
        const run = scalesRun(def, p, c);
        // Everything smaller than full size: the chain down, then the two blur passes.
        const reduced = run.filter((s) => s < 1);
        const chain: number[] = [];
        for (let s = 0.5; s >= target; s /= 2) chain.push(s);
        expect(reduced, `${id} ${value} @${px}x`).toEqual(target < 1 ? [...chain, target, target] : []);
      }
    }
  });

  it('gives tilt-shift a reduced copy once its widest blur outgrows the tap budget', () => {
    const def = getEffectDef('tiltShift')!;
    const run = (blur: number, px: number) =>
      scalesRun(def, params('tiltShift', { blur }), { px, width: 1920 * px, height: 1080 * px });
    // Sigma is half the blur setting in 1080p pixels: up to 16 texels are blurred directly.
    expect(run(16, 1)).toEqual([1, 1]);
    expect(run(16, 2)).toEqual([1, 1]);
    // Wider than that: halve, blur both ways, then merge with the sharp original at full size.
    expect(run(60, 1)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(run(60, 2)).toEqual([0.5, 0.25, 0.25, 0.25, 1]);
    for (const px of [1, 2, 4, 8, 15]) {
      for (const blur of [1, 16, 33, 60]) {
        const scales = run(blur, px);
        const blurAt = Math.min(...scales);
        expect(blur * 0.5 * px * blurAt, `blur ${blur} @${px}x`).toBeLessThanOrEqual(16);
      }
    }
  });
});

describe('effect previews', () => {
  it('only override parameters the effect has, with values the inspector could set', () => {
    for (const def of EFFECTS) {
      for (const [key, value] of Object.entries(def.preview ?? {})) {
        const param = def.params.find((d) => d.key === key);
        expect(param, `${def.id}.${key}`).toBeDefined();
        if (param!.type === 'float') {
          expect(typeof value).toBe('number');
          expect(value as number).toBeGreaterThanOrEqual(param!.min);
          expect(value as number).toBeLessThanOrEqual(param!.max);
        } else if (param!.type === 'angle') expect(typeof value).toBe('number');
        else if (param!.type === 'color') expect(value).toMatch(/^#[0-9a-f]{6}$/);
        else if (param!.type === 'bool') expect(typeof value).toBe('boolean');
        else if (param!.type === 'select') expect(param!.options.map((o) => o.value)).toContain(value);
        else expect(value).toHaveLength(2);
      }
    }
  });

  it('lay the preview over the defaults and leave the defaults alone', () => {
    const exposure = getEffectDef('exposure')!;
    expect(defaultParams(exposure.params)).toEqual({ exposure: 0, gamma: 1 });
    expect(previewParams(exposure)).toEqual({ exposure: 1, gamma: 1 });
    const invert = getEffectDef('invert')!;
    expect(invert.preview).toBeUndefined();
    expect(previewParams(invert)).toEqual(defaultParams(invert.params));
  });

  it('exist for the adjustments that do nothing until they are dialled in', () => {
    for (const id of ['brightnessContrast', 'exposure', 'hueSaturation', 'temperature', 'levels']) {
      const def = getEffectDef(id)!;
      const neutral = resolveParams(def.params, defaultParams(def.params));
      const shown = resolveParams(def.params, previewParams(def));
      expect(shown, id).not.toEqual(neutral);
    }
  });
});
