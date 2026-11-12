/**
 * SourceManager: turns clips into GPU textures.
 *
 *  - Video: one decode cursor per clip. A cursor owns a forward-running WebCodecs decode pipeline
 *    (via Mediabunny) with a small look-ahead buffer. Sequential playback therefore never seeks;
 *    scrubbing restarts the pipeline at the nearest keyframe. Going backwards (a reversed clip,
 *    J-shuttle, stepping back while paused) is served from short runs decoded behind the playhead.
 *  - Images: decoded at the resolution the frame being drawn can show and uploaded; the least
 *    recently drawn are released when together they outgrow a memory budget.
 *  - Generators: rasterised with Canvas 2D at render resolution, cached by content.
 *  - LUTs: parsed into 3D float textures.
 *
 * `getTexture` is synchronous and returns whatever is ready. `prepare` kicks off the work for a frame
 * and — in exact mode — resolves only once every layer has precisely the right picture.
 */
import { VideoSampleSink, type VideoSample } from 'mediabunny';

type PlaneLayout = { offset: number; stride: number };
import {
  isHdrMode,
  isHdrSpace,
  resolveInputSpace,
  type Clip,
  type ClipLayer,
  type FrameDesc,
  type Project,
} from '@tandem/core';
import type { Glx } from '../gl/glx';
import type { SourceProvider, TextureSource } from '../gl/compositor';
import { parseCubeLut } from '../gl/grade';
import { fontEpoch, fontSpec, generatorKey, onFontsLoaded, rasterizeGenerator } from '../generators';
import type { MediaFault, MediaLibrary, OpenMedia } from './library';

const EPS = 1e-4;
const MIB = 1024 * 1024;

/** How long to wait before asking again for media that is not available (a peer may be uploading it). */
const RETRY_MS = 2000;
/** Frames decoded ahead of the playhead. */
const AHEAD = 4;
/** Going backwards, each decode run covers this many seconds behind the wanted time. */
const BACK_RUN = 0.75;
/** Going backwards, the next run starts when this little of the current one is left to show. */
const BACK_LEAD = 0.4;
/** Picture kept behind a playhead that may step back: at most this many seconds and frames. */
const HISTORY = 0.5;
const HISTORY_FRAMES = 12;
/** Frames a cursor cannot do without: the one on screen, the one after it and the look-ahead. */
const MIN_HELD = AHEAD + 2;
/** A decoder that delivers nothing for this long while its frames are held is taken to want them back. */
const STARVED_MS = 600;
/** Given frames back, a decoder that was waiting for them delivers within this time. */
const CONFIRM_MS = 250;
/** A decoder that stops before its first frame is started again after these waits, then given up on. */
const RESTART_MS = [100, 400];
/** A frame further than this (seconds) from where a decoder gave up is in another part of the file. */
const ELSEWHERE = 1.5;

/** Why a clip's media could not be shown as asked. */
export type SourceFault = MediaFault | 'undecodable' | 'timeout' | 'decode-error';

