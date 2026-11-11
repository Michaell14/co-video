/**
 * SourceManager: turns clips into GPU textures.
 *
 *  - Video: one decode cursor per clip. A cursor owns a forward-running WebCodecs decode pipeline
 *    (via Mediabunny) with a small look-ahead buffer. Sequential playback therefore never seeks;
 *    scrubbing restarts the pipeline at the nearest keyframe.
 *  - Images: decoded once into an ImageBitmap and uploaded.
 *  - Generators: rasterised with Canvas 2D at render resolution, cached by content.
 *  - LUTs: parsed into 3D float textures.
 *
 * `getTexture` is synchronous and returns whatever is ready. `prepare` kicks off the work for a frame
 * and — in exact mode — resolves only once every layer has precisely the right picture.
 */
import { VideoSampleSink, type VideoSample } from 'mediabunny';

type PlaneLayout = { offset: number; stride: number };
import { isHdrMode, isHdrSpace, resolveInputSpace, type ClipLayer, type FrameDesc, type Project } from '@tandem/core';
import type { Glx } from '../gl/glx';
import type { SourceProvider, TextureSource } from '../gl/compositor';
import { parseCubeLut } from '../gl/grade';
import { fontSpec, generatorKey, rasterizeGenerator } from '../generators';
import type { MediaLibrary, OpenMedia } from './library';

const EPS = 1e-4;

/**
 * Containers round timestamps (WebM to whole milliseconds), so a frame that should start exactly at
 * the requested time can claim to start a fraction later. Accept a start up to 2 ms — but never
 * more than a third of a frame — in the future.
 */
const tolerance = (s: VideoSample): number => Math.min(0.002, Math.max(s.duration, 0.004) * 0.33);

// ─────────────────────────────────────────────────── high bit-depth planes ──

interface PlaneSet {
  data: Uint8Array;
  layout: PlaneLayout[];
  width: number;
  height: number;
  chromaW: number;
  chromaH: number;
  bits: number;
  fullRange: boolean;
  matrix: string | null;
}

const PLANAR_FORMATS: Record<string, { bits: number; subX: number; subY: number }> = {
  I420P10: { bits: 10, subX: 2, subY: 2 },
  I420P12: { bits: 12, subX: 2, subY: 2 },
  I422P10: { bits: 10, subX: 2, subY: 1 },
  I422P12: { bits: 12, subX: 2, subY: 1 },
  I444P10: { bits: 10, subX: 1, subY: 1 },
  I444P12: { bits: 12, subX: 1, subY: 1 },
};

/** Y'CbCr → R'G'B' (column-major), including limited-range expansion. */
function yuvToRgb(matrix: string | null, bits: number, fullRange: boolean): { m: Float32Array; offset: [number, number, number] } {
  const [kr, kb] = matrix === 'bt2020-ncl' || matrix === 'bt2020-cl' ? [0.2627, 0.0593] : matrix === 'smpte170m' || matrix === 'bt470bg' ? [0.299, 0.114] : [0.2126, 0.0722];
  const kg = 1 - kr - kb;
  const max = (1 << bits) - 1;
  const unit = 1 << (bits - 8);
  const sy = fullRange ? 1 : max / (219 * unit);
  const sc = fullRange ? 1 : max / (224 * unit);
  const offset: [number, number, number] = fullRange ? [0, (128 * unit) / max, (128 * unit) / max] : [(16 * unit) / max, (128 * unit) / max, (128 * unit) / max];
  const rCr = 2 * (1 - kr);
  const bCb = 2 * (1 - kb);
  const gCb = (-2 * kb * (1 - kb)) / kg;
  const gCr = (-2 * kr * (1 - kr)) / kg;
  // Rows: R = sy·Y + rCr·sc·Cr, G = sy·Y + gCb·sc·Cb + gCr·sc·Cr, B = sy·Y + bCb·sc·Cb
  return { m: new Float32Array([sy, sy, sy, 0, gCb * sc, bCb * sc, rCr * sc, gCr * sc, 0]), offset };
}

// ───────────────────────────────────────────────────────── video cursor ──

class VideoCursor {
  readonly tex: WebGLTexture;
  width = 0;
  height = 0;
  lastUsed = 0;
  /** Set when the media cannot be decoded at all. */
  failed = false;

