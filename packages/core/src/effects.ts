/**
 * The effect library.
 *
 * Effects are pure data: a parameter schema plus one or more GLSL passes. The engine has a single
 * generic runner (packages/engine/src/gl/effectRunner.ts) that compiles and executes them, which
 * means adding an effect is a matter of appending an entry here — no engine or UI changes needed.
 *
 * See `glsl.ts` for the shader conventions (premultiplied alpha, working encoding, top-left UVs).
 */
import type { EffectInstance, ParamValue } from './types';
import { newId } from './ids';

export type ParamDef =
  | {
      key: string;
      label: string;
      type: 'float';
      min: number;
      max: number;
      step?: number;
      default: number;
      unit?: string;
    }
  | { key: string; label: string; type: 'angle'; default: number }
  | { key: string; label: string; type: 'bool'; default: boolean }
  | { key: string; label: string; type: 'color'; default: string }
  | {
      key: string;
      label: string;
      type: 'select';
      options: { value: string; label: string }[];
      default: string;
    }
  | { key: string; label: string; type: 'point'; default: [number, number] };

/** Parameters after conversion to uniform-ready numbers. */
export type ResolvedParams = Record<string, number | number[]>;

export interface PassContext {
  /** Device pixels per 1080p-reference pixel. */
  px: number;
  width: number;
  height: number;
}

export interface EffectPass {
  glsl: string;
  /** Render-target scale relative to the effect input. Default 1. */
  scale?: number | ((p: ResolvedParams, c: PassContext) => number);
  uniforms?: (p: ResolvedParams, c: PassContext) => Record<string, number | number[]>;
  skip?: (p: ResolvedParams, c: PassContext) => boolean;
}

export type EffectCategory =
  'color' | 'blur' | 'stylize' | 'distort' | 'light' | 'retro' | 'keying' | 'utility';

export interface EffectDef {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: ParamDef[];
  passes: EffectPass[];
  /**
   * `layer` effects run in the source's own pixel space before the transform. `frame` effects run on
   * the transformed layer in sequence space, so they can paint outside the source bounds (shadows,
   * outlines). Generators (text, shapes) always run every effect in frame space.
   */
  space?: 'layer' | 'frame';
  /**
   * Parameter values for the effect's library thumbnail, laid over the defaults (see
   * `previewParams`). For effects whose defaults leave the picture as it is, because they are meant
   * to be dialled in: the thumbnail should still show what the effect does.
   */
  preview?: Record<string, ParamValue>;
}

export const EFFECT_CATEGORIES: { id: EffectCategory; label: string }[] = [
  { id: 'color', label: 'Colour' },
  { id: 'blur', label: 'Blur & Sharpen' },
  { id: 'light', label: 'Light' },
  { id: 'stylize', label: 'Stylise' },
  { id: 'retro', label: 'Retro' },
  { id: 'distort', label: 'Distort' },
  { id: 'keying', label: 'Keying' },
  { id: 'utility', label: 'Utility' },
];

// ─────────────────────────────────────────────────────────── shared passes ──

const f = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  step = 0.01,
  unit?: string,
): ParamDef => ({
  key,
  label,
  type: 'float',
  min,
  max,
  default: def,
  step,
  unit,
});

