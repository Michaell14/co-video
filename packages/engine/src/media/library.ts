/**
 * MediaLibrary: opens project media for decoding.
 *
 * The engine does not know where bytes live. The host app supplies a resolver that answers
 * "where is asset X right now?" with either a local Blob (fast path: OPFS / dropped file) or a URL
 * with range support (streaming straight from the collaboration server before the download finishes).
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import { ASSET_DEFAULTS, type Asset, type AssetKind } from '@tandem/core';

export interface MediaLocation {
  blob?: Blob;
  url?: string;
  headers?: Record<string, string>;
}

export type MediaResolver = (assetId: string) => Promise<MediaLocation | null>;

export interface OpenMedia {
  assetId: string;
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  /** True when the browser can decode the video track. */
  videoDecodable: boolean;
  audioDecodable: boolean;
  rotation: 0 | 90 | 180 | 270;
  /** Presentation timestamp of the first video / audio sample (some files do not start at zero). */
  videoStart: number;
  audioStart: number;
  local: boolean;
}

export function inputFor(loc: MediaLocation): Input {
  const source = loc.blob
    ? new BlobSource(loc.blob)
    : new UrlSource(loc.url!, loc.headers ? { requestInit: { headers: loc.headers } } : undefined);
  return new Input({ source, formats: ALL_FORMATS });
}

export class MediaLibrary {
  private readonly open = new Map<string, Promise<OpenMedia | null>>();
  private readonly blobs = new Map<string, Promise<Blob | null>>();
  private disposed = false;

  constructor(private readonly resolver: MediaResolver) {}

  /** Open (or reuse) the demuxer for a timed-media asset. Resolves null when it is not available. */
  get(assetId: string): Promise<OpenMedia | null> {
    let p = this.open.get(assetId);
    if (!p) {
      p = this.load(assetId).catch((err) => {
        console.warn(`[media] could not open ${assetId}`, err);
        // Let a later call retry (the file may still be uploading on a peer).
        setTimeout(() => this.open.delete(assetId), 2000);
        return null;
      });
      this.open.set(assetId, p);
    }
    return p;
  }

  private async load(assetId: string): Promise<OpenMedia | null> {
    const loc = await this.resolver(assetId);
    if (!loc || this.disposed) return null;
    const input = inputFor(loc);
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const [videoDecodable, audioDecodable] = await Promise.all([
      video ? video.canDecode().catch(() => false) : false,
      audio ? audio.canDecode().catch(() => false) : false,
    ]);
    const rotation = video ? await video.getRotation().catch(() => 0 as const) : 0;
    const videoStart = video ? await video.getFirstTimestamp().catch(() => 0) : 0;
    const audioStart = audio ? await audio.getFirstTimestamp().catch(() => 0) : 0;
    return { assetId, input, video, audio, videoDecodable, audioDecodable, rotation, videoStart, audioStart, local: !!loc.blob };
  }

  /** Whole-file bytes for small assets (images, LUTs). */
  blob(assetId: string): Promise<Blob | null> {
    let p = this.blobs.get(assetId);
    if (!p) {
      p = (async () => {
        const loc = await this.resolver(assetId);
        if (!loc) return null;
        if (loc.blob) return loc.blob;
        const res = await fetch(loc.url!, { headers: loc.headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.blob();
      })().catch((err) => {
        console.warn(`[media] could not fetch ${assetId}`, err);
        setTimeout(() => this.blobs.delete(assetId), 2000);
        return null;
      });
      this.blobs.set(assetId, p);
    }
    return p;
  }

  /** Forget a cached handle, e.g. after the asset finished downloading and a local copy exists. */
  invalidate(assetId: string): void {
    const p = this.open.get(assetId);
    this.open.delete(assetId);
    this.blobs.delete(assetId);
    p?.then((m) => m?.input.dispose()).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.open.values()) p.then((m) => m?.input.dispose()).catch(() => {});
    this.open.clear();
    this.blobs.clear();
  }
}

export { AudioBufferSink, CanvasSink, VideoSampleSink };

// ──────────────────────────────────────────────────────────────── probing ──

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ts|mts|avi)$/i;
const LUT_EXT = /\.cube$/i;

