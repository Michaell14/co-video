/**
 * Export: render the project deterministically, frame by frame, and encode it with WebCodecs.
 *
 * Nothing here is real-time. Every frame waits for exactly the right decoded pictures, so an export
 * is identical whether the machine is fast or slow. Audio is rendered offline through the same mixer
 * graph the preview uses and interleaved with the picture in short chunks to keep memory flat.
 *
 * Media that is missing or will not decode does not stop an export, but it never passes in silence:
 * every clip affected is named in the result's `warnings`, and `checkExportMedia` finds the missing
 * ones before any frame is rendered.
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import {
  audibleTracks,
  clipEnd,
  isHdrMode,
  resolveFrame,
  sequenceEnd,
  type Clip,
  type Project,
} from '@tandem/core';
import { AudioRuns, hasAudibleAudio, renderAudioChunk } from './audio/graph';
import { Compositor } from './gl/compositor';
import { MediaLibrary, type MediaResolver } from './media/library';
import { SourceManager, type SourceFault } from './media/sources';

export type ExportContainer = 'mp4' | 'mov' | 'webm' | 'mkv' | 'wav';
export type ExportDynamicRange = 'sdr' | 'pq' | 'hlg';

export interface ExportSettings {
  container: ExportContainer;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  /** Bits per second. */
  videoBitrate: number;
  audioBitrate: number;
  /** Frames in the project timebase; out is exclusive. Null exports the whole sequence. */
  range: { in: number; out: number } | null;
  includeVideo: boolean;
  includeAudio: boolean;
  dynamicRange: ExportDynamicRange;
  keyFrameInterval: number;
  hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing' | 'done';
  frame: number;
  totalFrames: number;
  /** Rendered frames per second (rolling). */
  speed: number;
  etaSeconds: number;
  elapsedSeconds: number;
}

/**
 * A clip whose media could not be rendered as it should be. An export does not stop for it: the
 * clip is left out (or shown with the nearest frame there is) and the caller is told.
 */
export interface ExportWarning {
  clipId: string;
  /** The asset at fault: the clip's media, or the LUT of its grade. */
  assetId: string;
  /** What the clip needed from the asset. */
  part: 'video' | 'image' | 'audio' | 'lut';
  /**
   * `missing`: the file is neither on this device nor on the server. `unreadable`: it is there but
   * could not be opened (damaged, not media, refused by the server). `undecodable`: it opens, and
   * this browser cannot decode what is in it. `timeout`: a frame did not arrive in time and a
   * neighbouring one was used. `decode-error`: decoding stopped part-way through the file, or
   * would not start at all.
   */
  reason: SourceFault;
  /** Project frame at which the problem starts (for a pre-flight check, where the clip enters the range). */
  frame: number;
  /** One sentence for the person exporting, naming the file. */
  message: string;
}

export interface ExportResult {
  blob: Blob | null;
  mimeType: string;
  extension: string;
  frames: number;
  seconds: number;
  /** Where the time went, in seconds: waiting for decoded frames, compositing, encoding, audio. */
  timings: { decode: number; render: number; encode: number; audio: number };
  /** Every clip whose media was missing or failed, once per clip and kind of problem. Empty for a clean export. */
  warnings: ExportWarning[];
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

/**
 * A lost context draws nothing and reads back blank frames without raising an error anywhere, so
 * every frame taken from the compositor is followed by this check.
 */
function assertContext(compositor: Compositor): void {
  if (compositor.glx.contextLost) {
    throw new Error(
      'The graphics context was lost while rendering. Close other GPU-heavy tabs or lower the resolution, then try again.',
    );
  }
}

export function outputFormatFor(container: ExportContainer): OutputFormat {
  switch (container) {
    case 'mov':
      return new MovOutputFormat({ fastStart: false });
    case 'webm':
      return new WebMOutputFormat();
    case 'mkv':
      return new MkvOutputFormat();
    case 'wav':
      return new WavOutputFormat();
    default:
      return new Mp4OutputFormat({ fastStart: false });
  }
}

export const CONTAINER_LABELS: Record<ExportContainer, string> = {
  mp4: 'MP4',
  mov: 'QuickTime (MOV)',
  webm: 'WebM',
  mkv: 'Matroska (MKV)',
  wav: 'WAV (audio only)',
};

export const VIDEO_CODEC_LABELS: Record<string, string> = {
  avc: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8',
};

export const AUDIO_CODEC_LABELS: Record<string, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  'pcm-s16': 'PCM 16-bit',
  'pcm-s24': 'PCM 24-bit',
  'pcm-f32': 'PCM 32-bit float',
};

