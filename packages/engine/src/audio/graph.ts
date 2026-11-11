/**
 * The audio mixer graph, built identically on a live AudioContext (preview) and on an
 * OfflineAudioContext (export) so what you hear is what you deliver.
 *
 *   clip voice:  buffer sources ─► gain (volume · fades · keyframes) ─► pan ─┐
 *   track:       ◄──────────────────────────────────────────────────────────┘
 *                input ─► [3-band EQ] ─► [compressor ─► make-up] ─► fader ─► pan ─► meter ─► master
 */
import {
  AudioBufferSink,
  type WrappedAudioBuffer,
} from 'mediabunny';
import {
  animated,
  audibleTracks,
  clipEnd,
  clipGainAt,
  dbToGain,
  framesToSeconds,
  gainBreakpoints,
  sourcePerFrame,
  tracksOf,
  type Clip,
  type Project,
  type Track,
} from '@tandem/core';
import type { MediaLibrary } from '../media/library';

interface TrackNodes {
  input: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  makeup: GainNode;
  fader: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode | null;
  wiring: string;
}

export interface Session {
  /** Timeline time (seconds) that plays at context time `t0`. */
  startSec: number;
  t0: number;
  rate: number;
  /** Do not schedule audio past this timeline time (seconds). */
  endSec: number;
}

interface Voice {
  clip: Clip;
  gain: GainNode;
  pan: StereoPannerNode;
  sources: Set<AudioBufferSourceNode>;
  cancelled: boolean;
  /** Context time up to which buffers are scheduled. */
  scheduledUntil: number;
  feeding: boolean;
  done: boolean;
}

/** Fields whose change requires re-scheduling a clip's buffers. */
const structuralKey = (c: Clip): string =>
  `${c.trackId}|${c.assetId}|${c.start}|${c.duration}|${c.sourceIn}|${c.speed}|${c.reverse}|${c.enabled}|${c.audioMuted}`;