  private media: OpenMedia | null = null;
  private sink: VideoSampleSink | null = null;
  private buffer: VideoSample[] = [];
  private pumpId = 0;
  private pumping = false;
  private pumpEnded = false;
  private want = 0;
  private pumpTarget = 0;
  private pumpStartedAt = 0;
  private uploadedTs = NaN;
  private waiters: (() => void)[] = [];
  private resume: (() => void) | null = null;
  private opening: Promise<void> | null = null;
  private disposed = false;
  /** Decode HDR sources at full bit depth (planar read-back) instead of the browser's 8-bit path. */
  private raw = false;
  private rawBroken = false;
  private readonly planes = new WeakMap<VideoSample, PlaneSet>();
  private planeTex: { y: WebGLTexture; u: WebGLTexture; v: WebGLTexture } | null = null;
  private yuvInfo: TextureSource['yuv'] | undefined;

  constructor(
    private readonly glx: Glx,
    private readonly library: MediaLibrary,
    readonly assetId: string,
    private reverse: boolean,
    private readonly onFrame: () => void,
  ) {
    this.tex = glx.createTexture();
  }

  /** Switch between forward and backward stepping (reverse clips, or J-shuttle). */
  setReverse(reverse: boolean): void {
    this.reverse = reverse;
  }

  get scale(): number {
    return this.media?.videoScale ?? 1;
  }

  get rotation(): 0 | 90 | 180 | 270 {
    return this.media?.rotation ?? 0;
  }

  /** Planar textures for the frame last uploaded, when the high bit-depth path is active. */
  get yuv(): TextureSource['yuv'] | undefined {
    return this.yuvInfo;
  }

  /** Ask for full bit-depth frames. Takes effect from the next decoded frame. */
  setRaw(raw: boolean): void {
    if (raw === this.raw) return;
    this.raw = raw;
    if (!raw) this.yuvInfo = undefined;
    // Frames already buffered were prepared for the other path; decode afresh.
    this.uploadedTs = NaN;
    if (this.sink && !this.disposed) this.startPump(this.want);
  }

  /** Copy a sample's planes off the decoder so they can be uploaded synchronously later. */
  private async capturePlanes(sample: VideoSample): Promise<void> {
    const fmt = sample.format ? PLANAR_FORMATS[sample.format] : undefined;
    if (!fmt) return;
    try {
      const data = new Uint8Array(sample.allocationSize());
      const layout = await sample.copyTo(data);
      const cs = sample.colorSpace;
      this.planes.set(sample, {
        data,
        layout,
        width: sample.codedWidth,
        height: sample.codedHeight,
        chromaW: Math.ceil(sample.codedWidth / fmt.subX),
        chromaH: Math.ceil(sample.codedHeight / fmt.subY),
        bits: fmt.bits,
        fullRange: cs.fullRange === true,
        matrix: cs.matrix,
      });
    } catch (err) {
      // Some GPU-backed frames cannot be read back; fall back to the 8-bit path for this clip.
      console.warn('[video] planar read-back unavailable, using 8-bit decode', err);
      this.rawBroken = true;
    }
  }

