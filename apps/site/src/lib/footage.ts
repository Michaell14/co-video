/**
 * Stand-in footage. Nothing on this site is a photograph or a video file: every "shot" is the
 * fragment shader below (a coastline at different times of day) rendered live in the hero viewer
 * and once, as stills, for thumbnails, effect tiles and the grading demo.
 */
import { createQuad, getGL, loseContext } from './gl';
import type { GL, Quad } from './gl';

type RGB = readonly [number, number, number];

export interface Shot {
  /** File-style name shown in the mock editor. */
  name: string;
  seed: number;
  skyTop: RGB;
  skyLow: RGB;
  sun: RGB;
  far: RGB;
  near: RGB;
  /** Sun position in 0…1 picture space, y up. */
  sunPos: readonly [number, number];
  /** CSS stand-in used before the still is rendered, or when WebGL is unavailable. */
  css: string;
}

const mix3 = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function shot(
  name: string,
  seed: number,
  colors: { skyTop: string; skyLow: string; sun: string; far: string; near: string },
  sunPos: readonly [number, number],
): Shot {
  const { skyTop, skyLow, sun, far, near } = colors;
  return {
    name,
    seed,
    skyTop: hex(skyTop),
    skyLow: hex(skyLow),
    sun: hex(sun),
    far: hex(far),
    near: hex(near),
    sunPos,
    css:
      `radial-gradient(60% 70% at ${sunPos[0] * 100}% ${(1 - sunPos[1]) * 100}%, ${sun}cc, transparent 60%), ` +
      `linear-gradient(180deg, ${skyTop} 0%, ${skyLow} 62%, ${far} 66%, ${near} 100%)`,
  };
}

export const SHOTS: readonly Shot[] = [
  shot(
    'Shore_A001.mov',
    1.3,
    { skyTop: '#141a3c', skyLow: '#ff8f55', sun: '#ffe2b0', far: '#6a4a6e', near: '#0c0b16' },
    [0.62, 0.41],
  ),
  shot(
    'Cliffs_A007.mov',
    4.7,
    { skyTop: '#070b24', skyLow: '#c8648c', sun: '#ffb9a6', far: '#33437a', near: '#060814' },
    [0.3, 0.35],
  ),
  shot(
    'Mist_A012.mov',
    7.9,
    { skyTop: '#7f9bb8', skyLow: '#f4d2b4', sun: '#fff3dc', far: '#9db0ba', near: '#24323b' },
    [0.5, 0.53],
  ),
  shot(
    'Golden_B003.mov',
    11.2,
    { skyTop: '#23486e', skyLow: '#ffc266', sun: '#fff6cf', far: '#b0733f', near: '#1c1109' },
    [0.74, 0.44],
  ),
  shot(
    'Drone_04.mov',
    15.6,
    { skyTop: '#04262c', skyLow: '#6fd3c0', sun: '#eafff6', far: '#237a7c', near: '#031318' },
    [0.38, 0.47],
  ),
];

/** Look adjustments applied in the shader (the hero's colour-wheel cursor drives these). */
export interface Grade {
  /** Per-channel gamma push, roughly −0.5…0.5. */
  tint: RGB;
  saturation: number;
  /** 0 = finished look, 1 = flat, low-contrast "ungraded" look. */
  flat: number;
}

export const NEUTRAL_GRADE: Grade = { tint: [0, 0, 0], saturation: 1, flat: 0 };

const FOOTAGE_FRAG = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform float u_time;
uniform float u_aspect;
uniform float u_seed;
uniform vec3 u_skyTop;
uniform vec3 u_skyLow;
uniform vec3 u_sun;
uniform vec3 u_far;
uniform vec3 u_near;
uniform vec2 u_sunPos;
uniform vec3 u_tint;
uniform float u_sat;
uniform float u_flat;

const float HORIZON = 0.34;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Per-pixel film grain wants a hash with no visible lattice at integer coordinates.
float grain(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * noise(p);
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}

// Sky gradient, sun disc with two-stage bloom, and thin lit cloud streaks.
vec3 sky(vec2 p) {
  float h = clamp((p.y - HORIZON) / (1.0 - HORIZON), 0.0, 1.0);
  vec3 c = mix(u_skyLow, u_skyTop, pow(h, 0.58));
  vec2 d = (p - u_sunPos) * vec2(u_aspect, 1.0);
  float r = length(d);
  c += u_sun * (0.5 * exp(-r * 4.5) + 0.4 * exp(-r * 15.0));
  c = mix(c, u_sun * 1.2, smoothstep(0.05, 0.043, r));
  float cl = fbm(vec2(p.x * u_aspect * 1.5 + u_time * 0.012 + u_seed, p.y * 8.0 + u_seed * 2.0));
  cl = smoothstep(0.5, 0.85, cl) * smoothstep(HORIZON + 0.06, HORIZON + 0.45, p.y);
  return mix(c, mix(u_skyLow, u_sun, 0.6), cl * 0.5);
}