const colorFx = (body: string): EffectPass[] => [
  {
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = unpremul(src(uv));
  ${body}
  return premul(c);
}`,
  },
];

const BLUR_GLSL = /* glsl */ `
uniform vec2 u_dir;
uniform float u_sigma;
vec4 effect(vec2 uv) {
  if (u_sigma < 0.05) return src(uv);
  vec4 acc = src(uv);
  float wsum = 1.0;
  float stepSize = max(1.0, u_sigma * 3.0 / 16.0);
  float inv = 0.5 / (u_sigma * u_sigma);
  for (int i = 1; i <= 16; i++) {
    float x = float(i) * stepSize;
    float w = exp(-x * x * inv);
    vec2 o = u_dir * u_texel * x;
    acc += (src(uv + o) + src(uv - o)) * w;
    wsum += 2.0 * w;
  }
  return acc / wsum;
}`;

const DOWNSAMPLE_GLSL = /* glsl */ `
vec4 effect(vec2 uv) {
  vec2 o = u_texel;
  return (src(uv + vec2(-o.x, -o.y)) + src(uv + vec2(o.x, -o.y)) + src(uv + vec2(-o.x, o.y)) + src(uv + vec2(o.x, o.y))) * 0.25;
}`;

/** Smallest scale a blur is computed at: enough for the widest blur on the largest frame. */
const MIN_BLUR_SCALE = 1 / 256;

/**
 * Chooses how far to shrink the image before blurring, which keeps wide blurs cheap and, just as
 * important, correct: the blur has a fixed number of taps, so sigma has to stay small enough (about
 * six texels) for neighbouring taps to overlap. Spread further apart they step over fine detail and
 * the blur comes out as stripes.
 */
export function blurScaleFor(sigmaPx: number): number {
  if (sigmaPx <= 4) return 1;
  if (sigmaPx <= 10) return 0.5;
  let scale = 0.25;
  while (sigmaPx * scale > 6 && scale > MIN_BLUR_SCALE) scale /= 2;
  return scale;
}

type ScaleOf = (p: ResolvedParams, c: PassContext) => number;

/** Halve the image step by step until it is at `scaleOf`, which must be 1 or a power of two below it. */
function downsamplePasses(scaleOf: ScaleOf, smallest: number): EffectPass[] {
  const passes: EffectPass[] = [];
  for (let scale = 0.5; scale >= smallest; scale /= 2) {
    passes.push({ glsl: DOWNSAMPLE_GLSL, scale, skip: (p, c) => scaleOf(p, c) > scale });
  }
  return passes;
}

/** A separable gaussian blur with automatic down-sampling. `sigmaOf` returns sigma in device pixels. */
function blurPasses(sigmaOf: (p: ResolvedParams, c: PassContext) => number): EffectPass[] {
  const sc: ScaleOf = (p, c) => blurScaleFor(sigmaOf(p, c));
  return [
    ...downsamplePasses(sc, MIN_BLUR_SCALE),
    {
      glsl: BLUR_GLSL,
      scale: sc,
      uniforms: (p, c) => ({ u_dir: [1, 0], u_sigma: sigmaOf(p, c) * sc(p, c) }),
    },
    {
      glsl: BLUR_GLSL,
      scale: sc,
      uniforms: (p, c) => ({ u_dir: [0, 1], u_sigma: sigmaOf(p, c) * sc(p, c) }),
    },
  ];
}

// Tilt-shift blurs by a different amount on every row, so it cannot use the fixed-tap blur above.
// It weighs every texel within three sigma, fetching them two at a time, which at 24 fetches a side
// covers a sigma of 16 texels; wider blurs are computed on a reduced copy.
const TILT_MAX_SIGMA = 16;
const MIN_TILT_SCALE = 1 / 32;

const tiltScale: ScaleOf = (p, c) => {
  const sigma = (p.blur as number) * 0.5 * c.px;
  let scale = 1;
  while (sigma * scale > TILT_MAX_SIGMA && scale > MIN_TILT_SCALE) scale /= 2;
  return scale;
};

const TILT_SIGMA_GLSL = /* glsl */ `
float tiltSigma(vec2 uv) {
  float d = abs(uv.y - u_position);
  float amt = smoothstep(u_range * 0.5, u_range * 0.5 + u_falloff, d);
  return u_blur * 0.5 * u_px * amt;
}`;

const TILT_BLUR_GLSL = /* glsl */ `
uniform vec2 u_dir;
${TILT_SIGMA_GLSL}
vec4 effect(vec2 uv) {
  float sigma = tiltSigma(uv);
  if (sigma < 0.3) return src(uv);
  float inv = 0.5 / (sigma * sigma);
  int pairs = int(ceil(min(sigma * 1.5, 24.0)));
  vec4 acc = src(uv);
  float wsum = 1.0;
  for (int i = 0; i < 24; i++) {
    if (i >= pairs) break;
    // One bilinear fetch between two neighbouring texels, placed so that the filter gives each
    // of them its own gaussian weight.
    float a = float(2 * i + 1);
    float wa = exp(-a * a * inv);
    float wb = exp(-(a + 1.0) * (a + 1.0) * inv);
    float w = wa + wb;
    vec2 o = u_dir * u_texel * (a + wb / w);
    acc += (src(uv + o) + src(uv - o)) * w;
    wsum += 2.0 * w;
  }
  return acc / wsum;
}`;

// A reduced copy is soft everywhere, the band in focus included. Back at full size the original
// takes over wherever less blur was asked for than the reduction itself gives (about one of its
// texels).
const TILT_MERGE_GLSL = /* glsl */ `
uniform float u_blurScale;
${TILT_SIGMA_GLSL}
vec4 effect(vec2 uv) {
  return mix(orig(uv), src(uv), smoothstep(0.0, 1.0, tiltSigma(uv) * u_blurScale));
}`;

// ───────────────────────────────────────────────────────────────── library ──

export const EFFECTS: EffectDef[] = [
  // ── Colour ──────────────────────────────────────────────────────────────
  {
    id: 'brightnessContrast',
    name: 'Brightness & Contrast',
    category: 'color',
    description: 'Lift or lower overall brightness and stretch contrast around mid-grey.',
    params: [f('brightness', 'Brightness', -1, 1, 0), f('contrast', 'Contrast', -1, 1, 0)],
    preview: { brightness: 0.1, contrast: 0.45 },
    passes: colorFx(`c.rgb += u_brightness;
  float k = u_contrast >= 0.0 ? 1.0 + u_contrast * 2.0 : 1.0 + u_contrast;
  c.rgb = (c.rgb - 0.5) * k + 0.5;`),
  },
  {
    id: 'exposure',
    name: 'Exposure',
    category: 'color',
    description: 'Photographic exposure in stops, computed in linear light.',
    params: [f('exposure', 'Exposure', -5, 5, 0, 0.01, 'EV'), f('gamma', 'Gamma', 0.2, 3, 1)],
    preview: { exposure: 1 },
    passes: colorFx(`vec3 l = toLinear(c.rgb) * exp2(u_exposure);
  c.rgb = fromLinear(l);
  c.rgb = sign(c.rgb) * pow(abs(c.rgb), vec3(1.0 / u_gamma));`),
  },
  {
    id: 'hueSaturation',
    name: 'Hue & Saturation',
    category: 'color',
    description: 'Rotate hue, scale saturation and adjust lightness.',
    params: [
      { key: 'hue', label: 'Hue', type: 'angle', default: 0 },
      f('saturation', 'Saturation', -1, 1, 0),
      f('lightness', 'Lightness', -1, 1, 0),
    ],
    preview: { hue: 120, saturation: 0.25 },
    passes: colorFx(`vec3 h = rgb2hsv(max(c.rgb, 0.0));
  h.x = fract(h.x + u_hue / 6.28318530718);
  h.y = clamp(h.y * (1.0 + u_saturation), 0.0, 1.0);
  c.rgb = hsv2rgb(h);
  c.rgb = u_lightness > 0.0 ? mix(c.rgb, vec3(1.0), u_lightness) : c.rgb * (1.0 + u_lightness);`),
  },
  {
    id: 'vibrance',
    name: 'Vibrance',
    category: 'color',
    description: 'Boost muted colours while protecting already-saturated ones and skin tones.',
    params: [f('amount', 'Amount', -1, 1, 0.4)],
    passes: colorFx(`float mx = max(c.r, max(c.g, c.b));
  float av = (c.r + c.g + c.b) / 3.0;
  float amt = (mx - av) * (-3.0 * u_amount);
  c.rgb = mix(c.rgb, vec3(mx), amt);`),
  },
  {
    id: 'temperature',
    name: 'Temperature & Tint',
    category: 'color',
    description: 'Warm or cool the image and correct green / magenta casts.',
    params: [f('temperature', 'Warmth', -1, 1, 0), f('tint', 'Tint', -1, 1, 0)],
    preview: { temperature: -0.8 },
    passes:
      colorFx(`vec3 gain = vec3(1.0 + 0.35 * u_temperature, 1.0 - 0.3 * u_tint, 1.0 - 0.35 * u_temperature);
  gain /= dot(gain, u_lumaW);
  c.rgb = fromLinear(toLinear(c.rgb) * gain);`),
  },
  {
    id: 'levels',
    name: 'Levels',
    category: 'color',
    description: 'Remap input black / white points, gamma and output range.',
    params: [
      f('inBlack', 'In black', 0, 1, 0),
      f('inWhite', 'In white', 0, 1, 1),
      f('gamma', 'Gamma', 0.1, 4, 1),
      f('outBlack', 'Out black', 0, 1, 0),
      f('outWhite', 'Out white', 0, 1, 1),
    ],
    preview: { inBlack: 0.25, inWhite: 0.7 },
    passes: colorFx(`vec3 v = (c.rgb - u_inBlack) / max(u_inWhite - u_inBlack, 1e-4);
  v = sign(v) * pow(abs(v), vec3(1.0 / u_gamma));
  c.rgb = mix(vec3(u_outBlack), vec3(u_outWhite), v);`),
  },
  {
    id: 'invert',
    name: 'Invert',
    category: 'color',
    description: 'Negative image.',
    params: [f('amount', 'Amount', 0, 1, 1)],
    passes: colorFx(`c.rgb = mix(c.rgb, 1.0 - c.rgb, u_amount);`),
  },
  {
    id: 'tint',
    name: 'Colourise',
    category: 'color',
    description: 'Map the image onto a single colour while preserving luminance.',
    params: [
      { key: 'color', label: 'Colour', type: 'color', default: '#ff9a3c' },
      f('amount', 'Amount', 0, 1, 1),
    ],
    passes: colorFx(`float l = clamp(luma(c.rgb), 0.0, 1.0);
  vec3 t = l < 0.5 ? mix(vec3(0.0), u_color, l * 2.0) : mix(u_color, vec3(1.0), (l - 0.5) * 2.0);
  c.rgb = mix(c.rgb, t, u_amount);`),
  },
  {
    id: 'duotone',
    name: 'Duotone',
    category: 'color',
    description: 'Two-colour gradient map from shadows to highlights.',
    params: [
      { key: 'shadow', label: 'Shadows', type: 'color', default: '#1b1464' },
      { key: 'highlight', label: 'Highlights', type: 'color', default: '#ff5e62' },
      f('amount', 'Amount', 0, 1, 1),
    ],
    passes: colorFx(`float l = clamp(luma(c.rgb), 0.0, 1.0);
  c.rgb = mix(c.rgb, mix(u_shadow, u_highlight, l), u_amount);`),
  },
  {
    id: 'blackWhite',
    name: 'Black & White',
    category: 'color',
    description: 'Monochrome conversion with a channel mixer.',
    params: [
      f('red', 'Reds', 0, 2, 0.6),
      f('green', 'Greens', 0, 2, 1.2),
      f('blue', 'Blues', 0, 2, 0.2),
      f('amount', 'Amount', 0, 1, 1),
    ],
    passes: colorFx(`float g = dot(c.rgb, vec3(u_red, u_green, u_blue)) / max(u_red + u_green + u_blue, 1e-3);
  c.rgb = mix(c.rgb, vec3(g), u_amount);`),
  },
  {
    id: 'sepia',
    name: 'Sepia',
    category: 'color',
    description: 'Warm brown antique toning.',
    params: [f('amount', 'Amount', 0, 1, 1)],
    passes:
      colorFx(`vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  c.rgb = mix(c.rgb, s, u_amount);`),
  },
  {
    id: 'posterize',
    name: 'Posterise',
    category: 'color',
    description: 'Reduce the number of tonal steps.',
    params: [f('levels', 'Levels', 2, 32, 6, 1)],
    passes: colorFx(`float n = max(2.0, floor(u_levels));
  c.rgb = floor(clamp(c.rgb, 0.0, 1.0) * (n - 1.0) + 0.5) / (n - 1.0);`),
  },
  {
    id: 'threshold',
    name: 'Threshold',
    category: 'color',
    description: 'Pure two-tone image split at a luminance level.',
    params: [
      f('level', 'Level', 0, 1, 0.5),
      f('softness', 'Softness', 0, 0.5, 0.01),
      { key: 'dark', label: 'Dark', type: 'color', default: '#000000' },
      { key: 'light', label: 'Light', type: 'color', default: '#ffffff' },
    ],
    passes: colorFx(`float t = smoothstep(u_level - u_softness, u_level + u_softness + 1e-4, luma(c.rgb));
  c.rgb = mix(u_dark, u_light, t);`),
  },
  {
    id: 'fill',
    name: 'Colour Overlay',
    category: 'color',
    description: 'Flood the layer with a flat colour, keeping its alpha.',
    params: [
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
      f('amount', 'Amount', 0, 1, 1),
    ],
    preview: { color: '#2f7bff', amount: 0.5 },
    passes: colorFx(`c.rgb = mix(c.rgb, u_color, u_amount);`),
  },

  // ── Blur & sharpen ──────────────────────────────────────────────────────
  {
    id: 'gaussianBlur',
    name: 'Gaussian Blur',
    category: 'blur',
    description: 'Smooth, high-quality blur. Stays fast at any radius.',
    params: [f('radius', 'Radius', 0, 200, 12, 0.1, 'px')],
    passes: blurPasses((p, c) => (p.radius as number) * 0.5 * c.px),
  },
  {
    id: 'directionalBlur',
    name: 'Directional Blur',
    category: 'blur',
    description: 'Motion-style blur along an angle.',
    params: [
      { key: 'angle', label: 'Angle', type: 'angle', default: 0 },
      f('distance', 'Distance', 0, 300, 40, 0.1, 'px'),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 d = vec2(cos(u_angle), sin(u_angle)) * u_distance * u_px / u_resolution;
  vec4 acc = vec4(0.0);
  for (int i = -12; i <= 12; i++) acc += src(uv + d * (float(i) / 24.0));
  return acc / 25.0;
}`,
      },
    ],
  },
  {
    id: 'radialBlur',
    name: 'Zoom Blur',
    category: 'blur',
    description: 'Blur that streaks outward from a centre point.',
    params: [
      f('amount', 'Amount', 0, 1, 0.25),
      { key: 'center', label: 'Centre', type: 'point', default: [0.5, 0.5] },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 dir = uv - u_center;
  vec4 acc = vec4(0.0);
  float jitter = hash12(uv * u_resolution) / 24.0;
  for (int i = 0; i < 24; i++) {
    float t = float(i) / 24.0 + jitter;
    acc += src(uv - dir * u_amount * 0.5 * t);
  }
  return acc / 24.0;
}`,
      },
    ],
  },
  {
    id: 'sharpen',
    name: 'Sharpen',
    category: 'blur',
    description: 'Unsharp mask for crisper detail.',
    params: [f('amount', 'Amount', 0, 3, 0.6), f('radius', 'Radius', 0.5, 5, 1, 0.1, 'px')],
    preview: { amount: 2, radius: 4 },
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 o = u_texel * u_radius * u_px;
  vec4 c = src(uv);
  vec4 b = (src(uv + vec2(o.x, 0.0)) + src(uv - vec2(o.x, 0.0)) + src(uv + vec2(0.0, o.y)) + src(uv - vec2(0.0, o.y))
    + src(uv + o) + src(uv - o) + src(uv + vec2(o.x, -o.y)) + src(uv + vec2(-o.x, o.y))) * 0.125;
  return vec4(c.rgb + (c.rgb - b.rgb) * u_amount, c.a);
}`,
      },
    ],
  },
  {
    id: 'clarity',
    name: 'Clarity',
    category: 'blur',
    description: 'Local contrast enhancement that adds punch to mid-tone texture.',
    params: [f('amount', 'Amount', -1, 2, 0.5), f('radius', 'Radius', 5, 120, 40, 0.5, 'px')],
    passes: [
      ...blurPasses((p, c) => (p.radius as number) * 0.5 * c.px),
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 o = orig(uv);
  vec4 b = src(uv);
  return vec4(o.rgb + (o.rgb - b.rgb) * u_amount, o.a);
}`,
      },
    ],
  },
  {
    id: 'tiltShift',
    name: 'Tilt-Shift',
    category: 'blur',
    description: 'Keep a horizontal band sharp and blur the rest for a miniature look.',
    params: [
      f('position', 'Position', 0, 1, 0.5),
      f('range', 'Range', 0, 1, 0.25),
      f('falloff', 'Falloff', 0.01, 1, 0.3),
      f('blur', 'Blur', 0, 60, 16, 0.1, 'px'),
    ],
    passes: [
      ...downsamplePasses(tiltScale, MIN_TILT_SCALE),
      { glsl: TILT_BLUR_GLSL, scale: tiltScale, uniforms: () => ({ u_dir: [1, 0] }) },
      { glsl: TILT_BLUR_GLSL, scale: tiltScale, uniforms: () => ({ u_dir: [0, 1] }) },
      {
        glsl: TILT_MERGE_GLSL,
        uniforms: (p, c) => ({ u_blurScale: tiltScale(p, c) }),
        skip: (p, c) => tiltScale(p, c) === 1,
      },
    ],
  },

  // ── Light ───────────────────────────────────────────────────────────────
  {
    id: 'glow',
    name: 'Glow',
    category: 'light',
    description: 'Bloom that makes highlights bleed light.',
    params: [
      f('threshold', 'Threshold', 0, 1, 0.6),
      f('radius', 'Radius', 1, 200, 40, 0.5, 'px'),
      f('intensity', 'Intensity', 0, 4, 1),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float k = smoothstep(u_threshold, u_threshold + 0.25, luma(c.rgb));
  return c * k;
}`,
      },
      ...blurPasses((p, c) => (p.radius as number) * 0.5 * c.px),
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 o = orig(uv);
  vec4 g = src(uv) * u_intensity;
  return vec4(o.rgb + g.rgb, clamp(max(o.a, g.a), 0.0, 1.0));
}`,
      },
    ],
  },
  {
    id: 'vignette',
    name: 'Vignette',
    category: 'light',
    description: 'Darken (or tint) the edges of the frame.',
    params: [
      f('amount', 'Amount', 0, 1, 0.5),
      f('size', 'Size', 0, 1, 0.45),
      f('softness', 'Softness', 0.01, 1, 0.5),
      f('roundness', 'Roundness', 0, 1, 0.5),
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec2 p = (uv - 0.5) * 2.0;
  float ax = mix(1.0, u_aspect, u_roundness);
  p.x *= ax;
  float d = length(p) / length(vec2(ax, 1.0));
  float v = smoothstep(u_size, u_size + u_softness, d) * u_amount;
  return vec4(mix(c.rgb, u_color * c.a, v), c.a);
}`,
      },
    ],
  },
  {
    id: 'lightLeak',
    name: 'Light Leak',
    category: 'light',
    description: 'Drifting warm light that washes across the frame.',
    params: [
      f('amount', 'Amount', 0, 1, 0.6),
      f('speed', 'Speed', 0, 4, 1),
      { key: 'color', label: 'Colour', type: 'color', default: '#ff7a2e' },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float t = u_time * u_speed;
  float n = fbm(uv * vec2(1.4, 0.9) + vec2(t * 0.12, -t * 0.05) + u_seed);
  float m = smoothstep(0.38, 0.85, fbm(uv * vec2(0.9, 0.6) + vec2(-t * 0.08, t * 0.04) + 3.7 + u_seed));
  vec3 leak = mix(u_color, vec3(1.0, 0.85, 0.5), n) * m * u_amount;
  vec3 rgb = c.rgb + leak * c.a * (1.0 - clamp(c.rgb, 0.0, 1.0) * 0.6);
  return vec4(rgb, c.a);
}`,
      },
    ],
  },

  // ── Stylise ─────────────────────────────────────────────────────────────
  {
    id: 'filmGrain',
    name: 'Film Grain',
    category: 'stylize',
    description: 'Organic animated grain, strongest in the mid-tones.',
    params: [
      f('amount', 'Amount', 0, 1, 0.25),
      f('size', 'Size', 0.5, 6, 1.5, 0.1, 'px'),
      { key: 'colored', label: 'Chromatic', type: 'bool', default: false },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec2 g = floor(uv * u_resolution / max(u_size * u_px, 1.0));
  float fr = floor(u_frame) + u_seed * 97.0;
  vec3 n = vec3(hash12(g + fr * 1.37), hash12(g + 31.7 + fr * 2.11), hash12(g + 71.3 + fr * 0.73)) - 0.5;
  n = mix(vec3(n.r), n, u_colored);
  float l = clamp(luma(c.rgb) / max(c.a, 1e-4), 0.0, 1.0);
  float weight = 1.0 - abs(l * 2.0 - 1.0) * 0.6;
  return vec4(c.rgb + n * u_amount * 0.5 * weight * c.a, c.a);
}`,
      },
    ],
  },
  {
    id: 'chromaticAberration',
    name: 'Chromatic Aberration',
    category: 'stylize',
    description: 'Lens-style colour fringing that grows toward the edges.',
    params: [f('amount', 'Amount', 0, 5, 1)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 d = (uv - 0.5) * u_amount * 0.02;
  vec4 r = src(uv + d);
  vec4 g = src(uv);
  vec4 b = src(uv - d);
  return vec4(r.r, g.g, b.b, max(g.a, (r.a + b.a) * 0.5));
}`,
      },
    ],
  },
  {
    id: 'rgbSplit',
    name: 'RGB Split',
    category: 'stylize',
    description: 'Offset the colour channels in a chosen direction.',
    params: [
      f('distance', 'Distance', 0, 100, 10, 0.1, 'px'),
      { key: 'angle', label: 'Angle', type: 'angle', default: 0 },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 o = vec2(cos(u_angle), sin(u_angle)) * u_distance * u_px / u_resolution;
  vec4 r = src(uv + o);
  vec4 g = src(uv);
  vec4 b = src(uv - o);
  return vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
      },
    ],
  },
  {
    id: 'glitch',
    name: 'Glitch',
    category: 'stylize',
    description: 'Digital signal corruption: slice displacement, channel tearing and block swaps.',
    params: [f('amount', 'Amount', 0, 1, 0.5), f('speed', 'Speed', 0, 1, 0.5)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  float t = floor(u_time * (4.0 + u_speed * 20.0)) + u_seed * 13.0;
  float rowH = mix(0.02, 0.2, hash11(t + 1.0));
  float row = floor(uv.y / rowH);
  float n = hash12(vec2(row, t));
  float on = step(1.0 - u_amount * 0.6, n);
  float shift = (hash12(vec2(row + 7.0, t)) - 0.5) * 0.25 * u_amount * on;
  vec2 p = vec2(uv.x + shift, uv.y);
  float ca = 0.006 * u_amount * (0.5 + hash11(t));
  vec4 r = src(p + vec2(ca, 0.0));
  vec4 g = src(p);
  vec4 b = src(p - vec2(ca, 0.0));
  vec4 c = vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
  vec2 blk = floor(uv * vec2(8.0, 6.0));
  float bn = hash12(blk + t * 3.1);
  if (bn > 1.0 - u_amount * 0.08) c.rgb = c.gbr;
  return c;
}`,
      },
    ],
  },
  {
    id: 'pixelate',
    name: 'Pixelate',
    category: 'stylize',
    description: 'Mosaic of large square pixels.',
    params: [f('size', 'Block size', 1, 200, 16, 1, 'px')],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 s = max(u_size * u_px, 1.0) / u_resolution;
  return src((floor(uv / s) + 0.5) * s);
}`,
      },
    ],
  },
  {
    id: 'halftone',
    name: 'Halftone',
    category: 'stylize',
    description: 'Print-style dot screen.',
    params: [
      f('size', 'Dot size', 2, 60, 8, 0.5, 'px'),
      { key: 'angle', label: 'Angle', type: 'angle', default: 45 },
      { key: 'ink', label: 'Ink', type: 'color', default: '#111111' },
      { key: 'paper', label: 'Paper', type: 'color', default: '#f5f1e8' },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  float s = max(u_size * u_px, 2.0);
  vec2 p = rot2(u_angle) * (uv * u_resolution);
  vec2 cell = (floor(p / s) + 0.5) * s;
  vec2 cuv = (rot2(-u_angle) * cell) / u_resolution;
  vec4 c = unpremul(src(cuv));
  float l = clamp(luma(c.rgb), 0.0, 1.0);
  float r = sqrt(1.0 - l) * s * 0.72;
  float k = 1.0 - smoothstep(r - 1.0, r + 1.0, length(p - cell));
  float a = src(uv).a;
  return vec4(mix(u_paper, u_ink, k) * a, a);
}`,
      },
    ],
  },
  {
    id: 'edges',
    name: 'Edge Detect',
    category: 'stylize',
    description: 'Sobel outlines; blend to taste for a sketch look.',
    params: [
      f('strength', 'Strength', 0, 8, 2),
      f('mix', 'Mix', 0, 1, 1),
      { key: 'invert', label: 'Invert', type: 'bool', default: false },
    ],
    passes: [
      {
        glsl: `float lm(vec2 uv) { return luma(src(uv).rgb); }
vec4 effect(vec2 uv) {
  vec2 o = u_texel * u_px;
  float tl = lm(uv + vec2(-o.x, -o.y)); float tc = lm(uv + vec2(0.0, -o.y)); float tr = lm(uv + vec2(o.x, -o.y));
  float ml = lm(uv + vec2(-o.x, 0.0)); float mr = lm(uv + vec2(o.x, 0.0));
  float bl = lm(uv + vec2(-o.x, o.y)); float bc = lm(uv + vec2(0.0, o.y)); float br = lm(uv + vec2(o.x, o.y));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  float e = clamp(length(vec2(gx, gy)) * u_strength, 0.0, 1.0);
  e = mix(e, 1.0 - e, u_invert);
  vec4 c = src(uv);
  return vec4(mix(c.rgb, vec3(e) * c.a, u_mix), c.a);
}`,
      },
    ],
  },
  {
    id: 'emboss',
    name: 'Emboss',
    category: 'stylize',
    description: 'Raised relief shading.',
    params: [
      f('strength', 'Strength', 0, 6, 2),
      { key: 'angle', label: 'Angle', type: 'angle', default: 135 },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 o = vec2(cos(u_angle), sin(u_angle)) * u_texel * u_px;
  vec4 c = src(uv);
  float d = luma(src(uv + o).rgb) - luma(src(uv - o).rgb);
  return vec4(vec3(0.5 + d * u_strength) * c.a, c.a);
}`,
      },
    ],
  },
  {
    id: 'outline',
    name: 'Outline',
    category: 'stylize',
    description: 'Stroke around the layer silhouette — a quick border for picture-in-picture.',
    space: 'frame',
    params: [
      f('width', 'Width', 0, 60, 6, 0.1, 'px'),
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
      f('opacity', 'Opacity', 0, 1, 1),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 o = src(uv);
  float a = 0.0;
  vec2 r = u_width * u_px / u_resolution;
  for (int i = 0; i < 24; i++) {
    float ang = float(i) * 0.2617993878;
    vec2 d = vec2(cos(ang), sin(ang));
    a = max(a, src(uv + d * r).a);
    a = max(a, src(uv + d * r * 0.5).a);
  }
  vec4 st = vec4(u_color, 1.0) * clamp(a, 0.0, 1.0) * u_opacity;
  return o + st * (1.0 - o.a);
}`,
      },
    ],
  },
  {
    id: 'dropShadow',
    name: 'Drop Shadow',
    category: 'stylize',
    description: 'Soft shadow cast behind the layer.',
    space: 'frame',
    params: [
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
      f('opacity', 'Opacity', 0, 1, 0.6),
      { key: 'angle', label: 'Angle', type: 'angle', default: 45 },
      f('distance', 'Distance', 0, 200, 16, 0.1, 'px'),
      f('blur', 'Softness', 0, 200, 24, 0.1, 'px'),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 off = vec2(cos(u_angle), sin(u_angle)) * u_distance * u_px / u_resolution;
  float a = srcT(uv - off).a * u_opacity;
  return vec4(u_color * a, a);
}`,
      },
      ...blurPasses((p, c) => (p.blur as number) * 0.5 * c.px),
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 s = src(uv);
  vec4 o = orig(uv);
  return o + s * (1.0 - o.a);
}`,
      },
    ],
  },
  {
    id: 'roundCorners',
    name: 'Round Corners',
    category: 'stylize',
    description: 'Clip the layer to a rounded rectangle.',
    params: [f('radius', 'Radius', 0, 1, 0.12), f('feather', 'Feather', 0, 0.2, 0)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 half_ = vec2(u_aspect, 1.0) * 0.5;
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float r = u_radius * min(half_.x, half_.y);
  vec2 q = abs(p) - half_ + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float aa = max(u_feather * 0.5, 1.5 / u_resolution.y);
  return src(uv) * (1.0 - smoothstep(-aa, aa * 0.25, d));
}`,
      },
    ],
  },

  // ── Retro ───────────────────────────────────────────────────────────────
  {
    id: 'vhs',
    name: 'VHS',
    category: 'retro',
    description: 'Tape wobble, chroma bleed, tracking noise and scanlines.',
    params: [f('amount', 'Amount', 0, 1, 0.6)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  float t = u_time + u_seed * 10.0;
  float wob = (vnoise(vec2(uv.y * 40.0, t * 6.0)) - 0.5) * 0.004 * u_amount;
  float roll = fract(t * 0.11);
  float bandK = 1.0 - smoothstep(0.0, 0.05, abs(uv.y - roll));
  vec2 p = vec2(uv.x + wob + bandK * 0.02 * u_amount * sin(uv.y * 200.0 + t * 30.0), uv.y);
  float ca = 0.004 * u_amount;
  vec4 cr = src(p + vec2(ca, 0.0));
  vec4 cg = src(p);
  vec4 cb = src(p - vec2(ca * 1.5, 0.0));
  vec3 col = vec3(cr.r, cg.g, cb.b);
  float lines = u_resolution.y / max(u_px, 0.5) / 4.0;
  col *= 1.0 - 0.14 * u_amount * (0.5 + 0.5 * sin(uv.y * lines * 6.28318));
  col += (hash12(uv * u_resolution + floor(t * 60.0)) - 0.5) * 0.12 * u_amount * cg.a;
  col += bandK * 0.1 * u_amount * hash12(vec2(floor(uv.x * 120.0), floor(t * 60.0))) * cg.a;
  float l = luma(col);
  col = mix(col, vec3(l), 0.18 * u_amount);
  col = col * (1.0 - 0.06 * u_amount) + 0.03 * u_amount * cg.a;
  return vec4(col, cg.a);
}`,
      },
    ],
  },
  {
    id: 'scanlines',
    name: 'Scanlines',
    category: 'retro',
    description: 'Horizontal display lines.',
    params: [f('count', 'Lines', 50, 1200, 360, 1), f('opacity', 'Opacity', 0, 1, 0.3)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float s = 0.5 + 0.5 * sin(uv.y * u_count * 6.28318);
  return vec4(c.rgb * (1.0 - u_opacity * s), c.a);
}`,
      },
    ],
  },
  {
    id: 'crt',
    name: 'CRT Monitor',
    category: 'retro',
    description: 'Curved glass, phosphor mask and scanlines of an old tube display.',
    params: [
      f('curvature', 'Curvature', 0, 1, 0.35),
      f('scanlines', 'Scanlines', 0, 1, 0.4),
      f('mask', 'Phosphors', 0, 1, 0.3),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  vec2 off = p.yx * p.yx * u_curvature * 0.18;
  p += p * off;
  vec2 q = p * 0.5 + 0.5;
  vec4 c = srcT(q);
  float sl = 0.5 + 0.5 * sin(q.y * u_resolution.y / max(u_px, 0.5) * 3.14159 / 1.5);
  c.rgb *= 1.0 - u_scanlines * 0.45 * sl;
  float m = mod(floor(gl_FragCoord.x / max(u_px, 1.0)), 3.0);
  vec3 mask = vec3(m == 0.0 ? 1.0 : 0.0, m == 1.0 ? 1.0 : 0.0, m == 2.0 ? 1.0 : 0.0);
  c.rgb *= mix(vec3(1.0), 0.6 + mask * 0.8, u_mask);
  float v = 1.0 - 0.35 * u_curvature * dot(p, p);
  c.rgb *= clamp(v, 0.0, 1.0);
  return c;
}`,
      },
    ],
  },
  {
    id: 'noise',
    name: 'Static Noise',
    category: 'retro',
    description: 'Television snow.',
    params: [
      f('amount', 'Amount', 0, 1, 0.3),
      { key: 'colored', label: 'Chromatic', type: 'bool', default: false },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  vec2 g = floor(uv * u_resolution / max(u_px, 1.0));
  float fr = floor(u_frame) + u_seed * 53.0;
  vec3 n = vec3(hash12(g + fr), hash12(g + 17.0 + fr * 1.7), hash12(g + 43.0 + fr * 2.3));
  n = mix(vec3(n.r), n, u_colored);
  return vec4(mix(c.rgb, n * c.a, u_amount), c.a);
}`,
      },
    ],
  },
  {
    id: 'oldFilm',
    name: 'Old Film',
    category: 'retro',
    description: 'Projector flicker, dust, scratches and faded stock.',
    params: [f('amount', 'Amount', 0, 1, 0.7), f('sepia', 'Toning', 0, 1, 0.6)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float fr = floor(u_time * 18.0) + u_seed * 31.0;
  vec3 rgb = c.rgb;
  float l = luma(rgb);
  vec3 sep = vec3(l * 1.07, l * 0.95, l * 0.74);
  rgb = mix(rgb, sep, u_sepia);
  rgb *= 1.0 - u_amount * 0.12 * hash11(fr);
  float sx = hash11(fr * 1.31);
  float scratch = (1.0 - smoothstep(0.0, 0.0015, abs(uv.x - sx))) * step(0.7, hash11(fr * 0.73));
  rgb += scratch * 0.35 * u_amount * c.a;
  vec2 dp = uv - hash22(vec2(fr, 3.0));
  dp.x *= u_aspect;
  float dust = (1.0 - smoothstep(0.002, 0.006, length(dp))) * step(0.5, hash11(fr * 2.17));
  rgb *= 1.0 - dust * 0.8 * u_amount;
  rgb += (hash12(uv * u_resolution / max(u_px, 1.0) + fr) - 0.5) * 0.18 * u_amount * c.a;
  vec2 p = (uv - 0.5) * 2.0;
  rgb *= 1.0 - u_amount * 0.35 * smoothstep(0.5, 1.5, length(p));
  return vec4(rgb, c.a);
}`,
      },
    ],
  },

  // ── Distort ─────────────────────────────────────────────────────────────
  {
    id: 'mirror',
    name: 'Mirror',
    category: 'distort',
    description: 'Reflect one half of the picture onto the other.',
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        default: 'left',
        options: [
          { value: 'left', label: 'Left → right' },
          { value: 'right', label: 'Right → left' },
          { value: 'top', label: 'Top → bottom' },
          { value: 'bottom', label: 'Bottom → top' },
          { value: 'quad', label: 'Four-way' },
        ],
      },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv;
  if (u_mode < 0.5) { if (p.x > 0.5) p.x = 1.0 - p.x; }
  else if (u_mode < 1.5) { if (p.x < 0.5) p.x = 1.0 - p.x; }
  else if (u_mode < 2.5) { if (p.y > 0.5) p.y = 1.0 - p.y; }
  else if (u_mode < 3.5) { if (p.y < 0.5) p.y = 1.0 - p.y; }
  else { p = 0.5 - abs(p - 0.5); }
  return src(p);
}`,
      },
    ],
  },
  {
    id: 'kaleidoscope',
    name: 'Kaleidoscope',
    category: 'distort',
    description: 'Radial mirror symmetry.',
    params: [
      f('segments', 'Segments', 2, 24, 6, 1),
      { key: 'angle', label: 'Rotation', type: 'angle', default: 0 },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv - 0.5;
  p.x *= u_aspect;
  float a = atan(p.y, p.x) + u_angle;
  float r = length(p);
  float seg = 6.28318530718 / max(2.0, floor(u_segments));
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  p = r * vec2(cos(a), sin(a));
  p.x /= u_aspect;
  vec2 q = p + 0.5;
  q = 1.0 - abs(1.0 - mod(q, 2.0));
  return src(q);
}`,
      },
    ],
  },
  {
    id: 'lensDistortion',
    name: 'Lens Distortion',
    category: 'distort',
    description: 'Barrel or pincushion warp, like a fisheye or a long lens.',
    params: [f('amount', 'Amount', -1, 1, 0.3), f('zoom', 'Zoom', 0.5, 2, 1)],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = (uv - 0.5) * 2.0;
  p.x *= u_aspect;
  float r2 = dot(p, p) / (u_aspect * u_aspect + 1.0);
  p *= (1.0 + u_amount * r2) / u_zoom;
  p.x /= u_aspect;
  return srcT(p * 0.5 + 0.5);
}`,
      },
    ],
  },
  {
    id: 'wave',
    name: 'Wave',
    category: 'distort',
    description: 'Animated sine-wave ripple.',
    params: [
      f('amplitude', 'Amplitude', 0, 1, 0.2),
      f('frequency', 'Frequency', 0.5, 30, 4, 0.1),
      f('speed', 'Speed', -10, 10, 2, 0.1),
      { key: 'vertical', label: 'Vertical', type: 'bool', default: false },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv;
  float ph = u_time * u_speed;
  if (u_vertical > 0.5) p.y += sin(uv.x * u_frequency * 6.28318 + ph) * u_amplitude * 0.1;
  else p.x += sin(uv.y * u_frequency * 6.28318 + ph) * u_amplitude * 0.1;
  return srcT(p);
}`,
      },
    ],
  },
  {
    id: 'swirl',
    name: 'Swirl',
    category: 'distort',
    description: 'Twist the image around a point.',
    params: [
      { key: 'angle', label: 'Twist', type: 'angle', default: 180 },
      f('radius', 'Radius', 0.05, 1.5, 0.5),
      { key: 'center', label: 'Centre', type: 'point', default: [0.5, 0.5] },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv - u_center;
  p.x *= u_aspect;
  float k = max(0.0, 1.0 - length(p) / u_radius);
  p = rot2(u_angle * k * k) * p;
  p.x /= u_aspect;
  return srcT(p + u_center);
}`,
      },
    ],
  },
  {
    id: 'bulge',
    name: 'Bulge / Pinch',
    category: 'distort',
    description: 'Magnify or pinch a circular region.',
    params: [
      f('strength', 'Strength', -1, 1, 0.5),
      f('radius', 'Radius', 0.05, 1.5, 0.4),
      { key: 'center', label: 'Centre', type: 'point', default: [0.5, 0.5] },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv - u_center;
  p.x *= u_aspect;
  float r = length(p) / u_radius;
  if (r < 1.0) {
    float e = u_strength > 0.0 ? 1.0 + u_strength * 1.5 : 1.0 / (1.0 - u_strength * 1.5);
    float w = pow(r, e) / max(r, 1e-4);
    p *= mix(w, 1.0, smoothstep(0.6, 1.0, r));
  }
  p.x /= u_aspect;
  return srcT(p + u_center);
}`,
      },
    ],
  },
  {
    id: 'tile',
    name: 'Tile',
    category: 'distort',
    description: 'Repeat the picture in a grid.',
    params: [
      f('count', 'Tiles', 1, 12, 2, 1),
      { key: 'mirror', label: 'Mirror edges', type: 'bool', default: false },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv * max(1.0, floor(u_count));
  vec2 q = u_mirror > 0.5 ? 1.0 - abs(1.0 - mod(p, 2.0)) : fract(p);
  return src(q);
}`,
      },
    ],
  },
  {
    id: 'shake',
    name: 'Camera Shake',
    category: 'distort',
    description: 'Handheld jitter with a little rotation.',
    params: [
      f('amplitude', 'Amplitude', 0, 1, 0.3),
      f('speed', 'Speed', 0.1, 20, 6, 0.1),
      f('rotation', 'Rotation', 0, 1, 0.3),
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  float t = u_time * u_speed + u_seed * 20.0;
  vec2 o = (vec2(vnoise(vec2(t, 1.3)), vnoise(vec2(7.1, t))) - 0.5) * u_amplitude * 0.12;
  float a = (vnoise(vec2(t * 0.8, 9.7)) - 0.5) * u_rotation * 0.2;
  vec2 p = uv - 0.5;
  p.x *= u_aspect;
  p = rot2(a) * p;
  p.x /= u_aspect;
  p /= 1.0 + u_amplitude * 0.14 + u_rotation * 0.08;
  return src(p + 0.5 + o);
}`,
      },
    ],
  },

  // ── Keying ──────────────────────────────────────────────────────────────
  {
    id: 'chromaKey',
    name: 'Chroma Key',
    category: 'keying',
    description: 'Remove a green or blue screen, with spill suppression.',
    params: [
      { key: 'color', label: 'Key colour', type: 'color', default: '#00d000' },
      f('similarity', 'Similarity', 0, 1, 0.3),
      f('smoothness', 'Softness', 0, 1, 0.1),
      f('spill', 'Despill', 0, 1, 0.5),
    ],
    preview: { color: '#e0568a', similarity: 0.35 },
    passes: [
      {
        glsl: `vec3 ycc(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.565, (c.r - y) * 0.713);
}
vec4 effect(vec2 uv) {
  vec4 c = unpremul(src(uv));
  vec3 k = ycc(u_color);
  vec3 p = ycc(c.rgb);
  float d = distance(p.yz, k.yz);
  float sim = u_similarity * 0.5;
  float a = smoothstep(sim, sim + u_smoothness * 0.5 + 1e-4, d);
  float sp = 1.0 - smoothstep(sim, sim + u_smoothness * 0.5 + 0.25, d);
  float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb = mix(c.rgb, vec3(y), sp * u_spill);
  c.a *= a;
  return premul(c);
}`,
      },
    ],
  },
  {
    id: 'lumaKey',
    name: 'Luma Key',
    category: 'keying',
    description: 'Make dark (or bright) areas transparent.',
    params: [
      f('threshold', 'Threshold', 0, 1, 0.2),
      f('softness', 'Softness', 0, 0.5, 0.1),
      { key: 'invert', label: 'Invert', type: 'bool', default: false },
    ],
    passes:
      colorFx(`float a = smoothstep(u_threshold - u_softness, u_threshold + u_softness + 1e-4, luma(c.rgb));
  a = mix(a, 1.0 - a, u_invert);
  c.a *= a;`),
  },

  // ── Utility ─────────────────────────────────────────────────────────────
  {
    id: 'letterbox',
    name: 'Letterbox',
    category: 'utility',
    description: 'Cinematic bars for a target aspect ratio.',
    space: 'frame',
    params: [
      f('ratio', 'Aspect ratio', 1, 3, 2.39),
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
    ],
    passes: [
      {
        glsl: `vec4 effect(vec2 uv) {
  vec4 c = src(uv);
  float bar = 0.0;
  if (u_ratio > u_aspect) {
    float h = (1.0 - u_aspect / u_ratio) * 0.5;
    bar = step(uv.y, h) + step(1.0 - h, uv.y);
  } else {
    float w = (1.0 - u_ratio / u_aspect) * 0.5;
    bar = step(uv.x, w) + step(1.0 - w, uv.x);
  }
  bar = clamp(bar, 0.0, 1.0);
  return mix(c, vec4(u_color, 1.0), bar);
}`,
      },
    ],
  },
];