export function guessKind(file: { name: string; type: string }): AssetKind | null {
  if (LUT_EXT.test(file.name)) return 'lut';
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  return null;
}

async function posterFromBitmap(bmp: ImageBitmap | HTMLCanvasElement | OffscreenCanvas, maxW = 320): Promise<string | null> {
  try {
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.max(2, Math.round(bmp.width * scale));
    const h = Math.max(2, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface ProbeResult {
  /** Fields to merge into a new Asset. */
  asset: Omit<Asset, 'id' | 'createdAt' | 'createdBy' | 'folderId' | 'uploaded'>;
  warnings: string[];
}

/** Inspect a file and describe it as an asset. Throws if the file is not usable media. */
export async function probeFile(file: File): Promise<ProbeResult> {
  const kind = guessKind(file);
  const base = { ...ASSET_DEFAULTS, name: file.name, size: file.size, mime: file.type };
  const warnings: string[] = [];
  if (!kind) throw new Error(`“${file.name}” is not a supported media type.`);

  if (kind === 'lut') {
    return { asset: { ...base, kind, mime: 'text/plain' }, warnings };
  }

  if (kind === 'image') {
    const bmp = await createImageBitmap(file);
    const thumb = await posterFromBitmap(bmp);
    const asset = { ...base, kind, width: bmp.width, height: bmp.height, hasVideo: true, thumb };
    bmp.close();
    return { asset, warnings };
  }

  const input = inputFor({ blob: file });
  try {
    if (!(await input.canRead())) throw new Error(`“${file.name}” is not a readable media file.`);
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) throw new Error(`“${file.name}” has no video or audio tracks.`);
    const duration = await input.computeDuration();
    const asset: ProbeResult['asset'] = {
      ...base,
      kind: video ? 'video' : 'audio',
      mime: file.type || (await input.getMimeType().catch(() => '')),
      duration,
    };

    if (video) {
      const decodable = await video.canDecode().catch(() => false);
      asset.hasVideo = true;
      asset.videoCodec = await video.getCodecParameterString().catch(() => null);
      const rotation = await video.getRotation().catch(() => 0);
      asset.rotation = rotation;
      const dw = await video.getDisplayWidth();
      const dh = await video.getDisplayHeight();
      asset.width = dw;
      asset.height = dh;
      try {
        const m = await video.computeFrameRateMetrics({ targetPacketCount: 120 });
        asset.fps = Math.round(m.bestGuessFrameRate * 1000) / 1000;
      } catch {
        asset.fps = 0;
      }
      try {
        const cs = await video.getColorSpace();
        asset.color = {
          primaries: cs.primaries ?? null,
          transfer: cs.transfer ?? null,
          matrix: cs.matrix ?? null,
          fullRange: cs.fullRange ?? null,
        };
        asset.hdr = await video.hasHighDynamicRange();
      } catch {
        /* colour metadata is optional */
      }
      if (!decodable) {
        warnings.push(`This browser cannot decode the video codec (${asset.videoCodec ?? (await video.getCodec()) ?? 'unknown'}) in “${file.name}”.`);
      } else {
        try {
          const sink = new CanvasSink(video, { width: 320, poolSize: 1 });
          const first = await video.getFirstTimestamp();
          const wrapped = await sink.getCanvas(first + Math.min(1, duration * 0.1));
          if (wrapped) asset.thumb = await posterFromBitmap(wrapped.canvas as OffscreenCanvas);
        } catch {
          /* a missing poster is not fatal */
        }
      }
    }
    if (audio) {
      asset.hasAudio = true;
      asset.audioCodec = await audio.getCodecParameterString().catch(() => null);
      asset.audioChannels = await audio.getNumberOfChannels().catch(() => 2);
      asset.audioSampleRate = await audio.getSampleRate().catch(() => 48000);
      if (!(await audio.canDecode().catch(() => false))) {
        warnings.push(`This browser cannot decode the audio codec (${asset.audioCodec ?? 'unknown'}) in “${file.name}”.`);
      }
    }
    return { asset, warnings };
  } finally {
    input.dispose();
  }
}
