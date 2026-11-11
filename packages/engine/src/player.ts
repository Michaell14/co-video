/**
 * Player: the real-time preview engine.
 *
 * Owns the compositor, the decode sources and the audio graph, and runs the master clock. While
 * playing, the AudioContext is the clock (so picture follows sound, never the other way round); the
 * render loop simply draws whichever frame the clock says is current.
 */
import {
  clipsOnTrack,
  resolveFrame,
  secondsToFrames,
  sequenceEnd,
  tracksOf,
  framesToSeconds,
  type ClipLayer,
  type Project,
} from '@tandem/core';
import { AudioGraph } from './audio/graph';
import { Compositor, type RenderOptions } from './gl/compositor';
import { MediaLibrary, type MediaResolver } from './media/library';
import { SourceManager } from './media/sources';

export type PreviewQuality = 'auto' | 1 | 0.5 | 0.25;

export interface PlayerState {
  playing: boolean;
  /** Playback rate; negative plays backwards. */
  rate: number;
  loop: boolean;
  /** In / out range in frames (out is exclusive), or null. */
  range: { in: number; out: number } | null;
  quality: PreviewQuality;
  muted: boolean;
  volume: number;
  falseColor: boolean;
}

export interface PlayerStats {
  /** Frames presented per second, measured. */
  fps: number;
  renderMs: number;
  dropped: number;
  renderWidth: number;
  renderHeight: number;
  passes: number;
}

type Listener = () => void;

export class Player {
  readonly compositor: Compositor;
  readonly library: MediaLibrary;
  readonly sources: SourceManager;
  stats: PlayerStats = { fps: 0, renderMs: 0, dropped: 0, renderWidth: 0, renderHeight: 0, passes: 0 };

  private project: Project;
  private state: PlayerState = {
    playing: false,
    rate: 1,
    loop: false,
    range: null,
    quality: 'auto',
    muted: false,
    volume: 1,
    falseColor: false,
  };
  private frame = 0;
  private stateListeners = new Set<Listener>();
  private frameListeners = new Set<(frame: number) => void>();
  private raf = 0;
  private dirty = true;
  private disposed = false;

  private audioCtx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;