  private uploadPlanes(p: PlaneSet): void {
    const gl = this.glx.gl;
    if (!this.planeTex) this.planeTex = { y: this.glx.createTexture(), u: this.glx.createTexture(), v: this.glx.createTexture() };
    const put = (tex: WebGLTexture, plane: PlaneLayout, w: number, h: number) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, plane.stride >> 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, p.data, plane.offset);
    };
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    put(this.planeTex.y, p.layout[0], p.width, p.height);
    put(this.planeTex.u, p.layout[1], p.chromaW, p.chromaH);
    put(this.planeTex.v, p.layout[2], p.chromaW, p.chromaH);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    const max = (1 << p.bits) - 1;
    const { m, offset } = yuvToRgb(p.matrix, p.bits, p.fullRange);
    this.yuvInfo = { ...this.planeTex, matrix: m, offset, pack: [255 / max, 65280 / max] };
  }

  get hasPicture(): boolean {
    return this.width > 0;
  }

  private maxBuffered(): number {
    if (!this.reverse) return 4;
    // Reverse playback keeps a whole run of frames; budget ~256 MB of decoded pictures.
    const px = Math.max(1, this.width * this.height);
    return Math.max(8, Math.min(48, Math.floor((256 * 1024 * 1024) / (px * 1.5))));
  }

  private ensureOpen(): Promise<void> {
    if (!this.opening) {
      this.opening = this.library.get(this.assetId).then((m) => {
        if (this.disposed) return;
        if (!m || !m.video || !m.videoDecodable) {
          this.failed = true;
          this.notify();
          return;
        }
        this.media = m;
        this.sink = new VideoSampleSink(m.video);
      });
    }
    return this.opening;
  }

  /** The buffered frame that should be on screen at `t`, if we have it. */
  private pick(t: number): VideoSample | null {
    let best: VideoSample | null = null;
    for (const s of this.buffer) {
      if (s.timestamp <= t + tolerance(s)) best = s;
      else break;
    }
    return best;
  }

  private covers(t: number): boolean {
    const s = this.pick(t);
    if (!s) return false;
    // Half-open interval [start, end), with the same forward tolerance `pick` uses applied to both
    // ends. Without it a frame would also "cover" the instant its successor starts, and an export
    // that outran the decoder would repeat a frame.
    if (t + tolerance(s) < s.timestamp + Math.max(s.duration, 1e-3)) return true;
    // The last frame of a file has no successor, so it holds for any later time.
    return this.pumpEnded && s === this.buffer[this.buffer.length - 1];
  }

  /** Whether the running decode pipeline will produce (or already holds) the frame for `t`. */
  private inRange(t: number): boolean {
    const lookahead = this.reverse ? 0.05 : 1.5;
    if (!this.buffer.length) {
      const span = this.reverse ? 0.8 : lookahead;
      return this.pumping && t >= this.pumpTarget - EPS && t <= this.pumpTarget + span;
    }
    const first = this.buffer[0];
    const last = this.buffer[this.buffer.length - 1];
    if (t < first.timestamp - EPS) return false;
    const end = last.timestamp + Math.max(last.duration, 1e-3);
    if (t <= end + EPS) return true;
    // Past the buffered frames: fine if decoding is still heading there, or the file simply ended.
    return this.pumpEnded || (this.pumping && t <= end + lookahead);
  }

  /** Ask for the frame at media time `t` (seconds, relative to the first video sample). */
  request(t: number): void {
    this.want = t;
    this.lastUsed = performance.now();
    if (this.failed || this.disposed) return;
    if (!this.sink) {
      void this.ensureOpen().then(() => {
        if (this.sink && !this.disposed) this.request(this.want);
      });
      return;
    }
    if (this.inRange(t)) {
      if (!this.reverse) this.trim(t);
      this.resume?.();
      return;
    }
    // A seek is already in flight and has not produced anything yet: let it land first so fast
    // scrubbing always shows *something*. The pump re-checks `want` when its first frame arrives.
    if (this.pumping && this.buffer.length === 0 && performance.now() - this.pumpStartedAt < 300) return;
    this.startPump(t);
  }

  /** Drop frames that are entirely in the past. */
  private trim(t: number): void {
    while (this.buffer.length > 1 && this.buffer[1].timestamp <= t + tolerance(this.buffer[1])) {
      this.buffer.shift()!.close();
    }
  }

  private startPump(t: number): void {
    const id = ++this.pumpId;
    for (const s of this.buffer) s.close();
    this.buffer = [];
    this.pumping = true;
    this.pumpEnded = false;
    this.pumpStartedAt = performance.now();
    this.resume?.();
    const sink = this.sink!;
    const offset = this.media!.videoStart;
    this.pumpTarget = Math.max(0, this.reverse ? t - 0.75 : t);
    const start = this.pumpTarget + offset;
    void (async () => {
      try {
        for await (const sample of sink.samples(start)) {
          if (id !== this.pumpId || this.disposed) {
            sample.close();
            return;
          }
          sample.setTimestamp(sample.timestamp - offset);
          if (this.raw && !this.rawBroken) {
            await this.capturePlanes(sample);
            if (id !== this.pumpId || this.disposed) {
              sample.close();
              return;
            }
          }
          this.buffer.push(sample);
          this.notify();
          if (id !== this.pumpId || this.disposed) return;
          if (!this.inRange(this.want)) {
            // The playhead moved on while we were seeking.
            this.startPump(this.want);
            return;
          }
          // Back-pressure: wait while we are far enough ahead of what is being asked for.
          while (id === this.pumpId && !this.disposed && this.full()) {
            await new Promise<void>((r) => (this.resume = r));
            this.resume = null;
          }
          if (id !== this.pumpId || this.disposed) return;
        }
        if (id === this.pumpId) {
          this.pumpEnded = true;
          this.pumping = false;
          this.notify();
        }
      } catch (err) {
        if (id === this.pumpId && !this.disposed) {
          console.warn('[video] decode error', err);
          this.pumping = false;
          this.pumpEnded = true;
          this.notify();
        }
      }
    })();
  }

  /** Should the decode pipeline pause? */
  private full(): boolean {
    const max = this.maxBuffered();
    if (this.reverse) {
      // Decode up to just past the wanted frame, then hold the whole run for backwards stepping.
      const last = this.buffer[this.buffer.length - 1];
      if (this.buffer.length > max) this.buffer.shift()!.close();
      return !!last && last.timestamp > this.want + 0.1;
    }
    let n = 0;
    for (const s of this.buffer) if (s.timestamp > this.want + EPS) n++;
    return n >= max;
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
    this.onFrame();
  }

  /** Resolve once the exact frame for `t` is buffered (or decoding is impossible). */
  async ready(t: number, timeoutMs = 8000): Promise<void> {
    this.request(t);
    const deadline = performance.now() + timeoutMs;
    while (!this.failed && !this.disposed && !this.covers(t)) {
      if (performance.now() > deadline) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      // Reverse cursors and end-of-stream may need a restart to reach `t`.
      if (!this.pumping && !this.covers(t) && !this.failed) this.request(t);
    }
  }

  /** Upload the best available frame for `t` and return whether there is any picture at all. */
  upload(t: number): boolean {
    this.lastUsed = performance.now();
    const s = this.pick(t) ?? (this.buffer.length && !this.hasPicture ? this.buffer[0] : null);
    if (!s) return this.hasPicture;
    if (s.timestamp === this.uploadedTs) return true;
    const gl = this.glx.gl;
    const planes = this.raw && !this.rawBroken ? this.planes.get(s) : undefined;
    if (planes) {
      this.uploadPlanes(planes);
      this.width = planes.width;
      this.height = planes.height;
      this.uploadedTs = s.timestamp;
      return true;
    }
    this.yuvInfo = undefined;
    try {
      const src = s.toCanvasImageSource();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      this.width = s.codedWidth;
      this.height = s.codedHeight;
      this.uploadedTs = s.timestamp;
      return true;
    } catch (err) {
      console.warn('[video] upload failed', err);
      return this.hasPicture;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pumpId++;
    for (const s of this.buffer) s.close();
    this.buffer = [];
    this.resume?.();
    this.notify();
    const gl = this.glx.gl;
    gl.deleteTexture(this.tex);
    if (this.planeTex) {
      gl.deleteTexture(this.planeTex.y);
      gl.deleteTexture(this.planeTex.u);
      gl.deleteTexture(this.planeTex.v);
    }
  }
}