/** Full codec strings for 10-bit HDR encodes; `transfer` is the CICP transfer code (16 = PQ, 18 = HLG). */
function hdrCodecString(
  codec: VideoCodec,
  width: number,
  height: number,
  fps: number,
  transfer: 16 | 18,
): string | undefined {
  const rate = width * height * fps;
  if (codec === 'vp9') {
    const level =
      rate <= 36864 * 1000
        ? 31
        : rate <= 83558400
          ? 40
          : rate <= 160432128
            ? 41
            : rate <= 311951360
              ? 50
              : rate <= 588251136
                ? 51
                : rate <= 1176502272
                  ? 52
                  : 61;
    return `vp09.02.${level}.10.01.09.${transfer}.09.00`;
  }
  if (codec === 'av1') {
    const pixels = width * height;
    const idx =
      pixels <= 2228224
        ? fps <= 30
          ? 8
          : 9
        : pixels <= 8912896
          ? fps <= 30
            ? 12
            : fps <= 60
              ? 13
              : 14
          : fps <= 30
            ? 16
            : fps <= 60
              ? 17
              : 18;
    return `av01.0.${String(idx).padStart(2, '0')}M.10.0.110.09.${transfer}.09.0`;
  }
  if (codec === 'hevc') {
    const pixels = width * height;
    const level =
      pixels <= 2228224
        ? fps <= 30
          ? 120
          : 123
        : pixels <= 8912896
          ? fps <= 30
            ? 150
            : fps <= 60
              ? 153
              : 156
          : fps <= 30
            ? 180
            : fps <= 60
              ? 183
              : 186;
    return `hvc1.2.4.L${level}.B0`;
  }
  return undefined;
}

export interface CodecSupport {
  video: VideoCodec[];
  audio: AudioCodec[];
}

/** Which codecs can this browser encode into `container` at the given size? */
export async function probeEncoders(
  container: ExportContainer,
  width: number,
  height: number,
  hdr: boolean,
): Promise<CodecSupport> {
  const format = outputFormatFor(container);
  const video: VideoCodec[] = [];
  for (const codec of format.getSupportedVideoCodecs()) {
    if (codec === 'prores') continue;
    if (hdr && (codec === 'avc' || codec === 'vp8')) continue;
    try {
      const fullCodecString = hdr ? hdrCodecString(codec, width, height, 30, 16) : undefined;
      if (await canEncodeVideo(codec, { width, height, bitrate: 8e6, fullCodecString })) video.push(codec);
    } catch {
      /* unsupported */
    }
  }
  const audio: AudioCodec[] = [];
  for (const codec of format.getSupportedAudioCodecs()) {
    if (!['aac', 'opus', 'flac', 'pcm-s16', 'pcm-s24', 'pcm-f32', 'mp3', 'vorbis'].includes(codec)) continue;
    try {
      if (await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000 })) audio.push(codec);
    } catch {
      /* unsupported */
    }
  }
  return { video, audio };
}