const EFFECT_INDEX = new Map(EFFECTS.map((e) => [e.id, e]));

export const getEffectDef = (id: string): EffectDef | undefined => EFFECT_INDEX.get(id);

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3)
    h = h
      .split('')
      .map((ch) => ch + ch)
      .join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function defaultParams(defs: ParamDef[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const d of defs) out[d.key] = Array.isArray(d.default) ? [...d.default] : d.default;
  return out;
}

/** The parameters an effect's library thumbnail is rendered with. */
export function previewParams(def: EffectDef): Record<string, ParamValue> {
  return { ...defaultParams(def.params), ...def.preview };
}

export function makeEffect(type: string): EffectInstance {
  const def = getEffectDef(type);
  return { id: newId(8), type, enabled: true, params: def ? defaultParams(def.params) : {} };
}

/**
 * Convert stored parameter values to uniform-ready numbers.
 * `numeric(key, fallback)` lets the caller substitute keyframed values.
 */
export function resolveParams(
  defs: ParamDef[],
  values: Record<string, ParamValue>,
  numeric?: (key: string, fallback: number) => number,
): ResolvedParams {
  const out: ResolvedParams = {};
  for (const d of defs) {
    const raw = values[d.key] ?? d.default;
    switch (d.type) {
      case 'float': {
        const base = typeof raw === 'number' ? raw : d.default;
        out[d.key] = numeric ? numeric(d.key, base) : base;
        break;
      }
      case 'angle': {
        const base = typeof raw === 'number' ? raw : d.default;
        out[d.key] = ((numeric ? numeric(d.key, base) : base) * Math.PI) / 180;
        break;
      }
      case 'bool':
        out[d.key] = raw ? 1 : 0;
        break;
      case 'color':
        out[d.key] = hexToRgb(typeof raw === 'string' ? raw : d.default);
        break;
      case 'select': {
        const idx = d.options.findIndex((o) => o.value === raw);
        out[d.key] = idx < 0 ? 0 : idx;
        break;
      }
      case 'point':
        out[d.key] = Array.isArray(raw) && raw.length >= 2 ? [raw[0], raw[1]] : d.default;
        break;
    }
  }
  return out;
}

/** GLSL uniform declarations for a parameter schema. */
export function paramUniformDecls(defs: ParamDef[]): string {
  return defs
    .map((d) => {
      const t = d.type === 'color' ? 'vec3' : d.type === 'point' ? 'vec2' : 'float';
      return `uniform ${t} u_${d.key};`;
    })
    .join('\n');
}