export class AudioGraph {
  readonly master: GainNode;
  readonly masterAnalysers: [AnalyserNode, AnalyserNode] | null;
  private readonly tracks = new Map<string, TrackNodes>();
  private readonly voices = new Map<string, Voice>();
  private readonly sinks = new Map<string, Promise<{ sink: AudioBufferSink; start: number } | null>>();
  private project: Project | null = null;
  private session: Session | null = null;
  private fps = 30;
  private readonly meterBuf = new Float32Array(1024);

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly library: MediaLibrary,
    private readonly realtime: boolean,
  ) {
    this.master = ctx.createGain();
    if (realtime) {
      const split = ctx.createChannelSplitter(2);
      const l = ctx.createAnalyser();
      const r = ctx.createAnalyser();
      l.fftSize = r.fftSize = 1024;
      this.master.connect(split);
      split.connect(l, 0);
      split.connect(r, 1);
      this.masterAnalysers = [l, r];
    } else this.masterAnalysers = null;
    this.master.connect(ctx.destination);
  }

  // ─────────────────────────────────────────────────────────────── tracks ──

  private trackNodes(track: Track): TrackNodes {
    let n = this.tracks.get(track.id);
    if (!n) {
      const ctx = this.ctx;
      n = {
        input: ctx.createGain(),
        low: ctx.createBiquadFilter(),
        mid: ctx.createBiquadFilter(),
        high: ctx.createBiquadFilter(),
        comp: ctx.createDynamicsCompressor(),
        makeup: ctx.createGain(),
        fader: ctx.createGain(),
        pan: ctx.createStereoPanner(),
        analyser: this.realtime ? ctx.createAnalyser() : null,
        wiring: '',
      };
      n.low.type = 'lowshelf';
      n.mid.type = 'peaking';
      n.high.type = 'highshelf';
      n.mid.Q.value = 0.9;
      n.fader.connect(n.pan);
      n.pan.connect(this.master);
      if (n.analyser) {
        n.analyser.fftSize = 1024;
        n.pan.connect(n.analyser);
      }
      this.tracks.set(track.id, n);
    }
    return n;
  }

  private syncTrack(track: Track, audible: boolean, immediate: boolean): void {
    const n = this.trackNodes(track);
    const ctx = this.ctx;
    const eqOn = !!track.eq?.enabled;
    const compOn = !!track.compressor?.enabled;
    const wiring = `${eqOn}|${compOn}`;
    if (wiring !== n.wiring) {
      // Re-patch the insert chain so disabled processors are truly out of the signal path.
      for (const node of [n.input, n.low, n.mid, n.high, n.comp, n.makeup]) node.disconnect();
      let tail: AudioNode = n.input;
      if (eqOn) {
        tail.connect(n.low);
        n.low.connect(n.mid);
        n.mid.connect(n.high);
        tail = n.high;
      }
      if (compOn) {
        tail.connect(n.comp);
        n.comp.connect(n.makeup);
        tail = n.makeup;
      }
      tail.connect(n.fader);
      n.wiring = wiring;
    }
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number) => {
      if (immediate) p.value = v;
      else p.setTargetAtTime(v, now, 0.015);
    };
    if (track.eq) {
      set(n.low.frequency, track.eq.lowFreq);
      set(n.mid.frequency, track.eq.midFreq);
      set(n.high.frequency, track.eq.highFreq);
      set(n.low.gain, track.eq.low);
      set(n.mid.gain, track.eq.mid);
      set(n.high.gain, track.eq.high);
    }
    if (track.compressor) {
      const c = track.compressor;
      set(n.comp.threshold, c.threshold);
      set(n.comp.ratio, c.ratio);
      set(n.comp.attack, c.attack);
      set(n.comp.release, c.release);
      set(n.comp.knee, c.knee);
      set(n.makeup.gain, dbToGain(c.makeup));
    }
    set(n.fader.gain, audible ? dbToGain(track.volume) : 0);
    set(n.pan.pan, Math.max(-1, Math.min(1, track.pan)));
  }

  private syncTracks(project: Project, immediate: boolean): void {
    const audible = audibleTracks(project);
    const { audio } = tracksOf(project);
    const seen = new Set<string>();
    for (const t of audio) {
      seen.add(t.id);
      this.syncTrack(t, audible.has(t.id), immediate);
    }
    for (const [id, n] of this.tracks) {
      if (seen.has(id)) continue;
      for (const node of [n.input, n.low, n.mid, n.high, n.comp, n.makeup, n.fader, n.pan]) node.disconnect();
      this.tracks.delete(id);
    }
  }

  // ─────────────────────────────────────────────────────────────── timing ──

  private ctxTime(timelineSec: number): number {
    const s = this.session!;
    return s.t0 + (timelineSec - s.startSec) / s.rate;
  }

  private timelineSec(ctxTime: number): number {
    const s = this.session!;
    return s.startSec + (ctxTime - s.t0) * s.rate;
  }

  // ─────────────────────────────────────────────────────────────── voices ──

  private sinkFor(assetId: string): Promise<{ sink: AudioBufferSink; start: number } | null> {
    let p = this.sinks.get(assetId);
    if (!p) {
      p = this.library.get(assetId).then((m) => {
        if (!m || !m.audio || !m.audioDecodable) return null;
        return { sink: new AudioBufferSink(m.audio), start: m.audioStart };
      });
      this.sinks.set(assetId, p);
    }
    return p;
  }

  /** Program a voice's gain envelope from context time `from` onward. */
  private automate(v: Voice, from: number): void {
    const project = this.project!;
    const clip = v.clip;
    const g = v.gain.gain;
    const startSec = framesToSeconds(clip.start, project.settings);
    const frameAt = (ctxT: number) => (this.timelineSec(ctxT) - startSec) * this.fps;
    g.cancelScheduledValues(Math.max(0, from));
    const f0 = Math.max(0, Math.min(clip.duration, frameAt(from)));
    g.setValueAtTime(clipGainAt(clip, f0), Math.max(0, from));
    if (f0 <= 0) {
      // The clip has not started yet: pin the envelope's first value to the clip start so ramps
      // begin there rather than at the moment we happened to schedule.
      const tStart = this.ctxTime(startSec);
      if (tStart > from) g.setValueAtTime(clipGainAt(clip, 0), tStart);
    }
    // Breakpoints, with fades subdivided so the equal-power curve is followed closely.
    const pts: number[] = [];
    const bps = gainBreakpoints(clip);
    for (let i = 0; i < bps.length - 1; i++) {
      const a = bps[i];
      const b = bps[i + 1];
      const steps = b - a > 1 ? Math.min(12, Math.ceil(b - a)) : 1;
      for (let k = 1; k <= steps; k++) pts.push(a + ((b - a) * k) / steps);
    }
    for (const f of pts) {
      if (f <= f0) continue;
      const t = this.ctxTime(startSec + f / this.fps);
      if (t <= from) continue;
      // Sample just inside the clip so the last point does not read the post-clip silence.
      g.linearRampToValueAtTime(clipGainAt(clip, Math.min(f, clip.duration - 1e-3)), t);
    }
    v.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, animated(clip, 'pan', f0, clip.pan))), Math.max(0, from));
    for (const k of clip.keyframes.pan ?? []) {
      if (k.t <= f0) continue;
      v.pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, k.v)), this.ctxTime(startSec + k.t / this.fps));
    }
  }

  private makeVoice(clip: Clip): Voice | null {
    const track = this.project!.tracks[clip.trackId];
    if (!track) return null;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    // Up-mix mono sources to dual-mono before panning. Otherwise the panner's equal-power law
    // would play every mono clip 3 dB quieter than its meter reads.
    gain.channelCount = 2;
    gain.channelCountMode = 'explicit';
    gain.channelInterpretation = 'speakers';
    const pan = ctx.createStereoPanner();
    gain.connect(pan);
    pan.connect(this.trackNodes(track).input);
    return { clip, gain, pan, sources: new Set(), cancelled: false, scheduledUntil: 0, feeding: false, done: false };
  }

  private killVoice(v: Voice): void {
    v.cancelled = true;
    for (const s of v.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    v.sources.clear();
    v.gain.disconnect();
    v.pan.disconnect();
  }

  /** Schedule one decoded buffer of a voice. Returns the context time at which it ends. */
  private scheduleBuffer(v: Voice, wb: WrappedAudioBuffer, srcOffset: number): number {
    const project = this.project!;
    const clip = v.clip;
    const per = sourcePerFrame(clip, project) * this.fps; // source seconds per timeline second
    const clipStartSec = framesToSeconds(clip.start, project.settings);
    const clipEndSec = framesToSeconds(clipEnd(clip), project.settings);
    const bufStart = wb.timestamp - srcOffset; // source time of the buffer's first sample
    const bufEnd = bufStart + wb.buffer.duration;

    // Source range this clip uses.
    const srcA = clip.sourceIn;
    const srcB = clip.sourceIn + (clipEndSec - clipStartSec) * per;
    let a = Math.max(bufStart, srcA);
    let b = Math.min(bufEnd, srcB);
    // …clipped to what the session will actually play.
    const s = this.session!;
    const sessFrom = clip.reverse ? srcB - (Math.min(s.endSec, clipEndSec) - clipStartSec) * per : srcA + (Math.max(s.startSec, clipStartSec) - clipStartSec) * per;
    const sessTo = clip.reverse ? srcB - (Math.max(s.startSec, clipStartSec) - clipStartSec) * per : srcA + (Math.min(s.endSec, clipEndSec) - clipStartSec) * per;
    a = Math.max(a, Math.min(sessFrom, sessTo));
    b = Math.min(b, Math.max(sessFrom, sessTo));
    if (b - a < 1e-4) return this.ctxTime(clipStartSec + ((clip.reverse ? srcB - bufStart : bufEnd - srcA) / per));

    let buffer = wb.buffer;
    let offset = a - bufStart;
    // Timeline time at which sample `a` (forward) or `b` (reverse) is heard.
    let tl = clipStartSec + (a - srcA) / per;
    if (clip.reverse) {
      buffer = reversed(this.ctx, wb.buffer);
      offset = bufEnd - b;
      tl = clipStartSec + (srcB - b) / per;
    }
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = per * s.rate;
    node.connect(v.gain);
    const when = this.ctxTime(tl);
    const dur = b - a;
    const endAt = when + dur / (per * s.rate);
    const now = this.ctx.currentTime;
    if (when >= now) node.start(when, offset, dur);
    else {
      // Late (decode lag): skip the part that should already have played.
      const late = (now - when) * per * s.rate;
      if (late >= dur) return endAt;
      node.start(now, offset + late, dur - late);
    }
    v.sources.add(node);
    node.onended = () => {
      v.sources.delete(node);
      node.disconnect();
    };
    return endAt;
  }

  /** Keep a voice's buffers scheduled up to `horizon` (context time). */
  private async feed(v: Voice, horizon: () => number): Promise<void> {
    if (v.feeding || v.done || v.cancelled) return;
    v.feeding = true;
    const clip = v.clip;
    const project = this.project!;
    const session = this.session!;
    try {
      const opened = clip.assetId ? await this.sinkFor(clip.assetId) : null;
      if (!opened || v.cancelled) {
        v.done = true;
        return;
      }
      const per = sourcePerFrame(clip, project) * this.fps;
      const clipStartSec = framesToSeconds(clip.start, project.settings);
      const clipEndSec = framesToSeconds(clipEnd(clip), project.settings);
      const fromTl = Math.max(session.startSec, clipStartSec);
      const toTl = Math.min(session.endSec, clipEndSec);
      if (toTl <= fromTl) {
        v.done = true;
        return;
      }
      const srcB = clip.sourceIn + (clipEndSec - clipStartSec) * per;
      const srcFrom = clip.reverse ? srcB - (toTl - clipStartSec) * per : clip.sourceIn + (fromTl - clipStartSec) * per;
      const srcTo = clip.reverse ? srcB - (fromTl - clipStartSec) * per : clip.sourceIn + (toTl - clipStartSec) * per;

      if (clip.reverse) {
        // Reverse playback needs the buffers in descending order: collect, then schedule backwards.
        const all: WrappedAudioBuffer[] = [];
        for await (const wb of opened.sink.buffers(srcFrom + opened.start, srcTo + opened.start)) {
          if (v.cancelled) return;
          all.push(wb);
          if (all.length > 20000) break;
        }
        for (let i = all.length - 1; i >= 0; i--) this.scheduleBuffer(v, all[i], opened.start);
        v.done = true;
        return;
      }

      for await (const wb of opened.sink.buffers(srcFrom + opened.start, srcTo + opened.start)) {
        if (v.cancelled) return;
        v.scheduledUntil = this.scheduleBuffer(v, wb, opened.start);
        while (!v.cancelled && this.realtime && v.scheduledUntil > horizon()) {
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      v.done = true;
    } catch (err) {
      if (!v.cancelled) console.warn('[audio] decode error', err);
      v.done = true;
    } finally {
      v.feeding = false;
    }
  }

  // ─────────────────────────────────────────────────────────── public API ──

  /** Begin (or restart) playback of `project` according to `session`. */
  start(project: Project, session: Session): void {
    this.stop();
    this.project = project;
    this.session = session;
    this.fps = project.settings.fpsNum / project.settings.fpsDen;
    this.syncTracks(project, true);
  }

  /**
   * Make sure every clip that sounds between now and `aheadSec` seconds from now has a voice with
   * buffers scheduled. Call periodically during playback. In offline mode resolves when everything
   * in the session range is scheduled.
   */
  async pump(aheadSec = 2): Promise<void> {
    const project = this.project;
    const session = this.session;
    if (!project || !session) return;
    const ctx = this.ctx;
    const nowTl = this.realtime ? this.timelineSec(ctx.currentTime) : session.startSec;
    const untilTl = this.realtime ? Math.min(session.endSec, nowTl + aheadSec * session.rate) : session.endSec;
    const audible = audibleTracks(project);
    const horizon = () => ctx.currentTime + aheadSec;
    const jobs: Promise<void>[] = [];
    for (const clip of Object.values(project.clips)) {
      if (clip.type !== 'audio' || !clip.enabled || clip.audioMuted || !clip.assetId) continue;
      if (!audible.has(clip.trackId)) continue;
      const a = framesToSeconds(clip.start, project.settings);
      const b = framesToSeconds(clipEnd(clip), project.settings);
      if (b <= nowTl || a >= untilTl) continue;
      let v = this.voices.get(clip.id);
      if (!v) {
        const made = this.makeVoice(clip);
        if (!made) continue;
        v = made;
        this.voices.set(clip.id, v);
        this.automate(v, this.realtime ? ctx.currentTime : 0);
      }
      jobs.push(this.feed(v, horizon));
    }
    if (!this.realtime) await Promise.all(jobs);
  }

  /** Apply project edits while playing. Returns true when a full restart is required. */
  update(project: Project): boolean {
    const prev = this.project;
    this.project = project;
    if (!prev || !this.session) return false;
    this.syncTracks(project, false);
    let restart = false;
    for (const [id, v] of this.voices) {
      const next = project.clips[id];
      if (!next || next.type !== 'audio' || structuralKey(next) !== structuralKey(v.clip)) {
        restart = true;
        continue;
      }
      if (next !== v.clip) {
        v.clip = next;
        this.automate(v, this.ctx.currentTime);
      }
    }
    // New or newly audible clips are picked up by the next pump().
    if (audibleKey(prev) !== audibleKey(project)) restart = true;
    return restart;
  }

  stop(): void {
    for (const v of this.voices.values()) this.killVoice(v);
    this.voices.clear();
    this.session = null;
  }

  /** Peak level (linear) of the master bus, per channel. */
  masterLevels(): [number, number] {
    if (!this.masterAnalysers) return [0, 0];
    return [this.peak(this.masterAnalysers[0]), this.peak(this.masterAnalysers[1])];
  }

  trackLevel(trackId: string): number {
    const n = this.tracks.get(trackId);
    return n?.analyser ? this.peak(n.analyser) : 0;
  }

  private peak(a: AnalyserNode): number {
    a.getFloatTimeDomainData(this.meterBuf);
    let p = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i]);
      if (v > p) p = v;
    }
    return p;
  }

  dispose(): void {
    this.stop();
    this.master.disconnect();
    this.tracks.clear();
    this.sinks.clear();
  }
}