/** A layer that `SourceManager.prepare` could not get exactly right. */
export interface SourceProblem {
  clipId: string;
  assetId: string;
  /** What the clip needed from the asset. */
  part: 'video' | 'image' | 'lut';
  /**
   * `missing`: the file is neither on this device nor on the server. `unreadable`: it is there but
   * could not be opened (damaged, not media, refused by the server). `undecodable`: it opens, and
   * this browser cannot decode what is in it. `timeout`: the frame did not arrive in time.
   * `decode-error`: decoding stopped part-way through the file, or would not start there at all.
   */
  reason: SourceFault;
}

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
function yuvToRgb(
  matrix: string | null,
  bits: number,
  fullRange: boolean,
): { m: Float32Array; offset: [number, number, number] } {
  const [kr, kb] =
    matrix === 'bt2020-ncl' || matrix === 'bt2020-cl'
      ? [0.2627, 0.0593]
      : matrix === 'smpte170m' || matrix === 'bt470bg'
        ? [0.299, 0.114]
        : [0.2126, 0.0722];
  const kg = 1 - kr - kb;
  const max = (1 << bits) - 1;
  const unit = 1 << (bits - 8);
  const sy = fullRange ? 1 : max / (219 * unit);
  const sc = fullRange ? 1 : max / (224 * unit);
  const offset: [number, number, number] = fullRange
    ? [0, (128 * unit) / max, (128 * unit) / max]
    : [(16 * unit) / max, (128 * unit) / max, (128 * unit) / max];
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
  /** Size of the picture on `tex` in square pixels, which is what layout works in. */
  width = 0;
  height = 0;
  lastUsed = 0;
  /** The `SourceManager.prepare` pass that last asked for this cursor. */
  pass = 0;
  /** Counts uploads into `tex`, so work derived from its pixels is redone only when they change. */
  version = 0;
  /**
   * Why there is no picture: the file cannot be found (asked for again shortly), opened or decoded,
   * or its decoder gave up before the first frame (`decode-error`, see `stopped`).
   */
  problem: MediaFault | 'undecodable' | 'decode-error' | null = null;

  private media: OpenMedia | null = null;
  private sink: VideoSampleSink | null = null;
  /** Decoded frames in presentation order, without gaps. */
  private buffer: VideoSample[] = [];
  /** Going backwards: the run being decoded in front of `buffer`, and where it starts. */
  private incoming: { from: number; frames: VideoSample[] } | null = null;
  /** Start of a buffer in front of which no run could be had: there is none, or it does not decode. */
  private floor = -1;
  private pumpId = 0;
  private pumping = false;
  private pumpEnded = false;
  /** Decoding stopped with an error before the end of the file. */
  private broken = false;
  private want = 0;
  /** The pump in flight yields frames from `pumpFrom` on and was started to reach `pumpTo`. */
  private pumpFrom = 0;
  private pumpTo = 0;
  private pumpStartedAt = 0;
  /** Decoders in a row that stopped before their first frame. */
  private failures = 0;
  /** No decoder is started before this time (`performance.now()`): the last one has just failed. */
  private holdUntil = 0;
  /** Where the decoder gave up, or the time a viewer at rest has asked for last since then. */
  private gaveUpAt = 0;
  private uploadedTs = NaN;
  private waiters: (() => void)[] = [];
  private resume: (() => void) | null = null;
  private opening = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watch: ReturnType<typeof setTimeout> | null = null;
  /** A limit lowered on suspicion (see `starved`): the one it replaced, and when frames were let go. */
  private trial: { limit: number; at: number } | null = null;
  private disposed = false;
  private reverse = false;
  private sequential = false;
  private history = 0;
  private sharers = 1;
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
    /** Per asset, how many decoded frames its decoder lets go unreturned: shared by its cursors. */
    private readonly limits: Map<string, number>,
    private readonly onFrame: () => void,
  ) {
    this.tex = glx.createTexture();
  }

  /**
   * `reverse`: the wanted time runs backwards (a reversed clip, or J-shuttle). `sequential`: frames
   * are asked for strictly in order (playback, an export); otherwise some picture is kept behind
   * the playhead, for a viewer that may step back. `sharers`: how many cursors are at work, which
   * is how many ways the memory for kept frames is split.
   */
  setMode(reverse: boolean, sequential: boolean, sharers: number): void {
    this.reverse = reverse;
    this.sequential = sequential;
    this.history = sequential ? 0 : HISTORY;
    this.sharers = Math.max(1, sharers);
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

  /** Decoded frames held right now. */
  get held(): number {
    return this.buffer.length + (this.incoming?.frames.length ?? 0);
  }

  /** Ask for full bit-depth frames. Takes effect from the next decoded frame. */
  setRaw(raw: boolean): void {
    if (raw === this.raw) return;
    this.raw = raw;
    if (!raw) this.yuvInfo = undefined;
    // Frames already buffered were prepared for the other path; decode afresh. A decoder that is
    // being held back, or was given up on, has none: its next start is the one `request` makes.
    this.uploadedTs = NaN;
    if (this.sink && !this.disposed && !this.problem && performance.now() >= this.holdUntil)
      this.startPump(this.want);
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
    if (!this.planeTex)
      this.planeTex = {
        y: this.glx.createTexture(),
        u: this.glx.createTexture(),
        v: this.glx.createTexture(),
      };
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

  /** How many decoded pictures of this size fit in this cursor's share of `bytes`. */
  private fits(bytes: number): number {
    // 4:2:0 at 8 bits; the high bit-depth path also holds a 16-bit copy of every plane.
    const each = Math.max(1, this.width * this.height) * (this.raw && !this.rawBroken ? 4.5 : 1.5);
    return Math.floor(bytes / this.sharers / each);
  }

  /**
   * Open the asset's file, once: a file that will not open or decode stays that way until the asset
   * is reset, and `opening` stays set with it. Only a missing file is worth asking for again.
   */
  private open(): void {
    if (this.opening) return;
    this.opening = true;
    void this.library.open(this.assetId).then((m) => {
      if (this.disposed) return;
      const before = this.problem;
      if (typeof m === 'string') this.problem = m;
      else if (!m.video || !m.videoDecodable) this.problem = 'undecodable';
      else {
        this.problem = null;
        this.media = m;
        this.sink = new VideoSampleSink(m.video);
        this.request(this.want);
        return;
      }
      if (m === 'missing') {
        // A collaborator may still be uploading it. Ask to be drawn again in a while: whoever
        // still shows this clip then asks for its frame, and with that for its file. A clip the
        // playhead has left is not asked about any more.
        this.retry = setTimeout(() => {
          this.opening = false;
          this.onFrame();
        }, RETRY_MS);
      }
      if (this.problem !== before) this.notify();
    });
  }

  /** Index of the buffered frame that should be on screen at `t`, or -1. */
  private pick(t: number): number {
    let best = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const s = this.buffer[i];
      if (s.timestamp <= t + tolerance(s)) best = i;
      else break;
    }
    return best;
  }

  /** Whether the buffer holds exactly the frame that is on screen at `t`. */
  private covers(t: number): boolean {
    const i = this.pick(t);
    if (i < 0) return false;
    // The next frame starts after `t` (or `pick` would have chosen it), so this one is on screen at
    // `t` whatever duration it claims. Some containers give none: MediaRecorder leaves it out on
    // the last frame of every cluster.
    if (i < this.buffer.length - 1) return true;
    const s = this.buffer[i];
    // Half-open interval [start, end), with the same forward tolerance `pick` uses applied to both
    // ends. Without it a frame would also "cover" the instant its successor starts, and an export
    // that outran the decoder would repeat a frame.
    if (t + tolerance(s) < s.timestamp + s.duration) return true;
    // The last frame of a file has no successor, so it holds for any later time.
    return this.pumpEnded;
  }

  /** Whether the running decode pipeline will produce (or already holds) the frame for `t`. */
  private inRange(t: number): boolean {
    // Further than this past the frames in hand, a fresh seek is quicker than decoding up to `t`.
    const reach = this.reverse ? 0.05 : 1.5;
    const first = this.buffer[0];
    if (!first) return this.pumping && t >= this.pumpFrom - EPS && t <= this.pumpTo + reach;
    if (t + tolerance(first) < first.timestamp) return !!this.incoming && t >= this.incoming.from - EPS;
    const last = this.buffer[this.buffer.length - 1];
    // Before the last frame: its neighbours bracket `t`.
    if (t + tolerance(last) < last.timestamp) return true;
    // On the last frame for as long as it says it lasts, or for good when the file ends with it.
    const end = last.timestamp + last.duration;
    if (t + tolerance(last) < end || this.pumpEnded) return true;
    // Past the buffered frames: fine if decoding is still heading there.
    return this.pumping && !this.incoming && t <= Math.max(end, this.pumpTo) + reach;
  }

  /** Ask for the frame at media time `t` (seconds, relative to the first video sample). */
  request(t: number): void {
    this.want = t;
    this.lastUsed = performance.now();
    if (this.disposed) return;
    if (!this.sink) {
      this.open();
      return;
    }
    if (this.problem === 'decode-error') {
      // Frames asked for in order (playback, an export) go on from the one that would not decode
      // and share its fate, however far a fast clip moves through its file from one to the next:
      // nothing is started for them. Damage is often local though. A viewer at rest that asks for
      // another part of the file gets a new try, and one that steps on frame by frame takes the
      // verdict along.
      if (this.sequential) return;
      const near = Math.abs(t - this.gaveUpAt) <= ELSEWHERE;
      this.gaveUpAt = t;
      if (near) return;
      this.problem = null;
      this.failures = 0;
    }
    if (this.inRange(t)) {
      this.trim();
      this.resume?.();
      if (this.reverse) this.runBefore();
      return;
    }
    // A seek is already in flight and has not produced anything yet: let it land first so fast
    // scrubbing always shows *something*. The pump re-checks `want` when its first frame arrives.
    if (this.pumping && this.buffer.length === 0 && performance.now() - this.pumpStartedAt < 300) return;
    if (performance.now() < this.holdUntil) return;
    this.startPump(t);
  }

  /**
   * The decoder stopped without a single frame: it threw, or had nothing to give. Started again at
   * once it does the same, and whoever waits for its picture asks again as soon as it has stopped,
   * so each new start waits longer than the one before, and after the last of them the file is
   * taken as one that does not decode here. Whoever is waiting is told when a wait is over.
   */
  private stopped(): void {
    const wait = RESTART_MS[this.failures++];
    if (wait === undefined) {
      this.problem = 'decode-error';
      this.gaveUpAt = this.want;
      return;
    }
    this.holdUntil = performance.now() + wait;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.notify();
    }, wait);
  }

  /** The most decoded frames this cursor's decoder has been seen to spare (see `starved`). */
  private get limit(): number {
    return this.limits.get(this.assetId) ?? Infinity;
  }

  /**
   * Going backwards a whole run of frames is kept: up to 48, within ~256 MB of decoded pictures
   * between all cursors.
   */
  private maxRun(): number {
    return Math.max(8, Math.min(48, this.fits(256 * MIB)));
  }

  /** The run that may be held right now: while its decoder is still at work, only what that can spare. */
  private runCap(): number {
    return this.pumping && !this.incoming ? Math.min(this.maxRun(), this.limit) : this.maxRun();
  }

  /**
   * Frames kept behind a playhead that may step back: up to a dozen and ~96 MB between all
   * cursors, and no more than the decoder can spare on top of the frames around the playhead.
   */
  private maxHistory(): number {
    if (this.history <= 0) return 0;
    const most = Math.min(Math.floor(HISTORY_FRAMES / this.sharers), this.fits(96 * MIB));
    return Math.max(0, Math.min(most, this.limit - MIN_HELD));
  }

  /** Release the frames furthest behind the one on screen, beyond what is kept for going back. */
  private trim(): void {
    const cur = this.pick(this.want);
    let drop: number;
    // Going backwards the frames behind the wanted time are the ones about to be shown.
    if (this.reverse) drop = Math.min(cur, this.buffer.length - this.runCap());
    else {
      drop = Math.max(0, cur - this.maxHistory());
      while (drop < cur && this.buffer[drop].timestamp < this.want - this.history - EPS) drop++;
    }
    for (let i = 0; i < drop; i++) this.buffer[i].close();
    if (drop > 0) this.buffer.splice(0, drop);
  }

  /** How far behind `t` a new decode run should start. */
  private lead(t: number): number {
    if (this.reverse) return BACK_RUN;
    // The playhead stepped off the back of what is buffered, and its next steps will go the same
    // way: decode the stretch behind `t` in one pass instead of seeking again for every frame.
    const from = this.buffer.length ? this.buffer[0].timestamp : this.pumping ? this.pumpFrom : NaN;
    return this.history > 0 && t < from && from - t <= 1 ? this.history : 0;
  }

  /** Start (or, with null, stop) waiting for the decoder of pump `id` to deliver its next frame. */
  private expect(id: number | null): void {
    if (this.watch) clearTimeout(this.watch);
    this.watch = id === null ? null : setTimeout(() => this.starved(id), STARVED_MS);
  }

  /**
   * The decoder has delivered nothing for a while although it was asked to. Hardware decoders draw
   * their pictures from a pool of fixed size and stop when it is empty, which is when all of it is
   * held here as decoded frames. Only frames of the decoder now at work count for that; before it
   * has delivered any, it is simply still seeking. What is held beyond the frames around the
   * playhead is a convenience, so let the furthest ones go and take the number held as what such
   * a decoder can spare. A stalled download looks the same from here; `arrived` tells the two
   * apart afterwards.
   */
  private starved(id: number): void {
    this.watch = null;
    const mine = this.incoming ? this.incoming.frames : this.buffer;
    const held = mine.length;
    if (id !== this.pumpId || this.disposed || held <= MIN_HELD) return;
    this.trial = { limit: this.trial?.limit ?? this.limit, at: performance.now() };
    this.limits.set(this.assetId, Math.max(MIN_HELD, Math.min(this.limit, held) - 4));
    if (this.incoming) while (mine.length > this.limit) mine.shift()!.close();
    else this.trim();
    if (mine.length < held) this.expect(id);
  }

  /**
   * A frame came out of the decoder. If frames were let go for it a moment ago and it answered at
   * once, it had indeed run out of pictures and the lower limit stands. If it took its time all the
   * same, it was busy with something else (a long seek, a slow connection) and the limit is undone.
   */
  private arrived(): void {
    if (!this.trial) return;
    if (performance.now() - this.trial.at > CONFIRM_MS) {
      if (Number.isFinite(this.trial.limit)) this.limits.set(this.assetId, this.trial.limit);
      else this.limits.delete(this.assetId);
    }
    this.trial = null;
  }

  private dropIncoming(): void {
    for (const s of this.incoming?.frames ?? []) s.close();
    this.incoming = null;
  }

  /** Frames from `from` on, in presentation order and on this clip's time base, while pump `id` is current. */
  private async *frames(id: number, from: number, until = Infinity): AsyncGenerator<VideoSample, void> {
    const offset = this.media!.videoStart;
    this.expect(id);
    try {
      for await (const sample of this.sink!.samples(from + offset, until + offset)) {
        this.arrived();
        if (id !== this.pumpId || this.disposed) {
          sample.close();
          return;
        }
        this.expect(null);
        sample.setTimestamp(sample.timestamp - offset);
        if (this.raw && !this.rawBroken) {
          await this.capturePlanes(sample);
          if (id !== this.pumpId || this.disposed) {
            sample.close();
            return;
          }
        }
        // The consumer may hold on here for as long as it likes (back-pressure); the decoder is
        // only being waited for again once it asks for the next frame.
        yield sample;
        if (id === this.pumpId && !this.disposed) this.expect(id);
      }
    } finally {
      if (id === this.pumpId) this.expect(null);
    }
  }

  private startPump(t: number): void {
    const lead = this.lead(t);
    const id = ++this.pumpId;
    for (const s of this.buffer) s.close();
    this.buffer = [];
    this.dropIncoming();
    this.floor = -1;
    this.pumping = true;
    this.pumpEnded = false;
    this.broken = false;
    this.pumpStartedAt = performance.now();
    this.resume?.();
    this.pumpFrom = Math.max(0, t - lead);
    this.pumpTo = t;
    void (async () => {
      let delivered = false;
      try {
        for await (const sample of this.frames(id, this.pumpFrom)) {
          delivered = true;
          this.failures = 0;
          this.buffer.push(sample);
          this.trim();
          this.notify();
          if (id !== this.pumpId || this.disposed) return;
          if (!this.inRange(this.want)) {
            // The playhead moved on while this seek was in flight. Before going after the next
            // one, put this picture up if it is closer to the playhead than the one on screen: a
            // scrub that outruns the decoder then keeps moving instead of freezing until it rests.
            this.upload(this.want);
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
        if (id === this.pumpId && !this.disposed) {
          this.pumpEnded = true;
          this.pumping = false;
          if (!delivered) this.stopped();
          this.notify();
        }
      } catch (err) {
        if (id === this.pumpId && !this.disposed) {
          console.warn('[video] decode error', err);
          this.pumping = false;
          this.pumpEnded = true;
          this.broken = true;
          if (!delivered) this.stopped();
          this.notify();
        }
      }
    })();
  }

  /**
   * Going backwards the playhead walks towards the start of the buffered run. Decode the stretch
   * in front of it while the run's first frames are still to be shown, so that playback carries on
   * across the join instead of stopping for a seek every `BACK_RUN` seconds.
   */
  private runBefore(): void {
    const first = this.buffer[0];
    if (this.incoming || !first) return;
    if (first.timestamp <= Math.max(EPS, this.floor) || this.want - first.timestamp > BACK_LEAD) return;
    // The run in hand has to reach the playhead first; until then its decoder is still needed.
    if (!this.covers(this.want)) return;
    // Room for the new run comes from the far end of this one, which the playhead has passed. The
    // frame after the one on screen stays: it is what says the one on screen is the right one.
    const room = this.maxRun() - (this.pick(this.want) + 2);
    if (room < 8) return;
    const take = Math.min(room, this.limit);
    while (this.buffer.length - 2 > this.pick(this.want)) {
      this.buffer.pop()!.close();
      this.pumpEnded = false;
    }
    // From here on the decoder of this run would only add frames the playhead is moving away from.
    const id = ++this.pumpId;
    this.resume?.();
    const until = first.timestamp;
    // No longer than there is room for, or than its decoder can spare: frames decoded only to be
    // let go again are wasted work. How far apart frames are shows in the ones in hand; a single
    // frame (a seek that landed on the last one of a file) has only its own duration to go by,
    // and not even that when its container gave it none.
    const n = this.buffer.length;
    const step = n > 1 ? (this.buffer[n - 1].timestamp - until) / (n - 1) : first.duration;
    const span = step > 0 ? Math.min(BACK_RUN, take * step) : BACK_RUN;
    const run = { from: Math.max(0, until - span), frames: [] as VideoSample[] };
    this.incoming = run;
    this.pumping = true;
    void (async () => {
      let complete = false;
      try {
        for await (const sample of this.frames(id, run.from, until)) {
          if (sample.timestamp >= until - EPS) {
            sample.close();
            break;
          }
          run.frames.push(sample);
          // Too long a run loses its far end, and the next one starts that much sooner.
          if (run.frames.length > Math.min(take, this.limit)) run.frames.shift()!.close();
        }
        complete = true;
      } catch (err) {
        if (id === this.pumpId && !this.disposed) console.warn('[video] decode error', err);
      }
      // Whoever superseded this run has taken its frames with it.
      if (id !== this.pumpId || this.disposed) return;
      this.incoming = null;
      this.pumping = false;
      // The run joins on only if it is whole and the frame it leads up to is still the first one
      // buffered (the cursor may have stopped going backwards and let that frame go meanwhile).
      const head = this.buffer[0];
      if (complete && run.frames.length && head && Math.abs(head.timestamp - until) < EPS)
        this.buffer = run.frames.concat(this.buffer);
      else {
        for (const s of run.frames) s.close();
        this.floor = until;
      }
      this.notify();
    })();
  }

  /** Should the decode pipeline pause? */
  private full(): boolean {
    if (this.reverse) {
      // Decode up to just past the wanted frame, then hold the whole run for backwards stepping.
      const last = this.buffer[this.buffer.length - 1];
      return this.buffer.length > this.runCap() || (!!last && last.timestamp > this.want + 0.1);
    }
    let n = 0;
    for (const s of this.buffer) if (s.timestamp > this.want + EPS) n++;
    return n >= AHEAD;
  }

  private notify(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
    this.onFrame();
  }

  /**
   * Resolve once the exact frame for `t` is buffered. When that cannot be had the answer says why,
   * and whatever picture is nearest stays in use.
   */
  async ready(t: number, timeoutMs = 8000): Promise<SourceFault | null> {
    this.request(t);
    const deadline = performance.now() + timeoutMs;
    while (!this.problem && !this.disposed && !this.covers(t)) {
      if (performance.now() > deadline) return 'timeout';
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      // Reverse cursors and end-of-stream may need a restart to reach `t`.
      if (!this.pumping && !this.covers(t) && !this.problem) this.request(t);
    }
    return this.problem ?? (this.broken ? 'decode-error' : null);
  }

  /**
   * The buffered frame to put on screen for `t`: the exact one when it is there. While the decoder
   * is still on its way, the frame it has reached replaces the picture already up only when it lies
   * between that picture and `t`. A seek then never takes the viewer away from the playhead, and
   * never past it either: going backwards, the frames of a run that precede `t` are yet to come.
   */
  private choose(t: number): VideoSample | null {
    const i = this.pick(t);
    const s = this.buffer[Math.max(i, 0)];
    if (!s) return null;
    if (!this.hasPicture || Number.isNaN(this.uploadedTs) || (i >= 0 && this.covers(t))) return s;
    const ahead = s.timestamp - t;
    const shown = this.uploadedTs - t;
    return ahead * shown >= 0 && Math.abs(ahead) < Math.abs(shown) ? s : null;
  }

  /** Upload the best available frame for `t` and return whether there is any picture at all. */
  upload(t: number): boolean {
    this.lastUsed = performance.now();
    const s = this.choose(t);
    if (!s || s.timestamp === this.uploadedTs) return this.hasPicture;
    const gl = this.glx.gl;
    const planes = this.raw && !this.rawBroken ? this.planes.get(s) : undefined;
    if (planes) this.uploadPlanes(planes);
    else {
      this.yuvInfo = undefined;
      try {
        const src = s.toCanvasImageSource();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      } catch (err) {
        console.warn('[video] upload failed', err);
        return this.hasPicture;
      }
    }
    // Layout works in square pixels; anamorphic footage stores fewer columns than it shows.
    this.width = s.squarePixelWidth;
    this.height = s.squarePixelHeight;
    this.uploadedTs = s.timestamp;
    this.version++;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.pumpId++;
    if (this.retry) clearTimeout(this.retry);
    this.expect(null);
    for (const s of this.buffer) s.close();
    this.buffer = [];
    this.dropIncoming();
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

/**
 * Texels kept per frame pixel a still can cover, so that what enlarges it beyond its clip's own
 * scale (an animation preset, an effect, a transition) still has detail to show.
 */
const STILL_OVERSAMPLE = 2;
const STILL_RETRY_MS = 3000;

/**
 * The fraction of a still's own resolution worth holding on the GPU for `clip` in a frame drawn at
 * `frameW` x `frameH`: enough to fill that frame, or for the largest the clip ever draws it when
 * that is more (a zoom, scale keyframes, a picture placed at its own size). A 24-megapixel photo in
 * an HD frame then takes a third of the 96 MB it would at full size, and a still no larger than the
 * frame is left alone.
 */
function stillDetail(clip: Clip, project: Project, frameW: number, frameH: number): number {
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
  if (!asset || !(asset.width > 0) || !(asset.height > 0)) return 1;
  // A preview draws fewer pixels than the project has, and how many changes as it adapts. A still
  // is not decoded anew for that: the project's size is the least to provide for. An export can
  // be several times larger, and layout grows with it.
  const width = Math.max(project.settings.width, frameW);
  const height = Math.max(project.settings.height, frameH);
  const kx = width / asset.width;
  const ky = height / asset.height;
  const fill = Math.max(kx, ky);
  const own = height / project.settings.height;
  const fit = clip.fit === 'none' ? own : clip.fit === 'contain' ? Math.min(kx, ky) : fill;
  let scale = Math.max(Math.abs(clip.scaleX), Math.abs(clip.scaleY));
  for (const k of clip.keyframes.scaleX ?? []) scale = Math.max(scale, Math.abs(k.v));
  for (const k of clip.keyframes.scaleY ?? []) scale = Math.max(scale, Math.abs(k.v));
  // In eighths, so that nudging a zoom does not ask for a new decode each time.
  return Math.min(1, Math.ceil(Math.max(fill, fit * scale) * STILL_OVERSAMPLE * 8) / 8);
}

interface ImageEntry {
  tex: WebGLTexture | null;
  /** Size of the original. Layout works in these pixels whatever the size of the texture. */
  width: number;
  height: number;
  /** Fraction of the original's resolution in `tex`, and the largest fraction asked for so far. */
  detail: number;
  want: number;
  bytes: number;
  /** Value of the manager's use counter when this was last asked for. */
  used: number;
  state: 'loading' | 'ready' | 'failed';
  fault: SourceFault | null;
  busy: boolean;
  retryAt: number;
  /** Settles when the texture holds the detail asked for, or loading failed. */
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
  fault: SourceFault | null;
  promise: Promise<void>;
}

/** What a `SourceManager` holds at the moment. */
export interface SourceStats {
  /** Open video decoders, and the decoded frames they are holding. */
  decoders: number;
  frames: number;
  /** Still textures and the bytes of their top mip level. */
  stills: number;
  stillBytes: number;
}

export class SourceManager implements SourceProvider {
  /** Called whenever new pixels become available, so a paused viewer can redraw. */
  onInvalidate: () => void = () => {};

  private readonly cursors = new Map<string, VideoCursor>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly gens = new Map<string, GenEntry>();
  private readonly luts = new Map<string, LutEntry>();
  /** What each asset's decoder was seen to spare in decoded frames, kept across its cursors. */
  private readonly spare = new Map<string, number>();
  /** +1 when the timeline plays forward, -1 when shuttling backwards. */
  direction: 1 | -1 = 1;
  /**
   * True while frames are asked for strictly in order (playback, export). Nothing behind the
   * playhead is worth keeping then, and a decoder that would not start is not tried again for the
   * frames that follow. Otherwise (paused, scrubbing) each decoder keeps about half a second of
   * frames behind it, so that stepping back is served from memory instead of a seek per frame, and
   * one that would not start gets a new try in another part of its file.
   */
  sequential = false;
  /**
   * Bytes of still-image texture to keep. Beyond it the stills drawn longest ago are released (and
   * decoded again if they come back); the ones in the frame being drawn always stay.
   */
  stillBudget = 384 * MIB;
  /**
   * Fonts that were asked about: the pending load, or null when there is nothing (more) to wait
   * for. Each is asked about once for as long as the document has the faces it has. A face whose
   * file cannot be fetched never loads however often it is requested, while `check` goes on
   * answering false; and asking `check` about a font that is there costs more, on every frame, than
   * the rest of what a title needs to be drawn again.
   */
  private readonly fonts = new Map<string, Promise<void> | null>();
  /** How many faces the document had when the answers in `fonts` were given. */
  private fontFaces = -1;
  private tick = 0;
  private pass = 0;
  private uses = 0;
  private usesAtCollect = 0;
  private stillBytes = 0;
  private disposed = false;
  private readonly offFonts: () => void;

  constructor(
    private readonly glx: Glx,
    readonly library: MediaLibrary,
  ) {
    // Text drawn before its font arrived used a fallback face; `generatorKey` carries the epoch.
    this.offFonts = onFontsLoaded(() => this.invalidate());
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
        return {
          tex: cur.tex,
          width: cur.width * cur.scale,
          height: cur.height * cur.scale,
          rotation: cur.rotation,
          yuv: cur.yuv,
          version: cur.version,
        };
      }
      case 'image': {
        if (!clip.assetId) return null;
        const img = this.image(clip.assetId, stillDetail(clip, project, frameW, frameH));
        return img.tex ? { tex: img.tex, width: img.width, height: img.height } : null;
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
   * layer has the precise frame buffered and all stills, fonts and LUTs are loaded, and it resolves
   * with the layers for which that could not be done: their media is missing, cannot be decoded or
   * did not deliver the frame in time. Such a layer is drawn with the nearest picture there is, or
   * not at all. Without `exact` the list is always empty.
   *
   * `frameWidth` x `frameHeight` is the size the frame will be drawn at, for a render larger than
   * the project (an export at a higher resolution): stills are then decoded with the detail that
   * size can show before the promise resolves, not after the first frame has been drawn.
   */
  async prepare(
    project: Project,
    desc: FrameDesc,
    exact: boolean,
    frameWidth = project.settings.width,
    frameHeight = project.settings.height,
  ): Promise<SourceProblem[]> {
    this.pass++;
    const waits: Promise<SourceProblem | null>[] = [];
    const visit = (l: ClipLayer | null) => {
      if (!l) return;
      const clip = l.clip;
      const { id: clipId, assetId } = clip;
      if (clip.type === 'video' && assetId) {
        const cur = this.cursor(clipId, assetId, clip.reverse);
        cur.setRaw(wantsRaw(project, assetId));
        if (!exact) cur.request(l.sourceTime);
        else
          waits.push(
            cur.ready(l.sourceTime).then((reason) => reason && { clipId, assetId, part: 'video', reason }),
          );
      } else if (clip.type === 'image' && assetId) {
        const img = this.image(assetId, stillDetail(clip, project, frameWidth, frameHeight));
        if (exact)
          waits.push(
            img.promise.then(() =>
              img.fault ? { clipId, assetId, part: 'image', reason: img.fault } : null,
            ),
          );
      } else if (clip.type === 'text' && clip.text) {
        const p = this.ensureFont(fontSpec(clip.text, 32), clip.text.content);
        if (exact && p) waits.push(p.then(() => null));
      }
      const lutId = clip.grade?.lutId;
      if (lutId) {
        const lut = this.lut(lutId);
        if (exact)
          waits.push(
            lut.promise.then(() =>
              lut.fault ? { clipId, assetId: lutId, part: 'lut', reason: lut.fault } : null,
            ),
          );
      }
    };
    for (const layer of desc.layers) {
      if (layer.kind === 'clip') visit(layer.layer);
      else {
        visit(layer.a);
        visit(layer.b);
      }
    }
    if (!waits.length) return [];
    return (await Promise.all(waits)).filter((p) => p !== null);
  }

  /** Warm up a cursor ahead of time (clips that are about to start during playback). */
  prewarm(clipId: string, assetId: string, reverse: boolean, sourceTime: number): void {
    const existing = this.cursors.get(clipId);
    if (existing && existing.hasPicture) return;
    this.cursor(clipId, assetId, reverse).request(sourceTime);
  }

  /** Free what has not been drawn recently. Call once per rendered frame. */
  collect(maxIdleMs = 4000): void {
    this.evictStills();
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

  /**
   * Free every decoder the frame prepared last did not use. For renders whose time only moves
   * forward (export): a clip that has left the picture is not coming back, and waiting for an idle
   * timer instead keeps a decoder and its frames alive for every clip a fast render has passed.
   */
  releaseUnused(): void {
    for (const [id, cur] of this.cursors) {
      if (cur.pass === this.pass) continue;
      cur.dispose();
      this.cursors.delete(id);
    }
  }

  /** Release stills that the frame just drawn did not use, oldest first, while over budget. */
  private evictStills(): void {
    if (this.stillBytes > this.stillBudget) {
      const idle = Array.from(this.images.entries())
        .filter(([, e]) => e.tex && !e.busy && e.used <= this.usesAtCollect)
        .sort((a, b) => a[1].used - b[1].used);
      for (const [id, e] of idle) {
        if (this.stillBytes <= this.stillBudget) break;
        this.glx.gl.deleteTexture(e.tex);
        this.stillBytes -= e.bytes;
        this.images.delete(id);
      }
    }
    this.usesAtCollect = this.uses;
  }

  stats(): SourceStats {
    let frames = 0;
    for (const cur of this.cursors.values()) frames += cur.held;
    let stills = 0;
    for (const e of this.images.values()) if (e.tex) stills++;
    return { decoders: this.cursors.size, frames, stills, stillBytes: this.stillBytes };
  }

  /**
   * Forget what is known about an asset's file: open decoders, and every failure to find or read
   * it. Call when the file changes or becomes available (finished uploading or downloading).
   */
  resetAsset(assetId: string): void {
    for (const [id, cur] of this.cursors) {
      if (cur.assetId === assetId) {
        cur.dispose();
        this.cursors.delete(id);
      }
    }
    const img = this.images.get(assetId);
    if (img?.state === 'failed') this.images.delete(assetId);
    else if (img) img.retryAt = 0;
    const lut = this.luts.get(assetId);
    if (lut?.state === 'failed') this.luts.delete(assetId);
    this.spare.delete(assetId);
    this.library.invalidate(assetId);
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.offFonts();
    const gl = this.glx.gl;
    for (const c of this.cursors.values()) c.dispose();
    for (const i of this.images.values()) if (i.tex) gl.deleteTexture(i.tex);
    for (const g of this.gens.values()) gl.deleteTexture(g.tex);
    for (const l of this.luts.values()) if (l.tex) gl.deleteTexture(l.tex);
    this.cursors.clear();
    this.images.clear();
    this.gens.clear();
    this.luts.clear();
    this.stillBytes = 0;
  }

  // ── internals ─────────────────────────────────────────────────────────

  private cursor(clipId: string, assetId: string, reverse: boolean): VideoCursor {
    let cur = this.cursors.get(clipId);
    if (cur && cur.assetId !== assetId) {
      cur.dispose();
      cur = undefined;
    }
    if (!cur) {
      cur = new VideoCursor(this.glx, this.library, assetId, this.spare, this.invalidate);
      this.cursors.set(clipId, cur);
    }
    cur.setMode(reverse !== this.direction < 0, this.sequential, this.cursors.size);
    cur.pass = this.pass;
    return cur;
  }

  /** The still for an asset, holding at least `want` of its resolution (now or once it has loaded). */
  private image(assetId: string, want: number): ImageEntry {
    let e = this.images.get(assetId);
    if (!e) {
      e = {
        tex: null,
        width: 0,
        height: 0,
        detail: 0,
        want,
        bytes: 0,
        used: 0,
        state: 'loading',
        fault: null,
        busy: false,
        retryAt: 0,
        promise: Promise.resolve(),
      };
      this.images.set(assetId, e);
    } else if (want > e.want && performance.now() >= e.retryAt) e.want = want;
    e.used = ++this.uses;
    if (!e.busy && e.state !== 'failed' && e.detail < e.want) e.promise = this.loadImage(assetId, e);
    return e;
  }

  private async loadImage(assetId: string, entry: ImageEntry): Promise<void> {
    entry.busy = true;
    // With the bytes in hand, whatever goes wrong is that they do not decode.
    let fault: SourceFault = 'undecodable';
    try {
      while (entry.detail < entry.want && this.images.get(assetId) === entry) {
        const want = entry.want;
        const blob = await this.library.read(assetId);
        if (typeof blob === 'string') {
          fault = blob;
          throw new Error(blob);
        }
        let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
        const { width, height } = bmp;
        const max = this.glx.caps.maxTextureSize;
        const k = Math.min(want, max / width, max / height);
        if (k < 1) {
          const scaled = await createImageBitmap(bmp, {
            resizeWidth: Math.max(1, Math.floor(width * k)),
            resizeHeight: Math.max(1, Math.floor(height * k)),
            resizeQuality: 'high',
            premultiplyAlpha: 'premultiply',
          });
          bmp.close();
          bmp = scaled;
        }
        if (this.disposed || this.images.get(assetId) !== entry) {
          bmp.close();
          return;
        }
        const gl = this.glx.gl;
        // A new texture rather than new pixels in the old one: the compositor takes a still's
        // texture to be written once.
        const tex = this.glx.createTexture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (entry.tex) gl.deleteTexture(entry.tex);
        this.stillBytes += bmp.width * bmp.height * 4 - entry.bytes;
        entry.tex = tex;
        entry.width = width;
        entry.height = height;
        entry.detail = want;
        entry.bytes = bmp.width * bmp.height * 4;
        entry.state = 'ready';
        entry.fault = null;
        bmp.close();
        this.invalidate();
      }
    } catch (err) {
      console.warn(`[image] ${assetId}`, err);
      entry.retryAt = performance.now() + STILL_RETRY_MS;
      if (entry.tex) {
        // The sharper copy could not be made; carry on with the one there is.
        entry.want = entry.detail;
      } else {
        entry.state = 'failed';
        entry.fault = fault;
        // Retry later: the file may still be syncing from a collaborator.
        setTimeout(() => {
          if (this.images.get(assetId) === entry) this.images.delete(assetId);
          this.invalidate();
        }, STILL_RETRY_MS);
      }
      this.invalidate();
    } finally {
      entry.busy = false;
    }
  }

  private lut(assetId: string): LutEntry {
    let e = this.luts.get(assetId);
    if (e) return e;
    const entry: LutEntry = { tex: null, size: 0, state: 'loading', fault: null, promise: Promise.resolve() };
    entry.promise = (async () => {
      // With the bytes in hand, whatever goes wrong is that they are not a LUT.
      let fault: SourceFault = 'undecodable';
      try {
        const blob = await this.library.read(assetId);
        if (typeof blob === 'string') {
          fault = blob;
          throw new Error(blob);
        }
        const parsed = parseCubeLut(await blob.text());
        if (this.disposed) return;
        const gl = this.glx.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_3D, tex);
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGB16F,
          parsed.size,
          parsed.size,
          parsed.size,
          0,
          gl.RGB,
          gl.FLOAT,
          parsed.data,
        );
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
        entry.fault = fault;
        console.warn(`[lut] ${assetId}`, err);
        // A file that could not be had yet may still arrive from a collaborator; one that does
        // not parse stays as it is until the asset changes.
        if (fault !== 'undecodable')
          setTimeout(() => {
            if (this.luts.get(assetId) === entry) this.luts.delete(assetId);
            this.invalidate();
          }, STILL_RETRY_MS);
      }
      this.invalidate();
    })();
    this.luts.set(assetId, entry);
    e = entry;
    return e;
  }

  private forgetSettledFonts(): void {
    for (const [key, pending] of this.fonts) if (!pending) this.fonts.delete(key);
  }

  private ensureFont(spec: string, sample: string): Promise<void> | null {
    if (typeof document === 'undefined' || !document.fonts) return null;
    // A family nobody has registered yet counts as available (the fallback will draw it). Once
    // its faces are added to the document, what was settled before says nothing about them.
    if (document.fonts.size !== this.fontFaces) {
      this.fontFaces = document.fonts.size;
      this.forgetSettledFonts();
    }
    const key = `${spec}\n${sample}`;
    const asked = this.fonts.get(key);
    if (asked !== undefined) return asked;
    // Text being typed asks about a new string with every key; keep the record small.
    if (this.fonts.size >= 256) this.forgetSettledFonts();
    if (document.fonts.check(spec, sample)) {
      this.fonts.set(key, null);
      return null;
    }
    // Success shows through `fontEpoch` (the document's fonts announce it); failure needs no redraw.
    const load = document.fonts
      .load(spec, sample)
      .then(
        () => {},
        () => {},
      )
      .finally(() => this.fonts.set(key, null));
    this.fonts.set(key, load);
    return load;
  }

  private generator(layer: ClipLayer, frameW: number, frameH: number): TextureSource | null {
    const clip = layer.clip;
    if (clip.type === 'text' && clip.text) this.ensureFont(fontSpec(clip.text, 32), clip.text.content);
    const key = generatorKey(clip, frameW, frameH, layer.anim.chars, fontEpoch());
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
