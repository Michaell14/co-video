/**
 * The transition library. Like effects, transitions are data: a parameter schema and one GLSL body
 * defining `vec4 transition(vec2 uv)` that blends `A(uv)` (outgoing) into `B(uv)` (incoming) as
 * `u_progress` runs 0 → 1. Either side may be fully transparent (a clip fading in from nothing).
 *
 * Adding one is an entry here and nothing in the engine or the editor. The website and README.md
 * say how many there are, though (the "transitions" heading in apps/site/src/sections/Effects.tsx
 * and the feature list): apps/site/test/catalogue.test.ts fails until both give the new number.
 */
import type { ParamDef } from './effects';
import { defaultParams } from './effects';
import type { Transition } from './types';

export type TransitionCategory = 'dissolve' | 'wipe' | 'motion' | 'stylize';

export interface TransitionDef {
  id: string;
  name: string;
  category: TransitionCategory;
  description: string;
  params: ParamDef[];
  glsl: string;
  /** Easing applied to progress before it reaches the shader. */
  ease: 'linear' | 'inOut' | 'out';
}

export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'motion', label: 'Motion' },
  { id: 'stylize', label: 'Stylise' },
];

const f = (key: string, label: string, min: number, max: number, def: number, step = 0.01): ParamDef => ({
  key,
  label,
  type: 'float',
  min,
  max,
  default: def,
  step,
});

const DIRECTION: ParamDef = {
  key: 'direction',
  label: 'Direction',
  type: 'select',
  default: 'left',
  options: [
    { value: 'left', label: 'From right' },
    { value: 'right', label: 'From left' },
    { value: 'up', label: 'From bottom' },
    { value: 'down', label: 'From top' },
  ],
};

const DIR_GLSL = /* glsl */ `
vec2 dirVec() {
  if (u_direction < 0.5) return vec2(1.0, 0.0);
  if (u_direction < 1.5) return vec2(-1.0, 0.0);
  if (u_direction < 2.5) return vec2(0.0, 1.0);
  return vec2(0.0, -1.0);
}`;

