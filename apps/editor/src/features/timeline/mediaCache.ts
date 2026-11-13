/**
 * Timeline media caches: filmstrip thumbnails and audio waveform peaks.
 *
 * Both are generated lazily, off the critical path, from the same media the player decodes. Requests
 * made while drawing are remembered with a "wanted" tick, so whatever is on screen right now is
 * generated first, and thumbnails that were asked for under a view that has been scrolled or zoomed
 * away since are not generated at all.
 */
import {
  AudioBufferSink,
  CanvasSink,
  MediaLibrary,
  type MediaResolver,
  type OpenMedia,
} from '@tandem/engine';

type Listener = () => void;

class Emitter {
  private listeners = new Set<Listener>();
  private scheduled = false;
  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  /** Coalesce bursts of updates into one notification per animation frame. */
  emit(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const fn of Array.from(this.listeners)) fn();
    });
  }
}

const THUMB_HEIGHT = 72;
const MAX_THUMBS = 900;
/** Thumbnail time steps (seconds), coarse to fine. */
const STEPS = [64, 32, 16, 8, 4, 2, 1, 0.5, 0.25, 0.125];

interface Pending {
  assetId: string;
  time: number;
  wanted: number;
  /** The view of the timeline this was last asked for under: see `FilmstripCache.viewing`. */
  view: number;
}

/** Called with what an asset's file turned out to hold, each time one of the caches opens it. */
type Opened = (assetId: string, media: OpenMedia) => void;

export class FilmstripCache extends Emitter {
  private readonly thumbs = new Map<string, { bmp: ImageBitmap; used: number }>();
  private readonly pending = new Map<string, Pending>();
  private readonly sinks = new Map<string, Promise<{ sink: CanvasSink; start: number } | null>>();
  private readonly failed = new Set<string>();
  private tick = 0;
  private busy = false;
  private disposed = false;
  private view = 0;
  private viewed = { scrollX: 0, ppf: 0 };

  constructor(
    private readonly library: MediaLibrary,
    private readonly opened: Opened = () => {},
  ) {
    super();
  }

  /**
   * Say which stretch of the timeline is being painted, before asking for its thumbnails. Every
   * lane is painted again when the view scrolls or zooms and asks again for what it shows, so a
   * request that the latest view has not repeated is for a thumbnail that went out of sight, and
   * is dropped instead of being decoded behind the ones on screen. A lane that is painted again
   * for another reason (an edit, a thumbnail arriving) leaves the view, and with it the requests
   * of the other lanes, as they are.
   */
  viewing(scrollX: number, ppf: number): void {
    if (this.viewed.scrollX === scrollX && this.viewed.ppf === ppf) return;
    this.viewed = { scrollX, ppf };
    this.view++;
  }