  /** Clock anchor: at `anchorTime` (seconds on the active clock) the playhead was at `anchorFrame`. */
  private anchorFrame = 0;
  private anchorTime = 0;
  private anchorKind: 'audio' | 'perf' = 'perf';
  private lastDrawn = -1;
  private viewport = { w: 1280, h: 720, dpr: 1 };
  private fpsWindow: number[] = [];
  private tickCount = 0;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, project: Project, resolver: MediaResolver) {
    this.project = project;
    this.compositor = new Compositor(canvas);
    this.library = new MediaLibrary(resolver);
    this.sources = new SourceManager(this.compositor.glx, this.library);
    this.sources.onInvalidate = () => {
      this.dirty = true;
    };
    if ('addEventListener' in canvas) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.compositor.glx.markLost();
      });
    }
    this.applySize();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ─────────────────────────────────────────────────────────────── state ──

  getState = (): PlayerState => this.state;
  getFrame = (): number => this.frame;
  getProject = (): Project => this.project;

  subscribe = (fn: Listener): (() => void) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };

  /** High-frequency playhead updates. Keep handlers cheap (they run inside the render loop). */
  onFrame = (fn: (frame: number) => void): (() => void) => {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  };

  private setState(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.stateListeners)) fn();
  }

  private emitFrame(): void {
    for (const fn of Array.from(this.frameListeners)) fn(this.frame);
  }

  // ───────────────────────────────────────────────────────────── project ──

  setProject(project: Project): void {
    if (project === this.project) return;
    const prev = this.project;
    this.project = project;
    this.dirty = true;
    if (prev.settings.width !== project.settings.width || prev.settings.height !== project.settings.height) this.applySize();
    if (this.state.playing && this.graph) {
      if (this.graph.update(project)) this.restartAudio();
    }
    const end = sequenceEnd(project);
    if (!this.state.playing && this.frame > end) this.seek(end);
  }

  /** The media behind an asset changed location (e.g. finished downloading). */
  refreshAsset(assetId: string): void {
    this.sources.resetAsset(assetId);
    this.graph?.forget(assetId);
    if (this.state.playing) this.restartAudio();
  }

  // ───────────────────────────────────────────────────────────── viewport ──

  /** Tell the player how large the viewer is on screen so `auto` quality can match it. */
  setViewport(cssWidth: number, cssHeight: number, dpr: number): void {
    this.viewport = { w: Math.max(1, cssWidth), h: Math.max(1, cssHeight), dpr: Math.max(1, dpr) };
    this.applySize();
  }

  setQuality(quality: PreviewQuality): void {
    this.setState({ quality });
    this.applySize();
  }

  private applySize(): void {
    const { width, height } = this.project.settings;
    let scale: number;
    if (this.state.quality === 'auto') {
      const fit = Math.min((this.viewport.w * this.viewport.dpr) / width, (this.viewport.h * this.viewport.dpr) / height);
      // Never render more pixels than the project has; quantise so small layout jitters do not
      // reallocate every buffer.
      scale = Math.min(1, Math.max(0.1, Math.ceil(fit * 8) / 8));
    } else scale = this.state.quality;
    const max = this.compositor.glx.caps.maxTextureSize;
    scale = Math.min(scale, max / width, max / height);
    const w = Math.max(2, Math.round((width * scale) / 2) * 2);
    const h = Math.max(2, Math.round((height * scale) / 2) * 2);
    if (w !== this.compositor.width || h !== this.compositor.height) {
      this.compositor.setSize(w, h);
      this.dirty = true;
    }
    this.stats.renderWidth = w;
    this.stats.renderHeight = h;
  }

  // ──────────────────────────────────────────────────────────── transport ──

  private clockKind(): 'audio' | 'perf' {
    return this.audioCtx && this.audioCtx.state === 'running' ? 'audio' : 'perf';
  }

  /**
   * Read a clock in seconds. The audio clock is offset by output latency so that the frame on
   * screen matches the sound leaving the speakers, not the sound entering the audio pipeline.
   */
  private readClock(kind: 'audio' | 'perf'): number {
    if (kind === 'audio' && this.audioCtx) {
      const latency = (this.audioCtx.outputLatency || 0) + (this.audioCtx.baseLatency || 0);
      return this.audioCtx.currentTime - Math.min(latency, 0.25);
    }
    return performance.now() / 1000;
  }

  private fps(): number {
    return this.project.settings.fpsNum / this.project.settings.fpsDen;
  }

  /** Last frame that playback may reach in the current direction. */
  private bounds(): { start: number; end: number } {
    const r = this.state.range;
    if (r && r.out > r.in) return { start: r.in, end: r.out };
    return { start: 0, end: sequenceEnd(this.project) };
  }

  play(rate = 1): void {
    if (this.disposed) return;
    const { start, end } = this.bounds();
    if (rate > 0 && this.frame >= end) this.frame = start;
    if (rate < 0 && this.frame <= start) this.frame = end;
    this.sources.direction = rate < 0 ? -1 : 1;
    this.ensureAudio();
    void this.audioCtx?.resume().catch(() => {});
    this.setState({ playing: true, rate });
    this.reanchor();
    this.restartAudio();
  }

  pause(): void {
    if (!this.state.playing) return;
    this.syncFrameToClock();
    this.sources.direction = 1;
    this.graph?.stop();
    this.setState({ playing: false, rate: 1 });
    this.frame = Math.round(this.frame);
    this.dirty = true;
    this.emitFrame();
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play(1);
  }

  /** J / K / L style shuttle. */
  shuttle(dir: -1 | 0 | 1): void {
    if (dir === 0) return this.pause();
    const cur = this.state.playing ? this.state.rate : 0;
    let next: number;
    if (dir > 0) next = cur <= 0 ? 1 : Math.min(8, cur * 2);
    else next = cur >= 0 ? -1 : Math.max(-8, cur * 2);
    if (this.state.playing) {
      this.syncFrameToClock();
      this.sources.direction = next < 0 ? -1 : 1;
      this.setState({ rate: next });
      this.reanchor();
      this.restartAudio();
    } else this.play(next);
  }

  seek(frame: number): void {
    const end = Math.max(0, sequenceEnd(this.project));
    const f = Math.max(0, Math.min(Math.round(frame), Math.max(end, 0)));
    this.frame = f;
    this.dirty = true;
    if (this.state.playing) {
      this.reanchor();
      this.restartAudio();
    }
    this.emitFrame();
  }

  step(delta: number): void {
    if (this.state.playing) this.pause();
    this.seek(this.frame + delta);
  }

  setLoop(loop: boolean): void {
    this.setState({ loop });
  }

  setRange(range: { in: number; out: number } | null): void {
    this.setState({ range });
  }

  setMuted(muted: boolean): void {
    this.setState({ muted });
    this.applyVolume();
  }

  setVolume(volume: number): void {
    this.setState({ volume: Math.max(0, Math.min(1.5, volume)) });
    this.applyVolume();
  }

  setFalseColor(on: boolean): void {
    this.setState({ falseColor: on });
    this.dirty = true;
  }

  private applyVolume(): void {
    if (!this.graph || !this.audioCtx) return;
    const silent = this.state.muted || Math.abs(this.state.rate) > 2 || this.state.rate < 0;
    this.graph.master.gain.setTargetAtTime(silent ? 0 : this.state.volume, this.audioCtx.currentTime, 0.01);
  }

  private reanchor(): void {
    this.anchorKind = this.clockKind();
    this.anchorFrame = this.frame;
    this.anchorTime = this.readClock(this.anchorKind);
  }

  private syncFrameToClock(): void {
    if (!this.state.playing) return;
    const elapsed = this.readClock(this.anchorKind) - this.anchorTime;
    this.frame = this.anchorFrame + elapsed * this.fps() * this.state.rate;
    if (this.clockKind() !== this.anchorKind) {
      // The AudioContext started (or stalled): hand the playhead over to the other clock.
      this.reanchor();
      this.restartAudio();
    }
  }

  // ──────────────────────────────────────────────────────────────── audio ──

  private ensureAudio(): void {
    if (this.audioCtx || typeof AudioContext === 'undefined') return;
    try {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: this.project.settings.sampleRate });
    } catch {
      try {
        this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      } catch {
        this.audioCtx = null;
        return;
      }
    }
    this.graph = new AudioGraph(this.audioCtx, this.library, true);
  }

  private restartAudio(): void {
    const { graph, audioCtx } = this;
    if (!graph || !audioCtx || !this.state.playing) return;
    const rate = this.state.rate;
    if (rate <= 0 || rate > 2 || this.anchorKind !== 'audio') {
      // No sound when shuttling fast or backwards, or until the audio clock is actually running.
      graph.stop();
      this.applyVolume();
      return;
    }
    const s = this.project.settings;
    const { end } = this.bounds();
    // `anchorTime` is on the latency-compensated clock, so scheduling against it directly makes
    // sound emerge exactly when its frame is on screen.
    graph.start(this.project, {
      startSec: framesToSeconds(this.anchorFrame, s),
      t0: this.anchorTime,
      rate,
      endSec: framesToSeconds(end, s),
    });
    this.applyVolume();
    void graph.pump();
    if (!this.pumpTimer) {
      this.pumpTimer = setInterval(() => {
        if (this.state.playing) void this.graph?.pump();
      }, 200);
    }
  }

  /** Peak meters: master [L, R] and one value per audio track id. */
  levels(): { master: [number, number]; tracks: Record<string, number> } {
    const tracks: Record<string, number> = {};
    if (!this.graph || !this.state.playing) return { master: [0, 0], tracks };
    for (const t of tracksOf(this.project).audio) tracks[t.id] = this.graph.trackLevel(t.id);
    return { master: this.graph.masterLevels(), tracks };
  }

  // ───────────────────────────────────────────────────────────── rendering ──

  /** Request a redraw on the next animation frame. */
  invalidate(): void {
    this.dirty = true;
  }

  private renderOptions(): RenderOptions {
    return { falseColor: this.state.falseColor };
  }

  private tick = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    this.tickCount++;

    if (this.state.playing) {
      this.syncFrameToClock();
      const { start, end } = this.bounds();
      const forward = this.state.rate > 0;
      if (forward ? this.frame >= end : this.frame <= start) {
        if (this.state.loop && end > start) {
          this.frame = forward ? start : end - 1;
          this.reanchor();
          this.restartAudio();
        } else {
          this.frame = forward ? end : start;
          this.graph?.stop();
          this.sources.direction = 1;
          this.setState({ playing: false, rate: 1 });
          this.dirty = true;
        }
      }
    }

    const display = Math.max(0, Math.floor(this.frame + 1e-6));
    if (display === this.lastDrawn && !this.dirty) return;
    const advanced = display !== this.lastDrawn;
    if (this.state.playing && advanced && this.lastDrawn >= 0) {
      const skipped = Math.abs(display - this.lastDrawn) - 1;
      if (skipped > 0 && Math.abs(this.state.rate) <= 1) this.stats.dropped += skipped;
    }
    this.dirty = false;
    this.lastDrawn = display;

    const t0 = performance.now();
    const desc = resolveFrame(this.project, display);
    void this.sources.prepare(this.project, desc, false);
    const st = this.compositor.render(this.project, desc, this.sources, this.renderOptions());
    this.sources.collect();
    const now = performance.now();
    this.stats.renderMs = this.stats.renderMs * 0.9 + (now - t0) * 0.1;
    this.stats.passes = st.passes;
    if (this.state.playing) {
      this.fpsWindow.push(now);
      while (this.fpsWindow.length && now - this.fpsWindow[0] > 1000) this.fpsWindow.shift();
      this.stats.fps = this.fpsWindow.length;
      if (this.tickCount % 8 === 0) this.prewarm(display);
    }
    if (advanced) this.emitFrame();
  };

  /** Start decoders for clips that begin within the next second so cuts play without a hitch. */
  private prewarm(frame: number): void {
    if (this.state.rate < 0) return;
    const horizon = frame + Math.ceil(this.fps() * Math.max(1, this.state.rate));
    for (const track of tracksOf(this.project).video) {
      if (track.hidden) continue;
      for (const clip of clipsOnTrack(this.project, track.id)) {
        if (clip.start > horizon) break;
        if (clip.type !== 'video' || !clip.assetId || !clip.enabled) continue;
        const lead = clip.transIn ? Math.floor(clip.transIn.duration / 2) : 0;
        const first = clip.start - lead;
        if (first <= frame) continue;
        const desc = resolveFrame(this.project, Math.max(first, 0));
        let found: ClipLayer | null = null;
        for (const l of desc.layers) {
          if (l.kind === 'clip' && l.layer.clip.id === clip.id) found = l.layer;
          else if (l.kind === 'transition') {
            if (l.b?.clip.id === clip.id) found = l.b;
            else if (l.a?.clip.id === clip.id) found = l.a;
          }
        }
        if (found) this.sources.prewarm(clip.id, clip.assetId, clip.reverse, found.sourceTime);
      }
    }
  }

  /** Display-referred pixels for scopes. */
  readScope(maxWidth?: number) {
    return this.compositor.readScope(maxWidth);
  }

  /** Convert a time in seconds to the nearest frame of this project. */
  secondsToFrame(seconds: number): number {
    return Math.round(secondsToFrames(seconds, this.project.settings));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.graph?.dispose();
    void this.audioCtx?.close().catch(() => {});
    this.sources.dispose();
    this.library.dispose();
    this.compositor.dispose();
    this.stateListeners.clear();
    this.frameListeners.clear();
  }
}
