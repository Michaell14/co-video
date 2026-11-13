/**
 * The audio mixer graph, built identically on a live AudioContext (preview) and on an
 * OfflineAudioContext (export) so what you hear is what you deliver.
 *
 *   clip voice:  buffer sources ─► gain (volume · fades · keyframes) ─► pan ─┐
 *   track:       ◄──────────────────────────────────────────────────────────┘
 *                input ─► [3-band EQ] ─► [compressor ─► make-up] ─► fader ─► pan ─► meter ─► master
 */
import { AudioBufferSink, type WrappedAudioBuffer } from 'mediabunny';
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
import type { MediaFault, MediaLibrary } from '../media/library';
import { FULL_KERNEL_STEP, Resampler, resampleReach, type Resampled } from './resample';

/** How long a voice waits before asking again for media that is not available yet. */
const RETRY_MS = 2000;
/** In samples: far more than the rounding noise of a time computed in seconds, far less than a sample. */
const HALF_SAMPLE_BIAS = 1e-4;
/** A preview's mixer gives way to the rest of the page after scheduling for this long at a stretch. */
const SLICE_MS = 6;

/** An audio clip that could not be mixed as asked. */
export interface AudioProblem {
  clipId: string;
  assetId: string;
  /**
   * `missing`: the file is neither on this device nor on the server. `unreadable`: it is there but
   * could not be opened. `undecodable`: this browser cannot decode its audio. `decode-error`:
   * decoding stopped part-way through.
   */
  reason: MediaFault | 'undecodable' | 'decode-error';
}

/** `rate` is the sample rate the file declares for its sound; decoded buffers carry their own. */
type OpenAudio = { sink: AudioBufferSink; start: number; rate: number };

/**
 * The buffers of one decode, each placed where the one before it ends. A decoder's buffers follow
 * one another to the sample, but each carries a time of its own that was rounded to a whole sample
 * by itself. Where the decode began between two samples (a container that keeps packet times in
 * milliseconds, sound at 44.1 kHz) the rounding falls now one way and now the other, and a buffer
 * taken at its word leaves a hole of one sample, or lands on the last sample of the one before
 * it: a click either way. So a buffer that claims to start one sample off is moved back by that
 * sample. A real gap in a file is longer, and stays.
 */
async function* inSequence(
  buffers: AsyncGenerator<WrappedAudioBuffer, void, unknown>,
): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
  // Where the buffer that comes next begins: `counted` samples at `rate` after `start`.
  let start = 0;
  let counted = 0;
  let rate = 0;
  for await (const wb of buffers) {
    const { length, sampleRate } = wb.buffer;
    const off = sampleRate === rate ? (wb.timestamp - start) * rate - counted : NaN;
    if (Math.abs(off) < 1.5) {
      counted += length;
      const samples = Math.round(off);
      yield samples === 0 ? wb : { ...wb, timestamp: wb.timestamp - samples / rate };
    } else {
      [start, counted, rate] = [wb.timestamp, length, sampleRate];
      yield wb;
    }
  }
}

/**
 * The longest stretch of a file (seconds) that is decoded and kept in one piece for a clip that
 * plays backwards in a render made in chunks: about 115 MB of stereo sound at 48 kHz.
 */
const HELD_BACKWARDS = 300;

/** One clip's sound on its way through a render made in chunks: see `AudioRuns`. */
class Run {
  /** Decoded and still to be asked for, in order. */
  private held: WrappedAudioBuffer[] = [];
  private source: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
  /**
   * For a clip that plays backwards: the time in its file up to which `held` has what is left for
   * it to play, decoded in one pass. Nothing is held that way while this is `-Infinity`.
   */
  private top = -Infinity;

