import { GLSL_COMMON } from '@tandem/core';

// ─────────────────────────────────────────────────────────────── colour ──

/** Transfer functions and tone-mapping operators shared by the grade and output shaders. */
export const GLSL_COLOR = /* glsl */ `
const float PQ_M1 = 0.1593017578125;
const float PQ_M2 = 78.84375;
const float PQ_C1 = 0.8359375;
const float PQ_C2 = 18.8515625;
const float PQ_C3 = 18.6875;
// PQ code value → luminance / 10000 nits.
vec3 pqToLinear(vec3 e) {
  vec3 p = pow(max(e, 0.0), vec3(1.0 / PQ_M2));
  return pow(max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), vec3(1.0 / PQ_M1));
}
vec3 linearToPq(vec3 l) {
  vec3 y = pow(clamp(l, 0.0, 1.0), vec3(PQ_M1));
  return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), vec3(PQ_M2));
}
const float HLG_A = 0.17883277;
const float HLG_B = 0.28466892;
const float HLG_C = 0.55991073;
vec3 hlgToScene(vec3 e) {
  vec3 lo = e * e / 3.0;
  vec3 hi = (exp((e - HLG_C) / HLG_A) + HLG_B) / 12.0;
  return mix(lo, hi, step(0.5, e));
}
vec3 sceneToHlg(vec3 s) {
  s = max(s, 0.0);
  vec3 lo = sqrt(3.0 * s);
  vec3 hi = HLG_A * log(max(12.0 * s - HLG_B, 1e-6)) + HLG_C;
  return mix(lo, hi, step(1.0 / 12.0, s));
}
vec3 slog3ToLinear(vec3 x) {
  vec3 hi = pow(vec3(10.0), (x * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01;
  vec3 lo = (x * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
  return mix(lo, hi, step(171.2102946929 / 1023.0, x));
}
vec3 logc3ToLinear(vec3 x) {
  const float cut = 0.010591; const float a = 5.555556; const float b = 0.052272;
  const float c = 0.247190; const float d = 0.385537; const float e = 5.367655; const float f = 0.092809;
  vec3 hi = (pow(vec3(10.0), (x - d) / c) - b) / a;
  vec3 lo = (x - f) / e;
  return mix(lo, hi, step(e * cut + f, x));
}
vec3 vlogToLinear(vec3 x) {
  vec3 lo = (x - 0.125) / 5.6;
  vec3 hi = pow(vec3(10.0), (x - 0.598206) / 0.241514) - 0.00873;
  return mix(lo, hi, step(0.181, x));
}
// Tone-map operators. Input: linear, 1.0 = diffuse white, may exceed 1. Output: 0…1.
vec3 tmKnee(vec3 x) {
  const float k = 0.75;
  vec3 over = max(x - k, 0.0);
  return min(x, vec3(k)) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}
vec3 tmReinhard(vec3 x, float peak) {
  float w2 = max(peak * peak, 1.0);
  return x * (1.0 + x / w2) / (1.0 + x);
}
vec3 hableCurve(vec3 x) {
  const float A = 0.15; const float B = 0.50; const float C = 0.10; const float D = 0.20; const float E = 0.02; const float F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 tmHable(vec3 x) {
  return hableCurve(x * 2.0) / hableCurve(vec3(11.2));
}
vec3 tmAces(vec3 x) {
  x *= 0.6;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toneMap(vec3 x, int op, float peak) {
  x = max(x, 0.0);
  if (op == 1) return tmReinhard(x, peak);
  if (op == 2) return tmHable(x);
  if (op == 3) return tmAces(x);
  if (op == 4) return tmKnee(x);
  return x;
}
`;

export const TONEMAP_IDS: Record<string, number> = { none: 0, reinhard: 1, hable: 2, aces: 3, bt2390: 4 };

export const TRANSFER_IDS: Record<string, number> = {
  srgb: 0,
  pq: 1,
  hlg: 2,
  linear: 3,
  slog3: 4,
  logc3: 5,
  vlog: 6,
};

// ─────────────────────────────────────────────────────────────── layers ──