  /** Step size to use for tiles that each cover `tileSeconds` of media. */
  static stepFor(tileSeconds: number): number {
    for (let i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] >= tileSeconds * 0.75) return STEPS[i];
    return STEPS[0];
  }

  private static key(assetId: string, time: number): string {
    return `${assetId}@${time.toFixed(3)}`;
  }

  /**
   * Best thumbnail for `time`. Returns the exact bucket when cached; otherwise the nearest coarser
   * one (so there is always *something* to draw) while the exact frame is queued.
   */
  get(assetId: string, time: number, step: number): ImageBitmap | null {
    this.tick++;
    const bucket = Math.max(0, Math.round(time / step) * step);
    const exact = this.thumbs.get(FilmstripCache.key(assetId, bucket));
    if (exact) {
      exact.used = this.tick;
      return exact.bmp;
    }
    if (!this.failed.has(assetId)) {
      const k = FilmstripCache.key(assetId, bucket);
      const p = this.pending.get(k);
      if (p) {
        p.wanted = this.tick;
        p.view = this.view;
      } else this.pending.set(k, { assetId, time: bucket, wanted: this.tick, view: this.view });
      void this.work();
    }
    for (const s of STEPS) {
      if (s <= step) continue;
      const t = this.thumbs.get(FilmstripCache.key(assetId, Math.max(0, Math.round(time / s) * s)));
      if (t) {
        t.used = this.tick;
        return t.bmp;
      }
    }
    return null;
  }

  private sinkFor(assetId: string) {
    let p = this.sinks.get(assetId);
    if (!p) {
      p = this.library.get(assetId).then((m) => {
        if (m) this.opened(assetId, m);
        if (!m || !m.video || !m.videoDecodable) return null;
        return { sink: new CanvasSink(m.video, { height: THUMB_HEIGHT, poolSize: 2 }), start: m.videoStart };
      });
      this.sinks.set(assetId, p);
    }
    return p;
  }

  private async work(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      while (this.pending.size && !this.disposed) {
        for (const [k, p] of this.pending) if (p.view !== this.view) this.pending.delete(k);
        // Most recently wanted request decides which asset we serve next.
        let top: Pending | null = null;
        for (const p of this.pending.values()) if (!top || p.wanted > top.wanted) top = p;
        if (!top) break;
        const assetId = top.assetId;
        const batch = Array.from(this.pending.values())
          .filter((p) => p.assetId === assetId)
          .sort((a, b) => b.wanted - a.wanted)
          .slice(0, 10)
          .sort((a, b) => a.time - b.time);
        for (const p of batch) this.pending.delete(FilmstripCache.key(p.assetId, p.time));
        const opened = await this.sinkFor(assetId).catch(() => null);
        if (!opened) {
          this.failed.add(assetId);
          for (const [k, p] of this.pending) if (p.assetId === assetId) this.pending.delete(k);
          continue;
        }
        try {
          let i = 0;
          for await (const wrapped of opened.sink.canvasesAtTimestamps(
            batch.map((p) => p.time + opened.start),
          )) {
            const req = batch[i++];
            if (!wrapped || this.disposed) continue;
            const bmp = await createImageBitmap(wrapped.canvas);
            this.thumbs.set(FilmstripCache.key(assetId, req.time), { bmp, used: this.tick });
            this.emit();
          }
        } catch (err) {
          // The media handle is replaced when a download finishes mid-batch; the tiles simply get
          // requested again on the next paint.
          if ((err as Error)?.name !== 'InputDisposedError') console.warn('[filmstrip]', err);
          this.sinks.delete(assetId);
        }
        this.evict();
        // Stay polite to the main thread between batches.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.busy = false;
    }
  }

  private evict(): void {
    if (this.thumbs.size <= MAX_THUMBS) return;
    const entries = Array.from(this.thumbs.entries()).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of entries.slice(0, this.thumbs.size - MAX_THUMBS + 100)) {
      v.bmp.close();
      this.thumbs.delete(k);
    }
  }

  forget(assetId: string): void {
    this.sinks.delete(assetId);
    this.failed.delete(assetId);
  }

  dispose(): void {
    this.disposed = true;
    for (const v of this.thumbs.values()) v.bmp.close();
    this.thumbs.clear();
    this.pending.clear();
  }
}

export interface Waveform {
  /** Peak magnitude (0…1) per bucket. */
  peaks: Float32Array;
  perSecond: number;
  /** Seconds analysed so far. */
  loaded: number;
  done: boolean;
}

export const PEAKS_PER_SECOND = 100;

export class WaveformCache extends Emitter {
  private readonly waves = new Map<string, Waveform>();
  private readonly queue: string[] = [];
  private busy = false;
  private disposed = false;

  constructor(
    private readonly library: MediaLibrary,
    private readonly opened: Opened = () => {},
  ) {
    super();
  }

  get(assetId: string, duration: number): Waveform | null {
    let w = this.waves.get(assetId);
    if (!w) {
      w = {
        peaks: new Float32Array(Math.max(1, Math.ceil(duration * PEAKS_PER_SECOND) + 2)),
        perSecond: PEAKS_PER_SECOND,
        loaded: 0,
        done: false,
      };
      this.waves.set(assetId, w);
      this.queue.push(assetId);
      void this.work();
    }
    return w;
  }

