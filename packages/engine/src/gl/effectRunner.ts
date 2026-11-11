import {
  GLSL_COMMON,
  GLSL_EFFECT_FOOTER,
  GLSL_EFFECT_HEADER,
  GLSL_EFFECT_SAMPLERS,
  GLSL_TRANSITION_FOOTER,
  GLSL_TRANSITION_HEADER,
  GLSL_TRANSITION_SAMPLERS,
  paramUniformDecls,
  type EffectDef,
  type PassContext,
  type ResolvedParams,
  type TransitionDef,
} from '@tandem/core';
import type { Glx, Program, RenderTarget, UniformValue } from './glx';
import { COPY_FS } from './shaders';

export interface FxContext {
  /** Device pixels per 1080p-reference pixel. */
  px: number;
  /** Clip-local time, seconds. */
  time: number;
  /** Clip-local frame. */
  frame: number;
  seed: number;
  lumaW: readonly [number, number, number];
}

/**
 * Passes of one effect that share their GLSL (the steps of a blur's down-sampling chain, its
 * horizontal and vertical halves) share one program too: the key names the first such pass.
 */
function passKey(def: EffectDef, index: number): string {
  const glsl = def.passes[index].glsl;
  return `fx:${def.id}:${def.passes.findIndex((p) => p.glsl === glsl)}`;
}

function effectProgram(glx: Glx, def: EffectDef, index: number): Program | null {
  // A broken shader must never take the whole render down: the effect is skipped instead.
  return glx.tryProgram(
    passKey(def, index),
    () =>
      GLSL_EFFECT_HEADER +
      GLSL_COMMON +
      GLSL_EFFECT_SAMPLERS +
      paramUniformDecls(def.params) +
      '\n' +
      def.passes[index].glsl +
      GLSL_EFFECT_FOOTER,
  );
}

function paramUniforms(params: ResolvedParams): Record<string, UniformValue> {
  const out: Record<string, UniformValue> = {};
  for (const k in params) out[`u_${k}`] = params[k];
  return out;
}

/**
 * Run an effect on `input`, returning a NEW render target the same size as the input.
 * The input target is left untouched; the caller owns (and releases) both. The passes actually
 * drawn (an effect skips those its parameters do not need) are added to `stats`.
 */
export function runEffect(
  glx: Glx,
  def: EffectDef,
  params: ResolvedParams,
  input: { tex: WebGLTexture; width: number; height: number },
  fx: FxContext,
  stats?: { passes: number },
): RenderTarget | null {
  const pc: PassContext = { px: fx.px, width: input.width, height: input.height };
  const base = paramUniforms(params);
  let src: { tex: WebGLTexture; width: number; height: number } = input;
  let owned: RenderTarget | null = null;

  for (let i = 0; i < def.passes.length; i++) {
    const pass = def.passes[i];
    if (pass.skip && pass.skip(params, pc)) continue;
    const program = effectProgram(glx, def, i);
    if (!program) {
      glx.release(owned);
      return null;
    }
    const scale = typeof pass.scale === 'function' ? pass.scale(params, pc) : (pass.scale ?? 1);
    const tw = Math.max(1, Math.round(input.width * scale));
    const th = Math.max(1, Math.round(input.height * scale));
    const target = glx.acquire(tw, th);
    glx.pass(program, target, {
      ...base,
      ...(pass.uniforms ? pass.uniforms(params, pc) : null),
      u_src: src.tex,
      u_orig: input.tex,
      u_resolution: [tw, th],
      u_texel: [1 / src.width, 1 / src.height],
      u_px: fx.px * scale,
      u_time: fx.time,
      u_frame: fx.frame,
      u_seed: fx.seed,
      u_aspect: input.width / input.height,
      u_lumaW: fx.lumaW,
    });
    if (stats) stats.passes++;
    glx.release(owned);
    owned = target;
    src = target;
  }

  if (!owned) return null;
  if (owned.width !== input.width || owned.height !== input.height) {
    // The chain ended at reduced resolution (e.g. a wide blur): bring it back up.
    const full = glx.acquire(input.width, input.height);
    glx.pass(glx.program('copy', COPY_FS), full, { u_tex: owned.tex, u_opacity: 1 });
    if (stats) stats.passes++;
    glx.release(owned);
    owned = full;
  }
  return owned;
}

export function transitionProgram(glx: Glx, def: TransitionDef): Program | null {
  return glx.tryProgram(
    `tr:${def.id}`,
    () =>
      GLSL_TRANSITION_HEADER +
      GLSL_COMMON +
      GLSL_TRANSITION_SAMPLERS +
      paramUniformDecls(def.params) +
      '\n' +
      def.glsl +
      GLSL_TRANSITION_FOOTER,
  );
}

/**
 * Compile the next not-yet-compiled program among the given effects and transitions. Returns false
 * when there was nothing left to do. Called from idle time so that the first frame which uses an
 * effect does not pay for its shader compile in the middle of playback.
 */
export function warmNext(
  glx: Glx,
  effects: Iterable<EffectDef>,
  transitions: Iterable<TransitionDef>,
): boolean {
  // Nothing can be compiled until the context is back; whoever restores it starts over.
  if (glx.contextLost) return false;
  for (const e of effects) {
    for (let i = 0; i < e.passes.length; i++) {
      if (glx.settled(passKey(e, i))) continue;
      effectProgram(glx, e, i);
      return true;
    }
  }
  for (const t of transitions) {
    if (glx.settled(`tr:${t.id}`)) continue;
    transitionProgram(glx, t);
    return true;
  }
  return false;
}

/** Compile every effect and transition; returns the ids that failed. Used by the test harness. */
export function compileAll(glx: Glx, effects: EffectDef[], transitions: TransitionDef[]): string[] {
  const bad: string[] = [];
  for (const e of effects) {
    for (let i = 0; i < e.passes.length; i++) if (!effectProgram(glx, e, i)) bad.push(`${e.id}#${i}`);
  }
  for (const t of transitions) if (!transitionProgram(glx, t)) bad.push(t.id);
  return bad;
}