export const LAYER_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;
uniform vec2 u_boxPx;
out vec2 v_uv;
void main() {
  // Grow the quad by one device pixel on every side so its edge can be anti-aliased in the
  // fragment shader, which matters as soon as a layer is rotated or sits on a sub-pixel.
  vec2 q = (a_pos - 0.5) * (1.0 + 2.0 / max(u_boxPx, vec2(1.0))) + 0.5;
  v_uv = q;
  vec3 p = u_matrix * vec3(q, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec4 u_crop;
uniform vec2 u_flip;
uniform float u_opacity;
uniform vec2 u_boxPx;
uniform int u_maskType;
uniform vec4 u_maskRect;
uniform vec4 u_maskParams;
uniform float u_wipe;
float maskAlpha(vec2 uv) {
  if (u_maskType == 0) return 1.0;
  vec2 p = (uv - u_maskRect.xy) * u_boxPx;
  float a = -u_maskParams.x;
  float cs = cos(a); float sn = sin(a);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  vec2 halfSize = max(u_maskRect.zw * u_boxPx * 0.5, vec2(0.5));
  float feather = max(u_maskParams.y * min(u_boxPx.x, u_boxPx.y), 1.0);
  float dist;
  if (u_maskType == 1) {
    float r = u_maskParams.z * min(halfSize.x, halfSize.y);
    vec2 q = abs(p) - halfSize + r;
    dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  } else {
    float k = length(p / halfSize);
    dist = (k - 1.0) * min(halfSize.x, halfSize.y);
  }
  float m = 1.0 - smoothstep(-feather * 0.5, feather * 0.5, dist);
  return mix(m, 1.0 - m, u_maskParams.w);
}
void main() {
  vec2 px = v_uv * u_boxPx;
  vec2 lo = u_crop.xy * u_boxPx;
  vec2 hi = (1.0 - u_crop.zw) * u_boxPx;
  vec2 d = min(px - lo, hi - px);
  float edge = clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
  if (edge <= 0.0) { outColor = vec4(0.0); return; }
  vec2 suv = mix(v_uv, 1.0 - v_uv, u_flip);
  vec4 c = texture(u_tex, clamp(suv, 0.0, 1.0));
  float wipe = u_wipe >= 1.0 ? 1.0 : 1.0 - smoothstep(u_wipe - 0.01, u_wipe + 0.01, v_uv.x);
  outColor = c * (edge * maskAlpha(v_uv) * wipe * u_opacity);
}`;

export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_opacity;
void main() { outColor = texture(u_tex, v_uv) * u_opacity; }`;

export const BLEND_MODE_IDS: Record<string, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
  add: 12,
  subtract: 13,
  hue: 14,
  saturation: 15,
  color: 16,
  luminosity: 17,
};

export const BLEND_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform float u_opacity;
uniform int u_mode;
uniform vec3 u_lumaW;
float lum(vec3 c) { return dot(c, u_lumaW); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float overlayCh(float b, float s) { return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s); }
float dodgeCh(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burnCh(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float softCh(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 blendFn(vec3 b, vec3 s) {
  if (u_mode == 1) return b * s;
  if (u_mode == 2) return b + s - b * s;
  if (u_mode == 3) return vec3(overlayCh(b.r, s.r), overlayCh(b.g, s.g), overlayCh(b.b, s.b));
  if (u_mode == 4) return min(b, s);
  if (u_mode == 5) return max(b, s);
  if (u_mode == 6) return vec3(dodgeCh(b.r, s.r), dodgeCh(b.g, s.g), dodgeCh(b.b, s.b));
  if (u_mode == 7) return vec3(burnCh(b.r, s.r), burnCh(b.g, s.g), burnCh(b.b, s.b));
  if (u_mode == 8) return vec3(overlayCh(s.r, b.r), overlayCh(s.g, b.g), overlayCh(s.b, b.b));
  if (u_mode == 9) return vec3(softCh(b.r, s.r), softCh(b.g, s.g), softCh(b.b, s.b));
  if (u_mode == 10) return abs(b - s);
  if (u_mode == 11) return b + s - 2.0 * b * s;
  if (u_mode == 12) return b + s;
  if (u_mode == 13) return max(b - s, 0.0);
  if (u_mode == 14) return setLum(setSat(s, sat(b)), lum(b));
  if (u_mode == 15) return setLum(setSat(b, sat(s)), lum(b));
  if (u_mode == 16) return setLum(s, lum(b));
  if (u_mode == 17) return setLum(b, lum(s));
  return s;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv) * u_opacity;
  if (u_mode == 0) { outColor = s + d * (1.0 - s.a); return; }
  vec3 dc = d.a > 1e-5 ? d.rgb / d.a : vec3(0.0);
  vec3 sc = s.a > 1e-5 ? s.rgb / s.a : vec3(0.0);
  vec3 bl = blendFn(dc, sc);
  vec3 co = sc * s.a * (1.0 - d.a) + bl * s.a * d.a + dc * d.a * (1.0 - s.a);
  outColor = vec4(co, s.a + d.a * (1.0 - s.a));
}`;

// ──────────────────────────────────────────────────────── input + grade ──

/**
 * One pass that (a) converts a source from its native colour space into the timeline working
 * encoding and (b) applies the clip's primary grade. Either half can be switched off.
 */
export const GRADE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
${GLSL_COMMON}
${GLSL_COLOR}
// Input transform
uniform int u_inEnabled;
uniform int u_inTransfer;
uniform mat3 u_inMat;
uniform float u_inScale;
uniform int u_inToneMap;
uniform float u_inPeak;
uniform float u_hlgGamma;
// Planar YUV input (high bit-depth decode path)
uniform int u_yuvEnabled;
uniform sampler2D u_texY;
uniform sampler2D u_texU;
uniform sampler2D u_texV;
uniform mat3 u_yuvMat;
uniform vec3 u_yuvOffset;
uniform vec2 u_yuvPack;
// Grade
uniform int u_gradeEnabled;
uniform float u_exposure;
uniform vec3 u_wb;
uniform float u_contrast;
uniform float u_pivot;
uniform float u_saturation;
uniform float u_vibrance;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_hue;
uniform vec3 u_lift;
uniform vec3 u_gamma;
uniform vec3 u_gain;
uniform vec3 u_offset;
uniform float u_zones[6];
uniform int u_zonesEnabled;
uniform int u_curvesEnabled;
uniform sampler2D u_curves;
uniform float u_encPeak;
uniform int u_hueCurvesEnabled;
uniform int u_lutEnabled;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_lutIntensity;
uniform float u_uvRot;

// Undo container rotation metadata: quarter-turns clockwise needed to show the picture upright.
vec2 rotUv(vec2 uv) {
  if (u_uvRot < 0.5) return uv;
  if (u_uvRot < 1.5) return vec2(uv.y, 1.0 - uv.x);
  if (u_uvRot < 2.5) return vec2(1.0 - uv.x, 1.0 - uv.y);
  return vec2(1.0 - uv.y, uv.x);
}

vec3 inputTransform(vec3 c) {
  vec3 lin;
  if (u_inTransfer == 1) lin = pqToLinear(c);
  else if (u_inTransfer == 2) {
    vec3 s = hlgToScene(c);
    float ys = dot(s, vec3(0.2627, 0.6780, 0.0593));
    lin = s * pow(max(ys, 1e-6), u_hlgGamma - 1.0);
  }
  else if (u_inTransfer == 3) lin = c;
  else if (u_inTransfer == 4) lin = slog3ToLinear(c);
  else if (u_inTransfer == 5) lin = logc3ToLinear(c);
  else if (u_inTransfer == 6) lin = vlogToLinear(c);
  else lin = toLinear(c);
  lin = u_inMat * (lin * u_inScale);
  if (u_inToneMap != 0) lin = toneMap(lin, u_inToneMap, u_inPeak);
  return fromLinear(lin);
}

float zoneWeight(float z, float center) {
  float d = (z - center) / 2.2;
  return exp(-d * d);
}

vec3 grade(vec3 c) {
  // Linear-light stage: white balance, exposure, tonal zones.
  vec3 lin = toLinear(c) * u_wb * exp2(u_exposure);
  if (u_zonesEnabled == 1) {
    float y = max(dot(lin, u_lumaW), 1e-5);
    float z = log2(y / 0.18);
    float w0 = zoneWeight(z, -6.0); float w1 = zoneWeight(z, -3.0); float w2 = zoneWeight(z, 0.0);
    float w3 = zoneWeight(z, 2.0); float w4 = zoneWeight(z, 4.0); float w5 = zoneWeight(z, 6.0);
    float ev = (w0 * u_zones[0] + w1 * u_zones[1] + w2 * u_zones[2] + w3 * u_zones[3] + w4 * u_zones[4] + w5 * u_zones[5])
      / max(w0 + w1 + w2 + w3 + w4 + w5, 1e-4);
    lin *= exp2(ev);
  }
  c = fromLinear(lin);

  // Tonal controls in the perceptual working encoding.
  float l = luma(c);
  float n = clamp(l / u_encPeak, 0.0, 1.0);
  c += u_shadows * 0.3 * pow(1.0 - n, 3.0) * n * 4.0;
  c += u_highlights * 0.3 * pow(n, 2.0) * (1.0 - n) * 4.0 * u_encPeak;
  c += u_blacks * 0.15 * pow(1.0 - n, 5.0);
  c *= 1.0 + u_whites * 0.4 * n * n;
  c = (c - u_pivot) * (1.0 + u_contrast) + u_pivot;

  // Lift / gamma / gain / offset.
  c = c * u_gain + u_offset;
  c = c + u_lift * (1.0 - c / u_encPeak);
  c = sign(c) * pow(abs(c) / u_encPeak, u_gamma) * u_encPeak;

  // Curves.
  if (u_curvesEnabled == 1) {
    vec3 x = clamp(c / u_encPeak, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    vec3 over = max(c - u_encPeak, 0.0);
    c = vec3(texture(u_curves, vec2(x.r, 0.25)).r, texture(u_curves, vec2(x.g, 0.25)).g, texture(u_curves, vec2(x.b, 0.25)).b) * u_encPeak + over;
  }

  // Colour: hue, hue curves, saturation, vibrance.
  l = luma(c);
  if (u_hue != 0.0 || u_hueCurvesEnabled == 1) {
    vec3 hsv = rgb2hsv(max(c, 0.0));
    float satMul = 1.0;
    if (u_hueCurvesEnabled == 1) {
      vec3 hc = texture(u_curves, vec2(hsv.x * (255.0 / 256.0) + 0.5 / 256.0, 0.75)).rgb;
      satMul = hc.r * 2.0;
      hsv.x = fract(hsv.x + (hc.g - 0.5));
      float ls = texture(u_curves, vec2(clamp(l / u_encPeak, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.75)).b * 2.0;
      satMul *= ls;
    }
    hsv.x = fract(hsv.x + u_hue / 6.28318530718);
    vec3 rot = hsv2rgb(hsv);
    rot += l - luma(rot);
    c = mix(vec3(l), rot, satMul);
  }
  l = luma(c);
  c = mix(vec3(l), c, u_saturation);
  if (u_vibrance != 0.0) {
    float mx = max(c.r, max(c.g, c.b));
    float av = (c.r + c.g + c.b) / 3.0;
    c = mix(c, vec3(mx), (mx - av) / max(u_encPeak, 1e-4) * (-3.0 * u_vibrance));
  }

  if (u_lutEnabled == 1) {
    vec3 p = clamp(c, 0.0, 1.0);
    vec3 graded = texture(u_lut, p * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize).rgb;
    c = mix(c, graded, u_lutIntensity);
  }
  return c;
}

void main() {
  vec2 uv = rotUv(v_uv);
  vec4 t;
  if (u_yuvEnabled == 1) {
    // Each plane is uploaded as two 8-bit channels (low byte, high byte) of a 16-bit sample.
    // Bilinear filtering stays exact because the value is linear in both bytes.
    vec3 yuv = vec3(dot(texture(u_texY, uv).rg, u_yuvPack), dot(texture(u_texU, uv).rg, u_yuvPack), dot(texture(u_texV, uv).rg, u_yuvPack));
    t = vec4(u_yuvMat * (yuv - u_yuvOffset), 1.0);
  } else {
    t = texture(u_src, uv);
  }
  vec4 c = unpremul(t);
  if (u_inEnabled == 1) c.rgb = inputTransform(c.rgb);
  if (u_gradeEnabled == 1) c.rgb = grade(c.rgb);
  outColor = premul(c);
}`;

// ─────────────────────────────────────────────────────────────── output ──

/**
 * Display / delivery transform.
 *   u_outMode 0  pass-through (SDR project → SDR target)
 *             1  HDR working → SDR (tone map, gamut map to Rec.709, sRGB encode)
 *             2  HDR working → PQ RGB code values (Rec.2020)
 *             3  HDR working → HLG RGB code values (Rec.2020)
 */
export const OUTPUT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
${GLSL_COMMON}
${GLSL_COLOR}
uniform int u_outMode;
uniform int u_toneMap;
uniform float u_peak;
uniform float u_refWhite;
uniform mat3 u_outMat;
uniform float u_dither;
uniform int u_falseColor;
vec3 displayTransform(vec3 c) {
  if (u_outMode == 0) {
    if (u_toneMap != 0) c = fromLinear(toneMap(toLinear(c), u_toneMap, 4.0));
    return c;
  }
  vec3 lin = max(toLinear(c), 0.0);
  if (u_outMode == 1) {
    lin = toneMap(lin, u_toneMap == 0 ? 4 : u_toneMap, u_peak);
    lin = u_outMat * lin;
    return fromLinear(clamp(lin, 0.0, 1.0));
  }
  if (u_outMode == 2) return linearToPq(min(lin, vec3(u_peak)) * (u_refWhite / 10000.0));
  // HLG: display light → scene light (inverse OOTF, Lw = 1000 nits) → OETF.
  vec3 disp = min(lin * u_refWhite, vec3(1000.0)) / 1000.0;
  float yd = max(dot(disp, vec3(0.2627, 0.6780, 0.0593)), 1e-6);
  vec3 scene = disp * pow(yd, (1.0 - 1.2) / 1.2);
  return sceneToHlg(scene);
}
void main() {
  vec4 t = texture(u_tex, v_uv);
  vec3 c = displayTransform(t.rgb);
  if (u_falseColor == 1) {
    // Highlight clipping (red) and crushed blacks (blue) for exposure checks.
    float l = luma(t.rgb);
    if (l >= 1.0) c = vec3(1.0, 0.1, 0.1);
    else if (l <= 0.002) c = vec3(0.1, 0.2, 1.0);
  }
  if (u_dither > 0.0) c += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 59.3) - 1.0) * u_dither;
  outColor = vec4(c, t.a);
}`;

/**
 * Packs RGB code values into 10-bit limited-range Y'CbCr, split across two 8-bit channels per
 * component so the result can be read back as little-endian uint16 planes.
 *   u_plane 0 → luma at full resolution: (Ylo, Yhi, 0, 1)
 *   u_plane 1 → chroma at half resolution: (Cblo, Cbhi, Crlo, Crhi)
 */
export const YUV_PACK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform int u_plane;
uniform vec3 u_kr_kg_kb;
uniform vec2 u_texel;
vec2 split(float code) {
  float v = clamp(floor(code + 0.5), 0.0, 1023.0);
  float hi = floor(v / 256.0);
  return vec2(v - hi * 256.0, hi) / 255.0;
}
vec3 toYcc(vec3 rgb) {
  float y = dot(rgb, u_kr_kg_kb);
  float cb = (rgb.b - y) / (2.0 * (1.0 - u_kr_kg_kb.z));
  float cr = (rgb.r - y) / (2.0 * (1.0 - u_kr_kg_kb.x));
  return vec3(y, cb, cr);
}
void main() {
  if (u_plane == 0) {
    vec3 ycc = toYcc(clamp(texture(u_tex, v_uv).rgb, 0.0, 1.0));
    outColor = vec4(split(64.0 + ycc.x * 876.0), 0.0, 1.0);
  } else {
    // Average the 2×2 block this chroma sample covers.
    vec2 o = u_texel * 0.5;
    vec3 rgb = (texture(u_tex, v_uv + vec2(-o.x, -o.y)).rgb + texture(u_tex, v_uv + vec2(o.x, -o.y)).rgb
              + texture(u_tex, v_uv + vec2(-o.x, o.y)).rgb + texture(u_tex, v_uv + vec2(o.x, o.y)).rgb) * 0.25;
    vec3 ycc = toYcc(clamp(rgb, 0.0, 1.0));
    outColor = vec4(split(512.0 + ycc.y * 896.0), split(512.0 + ycc.z * 896.0));
  }
}`;