export const TRANSITIONS: TransitionDef[] = [
  // ── Dissolve ────────────────────────────────────────────────────────────
  {
    id: 'crossDissolve',
    name: 'Cross Dissolve',
    category: 'dissolve',
    description: 'The classic: one shot melts into the next.',
    ease: 'linear',
    params: [],
    glsl: `vec4 transition(vec2 uv) { return mix(A(uv), B(uv), u_progress); }`,
  },
  {
    id: 'dipToBlack',
    name: 'Dip to Black',
    category: 'dissolve',
    description: 'Fade out to a colour, then in to the next shot.',
    ease: 'linear',
    params: [{ key: 'color', label: 'Colour', type: 'color', default: '#000000' }],
    glsl: `vec4 transition(vec2 uv) {
  vec4 c = vec4(u_color, 1.0);
  return u_progress < 0.5 ? mix(A(uv), c, u_progress * 2.0) : mix(c, B(uv), (u_progress - 0.5) * 2.0);
}`,
  },
  {
    id: 'dipToWhite',
    name: 'Dip to White',
    category: 'dissolve',
    description: 'A bright wash between shots.',
    ease: 'linear',
    params: [{ key: 'color', label: 'Colour', type: 'color', default: '#ffffff' }],
    glsl: `vec4 transition(vec2 uv) {
  vec4 c = vec4(u_color, 1.0);
  return u_progress < 0.5 ? mix(A(uv), c, u_progress * 2.0) : mix(c, B(uv), (u_progress - 0.5) * 2.0);
}`,
  },
  {
    id: 'additiveDissolve',
    name: 'Additive Dissolve',
    category: 'dissolve',
    description: 'A dissolve that blooms brighter through the middle.',
    ease: 'linear',
    params: [],
    glsl: `vec4 transition(vec2 uv) {
  vec4 a = A(uv) * min(1.0, 2.0 * (1.0 - u_progress));
  vec4 b = B(uv) * min(1.0, 2.0 * u_progress);
  vec4 c = a + b;
  c.a = min(c.a, 1.0);
  return c;
}`,
  },
  {
    id: 'blurDissolve',
    name: 'Blur Dissolve',
    category: 'dissolve',
    description: 'Both shots defocus as they cross.',
    ease: 'inOut',
    params: [f('strength', 'Blur', 0, 2, 1)],
    glsl: `vec4 transition(vec2 uv) {
  float r = sin(u_progress * 3.14159265) * u_strength * 0.035;
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float ang = fi * 2.39996323;
    vec2 o = vec2(cos(ang), sin(ang) * u_aspect) * r * sqrt((fi + 0.5) / 24.0);
    a += A(uv + o);
    b += B(uv + o);
  }
  return mix(a, b, u_progress) / 24.0;
}`,
  },
  {
    id: 'lumaFade',
    name: 'Luma Fade',
    category: 'dissolve',
    description: 'The brightest areas of the outgoing shot give way first.',
    ease: 'linear',
    params: [
      f('softness', 'Softness', 0.01, 1, 0.25),
      { key: 'invert', label: 'Darks first', type: 'bool', default: false },
    ],
    glsl: `vec4 transition(vec2 uv) {
  vec4 a = A(uv);
  float l = clamp(luma(a.rgb), 0.0, 1.0);
  l = mix(1.0 - l, l, u_invert);
  float th = u_progress * (1.0 + u_softness) - u_softness;
  float k = smoothstep(th, th + u_softness, l);
  return mix(B(uv), a, k);
}`,
  },
  {
    id: 'noiseDissolve',
    name: 'Grain Dissolve',
    category: 'dissolve',
    description: 'A sparkling, randomised pixel dissolve.',
    ease: 'linear',
    params: [f('size', 'Grain size', 1, 40, 3, 0.5), f('softness', 'Softness', 0, 1, 0.1)],
    glsl: `vec4 transition(vec2 uv) {
  float n = hash12(floor(uv * u_resolution / max(u_size * u_px, 1.0)) + u_seed);
  float th = u_progress * (1.0 + u_softness) - u_softness;
  float k = smoothstep(th, th + u_softness + 1e-4, n);
  return mix(B(uv), A(uv), k);
}`,
  },

  // ── Wipe ────────────────────────────────────────────────────────────────
  {
    id: 'wipe',
    name: 'Linear Wipe',
    category: 'wipe',
    description: 'A line sweeps across the frame at any angle.',
    ease: 'inOut',
    params: [
      { key: 'angle', label: 'Angle', type: 'angle', default: 0 },
      f('softness', 'Softness', 0, 1, 0.05),
    ],
    glsl: `vec4 transition(vec2 uv) {
  vec2 d = vec2(cos(u_angle), sin(u_angle));
  float proj = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
  float edge = u_progress * (1.0 + u_softness) - u_softness;
  float k = smoothstep(edge, edge + u_softness + 1e-4, proj);
  return mix(B(uv), A(uv), k);
}`,
  },
  {
    id: 'iris',
    name: 'Iris',
    category: 'wipe',
    description: 'A circle opens from a point to reveal the next shot.',
    ease: 'inOut',
    params: [
      f('softness', 'Softness', 0, 1, 0.05),
      { key: 'center', label: 'Centre', type: 'point', default: [0.5, 0.5] },
    ],
    glsl: `vec4 transition(vec2 uv) {
  vec2 p = (uv - u_center) * vec2(u_aspect, 1.0);
  float maxR = length(vec2(u_aspect, 1.0) * (0.5 + abs(u_center - 0.5)));
  float r = u_progress * (maxR + u_softness) - u_softness;
  float k = smoothstep(r, r + u_softness + 1e-4, length(p));
  return mix(B(uv), A(uv), k);
}`,
  },
  {
    id: 'clockWipe',
    name: 'Clock Wipe',
    category: 'wipe',
    description: 'A hand sweeps around the dial.',
    ease: 'linear',
    params: [f('softness', 'Softness', 0, 0.5, 0.01)],
    glsl: `vec4 transition(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float a = atan(p.x, -p.y) / 6.28318530718;
  if (a < 0.0) a += 1.0;
  float edge = u_progress * (1.0 + u_softness) - u_softness;
  float k = smoothstep(edge, edge + u_softness + 1e-4, a);
  return mix(B(uv), A(uv), k);
}`,
  },
  {
    id: 'barnDoor',
    name: 'Barn Doors',
    category: 'wipe',
    description: 'Two doors part from the centre.',
    ease: 'inOut',
    params: [
      { key: 'vertical', label: 'Vertical', type: 'bool', default: false },
      f('softness', 'Softness', 0, 1, 0.03),
    ],
    glsl: `vec4 transition(vec2 uv) {
  float d = abs((u_vertical > 0.5 ? uv.y : uv.x) - 0.5) * 2.0;
  float edge = u_progress * (1.0 + u_softness) - u_softness;
  float k = smoothstep(edge, edge + u_softness + 1e-4, d);
  return mix(B(uv), A(uv), k);
}`,
  },
  {
    id: 'blinds',
    name: 'Venetian Blinds',
    category: 'wipe',
    description: 'Slats rotate open.',
    ease: 'linear',
    params: [
      f('count', 'Slats', 2, 40, 10, 1),
      { key: 'vertical', label: 'Vertical', type: 'bool', default: false },
    ],
    glsl: `vec4 transition(vec2 uv) {
  float v = fract((u_vertical > 0.5 ? uv.x : uv.y) * floor(u_count));
  float edge = u_progress * 1.04 - 0.02;
  float k = smoothstep(edge - 0.02, edge + 0.02, v);
  return mix(B(uv), A(uv), k);
}`,
  },

  // ── Motion ──────────────────────────────────────────────────────────────
  {
    id: 'slide',
    name: 'Slide',
    category: 'motion',
    description: 'The incoming shot slides over the top.',
    ease: 'inOut',
    params: [DIRECTION],
    glsl: `${DIR_GLSL}
vec4 transition(vec2 uv) {
  vec4 b = BT(uv - dirVec() * (1.0 - u_progress));
  return b + A(uv) * (1.0 - b.a);
}`,
  },
  {
    id: 'push',
    name: 'Push',
    category: 'motion',
    description: 'The incoming shot shoves the outgoing one off screen.',
    ease: 'inOut',
    params: [DIRECTION],
    glsl: `${DIR_GLSL}
vec4 transition(vec2 uv) {
  vec2 d = dirVec();
  return AT(uv + d * u_progress) + BT(uv + d * (u_progress - 1.0));
}`,
  },
  {
    id: 'whipPan',
    name: 'Whip Pan',
    category: 'motion',
    description: 'A fast, motion-blurred camera swing between shots.',
    ease: 'inOut',
    params: [DIRECTION, f('blur', 'Blur', 0, 2, 1)],
    glsl: `${DIR_GLSL}
vec4 pushed(vec2 uv, float e) {
  vec2 d = dirVec();
  vec2 q = fract(uv + d * e);
  float sel = dot(uv + d * e, abs(d));
  bool second = d.x + d.y > 0.0 ? sel >= 1.0 : sel < 0.0;
  return second ? B(q) : A(q);
}
vec4 transition(vec2 uv) {
  float amt = sin(u_progress * 3.14159265) * 0.25 * u_blur;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    float t = (float(i) / 15.0 - 0.5) * amt;
    acc += pushed(uv, clamp(u_progress + t, 0.0, 1.0));
  }
  return acc / 16.0;
}`,
  },
  {
    id: 'crossZoom',
    name: 'Cross Zoom',
    category: 'motion',
    description: 'Punch in through a zoom blur and land on the next shot.',
    ease: 'inOut',
    params: [f('strength', 'Strength', 0, 2, 1)],
    glsl: `vec4 zoomed(bool second, vec2 uv, float amt) {
  vec2 c = uv - 0.5;
  vec4 acc = vec4(0.0);
  float jitter = hash12(uv * u_resolution) / 16.0;
  for (int i = 0; i < 16; i++) {
    float t = float(i) / 16.0 + jitter;
    vec2 q = 0.5 + c * (1.0 - amt * t);
    acc += second ? B(q) : A(q);
  }
  return acc / 16.0;
}
vec4 transition(vec2 uv) {
  float s = u_strength * 0.6;
  vec4 a = zoomed(false, uv, s * u_progress);
  vec4 b = zoomed(true, uv, s * (1.0 - u_progress));
  return mix(a, b, smoothstep(0.25, 0.75, u_progress));
}`,
  },
  {
    id: 'zoomIn',
    name: 'Zoom In',
    category: 'motion',
    description: 'The incoming shot grows from the centre.',
    ease: 'inOut',
    params: [],
    glsl: `vec4 transition(vec2 uv) {
  float s = max(u_progress, 1e-3);
  vec4 b = BT((uv - 0.5) / s + 0.5) * smoothstep(0.0, 0.3, u_progress);
  vec4 a = A((uv - 0.5) / (1.0 + u_progress * 0.2) + 0.5);
  return b + a * (1.0 - b.a);
}`,
  },
  {
    id: 'spin',
    name: 'Spin',
    category: 'motion',
    description: 'A rotating hand-off between shots.',
    ease: 'inOut',
    params: [{ key: 'angle', label: 'Rotation', type: 'angle', default: 180 }],
    glsl: `vec4 spun(bool second, vec2 uv, float ang, float sc) {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  p = rot2(ang) * p / sc;
  p.x /= u_aspect;
  vec2 q = 1.0 - abs(1.0 - mod(p + 0.5, 2.0));
  return second ? B(q) : A(q);
}
vec4 transition(vec2 uv) {
  float sc = 1.0 - 0.35 * sin(u_progress * 3.14159265);
  vec4 a = spun(false, uv, u_angle * u_progress, sc);
  vec4 b = spun(true, uv, -u_angle * (1.0 - u_progress), sc);
  return mix(a, b, smoothstep(0.35, 0.65, u_progress));
}`,
  },
  {
    id: 'crossWarp',
    name: 'Cross Warp',
    category: 'motion',
    description: 'Both shots stretch through each other.',
    ease: 'linear',
    params: [],
    glsl: `vec4 transition(vec2 uv) {
  float x = smoothstep(0.0, 1.0, u_progress * 2.0 + uv.x - 1.0);
  return mix(A((uv - 0.5) * (1.0 - x) + 0.5), B((uv - 0.5) * x + 0.5), x);
}`,
  },

  // ── Stylise ─────────────────────────────────────────────────────────────
  {
    id: 'glitchCut',
    name: 'Glitch',
    category: 'stylize',
    description: 'A burst of digital corruption on the cut.',
    ease: 'linear',
    params: [f('intensity', 'Intensity', 0, 2, 1)],
    glsl: `vec4 transition(vec2 uv) {
  float amt = sin(u_progress * 3.14159265) * u_intensity;
  float t = floor(u_progress * 14.0) + u_seed * 7.0;
  float rowH = mix(0.03, 0.18, hash11(t));
  float row = floor(uv.y / rowH);
  float n = hash12(vec2(row, t));
  vec2 q = vec2(uv.x + (n - 0.5) * 0.35 * amt * step(0.4, n), uv.y);
  float sw = step(hash12(vec2(row, 3.0 + floor(u_seed))), u_progress);
  float ca = 0.02 * amt;
  vec4 r = mix(A(q + vec2(ca, 0.0)), B(q + vec2(ca, 0.0)), sw);
  vec4 g = mix(A(q), B(q), sw);
  vec4 b = mix(A(q - vec2(ca, 0.0)), B(q - vec2(ca, 0.0)), sw);
  return vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`,
  },
  {
    id: 'pixelize',
    name: 'Pixelise',
    category: 'stylize',
    description: 'Dissolve through a burst of chunky pixels.',
    ease: 'linear',
    params: [f('size', 'Max block size', 4, 200, 60, 1)],
    glsl: `vec4 transition(vec2 uv) {
  float amt = sin(u_progress * 3.14159265);
  float s = mix(1.0, u_size * u_px, amt);
  vec2 cell = s / u_resolution;
  vec2 q = s <= 1.0 ? uv : (floor(uv / cell) + 0.5) * cell;
  return mix(A(q), B(q), smoothstep(0.35, 0.65, u_progress));
}`,
  },
  {
    id: 'flash',
    name: 'Flash',
    category: 'stylize',
    description: 'A camera-flash pop on the cut.',
    ease: 'linear',
    params: [
      f('intensity', 'Intensity', 0, 3, 1.2),
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
    ],
    glsl: `vec4 transition(vec2 uv) {
  float fl = pow(1.0 - abs(u_progress * 2.0 - 1.0), 2.0) * u_intensity;
  vec4 c = mix(A(uv), B(uv), smoothstep(0.4, 0.6, u_progress));
  float a = clamp(c.a + fl, 0.0, 1.0);
  return vec4(c.rgb + u_color * fl, a);
}`,
  },
  {
    id: 'filmBurn',
    name: 'Film Burn',
    category: 'stylize',
    description: 'Hot orange light eats through the frame.',
    ease: 'linear',
    params: [f('intensity', 'Intensity', 0, 3, 1.5)],
    glsl: `vec4 transition(vec2 uv) {
  float n = fbm(uv * vec2(2.2, 1.6) + u_seed * 5.0 + vec2(u_progress * 0.8, 0.0));
  float burn = sin(u_progress * 3.14159265);
  vec4 c = mix(A(uv), B(uv), smoothstep(0.3, 0.7, u_progress + (n - 0.5) * 0.5));
  float m = smoothstep(0.25, 0.9, n + burn * 0.55 - 0.25) * burn;
  vec3 fire = mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.85, 0.45), n);
  return vec4(c.rgb + fire * m * u_intensity, clamp(c.a + m, 0.0, 1.0));
}`,
  },
  {
    id: 'ripple',
    name: 'Ripple',
    category: 'stylize',
    description: 'Concentric waves wash one shot into the next.',
    ease: 'linear',
    params: [f('amplitude', 'Amplitude', 0, 2, 1), f('frequency', 'Frequency', 5, 80, 30, 1)],
    glsl: `vec4 transition(vec2 uv) {
  vec2 dir = uv - 0.5;
  float d = length(dir * vec2(u_aspect, 1.0));
  vec2 off = normalize(dir + 1e-5) * sin(d * u_frequency - u_progress * 20.0) * 0.03 * u_amplitude * sin(u_progress * 3.14159265);
  return mix(A(uv + off), B(uv + off), smoothstep(0.2, 0.8, u_progress));
}`,
  },
  {
    id: 'dreamy',
    name: 'Dreamy',
    category: 'stylize',
    description: 'A soft, wobbling flashback dissolve.',
    ease: 'linear',
    params: [],
    glsl: `vec4 transition(vec2 uv) {
  float w = sin(u_progress * 3.14159265);
  vec2 o = vec2(sin(uv.y * 24.0 + u_progress * 12.0), 0.0) * 0.02 * w;
  vec4 a = A(uv + o);
  vec4 b = B(uv - o);
  vec4 c = mix(a, b, u_progress);
  return vec4(c.rgb * (1.0 + 0.25 * w), c.a);
}`,
  },
];

const INDEX = new Map(TRANSITIONS.map((t) => [t.id, t]));

export const getTransitionDef = (id: string): TransitionDef | undefined => INDEX.get(id);

export function makeTransition(type: string, duration: number): Transition {
  const def = getTransitionDef(type);
  return { type, duration: Math.max(1, Math.round(duration)), params: def ? defaultParams(def.params) : {} };
}

export function easeProgress(kind: TransitionDef['ease'], t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (kind === 'inOut') return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  if (kind === 'out') return 1 - (1 - x) * (1 - x);
  return x;
}