  /**
   * The buffers `sink.buffers(from, to)` would give, out of one decode of `[low, high)`, the
   * stretch of the file the render plays for the clip. Forwards, the reads follow one another, and
   * each carries on where the one before stopped; one that does not lie in what that one decoded
   * seeks anew. `again` is where the read after this one may begin: what lies before it is not kept.
   * Backwards, the stretches asked for come in descending order, which no decoder can follow. So
   * the first read decodes everything from `low` up to its own end, beyond which no later one
   * asks, and that is handed out from its end and let go once a read has reached `low`. More than
   * `HELD_BACKWARDS` is too much to keep: reads seek for themselves until what is left to play is
   * no longer than that.
   */
  async *read(
    sink: AudioBufferSink,
    from: number,
    to: number,
    again: number,
    low: number,
    high: number,
    backwards: boolean,
  ): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    if (backwards) {
      if (to > this.top) {
        await this.end();
        if (to - low > HELD_BACKWARDS) {
          yield* inSequence(sink.buffers(from, to));
          return;
        }
        const all: WrappedAudioBuffer[] = [];
        for await (const wb of inSequence(sink.buffers(low, to))) all.push(wb);
        this.held = all;
      }
      // The reads come in descending order: what lies after this one is not asked for again.
      this.top = to;
      let i = Math.max(
        0,
        this.held.findLastIndex((wb) => wb.timestamp <= from),
      );
      for (; i < this.held.length && this.held[i].timestamp < to; i++) yield this.held[i];
      this.held.length = i;
      if (from <= low) await this.end();
      return;
    }
    const first = this.held.findLastIndex((wb) => wb.timestamp <= from);
    if (!this.source || first < 0) {
      await this.end();
      this.source = inSequence(sink.buffers(from, high));
    } else this.held.splice(0, first);
    for (let i = 0; ; i++) {
      if (i === this.held.length) {
        let next: IteratorResult<WrappedAudioBuffer, void>;
        try {
          next = await this.source.next();
        } catch (err) {
          // Nothing more comes from this decoder; a later read starts another.
          this.source = null;
          this.held = [];
          throw err;
        }
        if (next.done) break;
        this.held.push(next.value);
      }
      // A buffer that starts where this read ends stays for the read that follows.
      if (this.held[i].timestamp >= to) break;
      yield this.held[i];
      // Behind this buffer, only what the read that follows can ask for is of any use.
      while (i > 0 && this.held[1].timestamp <= again) {
        this.held.shift();
        i--;
      }
    }
    if (to >= high) await this.end();
  }

  /** Close the decoder and let go of what it gave. */
  async end(): Promise<void> {
    const source = this.source;
    this.source = null;
    this.held = [];
    this.top = -Infinity;
    await source?.return().catch(() => {});
  }
}

/**
 * What a render made in chunks carries from one chunk to the next: for every clip, the decoder
 * part-way through its sound, or the sound itself when the clip plays backwards. Each clip is
 * then decoded once, from where it starts to where it ends, as it is when the same stretch is
 * rendered in one go.
 *
 * Without it every chunk seeks to its own start, and what a decoder gives after a seek is not
 * always placed where the decode before it placed the same sound. WebM and Matroska round packet
 * times to milliseconds, so two decodes begun at different packets can be a millisecond apart, and
 * a Vorbis decoder returns nothing for the first packet it is given while its output is timed from
 * that packet. Where two stretches placed differently meet, there is a click.
 */
export class AudioRuns {
  /**
   * Seconds of timeline that the chunk after the one being rendered renders again before its own
   * start (its pre-roll). Sound decoded for an earlier time than that is not carried over.
   */
  lookBack = 0;
  private readonly runs = new Map<string, Run>();

  /**
   * `endSec` is the timeline time (seconds) at which the last chunk ends, when that is known
   * beforehand. Of a clip that goes on after it, only what the render plays is then decoded. That
   * matters most for a clip that plays backwards, whose sound is decoded all at once.
   */
  constructor(readonly endSec = Infinity) {}

  /** The decode of `clip` that is under way, for the mixer that renders the next chunk. */
  of(clip: Clip): Run {
    const key = `${clip.id}|${clip.assetId}`;
    let run = this.runs.get(key);
    if (!run) this.runs.set(key, (run = new Run()));
    return run;
  }

  dispose(): void {
    for (const run of this.runs.values()) void run.end();
    this.runs.clear();
  }
}

