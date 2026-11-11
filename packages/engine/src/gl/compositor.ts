/**
 * The compositor: draws one resolved frame.
 *
 *   for each layer (bottom → top)
 *     source texture ─► [input transform + grade] ─► [layer-space effects] ─► transform into frame
 *                    ─► [frame-space effects] ─► blend onto the accumulator
 *   accumulator ─► output transform ─► canvas (or packed YUV for HDR encode)
 *
 * It is synchronous and never waits on media: whatever the SourceProvider has ready is what gets
 * drawn. Exporters call `provider.prepare()` first so that "ready" means "exact".
 */
import {
  animated,
  fxPath,
  gamutMatrix,
  getEffectDef,
  getTransitionDef,
  INPUT_COLOR_SPACES,
  isHdrMode,
  isHdrSpace,
  isLogSpace,
  lumaWeights,
  resolveInputSpace,
  resolveParams,
  seedOf,
  toGlMat3,
  workingPrimaries,
  hexToRgb,
  linearToSrgb,
  type ClipLayer,
  type EffectDef,
  type FrameDesc,
  type Grade,
  type Layer,
  type Project,
  type ResolvedParams,
} from '@tandem/core';
import { runEffect, transitionProgram, type FxContext } from './effectRunner';
import { Glx, PRESENT_VS, type Program, type RenderTarget } from './glx';
import { bakeCurves, gradeUniforms, hasHueCurves, hasRgbCurves, isNeutralGrade } from './grade';
import {
  BLEND_FS,
  BLEND_MODE_IDS,
  COPY_FS,
  GRADE_FS,
  LAYER_FS,
  LAYER_VS,
  OUTPUT_FS,
  TONEMAP_IDS,
  TRANSFER_IDS,
  YUV_PACK_FS,
} from './shaders';

export interface TextureSource {
  tex: WebGLTexture;
  width: number;
  height: number;
  /** Quarter-turns clockwise needed to display the texture upright (container rotation metadata). */
  rotation?: 0 | 90 | 180 | 270;
  /** Planar Y'CbCr textures for the high bit-depth decode path. */
  yuv?: {
    y: WebGLTexture;
    u: WebGLTexture;
    v: WebGLTexture;
    /** Column-major Y'CbCr → R'G'B' matrix. */
    matrix: Float32Array;
    offset: [number, number, number];
    /** Normalised texel value → nominal 0…1 code range. */
    scale: number;
  };
}

export interface SourceProvider {
  /** Latest available picture for a clip, or null when nothing can be drawn yet. */
  getTexture(layer: ClipLayer, project: Project, frameWidth: number, frameHeight: number): TextureSource | null;
  getLut(assetId: string): { tex: WebGLTexture; size: number } | null;
}

export type OutputMode = 'display' | 'pq' | 'hlg';

export interface RenderOptions {
  /** `display`: SDR picture for the screen / 8-bit encode. `pq` / `hlg`: HDR code values. */
  output?: OutputMode;
  /** Show clipped highlights and crushed blacks. */
  falseColor?: boolean;
  /** Skip presenting to the canvas (used when only read-back is wanted). */
  skipPresent?: boolean;
}

export interface RenderStats {
  layers: number;
  passes: number;
  /** Layers skipped because their source was not available. */
  missing: number;
}

interface Step {
  kind: 'grade' | 'fx';
  def?: EffectDef;
  params?: ResolvedParams;
  seed?: number;
}

type Img = { tex: WebGLTexture; width: number; height: number };

const DEG = Math.PI / 180;

export class Compositor {
  readonly glx: Glx;
  readonly gl: WebGL2RenderingContext;
  width = 2;
  height = 2;
  stats: RenderStats = { layers: 0, passes: 0, missing: 0 };

