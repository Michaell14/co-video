/**
 * Shared GLSL (ES 3.00) helpers available to every effect and transition shader.
 *
 * Pipeline conventions
 *  - Textures hold premultiplied-alpha colour in the timeline's working encoding: display-referred
 *    gamma (sRGB curve, extended above 1.0 for HDR), Rec.709 primaries in SDR projects and Rec.2020
 *    primaries in HDR projects. `toLinear` / `fromLinear` convert to and from linear light.
 *  - UV origin is the TOP-left corner; +y points down.
 *  - Pixel distances exposed to users are authored against a 1080-pixel-tall frame. Multiply by
 *    `u_px` to get device pixels so a look survives changing the output or preview resolution.
 */
export const GLSL_COMMON = /* glsl */ `
uniform vec3 u_lumaW;
float luma(vec3 c) { return dot(c, u_lumaW); }
vec4 unpremul(vec4 c) { return c.a > 1e-5 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec3 toLinear(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(a / 12.92, pow((a + 0.055) / 1.055, vec3(2.4)), step(0.04045, a));
}
vec3 fromLinear(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(a * 12.92, 1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, a));
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.7; a *= 0.5; }
  return v;
}
mat2 rot2(float a) { float s = sin(a); float c = cos(a); return mat2(c, -s, s, c); }
float inside01(vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return s.x * s.y;
}
`;

/** Preamble for effect passes. The effect body must define `vec4 effect(vec2 uv)`. */
export const GLSL_EFFECT_HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform sampler2D u_orig;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform float u_px;
uniform float u_time;
uniform float u_frame;
uniform float u_seed;
uniform float u_aspect;
`;

/** Sampling helpers for effects; must come after GLSL_COMMON. */
export const GLSL_EFFECT_SAMPLERS = /* glsl */ `
vec4 src(vec2 uv) { return texture(u_src, uv); }
vec4 orig(vec2 uv) { return texture(u_orig, uv); }
vec4 srcT(vec2 uv) { return texture(u_src, uv) * inside01(uv); }
`;

export const GLSL_EFFECT_FOOTER = /* glsl */ `
void main() { outColor = effect(v_uv); }
`;

/** Preamble for transitions. The body must define `vec4 transition(vec2 uv)`. */
export const GLSL_TRANSITION_HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform vec2 u_resolution;
uniform vec2 u_texel;
uniform float u_px;
uniform float u_progress;
uniform float u_aspect;
uniform float u_seed;
`;

/** Sampling helpers for transitions; must come after GLSL_COMMON. */
export const GLSL_TRANSITION_SAMPLERS = /* glsl */ `
vec4 A(vec2 uv) { return texture(u_a, uv); }
vec4 B(vec2 uv) { return texture(u_b, uv); }
vec4 AT(vec2 uv) { return texture(u_a, uv) * inside01(uv); }
vec4 BT(vec2 uv) { return texture(u_b, uv) * inside01(uv); }
`;

export const GLSL_TRANSITION_FOOTER = /* glsl */ `
void main() { outColor = transition(v_uv); }
`;