/**
 * A run of buffers that follow one another, on its way through rate conversion. `next` is where
 * the buffer after the last one given has to begin to belong to the run: seconds of source from
 * the point of the file at which the clip starts to play.
 */
interface Conversion {
  resampler: Resampler;
  rate: number;
  next: number;
}

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
  /** Do not try to open the voice's media again before this time (`performance.now()`). */
  retryAt: number;
  /** Fraction of an output sample the voice is moved by to sit on the sample grid; null until known. */
  nudge: number | null;
  /** Set while the voice's sound is being converted to the context's rate (see `convert`). */
  conversion: Conversion | null;
}

/** Fields whose change requires re-scheduling a clip's buffers. */
const structuralKey = (c: Clip): string =>
  `${c.trackId}|${c.assetId}|${c.start}|${c.duration}|${c.sourceIn}|${c.speed}|${c.reverse}|${c.enabled}|${c.audioMuted}`;

export class AudioGraph {
  readonly master: GainNode;
  readonly masterAnalysers: [AnalyserNode, AnalyserNode] | null;
  private readonly tracks = new Map<string, TrackNodes>();
  private readonly voices = new Map<string, Voice>();
  private readonly sinks = new Map<string, Promise<OpenAudio | AudioProblem['reason'] | null>>();
  /** Told about each clip that stays silent, or falls silent, because of its media. */
  onProblem: ((problem: AudioProblem) => void) | null = null;
  private project: Project | null = null;
  private session: Session | null = null;
  private fps = 30;
  /** When the voices of a preview last gave way to the rest of the page (`performance.now()`). */
  private yieldedAt = 0;
  private readonly meterBuf = new Float32Array(1024);

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly library: MediaLibrary,
    private readonly realtime: boolean,
    /** Decoders carried over from the chunk rendered before this one, and on to the next. */
    private readonly runs: AudioRuns | null = null,
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