  private readonly quadVao: WebGLVertexArrayObject;
  private readonly layerProgram: Program;
  private readonly blendProgram: Program;
  private readonly copyProgram: Program;
  private readonly gradeProgram: Program;
  private readonly outputProgram: Program;
  private readonly presentProgram: Program;
  private readonly yuvProgram: Program;
  private readonly curveCache = new Map<string, { tex: WebGLTexture; curves: object; hueSat: object; hueHue: object; lumSat: object }>();
  private readonly outMat = toGlMat3(gamutMatrix('rec2020', 'rec709'));
  private readonly dummy2d: WebGLTexture;
  private readonly dummy3d: WebGLTexture;
  private last: RenderTarget | null = null;
  private lumaW: [number, number, number] = [0.2126, 0.7152, 0.0722];
  private project: Project | null = null;
  private provider: SourceProvider | null = null;
  private fps = 30;
  private packTargets: { y: RenderTarget; c: RenderTarget } | null = null;
  private scopeTarget: RenderTarget | null = null;
  private scopePbo: WebGLBuffer | null = null;
  private scopeBusy = false;
  private lastOutput: OutputMode = 'display';

  constructor(
    readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { float?: boolean } = {},
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.glx = new Glx(gl, opts.float !== false);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.layerProgram = this.glx.program('layer', LAYER_FS, LAYER_VS);
    this.blendProgram = this.glx.program('blend', BLEND_FS);
    this.copyProgram = this.glx.program('copy', COPY_FS);
    this.gradeProgram = this.glx.program('grade', GRADE_FS);
    this.outputProgram = this.glx.program('output', OUTPUT_FS);
    this.presentProgram = this.glx.program('present', OUTPUT_FS, PRESENT_VS);
    this.yuvProgram = this.glx.program('yuvpack', YUV_PACK_FS);

    this.dummy2d = this.glx.createTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.dummy3d = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.dummy3d);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Set the render resolution (also the canvas backing-store size). */
  setSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (w === this.width && h === this.height && this.canvas.width === w && this.canvas.height === h) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.glx.release(this.last);
    this.last = null;
    this.glx.trimPool();
    this.packTargets = null;
  }

  // ─────────────────────────────────────────────────────────────── render ──

  render(project: Project, desc: FrameDesc, provider: SourceProvider, opts: RenderOptions = {}): RenderStats {
    const { glx, gl } = this;
    this.stats = { layers: 0, passes: 0, missing: 0 };
    if (glx.contextLost) return this.stats;
    this.project = project;
    this.provider = provider;
    this.fps = project.settings.fpsNum / project.settings.fpsDen;
    this.lumaW = lumaWeights(workingPrimaries(project.settings.colorMode));

    gl.disable(gl.BLEND);
    let acc = glx.acquire(this.width, this.height);
    const bg = hexToRgb(project.settings.background);
    glx.clear(acc, bg[0], bg[1], bg[2], 1);

    for (const layer of desc.layers) {
      this.stats.layers++;
      acc = this.compositeLayer(layer, acc);
    }

    glx.release(this.last);
    this.last = acc;
    this.lastOutput = opts.output ?? 'display';
    if (!opts.skipPresent) this.present(acc, opts);
    return this.stats;
  }

  /** Re-present the last rendered frame (e.g. after toggling false colour). */
  represent(opts: RenderOptions = {}): void {
    if (this.last && this.project) this.present(this.last, opts);
  }

  private outputUniforms(mode: OutputMode, falseColor: boolean): Record<string, number | Float32Array | number[]> {
    const s = this.project!.settings;
    const hdr = isHdrMode(s.colorMode);
    let outMode = 0;
    if (hdr) outMode = mode === 'pq' ? 2 : mode === 'hlg' ? 3 : 1;
    return {
      u_outMode: outMode,
      u_toneMap: TONEMAP_IDS[s.toneMap] ?? 0,
      u_peak: Math.max(1, s.peakNits / s.refWhiteNits),
      u_refWhite: s.refWhiteNits,
      u_outMat: this.outMat,
      u_dither: this.glx.useFloat && mode === 'display' ? 1 / 255 : 0,
      u_falseColor: falseColor ? 1 : 0,
      u_lumaW: this.lumaW,
    };
  }

  private present(acc: RenderTarget, opts: RenderOptions): void {
    const { glx, gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    glx.pass(this.presentProgram, null, {
      u_tex: acc.tex,
      ...this.outputUniforms(opts.output ?? 'display', !!opts.falseColor),
    });
    this.stats.passes++;
  }

  // ─────────────────────────────────────────────────────────────── layers ──

  private compositeLayer(layer: Layer, acc: RenderTarget): RenderTarget {
    if (layer.kind === 'transition') return this.compositeTransition(layer, acc);
    const L = layer.layer;
    if (L.clip.type === 'adjustment') return this.compositeAdjustment(L, acc);
    const opacity = L.v.opacity * L.anim.opacity;
    if (opacity <= 0) return acc;
    const prepared = this.prepare(L);
    if (!prepared) {
      this.stats.missing++;
      return acc;
    }
    const blend = BLEND_MODE_IDS[L.clip.blend] ?? 0;
    if (prepared.frameSteps.length === 0 && blend === 0) {
      // Fast path: draw straight onto the accumulator with fixed-function blending.
      this.drawLayer(prepared, acc, opacity, true);
      this.glx.release(prepared.owned);
      return acc;
    }
    let rt = this.glx.acquire(this.width, this.height);
    this.glx.clear(rt);
    this.drawLayer(prepared, rt, 1, false);
    this.glx.release(prepared.owned);
    rt = this.runSteps(rt, prepared.frameSteps, L, this.framePx());
    const out = this.blend(acc, rt, blend, opacity);
    this.glx.release(rt);
    return out;
  }

  /** Render a layer into its own full-frame target with opacity baked in (for transitions). */
  private renderIsolated(L: ClipLayer | null): RenderTarget {
    const { glx } = this;
    let rt = glx.acquire(this.width, this.height);
    glx.clear(rt);
    if (!L) return rt;
    const opacity = L.v.opacity * L.anim.opacity;
    if (L.clip.type === 'adjustment' || opacity <= 0) return rt;
    const prepared = this.prepare(L);
    if (!prepared) {
      this.stats.missing++;
      return rt;
    }
    this.drawLayer(prepared, rt, opacity, false);
    glx.release(prepared.owned);
    rt = this.runSteps(rt, prepared.frameSteps, L, this.framePx());
    return rt;
  }

  private compositeTransition(layer: Extract<Layer, { kind: 'transition' }>, acc: RenderTarget): RenderTarget {
    const { glx } = this;
    const def = getTransitionDef(layer.transition.type);
    const program = def ? transitionProgram(glx, def) : null;
    const a = this.renderIsolated(layer.a);
    const b = this.renderIsolated(layer.b);
    let out: RenderTarget;
    if (!def || !program) {
      // Unknown transition (newer peer?) — fall back to a plain dissolve.
      const mixed = glx.acquire(this.width, this.height);
      glx.clear(mixed);
      glx.pass(this.copyProgram, mixed, { u_tex: a.tex, u_opacity: 1 - layer.progress }, true);
      glx.pass(this.copyProgram, mixed, { u_tex: b.tex, u_opacity: layer.progress }, true);
      out = this.blend(acc, mixed, 0, 1);
      glx.release(mixed);
    } else {
      const params = resolveParams(def.params, layer.transition.params);
      const uniforms: Record<string, number | number[] | WebGLTexture> = {};
      for (const k in params) uniforms[`u_${k}`] = params[k];
      const t = glx.acquire(this.width, this.height);
      glx.pass(program, t, {
        ...uniforms,
        u_a: a.tex,
        u_b: b.tex,
        u_progress: layer.progress,
        u_resolution: [this.width, this.height],
        u_texel: [1 / this.width, 1 / this.height],
        u_px: this.framePx(),
        u_aspect: this.width / this.height,
        u_seed: layer.seed,
        u_lumaW: this.lumaW,
      });
      this.stats.passes++;
      // A transition between clips with blend modes uses the incoming clip's mode.
      const blendClip = layer.b?.clip ?? layer.a?.clip;
      out = this.blend(acc, t, BLEND_MODE_IDS[blendClip?.blend ?? 'normal'] ?? 0, 1);
      glx.release(t);
    }
    glx.release(a);
    glx.release(b);
    return out;
  }

  private compositeAdjustment(L: ClipLayer, acc: RenderTarget): RenderTarget {
    const { glx } = this;
    const opacity = L.v.opacity * L.anim.opacity;
    const steps = this.stepsFor(L, true);
    if (opacity <= 0 || steps.length === 0) return acc;
    // Process a copy of everything below.
    let work = glx.acquire(this.width, this.height);
    glx.pass(this.copyProgram, work, { u_tex: acc.tex, u_opacity: 1 });
    work = this.runSteps(work, steps, L, this.framePx());
    if (!L.clip.mask && opacity >= 1) {
      glx.release(acc);
      return work;
    }
    // Route through the layer shader so opacity and the clip mask apply.
    const masked = glx.acquire(this.width, this.height);
    glx.clear(masked);
    this.drawQuad(masked, work, this.identityMatrix(), [this.width, this.height], L, 1, false);
    glx.release(work);
    const out = this.blend(acc, masked, 0, opacity);
    glx.release(masked);
    return out;
  }

  private blend(acc: RenderTarget, layer: RenderTarget, mode: number, opacity: number): RenderTarget {
    const { glx } = this;
    this.stats.passes++;
    if (mode === 0) {
      glx.pass(this.copyProgram, acc, { u_tex: layer.tex, u_opacity: opacity }, true);
      return acc;
    }
    const out = glx.acquire(this.width, this.height);
    glx.pass(this.blendProgram, out, {
      u_dst: acc.tex,
      u_src: layer.tex,
      u_opacity: opacity,
      u_mode: mode,
      u_lumaW: this.lumaW,
    });
    glx.release(acc);
    return out;
  }

  // ───────────────────────────────────────────────────────── preparation ──

  private framePx(): number {
    return this.height / 1080;
  }

  private stepsFor(L: ClipLayer, frameSpace: boolean): Step[] {
    const clip = L.clip;
    const generator = clip.type !== 'video' && clip.type !== 'image';
    const steps: Step[] = [];
    // Grade first. Media clips grade in layer space, generators / adjustments in frame space.
    if (frameSpace === generator && !isNeutralGrade(clip.grade)) steps.push({ kind: 'grade' });
    for (const inst of clip.effects) {
      if (!inst.enabled) continue;
      const def = getEffectDef(inst.type);
      if (!def) continue;
      const inFrame = generator || def.space === 'frame';
      if (inFrame !== frameSpace) continue;
      const params = resolveParams(def.params, inst.params, (key, base) =>
        animated(clip, fxPath(inst.id, key), L.localFrame, base),
      );
      steps.push({ kind: 'fx', def, params, seed: seedOf(inst.id) });
    }
    if (frameSpace && L.anim.blur > 0.01) {
      const blur = getEffectDef('gaussianBlur');
      if (blur) steps.push({ kind: 'fx', def: blur, params: { radius: L.anim.blur }, seed: 0 });
    }
    return steps;
  }

  private fxContext(L: ClipLayer, px: number, seed: number): FxContext {
    return { px, time: L.localFrame / this.fps, frame: L.localFrame, seed, lumaW: this.lumaW };
  }

  /** Run processing steps over a render target, returning the (possibly new) target. */
  private runSteps(rt: RenderTarget, steps: Step[], L: ClipLayer, px: number): RenderTarget {
    const { glx } = this;
    let cur = rt;
    for (const step of steps) {
      let next: RenderTarget | null = null;
      if (step.kind === 'grade') {
        next = glx.acquire(cur.width, cur.height);
        this.gradePass(cur, next, L, false);
      } else if (step.def && step.params) {
        next = runEffect(glx, step.def, step.params, cur, this.fxContext(L, px, step.seed ?? 0));
        this.stats.passes += step.def.passes.length;
      }
      if (next) {
        glx.release(cur);
        cur = next;
      }
    }
    return cur;
  }

  private prepare(L: ClipLayer): {
    img: Img;
    owned: RenderTarget | null;
    matrix: Float32Array;
    boxPx: [number, number];
    frameSteps: Step[];
    L: ClipLayer;
  } | null {
    const project = this.project!;
    const src = this.provider!.getTexture(L, project, this.width, this.height);
    if (!src) return null;
    const clip = L.clip;
    const rot = src.rotation ?? 0;
    const srcW = rot === 90 || rot === 270 ? src.height : src.width;
    const srcH = rot === 90 || rot === 270 ? src.width : src.height;
    const media = clip.type === 'video' || clip.type === 'image';

    // Layout box in device pixels.
    const W = this.width;
    const H = this.height;
    let boxW: number;
    let boxH: number;
    const renderScale = H / project.settings.height;
    switch (media ? clip.fit : clip.type === 'solid' ? 'stretch' : 'none') {
      case 'cover': {
        const k = Math.max(W / srcW, H / srcH);
        boxW = srcW * k;
        boxH = srcH * k;
        break;
      }
      case 'stretch':
        boxW = W;
        boxH = H;
        break;
      case 'none':
        // Generators are rasterised at render resolution already; media maps 1:1 to sequence pixels.
        boxW = media ? srcW * renderScale : srcW;
        boxH = media ? srcH * renderScale : srcH;
        break;
      default: {
        const k = Math.min(W / srcW, H / srcH);
        boxW = srcW * k;
        boxH = srcH * k;
      }
    }
    const sx = L.v.scaleX * L.anim.scale;
    const sy = L.v.scaleY * L.anim.scale;

    // Layer-space processing (media only).
    let img: Img = src;
    let owned: RenderTarget | null = null;
    const hdrProject = isHdrMode(project.settings.colorMode);
    // Generators are authored in sRGB, so on an HDR timeline they need a gamut conversion too.
    const needsInput = media ? this.needsInputTransform(clip.assetId) || rot !== 0 || !!src.yuv : hdrProject;
    const layerSteps = media ? this.stepsFor(L, false) : [];
    if (needsInput || layerSteps.length) {
      // Work at on-screen size when the source is larger than it will ever appear.
      const k = Math.min(1, Math.max((boxW * Math.abs(sx)) / srcW, (boxH * Math.abs(sy)) / srcH, 0.02) * 1.0);
      const pw = Math.max(2, Math.round(srcW * k));
      const ph = Math.max(2, Math.round(srcH * k));
      const hasGrade = layerSteps[0]?.kind === 'grade';
      let cur = this.glx.acquire(pw, ph);
      this.gradePass(src, cur, L, true, hasGrade, rot);
      const rest = hasGrade ? layerSteps.slice(1) : layerSteps;
      // Reference pixels are defined on the frame; convert to this buffer's pixel density.
      const px = this.framePx() * (ph / Math.max(1, boxH));
      cur = this.runSteps(cur, rest, L, px);
      owned = cur;
      img = cur;
    }

    return {
      img,
      owned,
      matrix: this.layerMatrix(L, boxW, boxH, sx, sy),
      boxPx: [Math.max(1, boxW * Math.abs(sx)), Math.max(1, boxH * Math.abs(sy))],
      frameSteps: this.stepsFor(L, true),
      L,
    };
  }

  private needsInputTransform(assetId: string | null): boolean {
    const project = this.project!;
    const asset = assetId ? project.assets[assetId] : undefined;
    const space = resolveInputSpace(asset);
    const hdrProject = isHdrMode(project.settings.colorMode);
    if (hdrProject) return true; // gamut conversion into Rec.2020 working space
    return space !== 'rec709' && space !== 'srgb';
  }

  private layerMatrix(L: ClipLayer, boxW: number, boxH: number, sx: number, sy: number): Float32Array {
    const W = this.width;
    const H = this.height;
    const clip = L.clip;
    const a = boxW * sx;
    const b = boxH * sy;
    const r = (L.v.rotation + L.anim.rotation) * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const ax = clip.anchorX;
    const ay = clip.anchorY;
    const px = W / 2 + (L.v.x + L.anim.dx) * W + (ax - 0.5) * boxW;
    const py = H / 2 + (L.v.y + L.anim.dy) * H + (ay - 0.5) * boxH;
    const m00 = (2 / W) * c * a;
    const m01 = (2 / W) * -s * b;
    const m02 = (2 / W) * (px - c * a * ax + s * b * ay) - 1;
    const m10 = (2 / H) * s * a;
    const m11 = (2 / H) * c * b;
    const m12 = (2 / H) * (py - s * a * ax - c * b * ay) - 1;
    return new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1]);
  }

  private identityMatrix(): Float32Array {
    return new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);
  }

  private drawLayer(
    p: { img: Img; matrix: Float32Array; boxPx: [number, number]; L: ClipLayer },
    target: RenderTarget,
    opacity: number,
    blend: boolean,
  ): void {
    this.drawQuad(target, p.img, p.matrix, p.boxPx, p.L, opacity, blend);
  }

  private drawQuad(
    target: RenderTarget,
    img: Img,
    matrix: Float32Array,
    boxPx: [number, number],
    L: ClipLayer,
    opacity: number,
    blend: boolean,
  ): void {
    const { gl, glx } = this;
    const clip = L.clip;
    const v = L.v;
    const mask = clip.mask;
    glx.bind(target);
    this.layerProgram.use();
    this.layerProgram.setAll({
      u_tex: img.tex,
      u_matrix: matrix,
      u_boxPx: boxPx,
      u_crop: [clampCrop(v.cropL), clampCrop(v.cropT), clampCrop(v.cropR), clampCrop(v.cropB)],
      u_flip: [clip.flipH ? 1 : 0, clip.flipV ? 1 : 0],
      u_opacity: opacity,
      u_maskType: mask ? (mask.type === 'rect' ? 1 : 2) : 0,
      u_maskRect: mask ? [mask.x, mask.y, mask.w, mask.h] : [0.5, 0.5, 1, 1],
      u_maskParams: mask ? [mask.rotation * DEG, mask.feather, mask.radius, mask.invert ? 1 : 0] : [0, 0, 0, 0],
      u_wipe: L.anim.wipe,
    });
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    this.stats.passes++;
  }

  // ──────────────────────────────────────────────────────── grade / input ──

  private curveTexture(clipId: string, g: Grade): WebGLTexture {
    // Curve arrays are replaced (never mutated) when edited, so identity is a cheap dirty check.
    const gl = this.gl;
    let entry = this.curveCache.get(clipId);
    if (entry && entry.curves === g.curves && entry.hueSat === g.hueSat && entry.hueHue === g.hueHue && entry.lumSat === g.lumSat) {
      return entry.tex;
    }
    if (!entry) {
      if (this.curveCache.size > 400) {
        for (const [id, e] of this.curveCache) {
          if (!this.project?.clips[id]) {
            gl.deleteTexture(e.tex);
            this.curveCache.delete(id);
          }
        }
      }
      entry = { tex: this.glx.createTexture(), curves: g.curves, hueSat: g.hueSat, hueHue: g.hueHue, lumSat: g.lumSat };
      this.curveCache.set(clipId, entry);
    }
    entry.curves = g.curves;
    entry.hueSat = g.hueSat;
    entry.hueHue = g.hueHue;
    entry.lumSat = g.lumSat;
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, 2, 0, gl.RGBA, gl.FLOAT, bakeCurves(g));
    return entry.tex;
  }

  /**
   * Input transform (optional) + grade (optional) from `src` into `dst`.
   * `rot` un-rotates container rotation metadata while we are at it.
   */
  private gradePass(src: TextureSource | Img, dst: RenderTarget, L: ClipLayer, input: boolean, grade = true, rot = 0): void {
    const { glx } = this;
    const project = this.project!;
    const s = project.settings;
    const clip = L.clip;
    const hdrProject = isHdrMode(s.colorMode);
    const u: Record<string, number | number[] | Float32Array | WebGLTexture> = {
      u_src: src.tex,
      u_lumaW: this.lumaW,
      u_uvRot: rot / 90,
      u_inEnabled: 0,
      u_yuvEnabled: 0,
      u_texY: this.dummy2d,
      u_texU: this.dummy2d,
      u_texV: this.dummy2d,
      u_gradeEnabled: 0,
      u_curves: this.dummy2d,
      u_lut: this.dummy3d,
      u_curvesEnabled: 0,
      u_hueCurvesEnabled: 0,
      u_lutEnabled: 0,
      u_encPeak: 1,
    };

    if (input) {
      const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
      const space = resolveInputSpace(asset);
      const desc = INPUT_COLOR_SPACES[space];
      const yuv = (src as TextureSource).yuv;
      if (yuv) {
        u.u_yuvEnabled = 1;
        u.u_texY = yuv.y;
        u.u_texU = yuv.u;
        u.u_texV = yuv.v;
        u.u_yuvMat = yuv.matrix;
        u.u_yuvOffset = yuv.offset;
        u.u_yuvScale = yuv.scale;
      }
      // The 8-bit fast path hands us pixels the browser already converted to SDR sRGB, so HDR
      // sources only need their own transfer function when we decoded the raw planes ourselves.
      const rawHdr = isHdrSpace(space) && !!yuv;
      const effective = isHdrSpace(space) && !yuv ? INPUT_COLOR_SPACES.rec709 : desc;
      const needs = hdrProject || effective.transfer !== 'srgb' || effective.primaries !== 'rec709';
      if (needs) {
        u.u_inEnabled = 1;
        u.u_inTransfer = TRANSFER_IDS[effective.transfer] ?? 0;
        u.u_inMat = toGlMat3(gamutMatrix(effective.primaries, workingPrimaries(s.colorMode)));
        u.u_hlgGamma = 1.2;
        let scale = 1;
        if (effective.transfer === 'pq') scale = 10000 / s.refWhiteNits;
        else if (effective.transfer === 'hlg') scale = 1000 / s.refWhiteNits;
        u.u_inScale = scale;
        // Scene-referred or HDR material landing on an SDR timeline needs highlight roll-off.
        const wide = rawHdr || isLogSpace(space) || effective.transfer === 'linear';
        u.u_inToneMap = !hdrProject && wide ? (s.toneMap !== 'none' ? (TONEMAP_IDS[s.toneMap] ?? 2) : 2) : 0;
        u.u_inPeak = Math.max(1, s.peakNits / s.refWhiteNits);
      }
    }

    const g = clip.grade;
    if (grade && g && !isNeutralGrade(g)) {
      u.u_gradeEnabled = 1;
      Object.assign(u, gradeUniforms(g, this.lumaW));
      // In HDR projects the curves / wheels span the whole range up to mastering peak.
      u.u_encPeak = hdrProject ? linearToSrgb(Math.max(1, s.peakNits / s.refWhiteNits)) : 1;
      const rgb = hasRgbCurves(g);
      const hue = hasHueCurves(g);
      if (rgb || hue) {
        u.u_curves = this.curveTexture(clip.id, g);
        u.u_curvesEnabled = rgb ? 1 : 0;
        u.u_hueCurvesEnabled = hue ? 1 : 0;
      }
      if (g.lutId) {
        const lut = this.provider!.getLut(g.lutId);
        if (lut) {
          u.u_lut = lut.tex;
          u.u_lutSize = lut.size;
          u.u_lutIntensity = g.lutIntensity;
          u.u_lutEnabled = 1;
        }
      }
    }
    glx.pass(this.gradeProgram, dst, u);
    this.stats.passes++;
  }

  // ───────────────────────────────────────────────────────────── read-back ──

  /** RGBA8 pixels of the current canvas-space output, rows top-first. Blocks; export / stills only. */
  readPixels(): Uint8Array {
    const { gl, glx } = this;
    const out = new Uint8Array(this.width * this.height * 4);
    if (!this.last || !this.project) return out;
    const wasFloat = glx.useFloat;
    glx.useFloat = false;
    const rt = glx.acquire(this.width, this.height);
    glx.pass(this.outputProgram, rt, { u_tex: this.last.tex, ...this.outputUniforms(this.lastOutput, false), u_dither: wasFloat ? 1 / 255 : 0 });
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    glx.release(rt);
    glx.useFloat = wasFloat;
    return out;
  }

  /**
   * 10-bit 4:2:0 planar Y'CbCr (I420P10 layout, little-endian uint16) of the last frame, encoded with
   * the given HDR transfer. Used for HDR10 / HLG export.
   */
  readYuv10(mode: 'pq' | 'hlg'): Uint16Array {
    const { gl, glx } = this;
    const W = this.width;
    const H = this.height;
    const cw = W >> 1;
    const chH = H >> 1;
    const out = new Uint16Array(W * H + 2 * cw * chH);
    if (!this.last || !this.project) return out;
    const wasFloat = glx.useFloat;

    // 1. HDR code values in a float target.
    const rgb = glx.acquire(W, H);
    glx.pass(this.outputProgram, rgb, { u_tex: this.last.tex, ...this.outputUniforms(mode, false), u_dither: 0 });

    // 2. Pack to 8-bit pairs.
    glx.useFloat = false;
    if (!this.packTargets || this.packTargets.y.width !== W || this.packTargets.y.height !== H) {
      this.packTargets = { y: glx.acquire(W, H), c: glx.acquire(cw, chH) };
    }
    const kr = 0.2627;
    const kb = 0.0593;
    const k = [kr, 1 - kr - kb, kb];
    const { y, c } = this.packTargets;
    glx.pass(this.yuvProgram, y, { u_tex: rgb.tex, u_plane: 0, u_kr_kg_kb: k, u_texel: [1 / W, 1 / H] });
    const yBytes = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, yBytes);
    glx.pass(this.yuvProgram, c, { u_tex: rgb.tex, u_plane: 1, u_kr_kg_kb: k, u_texel: [1 / W, 1 / H] });
    const cBytes = new Uint8Array(cw * chH * 4);
    gl.readPixels(0, 0, cw, chH, gl.RGBA, gl.UNSIGNED_BYTE, cBytes);
    glx.useFloat = wasFloat;
    glx.release(rgb);

    // 3. Reassemble uint16 planes.
    const n = W * H;
    for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = yBytes[j] | (yBytes[j + 1] << 8);
    const m = cw * chH;
    const uOff = n;
    const vOff = n + m;
    for (let i = 0, j = 0; i < m; i++, j += 4) {
      out[uOff + i] = cBytes[j] | (cBytes[j + 1] << 8);
      out[vOff + i] = cBytes[j + 2] | (cBytes[j + 3] << 8);
    }
    return out;
  }

  /**
   * Small display-referred copy of the last frame for scopes. Asynchronous (PBO + fence) so it never
   * stalls the render loop. Resolves null when a read is already in flight.
   */
  async readScope(maxWidth = 320): Promise<{ data: Uint8Array; width: number; height: number; pq: boolean } | null> {
    const { gl, glx } = this;
    if (!this.last || !this.project || this.scopeBusy || glx.contextLost) return null;
    const w = Math.max(2, Math.min(maxWidth, this.width));
    const h = Math.max(2, Math.round((w * this.height) / this.width));
    const hdr = isHdrMode(this.project.settings.colorMode);
    const wasFloat = glx.useFloat;
    glx.useFloat = false;
    if (!this.scopeTarget || this.scopeTarget.width !== w || this.scopeTarget.height !== h) {
      this.scopeTarget = glx.acquire(w, h);
    }
    glx.useFloat = wasFloat;
    glx.pass(this.outputProgram, this.scopeTarget, {
      u_tex: this.last.tex,
      ...this.outputUniforms(hdr ? 'pq' : 'display', false),
      u_dither: 0,
    });
    if (!this.scopePbo) this.scopePbo = gl.createBuffer();
    const size = w * h * 4;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopePbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return null;
    gl.flush();
    this.scopeBusy = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = () => {
          if (glx.contextLost) return reject(new Error('context lost'));
          const st = gl.clientWaitSync(sync, 0, 0);
          if (st === gl.WAIT_FAILED) return reject(new Error('sync failed'));
          if (st === gl.TIMEOUT_EXPIRED) return void setTimeout(poll, 4);
          resolve();
        };
        poll();
      });
      const data = new Uint8Array(size);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopePbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      return { data, width: w, height: h, pq: hdr };
    } catch {
      return null;
    } finally {
      gl.deleteSync(sync);
      this.scopeBusy = false;
    }
  }

  dispose(): void {
    this.glx.release(this.last);
    this.last = null;
    this.glx.dispose();
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}

const clampCrop = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