const audibleKey = (p: Project): string => Array.from(audibleTracks(p)).sort().join(',');

const reverseCache = new WeakMap<AudioBuffer, AudioBuffer>();

function reversed(ctx: BaseAudioContext, src: AudioBuffer): AudioBuffer {
  let out = reverseCache.get(src);
  if (out) return out;
  out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = new Float32Array(src.length);
    src.copyFromChannel(data, c);
    data.reverse();
    out.copyToChannel(data, c);
  }
  reverseCache.set(src, out);
  return out;
}

/**
 * Render a stretch of the project's audio offline. A short pre-roll is rendered and discarded so
 * filters and compressors have settled by the first returned sample.
 */
export async function renderAudioChunk(
  project: Project,
  library: MediaLibrary,
  startSec: number,
  durationSec: number,
  sampleRate: number,
  preRollSec = 0.5,
): Promise<AudioBuffer> {
  const pre = Math.min(preRollSec, startSec);
  const total = Math.max(1, Math.ceil((pre + durationSec) * sampleRate));
  const ctx = new OfflineAudioContext(2, total, sampleRate);
  const graph = new AudioGraph(ctx, library, false);
  graph.start(project, { startSec: startSec - pre, t0: 0, rate: 1, endSec: startSec + durationSec });
  await graph.pump();
  const rendered = await ctx.startRendering();
  graph.dispose();
  const skip = Math.round(pre * sampleRate);
  if (skip === 0) return rendered;
  const length = Math.max(1, rendered.length - skip);
  const out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  for (let c = 0; c < 2; c++) {
    out.copyToChannel(rendered.getChannelData(c).subarray(skip), c);
  }
  return out;
}

/** Does anything in the project make sound? */
export function hasAudibleAudio(project: Project): boolean {
  const audible = audibleTracks(project);
  return Object.values(project.clips).some((c) => c.type === 'audio' && c.enabled && !c.audioMuted && audible.has(c.trackId));
}