  /** The decoder for an asset's sound; null when it has none, or the reason it cannot be had. */
  private sinkFor(assetId: string): Promise<OpenAudio | AudioProblem['reason'] | null> {
    let p = this.sinks.get(assetId);
    if (!p) {
      const opening = this.library.open(assetId).then(async (m) => {
        if (typeof m === 'string') {
          // Nothing that lasts: a missing file may have arrived by the time the next voice asks,
          // and one that did not open is tried again when playback next starts.
          if (this.sinks.get(assetId) === opening) this.sinks.delete(assetId);
          return m;
        }
        if (!m.audio) return null;
        if (!m.audioDecodable) return 'undecodable';
        return {
          sink: new AudioBufferSink(m.audio),
          start: m.audioStart,
          rate: await m.audio.getSampleRate(),
        };
      });
      this.sinks.set(assetId, (p = opening));
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
    v.pan.pan.setValueAtTime(
      Math.max(-1, Math.min(1, animated(clip, 'pan', f0, clip.pan))),
      Math.max(0, from),
    );
    for (const k of clip.keyframes.pan ?? []) {
      if (k.t <= f0) continue;
      v.pan.pan.linearRampToValueAtTime(
        Math.max(-1, Math.min(1, k.v)),
        this.ctxTime(startSec + k.t / this.fps),
      );
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
    return {
      clip,
      gain,
      pan,
      sources: new Set(),
      cancelled: false,
      scheduledUntil: 0,
      feeding: false,
      done: false,
      retryAt: 0,
      nudge: null,
      conversion: null,
    };
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
    v.conversion = null;
    v.gain.disconnect();
    v.pan.disconnect();
  }

  /** Whether sound at `sampleRate`, read at `speed`, is the context's own samples one for one. */
  private passes(sampleRate: number, speed: number): boolean {
    return sampleRate === this.ctx.sampleRate && Math.abs(speed - 1) < 1e-9;
  }

  /**
   * Whether sound that does not pass as it is, read at `step` of its samples per output sample,
   * gets converted here (see `convert`). In an export it always is. A preview has to stay ahead
   * of the clock on the thread that also draws the picture, and what it does not convert in time
   * is not heard at all. The work grows with the step: a few clips sped up a hundred times take
   * longer to convert than to play. So beyond the step up to which the kernel has all its lobes a
   * preview leaves the sound to the buffer sources, which play at the matching rate themselves,
   * coarsely and for a fraction of the work. It does the same with everything while shuttling,
   * which is for finding one's place.
   */
  private converting(step: number): boolean {
    return this.session!.rate === 1 && (!this.realtime || step < FULL_KERNEL_STEP + 1e-9);
  }

  /** Hand a node to the voice that plays it, to be stopped with the voice and let go when it ends. */
  private adopt(v: Voice, node: AudioBufferSourceNode): void {
    v.sources.add(node);
    node.onended = () => {
      v.sources.delete(node);
      node.disconnect();
    };
  }

  /** Schedule converted samples; the first of them belongs on context sample `out.first`. */
  private play(v: Voice, out: Resampled | null): void {
    if (!out) return;
    const rate = this.ctx.sampleRate;
    // Late (decode lag): skip the part that should already have played.
    const late = Math.max(0, Math.ceil(this.ctx.currentTime * rate) - out.first);
    const length = out.data[0].length - late;
    if (length <= 0) return;
    const buffer = this.ctx.createBuffer(out.data.length, length, rate);
    out.data.forEach((samples, c) => buffer.copyToChannel(samples.subarray(late), c));
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(v.gain);
    // On a whole sample, at the context's rate and at normal speed: played as computed. The end
    // is given as well, a quarter of a sample short. Left to work it out from the buffer's length
    // in seconds, the browser plays the last sample twice for the lengths that come back from
    // that a hair too long (about one in sixteen), on top of the first sample of what follows.
    node.start((out.first + late) / rate, 0, (length - 0.25) / rate);
    this.adopt(v, node);
  }

  /** The run of buffers being converted has ended: play out what its last samples still reach. */
  private endConversion(v: Voice): void {
    if (!v.conversion) return;
    this.play(v, v.conversion.resampler.finish());
    v.conversion = null;
  }

  /**
   * Schedule one decoded buffer of a voice whose sound is not the context's samples one for one:
   * another sample rate, another speed, or both. A buffer source left to play it at the matching
   * rate would draw a line between neighbouring samples. Instead the output samples are computed
   * here, band-limited, each at its exact place on the context's sample grid, and played as they
   * are. Returns the context time at which the buffer ends.
   */
  private convert(v: Voice, wb: WrappedAudioBuffer, srcOffset: number): number {
    const project = this.project!;
    const s = this.session!;
    const clip = v.clip;
    const buffer = wb.buffer;
    const per = sourcePerFrame(clip, project) * this.fps;
    const clipStartSec = framesToSeconds(clip.start, project.settings);
    const clipEndSec = framesToSeconds(clipEnd(clip), project.settings);
    const bufStart = wb.timestamp - srcOffset;
    const seconds = buffer.length / buffer.sampleRate;
    // Source seconds from where the clip starts to play to the first sample of this buffer that
    // is heard: its first one, or its last when the clip runs backwards, as the reversed buffers
    // of the other path are placed.
    const lead = clip.reverse
      ? clip.sourceIn + (clipEndSec - clipStartSec) * per - (bufStart + seconds)
      : bufStart - clip.sourceIn;
    let run = v.conversion;
    if (
      run &&
      (run.rate !== buffer.sampleRate ||
        run.resampler.channels !== buffer.numberOfChannels ||
        Math.abs(lead - run.next) * buffer.sampleRate > 1e-3)
    ) {
      // Not the continuation of what came before (a gap in the file, a change of format). Each
      // run fades into silence at its ends over the reach of the kernel, and runs add up.
      this.endConversion(v);
      run = null;
    }
    if (!run) {
      const rate = this.ctx.sampleRate;
      // Context sample `i` is heard at timeline time `startSec + (i / rate - t0) * s.rate`, which
      // lies `(that - clipStartSec) * per` source seconds into the clip: `origin + i * step`
      // source samples from the start of this run.
      const step = (per * s.rate * buffer.sampleRate) / rate;
      const origin = ((s.startSec - s.t0 * s.rate - clipStartSec) * per - lead) * buffer.sampleRate;
      // The clip sounds on the samples from its start up to its end, and a sample that rounding
      // noise puts a hair before either edge is on it.
      const sampleAt = (timelineSec: number) =>
        Math.ceil(this.ctxTime(timelineSec) * rate - HALF_SAMPLE_BIAS);
      const first = sampleAt(Math.max(s.startSec, clipStartSec));
      const last = sampleAt(Math.min(s.endSec, clipEndSec));
      run = {
        resampler: new Resampler(buffer.numberOfChannels, origin, step, first, last),
        rate: buffer.sampleRate,
        next: lead,
      };
      v.conversion = run;
    }
    run.next = lead + seconds;
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const samples = buffer.getChannelData(c);
      channels.push(clip.reverse ? samples.slice().reverse() : samples);
    }
    this.play(v, run.resampler.push(channels));
    return this.ctxTime(clipStartSec + (lead + seconds) / per);
  }

  /** Schedule one decoded buffer of a voice. Returns the context time at which it ends. */
  private scheduleBuffer(v: Voice, wb: WrappedAudioBuffer, srcOffset: number): number {
    const project = this.project!;
    const clip = v.clip;
    const s = this.session!;
    const per = sourcePerFrame(clip, project) * this.fps; // source seconds per timeline second
    const exact = this.passes(wb.buffer.sampleRate, per * s.rate);
    const step = (per * s.rate * wb.buffer.sampleRate) / this.ctx.sampleRate;
    if (!exact && this.converting(step)) return this.convert(v, wb, srcOffset);
    this.endConversion(v);
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
    const sessFrom = clip.reverse
      ? srcB - (Math.min(s.endSec, clipEndSec) - clipStartSec) * per
      : srcA + (Math.max(s.startSec, clipStartSec) - clipStartSec) * per;
    const sessTo = clip.reverse
      ? srcB - (Math.max(s.startSec, clipStartSec) - clipStartSec) * per
      : srcA + (Math.min(s.endSec, clipEndSec) - clipStartSec) * per;
    a = Math.max(a, Math.min(sessFrom, sessTo));
    b = Math.min(b, Math.max(sessFrom, sessTo));
    if (b - a < 1e-4)
      return this.ctxTime(clipStartSec + (clip.reverse ? srcB - bufStart : bufEnd - srcA) / per);

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
    let when = this.ctxTime(tl);
    let dur = b - a;
    const endAt = when + dur / (per * s.rate);
    // Audio at the context's own rate and at normal speed can be played sample for sample, but
    // only from a whole sample of the buffer at a whole sample of the output. Started in between
    // (a clip on a 29.97 fps frame, an in-point between samples) every sample is interpolated
    // from its neighbours instead and the treble goes. So the voice as a whole moves by the
    // fraction of a sample that puts its first buffer on the grid (at most 10 µs at 48 kHz), and
    // the buffers after it, which follow at whole-sample distances, land there as well.
    const rate = this.ctx.sampleRate;
    if (exact) {
      // A voice that lies exactly half-way between two samples (44.1 kHz at 24 fps does that on
      // every other frame) has to fall the same way each time it is scheduled, or the chunks of an
      // export would not join: rounding noise must not decide. So the edges of what plays round
      // half up and the position rounds half down, each with room to spare.
      const first = Math.floor(offset * rate + 0.5 + HALF_SAMPLE_BIAS);
      const count = Math.floor((offset + dur) * rate + 0.5 + HALF_SAMPLE_BIAS) - first;
      const at = (when + (first / rate - offset)) * rate;
      v.nudge ??= Math.floor(at + 0.5 - HALF_SAMPLE_BIAS) - at;
      const sample = at + v.nudge;
      // A buffer whose timestamp is off that grid (containers that round) is left where it is.
      if (count > 0 && Math.abs(sample - Math.round(sample)) < 1e-3) {
        when = Math.round(sample) / rate;
        offset = first / rate;
        // Ends a quarter of a sample short, so that however the end is rounded it is `count`
        // samples that play: neither one more nor one fewer.
        dur = (count - 0.25) / rate;
      }
    }
    const now = this.ctx.currentTime;
    if (when >= now) node.start(when, offset, dur);
    else {
      // Late (decode lag): skip the part that should already have played.
      const late = (now - when) * per * s.rate;
      if (late >= dur) return endAt;
      node.start(now, offset + late, dur - late);
    }
    this.adopt(v, node);
    return endAt;
  }

  /**
   * Between two buffers of a preview's voice: wait while it is scheduled as far ahead as it need
   * be, and otherwise let the page have a turn once the voices have kept it for a while. Decoded
   * buffers can arrive many at a time, converting them is real work, and the picture is drawn on
   * the same thread.
   */
  private async pace(v: Voice, horizon: () => number): Promise<void> {
    let waited = false;
    while (!v.cancelled && v.scheduledUntil > horizon()) {
      await new Promise((r) => setTimeout(r, 120));
      waited = true;
    }
    if (!waited && performance.now() - this.yieldedAt < SLICE_MS) return;
    if (!waited) await new Promise((r) => setTimeout(r, 0));
    this.yieldedAt = performance.now();
  }

  /** Keep a voice's buffers scheduled up to `horizon` (context time). */
  private async feed(v: Voice, horizon: () => number): Promise<void> {
    if (v.feeding || v.done || v.cancelled || performance.now() < v.retryAt) return;
    v.feeding = true;
    const clip = v.clip;
    const project = this.project!;
    const session = this.session!;
    const assetId = clip.assetId;
    try {
      const opened = assetId ? await this.sinkFor(assetId) : null;
      if (v.cancelled) return;
      if (opened === 'missing' && this.realtime) {
        // Keep the voice and let a later pump ask again: its file may arrive while this plays.
        v.retryAt = performance.now() + RETRY_MS;
        return;
      }
      if (!opened || typeof opened === 'string') {
        if (opened && assetId) this.onProblem?.({ clipId: clip.id, assetId, reason: opened });
        v.done = true;
        return;
      }
      const per = sourcePerFrame(clip, project) * this.fps;
      const clipStartSec = framesToSeconds(clip.start, project.settings);
      const clipEndSec = framesToSeconds(clipEnd(clip), project.settings);
      // A voice can start long after the session was anchored: the mix was rebuilt for an edit, or
      // its file has only just become available. Decoding from the anchor would then produce
      // minutes of sound that is thrown away as already played before anything is heard.
      const nowTl = this.realtime
        ? session.startSec + (this.ctx.currentTime - session.t0) * session.rate
        : session.startSec;
      const fromTl = Math.max(session.startSec, clipStartSec, nowTl);
      const toTl = Math.min(session.endSec, clipEndSec);
      if (toTl <= fromTl) {
        v.done = true;
        return;
      }
      const srcB = clip.sourceIn + (clipEndSec - clipStartSec) * per;
      const srcFrom = clip.reverse
        ? srcB - (toTl - clipStartSec) * per
        : clip.sourceIn + (fromTl - clipStartSec) * per;
      const srcTo = clip.reverse
        ? srcB - (fromTl - clipStartSec) * per
        : clip.sourceIn + (toTl - clipStartSec) * per;
      // Converted sound is made from the samples around each position, so the first and the last
      // of it need the source a little beyond what plays: what really is there, not silence.
      const speed = per * session.rate;
      const step = (speed * opened.rate) / this.ctx.sampleRate;
      const around =
        this.passes(opened.rate, speed) || !this.converting(step)
          ? 0
          : (resampleReach(step) + 1) / opened.rate;
      const from = srcFrom - around + opened.start;
      const to = srcTo + around + opened.start;
      // In a render made in chunks the clip's sound comes out of one decode of all that the render
      // plays of it, `[low, high)`. The chunk after this one starts its pre-roll before this one
      // ends, and asks again for what is played from there on (taken a little earlier here, so that
      // rounding in where a chunk begins never has it ask for more than was kept).
      const next = Math.max(session.endSec - (this.runs?.lookBack ?? 0) - 0.1, clipStartSec);
      const again = clip.sourceIn + (next - clipStartSec) * per - around + opened.start;
      // The render may end before the clip does. It goes at least as far as this chunk.
      const lastTl = Math.min(Math.max(this.runs?.endSec ?? Infinity, session.endSec), clipEndSec);
      const played = (lastTl - clipStartSec) * per;
      const low = (clip.reverse ? srcB - played : clip.sourceIn) - around + opened.start;
      const high = (clip.reverse ? srcB : clip.sourceIn + played) + around + opened.start;
      const buffers = this.runs
        ? this.runs.of(clip).read(opened.sink, from, to, again, low, high, clip.reverse)
        : inSequence(opened.sink.buffers(from, to));

      if (clip.reverse) {
        // Reverse playback needs the buffers in descending order: collect, then schedule backwards.
        const all: WrappedAudioBuffer[] = [];
        for await (const wb of buffers) {
          if (v.cancelled) return;
          all.push(wb);
          if (all.length > 20000) break;
        }
        for (let i = all.length - 1; i >= 0; i--) {
          if (v.cancelled) return;
          v.scheduledUntil = this.scheduleBuffer(v, all[i], opened.start);
          if (this.realtime) await this.pace(v, horizon);
        }
      } else {
        for await (const wb of buffers) {
          if (v.cancelled) return;
          v.scheduledUntil = this.scheduleBuffer(v, wb, opened.start);
          if (this.realtime) await this.pace(v, horizon);
        }
      }
      this.endConversion(v);
      v.done = true;
    } catch (err) {
      if (!v.cancelled) {
        console.warn('[audio] decode error', err);
        if (assetId) this.onProblem?.({ clipId: clip.id, assetId, reason: 'decode-error' });
        this.endConversion(v);
      }
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
    const untilTl = this.realtime
      ? Math.min(session.endSec, nowTl + aheadSec * session.rate)
      : session.endSec;
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

  /** Drop the cached decoder for an asset whose backing file changed. */
  forget(assetId: string): void {
    this.sinks.delete(assetId);
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
 * filters and compressors have settled by the first returned sample. `onProblem` hears about every
 * clip in the stretch whose sound is missing from the result.
 *
 * The result holds `durationSec` rounded to whole samples, the first of them at `startSec`. Chunks
 * rendered one after the other at whole-sample distances (an export) therefore share one sample
 * grid and join without a sample missing or added, wherever the first of them starts. Give such
 * chunks, in order, the same `runs`, made for the time at which the last of them ends: every clip
 * is then decoded in one pass over all of them, and sound from a lossy codec joins at the seams as
 * well (see `AudioRuns`). Dispose of it at the end.
 */
export async function renderAudioChunk(
  project: Project,
  library: MediaLibrary,
  startSec: number,
  durationSec: number,
  sampleRate: number,
  preRollSec = 0.5,
  onProblem?: (problem: AudioProblem) => void,
  runs?: AudioRuns,
): Promise<AudioBuffer> {
  // A whole number of samples of pre-roll, so that sample 0 of the result is the one at `startSec`
  // even when there is less than `preRollSec` of timeline before it.
  const skip = Math.floor(Math.min(preRollSec, startSec) * sampleRate);
  const pre = skip / sampleRate;
  const length = Math.max(1, Math.round(durationSec * sampleRate));
  const ctx = new OfflineAudioContext(2, skip + length, sampleRate);
  if (runs) runs.lookBack = preRollSec;
  const graph = new AudioGraph(ctx, library, false, runs);
  graph.onProblem = onProblem ?? null;
  graph.start(project, { startSec: startSec - pre, t0: 0, rate: 1, endSec: startSec + durationSec });
  await graph.pump();
  const rendered = await ctx.startRendering();
  graph.dispose();
  if (skip === 0) return rendered;
  const out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  for (let c = 0; c < 2; c++) {
    out.copyToChannel(rendered.getChannelData(c).subarray(skip), c);
  }
  return out;
}

/** Does anything in the project make sound? */
export function hasAudibleAudio(project: Project): boolean {
  const audible = audibleTracks(project);
  return Object.values(project.clips).some(
    (c) => c.type === 'audio' && c.enabled && !c.audioMuted && audible.has(c.trackId),
  );
}