  private async work(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.disposed) {
        const assetId = this.queue.shift()!;
        const w = this.waves.get(assetId)!;
        try {
          const media = await this.library.get(assetId);
          if (media) this.opened(assetId, media);
          if (!media || !media.audio || !media.audioDecodable) {
            w.done = true;
            continue;
          }
          const sink = new AudioBufferSink(media.audio);
          let lastEmit = 0;
          let lastYield = performance.now();
          for await (const { buffer, timestamp } of sink.buffers()) {
            if (this.disposed) return;
            const t0 = timestamp - media.audioStart;
            const sr = buffer.sampleRate;
            const per = sr / PEAKS_PER_SECOND;
            for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
              const data = buffer.getChannelData(c);
              // Sample sparsely inside each bucket: plenty for a picture, several times faster.
              const stride = Math.max(1, Math.floor(per / 24));
              for (let i = 0; i < data.length; i += stride) {
                const b = Math.floor((t0 * sr + i) / per);
                if (b < 0 || b >= w.peaks.length) continue;
                const v = data[i] < 0 ? -data[i] : data[i];
                if (v > w.peaks[b]) w.peaks[b] = v;
              }
            }
            w.loaded = t0 + buffer.duration;
            const now = performance.now();
            if (now - lastEmit > 300) {
              lastEmit = now;
              this.emit();
            }
            if (now - lastYield > 12) {
              await new Promise((r) => setTimeout(r, 0));
              lastYield = performance.now();
            }
          }
        } catch (err) {
          // The project was closed while this file was being read: nobody is left to tell.
          if (this.disposed) return;
          if ((err as Error)?.name === 'InputDisposedError') {
            // The file moved underneath us (finished downloading): start this one over.
            w.peaks.fill(0);
            w.loaded = 0;
            this.queue.push(assetId);
            continue;
          }
          console.warn('[waveform]', err);
        }
        w.done = true;
        this.emit();
      }
    } finally {
      this.busy = false;
    }
  }

  forget(assetId: string): void {
    const w = this.waves.get(assetId);
    if (w && !w.done) return;
    if (w && w.loaded === 0) this.waves.delete(assetId);
  }

  dispose(): void {
    this.disposed = true;
    this.waves.clear();
  }
}

/** What of an asset's file this browser has no decoder for. */
export interface DecodeFault {
  picture: boolean;
  sound: boolean;
}

/** Caches for one open project. */
export class TimelineMedia {
  readonly library: MediaLibrary;
  readonly film: FilmstripCache;
  readonly wave: WaveformCache;
  private readonly posters = new Map<string, HTMLImageElement>();
  private readonly faults = new Map<string, DecodeFault>();
  private readonly faultListeners = new Set<Listener>();
  private faultsVersion = 0;

  constructor(resolver: MediaResolver) {
    this.library = new MediaLibrary(resolver);
    const opened: Opened = (assetId, media) => this.noteFault(assetId, media);
    this.film = new FilmstripCache(this.library, opened);
    this.wave = new WaveformCache(this.library, opened);
  }

  /**
   * Whether the file can be decoded is known once it has been opened, which the caches do for
   * every asset the timeline shows. The verdict is kept by asset, so that what draws a clip can
   * say why its picture is black or its sound silent without opening the file itself.
   */
  private noteFault(assetId: string, media: OpenMedia): void {
    const fault = {
      picture: !!media.video && !media.videoDecodable,
      sound: !!media.audio && !media.audioDecodable,
    };
    const before = this.faults.get(assetId);
    if ((before?.picture ?? false) === fault.picture && (before?.sound ?? false) === fault.sound) return;
    if (fault.picture || fault.sound) this.faults.set(assetId, fault);
    else this.faults.delete(assetId);
    this.faultsVersion++;
    for (const fn of Array.from(this.faultListeners)) fn();
  }

  /** What this browser cannot decode of the asset's file, as far as the file has been opened. */
  fault(assetId: string): DecodeFault | null {
    return this.faults.get(assetId) ?? null;
  }

  subscribeFaults = (fn: Listener): (() => void) => {
    this.faultListeners.add(fn);
    return () => this.faultListeners.delete(fn);
  };

  getFaultsVersion = (): number => this.faultsVersion;

  /** The asset's embedded poster frame, decoded once. Used until real thumbnails arrive. */
  poster(assetId: string, dataUrl: string | null): HTMLImageElement | null {
    if (!dataUrl) return null;
    let img = this.posters.get(assetId);
    if (!img) {
      img = new Image();
      img.onload = () => this.film.emit();
      img.src = dataUrl;
      this.posters.set(assetId, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** An asset's bytes moved (e.g. finished downloading): reopen it. */
  refresh(assetId: string): void {
    this.library.invalidate(assetId);
    this.film.forget(assetId);
    this.wave.forget(assetId);
    this.film.emit();
  }

  dispose(): void {
    this.film.dispose();
    this.wave.dispose();
    this.library.dispose();
  }
}