// ────────────────────────────────────────────────────────────── manager ──

/**
 * HDR sources are decoded at full bit depth only on HDR timelines. On SDR timelines the browser's
 * own (GPU, zero-copy) HDR→SDR conversion is both faster and exactly what the viewer expects.
 */
function wantsRaw(project: Project, assetId: string): boolean {
  if (!isHdrMode(project.settings.colorMode)) return false;
  return isHdrSpace(resolveInputSpace(project.assets[assetId]));
}

interface ImageEntry {
  tex: WebGLTexture | null;
  width: number;
  height: number;
  state: 'loading' | 'ready' | 'failed';
  promise: Promise<void>;
}

interface GenEntry {
  tex: WebGLTexture;
  width: number;
  height: number;
  used: number;
}

interface LutEntry {
  tex: WebGLTexture | null;
  size: number;
  state: 'loading' | 'ready' | 'failed';
  promise: Promise<void>;
}

export class SourceManager implements SourceProvider {
  /** Called whenever new pixels become available, so a paused viewer can redraw. */
  onInvalidate: () => void = () => {};

  private readonly cursors = new Map<string, VideoCursor>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly gens = new Map<string, GenEntry>();
  private readonly luts = new Map<string, LutEntry>();
  private fontEpoch = 0;
  /** +1 when the timeline plays forward, -1 when shuttling backwards. */
  direction: 1 | -1 = 1;
  private readonly fontsLoading = new Set<string>();
  private tick = 0;
  private disposed = false;
  private readonly onFontsDone = () => {
    this.fontEpoch++;
    this.invalidate();
  };

