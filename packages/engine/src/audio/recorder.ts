/**
 * Voiceover recording: microphone → 16-bit PCM WAV.
 *
 * PCM is deliberate. A WAV has an exact duration and seeks to the sample, which a browser-recorded
 * WebM (no duration, no cues) does not, and at about 6 MB a minute it is cheap for speech.
 */
import { BufferTarget, MediaStreamAudioTrackSource, Output, WavOutputFormat } from 'mediabunny';

export class VoiceRecorder {
  private readonly startedAt = performance.now();
  private readonly meter = new Float32Array(1024);
  private done = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly output: Output,
    private readonly target: BufferTarget,
    private readonly ctx: AudioContext | null,
    private readonly analyser: AnalyserNode | null,
    /** Seconds between sound reaching the microphone and it reaching the file. */
    readonly latency: number,
  ) {}

  /** Ask for the microphone and start recording. Rejects if access is refused or there is no input. */
  static async start(): Promise<VoiceRecorder> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
    // Voice processing is off: it pumps, gates and band-limits, which is wrong for a recording.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    try {
      const [track] = stream.getAudioTracks();
      if (!track) throw new Error('No microphone was found.');
      const target = new BufferTarget();
      const output = new Output({ format: new WavOutputFormat(), target });
      const source = new MediaStreamAudioTrackSource(
        track as MediaStreamAudioTrack,
        { codec: 'pcm-s16' },
        { timestampBase: 'zero' },
      );
      output.addAudioTrack(source);
      await output.start();

      let ctx: AudioContext | null = null;
      let analyser: AnalyserNode | null = null;
      try {
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
      } catch {
        // No meter is not a reason to refuse to record.
      }
      const latency = Number((track.getSettings() as { latency?: number }).latency ?? 0);
      return new VoiceRecorder(
        stream,
        output,
        target,
        ctx,
        analyser,
        Number.isFinite(latency) ? Math.min(Math.max(latency, 0), 0.5) : 0,
      );
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      throw err;
    }
  }

  /** Seconds recorded so far. */
  elapsed(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  /** Current input peak, 0…1. */
  level(): number {
    if (!this.analyser || this.done) return 0;
    this.analyser.getFloatTimeDomainData(this.meter);
    let peak = 0;
    for (let i = 0; i < this.meter.length; i++) peak = Math.max(peak, Math.abs(this.meter[i]));
    return Math.min(1, peak);
  }

  private release(): void {
    this.done = true;
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx?.close().catch(() => {});
  }

  /** Stop and return the finished WAV. */
  async stop(): Promise<Blob> {
    if (this.done) throw new Error('The recording has already ended.');
    try {
      await this.output.finalize();
    } finally {
      this.release();
    }
    if (!this.target.buffer || this.target.buffer.byteLength <= 44) throw new Error('Nothing was recorded.');
    return new Blob([this.target.buffer], { type: 'audio/wav' });
  }

  /** Stop and throw the recording away. */
  async cancel(): Promise<void> {
    if (this.done) return;
    this.release();
    await this.output.cancel().catch(() => {});
  }
}
