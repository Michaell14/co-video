/**
 * The grading demo's engine: one fragment shader that applies a small primary grade to a still,
 * plus a readback of the graded pixels for the scope.
 */
import { createQuad, getGL } from '../../lib/gl';
import type { Point } from '../../lib/math';

export interface GradeParams {
  /** Wheel pucks, each −1…1 on both axes. Angle picks the hue, distance the amount. */
  lift: Point;
  gamma: Point;
  gain: Point;
  /** Stops. */
  exposure: number;
  contrast: number;
  saturation: number;
  /** −1 (cool) … 1 (warm). */
  temperature: number;
}

export const NEUTRAL: GradeParams = {
  lift: { x: 0, y: 0 },
  gamma: { x: 0, y: 0 },
  gain: { x: 0, y: 0 },
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
};

const mixPoint = (a: Point, b: Point, u: number): Point => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
});
const mixNum = (a: number, b: number, u: number): number => a + (b - a) * u;

export function mixGrade(a: GradeParams, b: GradeParams, u: number): GradeParams {
  return {
    lift: mixPoint(a.lift, b.lift, u),
    gamma: mixPoint(a.gamma, b.gamma, u),
    gain: mixPoint(a.gain, b.gain, u),
    exposure: mixNum(a.exposure, b.exposure, u),
    contrast: mixNum(a.contrast, b.contrast, u),
    saturation: mixNum(a.saturation, b.saturation, u),
    temperature: mixNum(a.temperature, b.temperature, u),
  };
}

/**
 * A wheel position as a zero-sum RGB offset. Hue runs clockwise from red at the top, matching the
 * conic gradient drawn around each wheel.
 */
function wheelRGB(p: Point, strength: number): [number, number, number] {
  const angle = Math.atan2(p.x, -p.y);
  const amount = Math.min(1, Math.hypot(p.x, p.y)) * strength;
  const third = (Math.PI * 2) / 3;
  return [Math.cos(angle) * amount, Math.cos(angle - third) * amount, Math.cos(angle - 2 * third) * amount];
}

const GRADE_FRAG = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_split; // show the ungraded source left of this x

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 src = texture2D(u_tex, v_uv).rgb;

  // Exposure and white balance belong in linear light.
  vec3 c = pow(src, vec3(2.2));
  c *= exp2(u_exposure);
  c *= vec3(1.0 + 0.35 * u_temperature, 1.0, 1.0 - 0.35 * u_temperature);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));

  // Lift raises the blacks, gain scales the whites, gamma bends what is in between.
  c = c * (1.0 + u_gain) + u_lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / max(1.0 + u_gamma, 0.05));

  // Contrast pivots on mid-grey; saturation pivots on luma.
  c = (c - 0.5) * u_contrast + 0.5;
  c = mix(vec3(dot(c, LUMA)), c, u_saturation);
  c = clamp(c, 0.0, 1.0);

  gl_FragColor = vec4(v_uv.x < u_split ? src : c, 1.0);
}`;

const UNIFORMS = [
  'u_tex',
  'u_lift',
  'u_gamma',
  'u_gain',
  'u_exposure',
  'u_contrast',
  'u_saturation',
  'u_temperature',
  'u_split',
] as const;

/** Size of the readback the scope is built from. */
export const SAMPLE_W = 256;
export const SAMPLE_H = 144;

export interface Grader {
  /**
   * Draw the graded frame. `split` (0…1) shows the source left of that point. Returns the fully
   * graded picture at SAMPLE_W×SAMPLE_H as RGBA bytes, bottom row first.
   */
  render(params: GradeParams, split: number): Uint8Array;
  dispose(): void;
}

export function createGrader(canvas: HTMLCanvasElement, source: HTMLCanvasElement): Grader | null {
  canvas.width = source.width;
  canvas.height = source.height;
  const gl = getGL(canvas, { preserveDrawingBuffer: true });
  if (!gl) return null;
  const quad = createQuad(gl, GRADE_FRAG, UNIFORMS);
  if (!quad) return null;

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.useProgram(quad.program);
  gl.uniform1i(quad.uniforms.u_tex, 0);
  const u = quad.uniforms;
  const pixels = new Uint8Array(SAMPLE_W * SAMPLE_H * 4);

  return {
    render(params, split) {
      gl.uniform3fv(u.u_lift, wheelRGB(params.lift, 0.22));
      gl.uniform3fv(u.u_gamma, wheelRGB(params.gamma, 0.5));
      gl.uniform3fv(u.u_gain, wheelRGB(params.gain, 0.4));
      gl.uniform1f(u.u_exposure, params.exposure);
      gl.uniform1f(u.u_contrast, params.contrast);
      gl.uniform1f(u.u_saturation, params.saturation);
      gl.uniform1f(u.u_temperature, params.temperature);

      // Pass 1: a small, fully graded copy in the corner of the buffer, read back for the scope.
      gl.viewport(0, 0, SAMPLE_W, SAMPLE_H);
      gl.uniform1f(u.u_split, 0);
      quad.draw();
      gl.readPixels(0, 0, SAMPLE_W, SAMPLE_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // Pass 2: the picture itself, drawn over it.
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(u.u_split, split);
      quad.draw();
      return pixels;
    },
    dispose() {
      gl.deleteTexture(texture);
      quad.dispose();
    },
  };
}

export type ScopeMode = 'parade' | 'waveform';

const SCOPE_W = 384;
const SCOPE_H = 160;
const PANEL = SCOPE_W / 3;
const CHANNEL_COLORS = [
  [255, 86, 86],
  [96, 255, 128],
  [92, 150, 255],
] as const;

/** Plot graded pixels as an RGB parade or a luma waveform: x is picture position, y is level. */
export function drawScope(canvas: HTMLCanvasElement, pixels: Uint8Array, mode: ScopeMode): void {
  if (canvas.width !== SCOPE_W) canvas.width = SCOPE_W;
  if (canvas.height !== SCOPE_H) canvas.height = SCOPE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // One hit counter per scope pixel; in parade mode each third of the width is one channel.
  const hits = new Uint16Array(SCOPE_W * SCOPE_H);
  const top = SCOPE_H - 1;
  for (let y = 0; y < SAMPLE_H; y += 2) {
    for (let x = 0; x < SAMPLE_W; x++) {
      const i = (y * SAMPLE_W + x) * 4;
      if (mode === 'parade') {
        const px = Math.floor((x / SAMPLE_W) * (PANEL - 6)) + 3;
        for (let c = 0; c < 3; c++) {
          hits[(top - Math.round((pixels[i + c] / 255) * top)) * SCOPE_W + c * PANEL + px]++;
        }
      } else {
        const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
        hits[(top - Math.round((luma / 255) * top)) * SCOPE_W + Math.floor((x / SAMPLE_W) * SCOPE_W)]++;
      }
    }
  }

  const image = ctx.createImageData(SCOPE_W, SCOPE_H);
  const gain = mode === 'parade' ? 0.11 : 0.2;
  for (let p = 0; p < hits.length; p++) {
    if (hits[p] === 0) continue;
    const level = Math.min(1, hits[p] * gain);
    const color =
      mode === 'parade' ? CHANNEL_COLORS[Math.min(2, Math.floor((p % SCOPE_W) / PANEL))] : [214, 255, 190];
    image.data[p * 4] = color[0];
    image.data[p * 4 + 1] = color[1];
    image.data[p * 4 + 2] = color[2];
    image.data[p * 4 + 3] = Math.round(70 + level * 185);
  }
  ctx.putImageData(image, 0, 0);
}