/** A sensible bitrate (bits/s) for a resolution, frame rate and codec. */
export function suggestBitrate(
  width: number,
  height: number,
  fps: number,
  codec: VideoCodec,
  quality: 'low' | 'medium' | 'high' | 'max',
  hdr = false,
): number {
  const bpp = { low: 0.045, medium: 0.08, high: 0.13, max: 0.22 }[quality];
  const efficiency = codec === 'avc' || codec === 'vp8' ? 1 : codec === 'av1' ? 0.6 : 0.7;
  // Bits do not need to scale linearly with motion sampling; damp very high frame rates.
  const motion = Math.pow(Math.max(fps, 1) / 30, 0.75) * 30;
  const raw = width * height * motion * bpp * efficiency * (hdr ? 1.25 : 1);
  return Math.round(Math.min(Math.max(raw, 400_000), 400_000_000) / 1000) * 1000;
}

export interface ExportHandle {
  /** File System Access writable, when the user picked a destination up front. */
  writable?: FileSystemWritableFileStream;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  /** Called as soon as a problem is met, with the same objects that end up in `ExportResult.warnings`. */
  onWarning?: (w: ExportWarning) => void;
}

const AUDIO_CHUNK_SECONDS = 4;

type Problem = Pick<ExportWarning, 'clipId' | 'assetId' | 'part' | 'reason'>;

function describeProblem(project: Project, p: Problem): string {
  const asset = project.assets[p.assetId];
  const name = asset ? `“${asset.name}”` : 'A file that is no longer in the project';
  const lost = p.part === 'lut' ? 'its look is missing from the export' : 'it is missing from the export';
  switch (p.reason) {
    case 'missing':
      return `${name} is not on this device or the server, so ${lost}.`;
    case 'unreadable':
      return `${name} could not be opened, so ${lost}.`;
    case 'undecodable':
      if (p.part === 'lut') return `${name} cannot be read as a LUT, so ${lost}.`;
      if (p.part === 'image') return `${name} cannot be read as an image, so ${lost}.`;
      return `This browser cannot decode the ${p.part} in ${name}, so ${lost}.`;
    case 'timeout':
      return `${name} took too long to deliver a frame, so the export shows a neighbouring frame there.`;
    default:
      return p.part === 'audio'
        ? `The audio in ${name} stopped decoding part-way through, so the export is silent from there.`
        : `${name} stopped decoding, so the export holds its last good frame from there, or leaves it out where there is none.`;
  }
}

