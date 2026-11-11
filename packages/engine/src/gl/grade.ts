/** CPU-side helpers for the grade pass: curve baking, wheel maths and .cube LUT parsing. */
import { DEFAULT_GRADE, type CurvePoint, type Grade } from '@tandem/core';

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through curve control points, sampled to `n` values.
 * Monotone splines never overshoot, so a gentle S-curve cannot produce ringing or inverted tones.
 */
export function sampleCurve(points: readonly CurvePoint[], n = 256): Float32Array {
  const out = new Float32Array(n);
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) {
    for (let i = 0; i < n; i++) out[i] = i / (n - 1);
    return out;
  }
  if (pts.length === 1) {
    out.fill(pts[0][1]);
    return out;
  }
  const k = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < k - 1; i++) {
    dx[i] = Math.max(pts[i + 1][0] - pts[i][0], 1e-6);
    slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const m: number[] = new Array(k);
  m[0] = slope[0];
  m[k - 1] = slope[k - 2];
  for (let i = 1; i < k - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < k - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    if (x <= pts[0][0]) {
      out[i] = pts[0][1];
      continue;
    }
    if (x >= pts[k - 1][0]) {
      out[i] = pts[k - 1][1];
      continue;
    }
    while (seg < k - 2 && x > pts[seg + 1][0]) seg++;
    const h = dx[seg];
    const t = (x - pts[seg][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] =
      (2 * t3 - 3 * t2 + 1) * pts[seg][1] +
      (t3 - 2 * t2 + t) * h * m[seg] +
      (-2 * t3 + 3 * t2) * pts[seg + 1][1] +
      (t3 - t2) * h * m[seg + 1];
  }
  return out;
}

const isIdentity = (pts: readonly CurvePoint[]): boolean =>
  pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;

const isFlat = (pts: readonly CurvePoint[]): boolean => pts.every((p) => Math.abs(p[1] - 0.5) < 1e-4);

export function hasRgbCurves(g: Grade): boolean {
  return !(isIdentity(g.curves.m) && isIdentity(g.curves.r) && isIdentity(g.curves.g) && isIdentity(g.curves.b));
}

export function hasHueCurves(g: Grade): boolean {
  return !(isFlat(g.hueSat) && isFlat(g.hueHue) && isFlat(g.lumSat));
}

/**
 * Bake all curves of a grade into a 256×2 RGBA float image:
 *   row 0: master∘red, master∘green, master∘blue
 *   row 1: hue→sat, hue→hue, luma→sat
 */
export function bakeCurves(g: Grade): Float32Array {
  const n = 256;
  const data = new Float32Array(n * 2 * 4);
  const m = sampleCurve(g.curves.m, n);
  const ch = [sampleCurve(g.curves.r, n), sampleCurve(g.curves.g, n), sampleCurve(g.curves.b, n)];
  const lookup = (table: Float32Array, x: number): number => {
    const f = Math.min(Math.max(x, 0), 1) * (n - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, n - 1);
    return table[i] + (table[j] - table[i]) * (f - i);
  };
  const hs = sampleCurve(g.hueSat, n);
  const hh = sampleCurve(g.hueHue, n);
  const ls = sampleCurve(g.lumSat, n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const o = i * 4;
    data[o] = lookup(m, lookup(ch[0], x));
    data[o + 1] = lookup(m, lookup(ch[1], x));
    data[o + 2] = lookup(m, lookup(ch[2], x));
    data[o + 3] = 1;
    const p = (n + i) * 4;
    data[p] = hs[i];
    data[p + 1] = hh[i];
    data[p + 2] = ls[i];
    data[p + 3] = 1;
  }
  return data;
}

/** True when a grade does nothing and the pass can be skipped. */
export function isNeutralGrade(g: Grade | null): boolean {
  if (!g || !g.enabled) return true;
  const d = DEFAULT_GRADE;
  const wheelsNeutral = [g.lift, g.gamma, g.gain, g.offset].every((w) => w.every((v) => v === 0));
  const zonesNeutral = Object.values(g.zones).every((v) => v === 0);
  return (
    g.exposure === d.exposure &&
    g.contrast === d.contrast &&
    g.saturation === d.saturation &&
    g.vibrance === 0 &&
    g.temperature === 0 &&
    g.tint === 0 &&
    g.highlights === 0 &&
    g.shadows === 0 &&
    g.whites === 0 &&
    g.blacks === 0 &&
    g.hue === 0 &&
    wheelsNeutral &&
    zonesNeutral &&
    !hasRgbCurves(g) &&
    !hasHueCurves(g) &&
    !g.lutId
  );
}

/** Uniform values for the wheel / slider part of a grade. */
export function gradeUniforms(g: Grade, lumaW: readonly [number, number, number]): Record<string, number | number[]> {
  // Temperature / tint as luminance-preserving channel gains.
  const wb = [1 + 0.35 * g.temperature, 1 - 0.3 * g.tint, 1 - 0.35 * g.temperature];
  const y = wb[0] * lumaW[0] + wb[1] * lumaW[1] + wb[2] * lumaW[2];
  const wheel = (w: readonly number[], scale: number) => [(w[0] + w[3]) * scale, (w[1] + w[3]) * scale, (w[2] + w[3]) * scale];
  const lift = wheel(g.lift, 0.5);
  const gain = wheel(g.gain, 1).map((v) => 1 + v);
  const offset = wheel(g.offset, 0.5);
  const gamma = wheel(g.gamma, 1).map((v) => Math.pow(2, -v));
  const zones = g.zones;
  return {
    u_exposure: g.exposure,
    u_wb: wb.map((v) => v / y),
    u_contrast: g.contrast,
    u_pivot: g.pivot,
    u_saturation: g.saturation,
    u_vibrance: g.vibrance,
    u_highlights: g.highlights,
    u_shadows: g.shadows,
    u_whites: g.whites,
    u_blacks: g.blacks,
    u_hue: (g.hue * Math.PI) / 180,
    u_lift: lift,
    u_gamma: gamma,
    u_gain: gain,
    u_offset: offset,
    u_zones: [zones.black, zones.shadow, zones.mid, zones.light, zones.highlight, zones.specular],
    u_zonesEnabled: Object.values(zones).some((v) => v !== 0) ? 1 : 0,
  };
}

export interface ParsedLut {
  size: number;
  /** RGB float triples, red varying fastest (the .cube convention, which matches 3D texture layout). */
  data: Float32Array;
  title: string;
}

/** Parse an Adobe / Resolve `.cube` 3D LUT. Throws on malformed files. */
export function parseCubeLut(text: string): ParsedLut {
  let size = 0;
  let title = '';
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z_]/.test(line)) {
      const [key, ...rest] = line.split(/\s+/);
      const k = key.toUpperCase();
      if (k === 'TITLE') title = rest.join(' ').replace(/^"|"$/g, '');
      else if (k === 'LUT_3D_SIZE') size = parseInt(rest[0], 10);
      else if (k === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported; use a 3D .cube file');
      else if (k === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number);
      else if (k === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number);
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!size || size < 2 || size > 129) throw new Error('Missing or invalid LUT_3D_SIZE');
  if (values.length !== size * size * size * 3) {
    throw new Error(`LUT has ${values.length / 3} entries, expected ${size * size * size}`);
  }
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    const v = (values[i] - min[c]) / (max[c] - min[c] || 1);
    data[i] = Number.isFinite(v) ? v : 0;
  }
  return { size, data, title };
}