  constructor(
    private readonly glx: Glx,
    readonly library: MediaLibrary,
  ) {
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.addEventListener('loadingdone', this.onFontsDone);
    }
  }

  private invalidate = (): void => {
    if (!this.disposed) this.onInvalidate();
  };

  // ── SourceProvider ────────────────────────────────────────────────────

  getTexture(layer: ClipLayer, project: Project, frameW: number, frameH: number): TextureSource | null {
    const clip = layer.clip;
    switch (clip.type) {
      case 'video': {
        if (!clip.assetId) return null;
        const cur = this.cursor(clip.id, clip.assetId, clip.reverse);
        cur.setRaw(wantsRaw(project, clip.assetId));
        if (!cur.upload(layer.sourceTime)) return null;
        // Layout is in the original's pixels even when the texture is a smaller proxy.
        return { tex: cur.tex, width: cur.width * cur.scale, height: cur.height * cur.scale, rotation: cur.rotation, yuv: cur.yuv };
      }
      case 'image': {
        if (!clip.assetId) return null;
        const img = this.image(clip.assetId);
        return img.state === 'ready' && img.tex ? { tex: img.tex, width: img.width, height: img.height } : null;
      }
      case 'text':
      case 'shape':
      case 'solid':
        return this.generator(layer, frameW, frameH);
      default:
        return null;
    }
  }

  getLut(assetId: string): { tex: WebGLTexture; size: number } | null {
    const e = this.lut(assetId);
    return e.state === 'ready' && e.tex ? { tex: e.tex, size: e.size } : null;
  }

  // ── preparation ───────────────────────────────────────────────────────

  /**
   * Start loading everything `desc` needs. With `exact` the promise resolves only when each video
   * layer has the precise frame buffered and all stills, fonts and LUTs are loaded.
   */
  async prepare(project: Project, desc: FrameDesc, exact: boolean): Promise<void> {
    const waits: Promise<unknown>[] = [];
    const visit = (l: ClipLayer | null) => {
      if (!l) return;
      const clip = l.clip;
      if (clip.type === 'video' && clip.assetId) {
        const cur = this.cursor(clip.id, clip.assetId, clip.reverse);
        cur.setRaw(wantsRaw(project, clip.assetId));
        if (exact) waits.push(cur.ready(l.sourceTime));
        else cur.request(l.sourceTime);
      } else if (clip.type === 'image' && clip.assetId) {
        const img = this.image(clip.assetId);
        if (exact) waits.push(img.promise);
      } else if (clip.type === 'text' && clip.text) {
        const p = this.ensureFont(fontSpec(clip.text, 32), clip.text.content);
        if (exact && p) waits.push(p);
      }
      if (clip.grade?.lutId) {
        const lut = this.lut(clip.grade.lutId);
        if (exact) waits.push(lut.promise);
      }
    };
    for (const layer of desc.layers) {
      if (layer.kind === 'clip') visit(layer.layer);
      else {
        visit(layer.a);
        visit(layer.b);
      }
    }
    if (waits.length) await Promise.all(waits);
  }

  /** Warm up a cursor ahead of time (clips that are about to start during playback). */
  prewarm(clipId: string, assetId: string, reverse: boolean, sourceTime: number): void {
    const existing = this.cursors.get(clipId);
    if (existing && existing.hasPicture) return;
    this.cursor(clipId, assetId, reverse).request(sourceTime);
  }

  /** Free decoders that have not been drawn recently. Call once per rendered frame. */
  collect(maxIdleMs = 4000): void {
    if (++this.tick % 30 !== 0) return;
    const now = performance.now();
    for (const [id, cur] of this.cursors) {
      if (now - cur.lastUsed > maxIdleMs) {
        cur.dispose();
        this.cursors.delete(id);
      }
    }
    if (this.gens.size > 96) {
      const entries = Array.from(this.gens.entries()).sort((a, b) => a[1].used - b[1].used);
      for (const [key, e] of entries.slice(0, this.gens.size - 64)) {
        this.glx.gl.deleteTexture(e.tex);
        this.gens.delete(key);
      }
    }
  }

  /** Drop every decoder (e.g. when an asset's backing file changes). */
  resetAsset(assetId: string): void {
    for (const [id, cur] of this.cursors) {
      if (cur.assetId === assetId) {
        cur.dispose();
        this.cursors.delete(id);
      }
    }
    const img = this.images.get(assetId);
    if (img?.state === 'failed') this.images.delete(assetId);
    const lut = this.luts.get(assetId);
    if (lut?.state === 'failed') this.luts.delete(assetId);
    this.library.invalidate(assetId);
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.removeEventListener('loadingdone', this.onFontsDone);
    }
    const gl = this.glx.gl;
    for (const c of this.cursors.values()) c.dispose();
    for (const i of this.images.values()) if (i.tex) gl.deleteTexture(i.tex);
    for (const g of this.gens.values()) gl.deleteTexture(g.tex);
    for (const l of this.luts.values()) if (l.tex) gl.deleteTexture(l.tex);
    this.cursors.clear();
    this.images.clear();
    this.gens.clear();
    this.luts.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private cursor(clipId: string, assetId: string, reverse: boolean): VideoCursor {
    let cur = this.cursors.get(clipId);
    if (cur && cur.assetId !== assetId) {
      cur.dispose();
      cur = undefined;
    }
    const backwards = reverse !== this.direction < 0;
    if (!cur) {
      cur = new VideoCursor(this.glx, this.library, assetId, backwards, this.invalidate);
      this.cursors.set(clipId, cur);
    } else cur.setReverse(backwards);
    return cur;
  }

  private image(assetId: string): ImageEntry {
    let e = this.images.get(assetId);
    if (e) return e;
    const entry: ImageEntry = { tex: null, width: 0, height: 0, state: 'loading', promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        const blob = await this.library.blob(assetId);
        if (!blob) throw new Error('unavailable');
        const max = this.glx.caps.maxTextureSize;
        let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
        if (bmp.width > max || bmp.height > max) {
          const k = Math.min(max / bmp.width, max / bmp.height);
          const scaled = await createImageBitmap(bmp, {
            resizeWidth: Math.floor(bmp.width * k),
            resizeHeight: Math.floor(bmp.height * k),
            resizeQuality: 'high',
            premultiplyAlpha: 'premultiply',
          });
          bmp.close();
          bmp = scaled;
        }
        if (this.disposed) return;
        const gl = this.glx.gl;
        const tex = this.glx.createTexture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        entry.tex = tex;
        entry.width = bmp.width;
        entry.height = bmp.height;
        entry.state = 'ready';
        bmp.close();
      } catch (err) {
        entry.state = 'failed';
        console.warn(`[image] ${assetId}`, err);
        // Retry later: the file may still be syncing from a collaborator.
        setTimeout(() => {
          if (this.images.get(assetId) === entry) this.images.delete(assetId);
          this.invalidate();
        }, 3000);
      }
      this.invalidate();
    })();
    this.images.set(assetId, entry);
    e = entry;
    return e;
  }

  private lut(assetId: string): LutEntry {
    let e = this.luts.get(assetId);
    if (e) return e;
    const entry: LutEntry = { tex: null, size: 0, state: 'loading', promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        const blob = await this.library.blob(assetId);
        if (!blob) throw new Error('unavailable');
        const parsed = parseCubeLut(await blob.text());
        if (this.disposed) return;
        const gl = this.glx.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_3D, tex);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, parsed.size, parsed.size, parsed.size, 0, gl.RGB, gl.FLOAT, parsed.data);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        entry.tex = tex;
        entry.size = parsed.size;
        entry.state = 'ready';
      } catch (err) {
        entry.state = 'failed';
        console.warn(`[lut] ${assetId}`, err);
      }
      this.invalidate();
    })();
    this.luts.set(assetId, entry);
    e = entry;
    return e;
  }

  private ensureFont(spec: string, sample: string): Promise<unknown> | null {
    if (typeof document === 'undefined' || !document.fonts) return null;
    if (document.fonts.check(spec, sample)) return null;
    if (this.fontsLoading.has(spec)) return document.fonts.ready;
    this.fontsLoading.add(spec);
    return document.fonts
      .load(spec, sample)
      .catch(() => {})
      .finally(() => {
        this.fontsLoading.delete(spec);
        this.fontEpoch++;
        this.invalidate();
      });
  }

  private generator(layer: ClipLayer, frameW: number, frameH: number): TextureSource | null {
    const clip = layer.clip;
    if (clip.type === 'text' && clip.text) this.ensureFont(fontSpec(clip.text, 32), clip.text.content);
    const key = generatorKey(clip, frameW, frameH, layer.anim.chars, this.fontEpoch);
    if (!key) return null;
    let e = this.gens.get(key);
    if (!e) {
      const raster = rasterizeGenerator(clip, frameW, frameH, layer.anim.chars);
      if (!raster) return null;
      const gl = this.glx.gl;
      const tex = this.glx.createTexture();
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, raster.canvas as TexImageSource);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      e = { tex, width: raster.width, height: raster.height, used: 0 };
      this.gens.set(key, e);
    }
    e.used = performance.now();
    return { tex: e.tex, width: e.width, height: e.height };
  }
}