/** Collects problems into warnings: one per clip and kind of problem, reported the moment it is first seen. */
function warningLog(project: Project, onWarning?: (w: ExportWarning) => void) {
  const warnings: ExportWarning[] = [];
  const seen = new Set<string>();
  const add = (p: Problem, frame: number): void => {
    const key = `${p.clipId}|${p.part}|${p.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    const w: ExportWarning = {
      clipId: p.clipId,
      assetId: p.assetId,
      part: p.part,
      reason: p.reason,
      frame,
      message: describeProblem(project, p),
    };
    warnings.push(w);
    onWarning?.(w);
  };
  return { warnings, add };
}

/** The frames an export covers (`out` exclusive) and which of picture and sound it carries. */
function exportScope(project: Project, settings: ExportSettings) {
  const startFrame = Math.max(0, settings.range?.in ?? 0);
  const endFrame = Math.max(
    startFrame,
    Math.min(settings.range?.out ?? sequenceEnd(project), sequenceEnd(project)),
  );
  const audioOnly = settings.container === 'wav' || !settings.includeVideo;
  const wantAudio = settings.includeAudio && (audioOnly || hasAudibleAudio(project));
  return { startFrame, endFrame, audioOnly, wantAudio };
}

/**
 * Pre-flight for an export: the clips in its range whose media `resolver` cannot supply, cannot be
 * opened or cannot be decoded by this browser, without rendering anything. An empty list means
 * every file is there and every video and audio file opens; a non-empty one is what
 * `exportProject` would report as `missing` / `unreadable` / `undecodable` warnings, with the same
 * reasons, so the person can be asked before a long render rather than after it. Video and audio
 * files are opened (their headers read), not decoded; stills and LUTs are only located.
 */
export async function checkExportMedia(
  project: Project,
  resolver: MediaResolver,
  settings: ExportSettings,
): Promise<ExportWarning[]> {
  const { startFrame, endFrame, audioOnly, wantAudio } = exportScope(project, settings);
  const audible = audibleTracks(project);
  const uses: { clip: Clip; assetId: string; part: ExportWarning['part'] }[] = [];
  for (const clip of Object.values(project.clips)) {
    if (!clip.enabled || clip.start >= endFrame || clipEnd(clip) <= startFrame) continue;
    const track = project.tracks[clip.trackId];
    if (!track) continue;
    if (clip.type === 'audio') {
      if (wantAudio && clip.assetId && !clip.audioMuted && audible.has(track.id))
        uses.push({ clip, assetId: clip.assetId, part: 'audio' });
      continue;
    }
    if (audioOnly || track.hidden) continue;
    if ((clip.type === 'video' || clip.type === 'image') && clip.assetId)
      uses.push({ clip, assetId: clip.assetId, part: clip.type });
    if (clip.grade?.lutId) uses.push({ clip, assetId: clip.grade.lutId, part: 'lut' });
  }

  const library = new MediaLibrary(resolver);
  const verdicts = new Map<string, Promise<ExportWarning['reason'] | null>>();
  const judge = (assetId: string, part: ExportWarning['part']) => {
    const key = `${part}|${assetId}`;
    let v = verdicts.get(key);
    if (!v) {
      v = (async () => {
        if (part === 'image' || part === 'lut')
          return (await resolver(assetId).catch(() => null)) ? null : 'missing';
        // The verdict of the library the export itself opens files with.
        const media = await library.open(assetId);
        if (typeof media === 'string') return media;
        if (part === 'video') return media.video && media.videoDecodable ? null : 'undecodable';
        return media.audio && !media.audioDecodable ? 'undecodable' : null;
      })();
      verdicts.set(key, v);
    }
    return v;
  };
  try {
    const log = warningLog(project);
    uses.sort((a, b) => a.clip.start - b.clip.start);
    for (const { clip, assetId, part } of uses) {
      const reason = await judge(assetId, part);
      if (reason) log.add({ clipId: clip.id, assetId, part, reason }, Math.max(clip.start, startFrame));
    }
    return log.warnings;
  } finally {
    library.dispose();
  }
}

export async function exportProject(
  project: Project,
  resolver: MediaResolver,
  settings: ExportSettings,
  handle: ExportHandle = {},
): Promise<ExportResult> {
  const { signal, onProgress } = handle;
  const check = () => {
    if (signal?.aborted) throw new ExportCancelled();
  };

  const projFps = project.settings.fpsNum / project.settings.fpsDen;
  const outFps = settings.fpsNum / settings.fpsDen;
  const { startFrame, endFrame, audioOnly, wantAudio } = exportScope(project, settings);
  const startSec = startFrame / projFps;
  const durationSec = (endFrame - startFrame) / projFps;
  if (durationSec <= 0) throw new Error('Nothing to export: the timeline is empty.');
  const totalFrames = Math.max(1, Math.round(durationSec * outFps));

  if (audioOnly && !wantAudio) throw new Error('Nothing to export: enable video or audio.');
  const hdr = settings.dynamicRange !== 'sdr' && isHdrMode(project.settings.colorMode) && !audioOnly;

  const format = outputFormatFor(settings.container);
  let target: StreamTarget | BufferTarget;
  if (handle.writable) {
    const fsWritable = handle.writable;
    target = new StreamTarget(
      new WritableStream({
        write: (chunk) => fsWritable.write({ type: 'write', data: chunk.data, position: chunk.position }),
      }),
      { chunked: true, chunkSize: 8 * 1024 * 1024 },
    );
  } else target = new BufferTarget();
  const output = new Output({ format, target });

  // ── picture ─────────────────────────────────────────────────────────────
  const library = new MediaLibrary(resolver);
  let compositor: Compositor | null = null;
  let sources: SourceManager | null = null;
  let canvasSource: CanvasSource | null = null;
  let sampleSource: VideoSampleSource | null = null;

  if (!audioOnly) {
    const canvas = new OffscreenCanvas(settings.width, settings.height);
    compositor = new Compositor(canvas);
    compositor.setSize(settings.width, settings.height);
    sources = new SourceManager(compositor.glx, library);
    sources.sequential = true;
    const common = {
      codec: settings.videoCodec,
      bitrate: settings.videoBitrate,
      keyFrameInterval: settings.keyFrameInterval,
      hardwareAcceleration: settings.hardwareAcceleration,
      latencyMode: 'quality' as const,
    };
    if (hdr) {
      sampleSource = new VideoSampleSource({
        ...common,
        fullCodecString: hdrCodecString(
          settings.videoCodec,
          settings.width,
          settings.height,
          outFps,
          settings.dynamicRange === 'pq' ? 16 : 18,
        ),
      });
      output.addVideoTrack(sampleSource, { frameRate: outFps });
    } else {
      canvasSource = new CanvasSource(canvas, common);
      output.addVideoTrack(canvasSource, { frameRate: outFps });
    }
  }

  // ── sound ───────────────────────────────────────────────────────────────
  let audioSource: AudioBufferSource | null = null;
  if (wantAudio) {
    audioSource = new AudioBufferSource(
      settings.container === 'wav'
        ? { codec: 'pcm-s16' }
        : { codec: settings.audioCodec, bitrate: settings.audioBitrate },
    );
    output.addAudioTrack(audioSource);
  }

  const t0 = performance.now();
  const report = (phase: ExportProgress['phase'], frame: number) => {
    if (!onProgress) return;
    const elapsed = (performance.now() - t0) / 1000;
    const speed = frame > 0 ? frame / Math.max(elapsed, 1e-3) : 0;
    onProgress({
      phase,
      frame,
      totalFrames,
      speed,
      etaSeconds: speed > 0 ? (totalFrames - frame) / speed : 0,
      elapsedSeconds: elapsed,
    });
  };

  const timings = { decode: 0, render: 0, encode: 0, audio: 0 };
  const log = warningLog(project, handle.onWarning);
  // Sound is rendered a few seconds at a time, and decoded in one pass all the same.
  const audioRuns = new AudioRuns(startSec + durationSec);
  let audioRenderedTo = 0;
  const pumpAudio = async (upToSec: number, flush: boolean) => {
    if (!audioSource) return;
    const a0 = performance.now();
    try {
      await pumpAudioInner(upToSec, flush);
    } finally {
      timings.audio += (performance.now() - a0) / 1000;
    }
  };
  const pumpAudioInner = async (upToSec: number, flush: boolean) => {
    if (!audioSource) return;
    while (audioRenderedTo < durationSec && (flush || audioRenderedTo + AUDIO_CHUNK_SECONDS <= upToSec)) {
      check();
      const len = Math.min(AUDIO_CHUNK_SECONDS, durationSec - audioRenderedTo);
      const chunkFrame = startFrame + Math.round(audioRenderedTo * projFps);
      const buf = await renderAudioChunk(
        project,
        library,
        startSec + audioRenderedTo,
        len,
        project.settings.sampleRate,
        undefined,
        (p) => log.add({ ...p, part: 'audio' }, Math.max(chunkFrame, project.clips[p.clipId]?.start ?? 0)),
        audioRuns,
      );
      await audioSource.add(buf);
      audioRenderedTo += len;
    }
  };

  try {
    report('preparing', 0);
    await output.start();
    check();

    if (compositor && sources) {
      const frameDur = 1 / outFps;
      for (let i = 0; i < totalFrames; i++) {
        check();
        const t = i * frameDur;
        // The project frame on screen at this output time.
        const frame = startFrame + Math.min(endFrame - startFrame - 1, Math.floor(t * projFps + 1e-6));
        const desc = resolveFrame(project, frame);
        const p0 = performance.now();
        const problems = await sources.prepare(project, desc, true, settings.width, settings.height);
        for (const problem of problems) log.add(problem, frame);
        const p1 = performance.now();
        compositor.render(project, desc, sources, {
          output: hdr ? (settings.dynamicRange as 'pq' | 'hlg') : 'display',
          skipPresent: hdr,
        });
        const p2 = performance.now();
        timings.decode += (p1 - p0) / 1000;
        timings.render += (p2 - p1) / 1000;
        if (canvasSource) await canvasSource.add(t, frameDur);
        else if (sampleSource) {
          const data = compositor.readYuv10(settings.dynamicRange as 'pq' | 'hlg');
          const sample = new VideoSample(data.buffer as ArrayBuffer, {
            format: 'I420P10',
            codedWidth: settings.width,
            codedHeight: settings.height,
            timestamp: t,
            duration: frameDur,
            // lib.dom's colour-space enums lag behind the WebCodecs spec (no bt2020 / pq / hlg yet).
            colorSpace: {
              primaries: 'bt2020',
              transfer: settings.dynamicRange === 'pq' ? 'pq' : 'hlg',
              matrix: 'bt2020-ncl',
              fullRange: false,
            } as unknown as VideoColorSpaceInit,
          });
          await sampleSource.add(sample);
          sample.close();
        }
        assertContext(compositor);
        timings.encode += (performance.now() - p2) / 1000;
        // Export time only moves forward: a decoder is finished with as soon as its clip has left
        // the picture.
        sources.releaseUnused();
        sources.collect();
        await pumpAudio(t, false);
        if (i % 4 === 0) report('rendering', i + 1);
        // Yield so the UI stays responsive and cancellation is seen promptly.
        if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    await pumpAudio(durationSec, true);
    check();
    report('finalizing', totalFrames);
    await output.finalize();
    if (handle.writable) await handle.writable.close();
    report('done', totalFrames);

    const mimeType = await output.getMimeType().catch(() => format.mimeType);
    const buffer = target instanceof BufferTarget ? target.buffer : null;
    return {
      blob: buffer ? new Blob([buffer], { type: format.mimeType }) : null,
      mimeType,
      extension: format.fileExtension,
      frames: audioOnly ? 0 : totalFrames,
      seconds: (performance.now() - t0) / 1000,
      timings,
      warnings: log.warnings,
    };
  } catch (err) {
    await output.cancel().catch(() => {});
    if (handle.writable) await handle.writable.abort().catch(() => {});
    throw err;
  } finally {
    audioRuns.dispose();
    sources?.dispose();
    compositor?.dispose();
    library.dispose();
  }
}

/**
 * Render a single frame at full project resolution and return it as a PNG. `onWarning` hears about
 * every clip in the frame whose media was missing or failed, as an export would report it.
 */
export async function renderStill(
  project: Project,
  resolver: MediaResolver,
  frame: number,
  onWarning?: (w: ExportWarning) => void,
): Promise<Blob> {
  const { width, height } = project.settings;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = new Compositor(canvas);
  compositor.setSize(width, height);
  const library = new MediaLibrary(resolver);
  const sources = new SourceManager(compositor.glx, library);
  sources.sequential = true;
  try {
    const desc = resolveFrame(project, frame);
    const log = warningLog(project, onWarning);
    for (const problem of await sources.prepare(project, desc, true)) log.add(problem, frame);
    compositor.render(project, desc, sources, { skipPresent: true });
    const pixels = compositor.readPixels();
    assertContext(compositor);
    const out = new OffscreenCanvas(width, height);
    const ctx = out.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), width, height), 0, 0);
    return await out.convertToBlob({ type: 'image/png' });
  } finally {
    sources.dispose();
    compositor.dispose();
    library.dispose();
  }
}