// Four headlands, far to near, each a noise ridge that dips around the sun so it stays in frame.
vec3 scene(vec2 p) {
  vec3 c = sky(p);
  for (int i = 0; i < 4; i++) {
    float f = float(i);
    float k = f / 3.0;
    float x = p.x * u_aspect * (0.8 + f * 0.5) + u_seed * (3.1 + f) + u_time * (0.003 + 0.005 * f);
    float gap = 0.25 + 0.75 * smoothstep(0.0, 0.42, abs(p.x - u_sunPos.x) + 0.05 * f);
    float ridge = HORIZON + (0.3 - 0.06 * f) * gap * fbm(vec2(x * 1.3, f * 9.7 + u_seed));
    float m = smoothstep(ridge + 0.004, ridge - 0.002, p.y);
    vec3 land = mix(u_far, u_near, k);
    float haze = (1.0 - k) * 0.55 * smoothstep(ridge, HORIZON, p.y);
    land = mix(land, u_skyLow, haze);
    c = mix(c, land, m);
  }
  return c;
}

void main() {
  // Slow push-in so a held shot never looks frozen.
  float zoom = 1.0 + 0.03 * sin(u_time * 0.11 + u_seed);
  vec2 p = (v_uv - 0.5) / zoom + 0.5;

  vec3 c;
  if (p.y >= HORIZON) {
    c = scene(p);
  } else {
    // Water: the scene mirrored about the horizon, broken up by ripples, darker toward the lens.
    float d = HORIZON - p.y;
    float rip = (noise(vec2(p.x * 36.0, d * 240.0 - u_time * 0.8)) - 0.5) * 0.03 * (0.25 + d * 4.0);
    c = scene(vec2(p.x + rip, HORIZON + d * 1.2 + rip * 0.5));
    c = mix(c, u_near * 0.7 + u_skyLow * 0.06, 0.22 + 0.5 * d / HORIZON);
    float glitter = noise(vec2(p.x * 80.0, d * 420.0 - u_time * 1.6));
    float lane = exp(-abs(p.x - u_sunPos.x) * u_aspect * max(2.5, 11.0 - d * 26.0));
    c += u_sun * smoothstep(0.6, 0.95, glitter) * lane * 0.55 * smoothstep(0.0, 0.02, d);
  }
  c = mix(c, u_skyLow, 0.3 * exp(-abs(p.y - HORIZON) * 70.0));

  // Look: gentle S-curve, optional "flat" profile, per-channel gamma tint, saturation.
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.4);
  c = mix(c, c * 0.56 + 0.2, u_flat);
  c = pow(c, vec3(1.0) / (vec3(1.0) + u_tint));
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, u_sat * (1.0 - 0.4 * u_flat));

  vec2 v = v_uv - 0.5;
  c *= 1.0 - dot(v, v) * 0.75;
  c += (grain(gl_FragCoord.xy + fract(u_time * 7.13) * 91.0) - 0.5) * 0.04;
  gl_FragColor = vec4(c, 1.0);
}`;

const UNIFORMS = [
  'u_time',
  'u_aspect',
  'u_seed',
  'u_skyTop',
  'u_skyLow',
  'u_sun',
  'u_far',
  'u_near',
  'u_sunPos',
  'u_tint',
  'u_sat',
  'u_flat',
] as const;

export interface FootageRenderer {
  render(time: number, shotIndex: number, grade?: Grade): void;
  /** Free GPU resources. The canvas keeps its context and can be bound again. */
  dispose(): void;
  /** Dispose and give the context back to the browser. Only for throwaway canvases. */
  release(): void;
}

/** Bind the footage shader to a canvas. Returns null when WebGL is unavailable. */
export function createFootageRenderer(canvas: HTMLCanvasElement): FootageRenderer | null {
  const gl: GL | null = getGL(canvas);
  if (!gl) return null;
  const quad: Quad<(typeof UNIFORMS)[number]> | null = createQuad(gl, FOOTAGE_FRAG, UNIFORMS);
  if (!quad) return null;
  gl.useProgram(quad.program);
  const u = quad.uniforms;

  return {
    render(time, shotIndex, grade = NEUTRAL_GRADE) {
      const s = SHOTS[shotIndex % SHOTS.length];
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(u.u_time, time);
      gl.uniform1f(u.u_aspect, canvas.width / canvas.height);
      gl.uniform1f(u.u_seed, s.seed);
      gl.uniform3fv(u.u_skyTop, s.skyTop);
      gl.uniform3fv(u.u_skyLow, s.skyLow);
      gl.uniform3fv(u.u_sun, s.sun);
      gl.uniform3fv(u.u_far, s.far);
      gl.uniform3fv(u.u_near, s.near);
      gl.uniform2fv(u.u_sunPos, s.sunPos);
      gl.uniform3fv(u.u_tint, grade.tint);
      gl.uniform1f(u.u_sat, grade.saturation);
      gl.uniform1f(u.u_flat, grade.flat);
      quad.draw();
    },
    dispose() {
      quad.dispose();
    },
    release() {
      quad.dispose();
      loseContext(gl);
    },
  };
}

const STILL_WIDTH = 480;
const STILL_HEIGHT = 270;
/** The grading demo shows its frame large, so that one is rendered at twice the size. */
const FLAT_SCALE = 2;

export interface Stills {
  /** One finished-look frame per shot, as data URLs (also published as `--still-N` on :root). */
  urls: readonly string[];
  /** A flat, ungraded frame for the colour demo to work on. */
  flat: HTMLCanvasElement;
}

/** 2D-canvas approximation of a shot, for browsers without WebGL. */
function paintFallback(ctx: CanvasRenderingContext2D, s: Shot, flat: boolean): void {
  const { width: w, height: h } = ctx.canvas;
  const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  const horizon = h * 0.66;
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horizon);
  skyGrad.addColorStop(0, css(s.skyTop));
  skyGrad.addColorStop(1, css(s.skyLow));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, w, horizon);
  const sunX = s.sunPos[0] * w;
  const sunY = (1 - s.sunPos[1]) * h;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.5);
  glow.addColorStop(0, css(s.sun));
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, horizon);
  for (let layer = 0; layer < 3; layer++) {
    const k = layer / 2;
    ctx.fillStyle = css(mix3(s.far, s.near, k));
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (let x = 0; x <= w; x += 6) {
      const n = Math.sin(x * 0.011 * (layer + 1) + s.seed * (layer + 2)) + Math.sin(x * 0.027 + s.seed) * 0.5;
      ctx.lineTo(x, horizon - (0.16 - layer * 0.04) * h * (0.55 + 0.3 * n));
    }
    ctx.lineTo(w, horizon);
    ctx.fill();
  }
  const water = ctx.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, css(s.skyLow));
  water.addColorStop(1, css(s.near));
  ctx.fillStyle = water;
  ctx.fillRect(0, horizon, w, h - horizon);
  if (flat) {
    ctx.fillStyle = 'rgba(120,120,120,0.45)';
    ctx.fillRect(0, 0, w, h);
  }
}

function renderStills(): Stills {
  const scratch = document.createElement('canvas');
  const renderer = createFootageRenderer(scratch);

  const frame = (index: number, flat: boolean, scale = 1): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = scratch.width = STILL_WIDTH * scale;
    canvas.height = scratch.height = STILL_HEIGHT * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    if (renderer) {
      renderer.render(12 + index * 3.7, index, { ...NEUTRAL_GRADE, flat: flat ? 1 : 0 });
      ctx.drawImage(scratch, 0, 0);
    } else {
      paintFallback(ctx, SHOTS[index], flat);
    }
    return canvas;
  };

  const urls = SHOTS.map((_, i) => frame(i, false).toDataURL('image/jpeg', 0.84));
  const flat = frame(3, true, FLAT_SCALE);
  renderer?.release();

  const root = document.documentElement.style;
  urls.forEach((url, i) => root.setProperty(`--still-${i}`, `url("${url}")`));
  return { urls, flat };
}

/** Publish the CSS stand-ins as `--still-N` straight away, so nothing waits on the shader. */
export function primeStillVars(): void {
  const root = document.documentElement.style;
  SHOTS.forEach((s, i) => root.setProperty(`--still-${i}`, s.css));
}

let stillsPromise: Promise<Stills> | null = null;

/** Render the stills once, off the critical path, and publish them as CSS variables. */
export function loadStills(): Promise<Stills> {
  stillsPromise ??= new Promise<Stills>((resolve) => {
    const run = () => resolve(renderStills());
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 60);
  });
  return stillsPromise;
}
