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
  /** A lower-resolution stand-in for the video track (see `media/proxy.ts`). Preview only. */
  proxy?: Blob;
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
  /**
   * Where the asset's time zero lies in the timestamps of `video` and `audio`. A file has a single
   * origin, its first video frame (its first audio sample when it has no picture), so sound that
   * begins before or after the picture keeps its place against it. Many files do not start at zero;
   * transport streams start wherever the broadcast clock happened to be. The two values differ only
   * when `video` is a proxy, which has a time base of its own.
   */
  videoStart: number;
  audioStart: number;
  local: boolean;
  /** Original pixels per decoded pixel: 1, or more when `video` is a proxy of the real track. */
  videoScale: number;
  proxyInput: Input | null;
}

function disposeMedia(m: OpenMedia | null): void {
  m?.input.dispose();
  m?.proxyInput?.dispose();
}

export function inputFor(loc: MediaLocation): Input {
  const source = loc.blob
    ? new BlobSource(loc.blob)
    : new UrlSource(loc.url!, loc.headers ? { requestInit: { headers: loc.headers } } : undefined);
  return new Input({ source, formats: ALL_FORMATS });
}

/** A file's time zero in its own timestamps: see `OpenMedia.videoStart`. */
async function originOf(video: InputVideoTrack | null, audio: InputAudioTrack | null): Promise<number> {
  const track = video ?? audio;
  return track ? track.getFirstTimestamp().catch(() => 0) : 0;
}

/** After a failed request, how long the failure stands in for a new attempt. */
const FAILURE_HOLD_MS = 2000;

/**
 * Why an asset's file could not be had. `missing`: there is nothing to open, on this device or on
 * the server, or nobody could say where; it may yet arrive. `unreadable`: there is a file, but it
 * could not be opened: it is damaged or not media at all, or the server would not hand it over.
 */
export type MediaFault = 'missing' | 'unreadable';

const found = <T extends object>(answer: T | MediaFault): T | null =>
  typeof answer === 'string' ? null : answer;

export class MediaLibrary {
  private readonly opened = new Map<string, Promise<OpenMedia | MediaFault>>();
  private readonly blobs = new Map<string, Promise<Blob | MediaFault>>();
  /** Per asset, what was tried for it and failed with a warning. */
  private readonly reported = new Map<string, Set<string>>();
  private disposed = false;

  constructor(private readonly resolver: MediaResolver) {}

  /**
   * Share one request per asset between callers, and keep its answer only while it is worth
   * keeping. "Missing" describes this moment, not the asset: the file may be on its way from a
   * collaborator, so the next call asks the resolver again. A request that failed is held for a
   * moment so that a struggling server, or a file that will not open, is not tried on every frame.
   * Why it failed is said once, not for every new try: whatever shows the asset asks again every
   * few seconds for as long as it does. It is said again when the session has reported a change
   * to the asset (`invalidate`), and for a resolver that fails, once it has answered in between.
   */
  private shared<T extends object>(
    cache: Map<string, Promise<T | MediaFault>>,
    assetId: string,
    read: (loc: MediaLocation) => Promise<T | null>,
    what: string,
  ): Promise<T | MediaFault> {
    let p = cache.get(assetId);
    if (!p) {
      const forget = () => {
        if (cache.get(assetId) === request) cache.delete(assetId);
      };
      const nothing = (): MediaFault => {
        forget();
        return 'missing';
      };
      const failed = (fault: MediaFault, doing: string) => (err: unknown) => {
        let said = this.reported.get(assetId);
        if (!said) this.reported.set(assetId, (said = new Set()));
        if (!said.has(doing)) {
          said.add(doing);
          console.warn(`[media] could not ${doing} ${assetId}`, err);
        }
        setTimeout(forget, FAILURE_HOLD_MS);
        return fault;
      };
      // `async`, so that a resolver that throws outright fails like one whose promise rejects.
      const locate = async () => this.resolver(assetId);
      const request: Promise<T | MediaFault> = locate().then(
        (loc) => {
          this.reported.get(assetId)?.delete('locate');
          return loc ? read(loc).then((value) => value ?? nothing(), failed('unreadable', what)) : nothing();
        },
        failed('missing', 'locate'),
      );
      cache.set(assetId, (p = request));
    }
    return p;
  }

  /**
   * Open (or reuse) the demuxer for a timed-media asset, or say why there is none: see
   * `MediaFault`. Ask again later, at intervals, for media that is missing and may yet turn up.
   */
  open(assetId: string): Promise<OpenMedia | MediaFault> {
    return this.shared(this.opened, assetId, (loc) => this.load(assetId, loc), 'open');
  }

  /** As `open`, for callers to whom every reason is the same: null when there is no media to be had. */
  get(assetId: string): Promise<OpenMedia | null> {
    return this.open(assetId).then(found);
  }

  private async load(assetId: string, loc: MediaLocation): Promise<OpenMedia | null> {
    if (this.disposed) return null;
    const input = inputFor(loc);
    const original = await input.getPrimaryVideoTrack();
    let video = original;
    const audio = await input.getPrimaryAudioTrack();
    let [videoDecodable, audioDecodable] = await Promise.all([
      video ? video.canDecode().catch(() => false) : false,
      audio ? audio.canDecode().catch(() => false) : false,
    ]);
    // Picture from the proxy when there is one; sound (and everything else) from the original.
    let proxyInput: Input | null = null;
    let videoScale = 1;
    if (loc.proxy && video) {
      const candidate = new Input({ source: new BlobSource(loc.proxy), formats: ALL_FORMATS });
      try {
        const pv = await candidate.getPrimaryVideoTrack();
        if (pv && (await pv.canDecode()) && pv.displayWidth > 0) {
          videoScale = video.displayWidth / pv.displayWidth;
          video = pv;
          videoDecodable = true;
          proxyInput = candidate;
        }
      } catch {
        // A damaged proxy is simply not used.
      }
      if (!proxyInput) candidate.dispose();
    }
    const rotation = video ? await video.getRotation().catch(() => 0 as const) : 0;
    const audioStart = await originOf(original, audio);
    const videoStart = video === original ? audioStart : await originOf(video, null);
    return {
      assetId,
      input,
      video,
      audio,
      videoDecodable,
      audioDecodable,
      rotation,
      videoStart,
      audioStart,
      local: !!loc.blob,
      videoScale,
      proxyInput,
    };
  }

  /** Whole-file bytes for small assets (images, LUTs), or why they cannot be had, as for `open`. */
  read(assetId: string): Promise<Blob | MediaFault> {
    return this.shared(
      this.blobs,
      assetId,
      async (loc) => {
        if (loc.blob) return loc.blob;
        const res = await fetch(loc.url!, { headers: loc.headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.blob();
      },
      'fetch',
    );
  }

  /** As `read`, with null for bytes that cannot be had, whatever the reason. */
  blob(assetId: string): Promise<Blob | null> {
    return this.read(assetId).then(found);
  }

  /** Forget a cached handle, e.g. after the asset finished downloading and a local copy exists. */
  invalidate(assetId: string): void {
    const p = this.opened.get(assetId);
    this.opened.delete(assetId);
    this.blobs.delete(assetId);
    this.reported.delete(assetId);
    p?.then((m) => disposeMedia(found(m))).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.opened.values()) p.then((m) => disposeMedia(found(m))).catch(() => {});
    this.opened.clear();
    this.blobs.clear();
    this.reported.clear();
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

async function posterFromBitmap(
  bmp: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  maxW = 320,
): Promise<string | null> {
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
    // `computeDuration` is the timestamp at which the last track ends; the asset starts at the
    // file's origin, which is rarely zero for transport streams and camera recordings.
    const duration = Math.max(0, (await input.computeDuration()) - (await originOf(video, audio)));
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
        warnings.push(
          `This browser cannot decode the video codec (${asset.videoCodec ?? (await video.getCodec()) ?? 'unknown'}) in “${file.name}”.`,
        );
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
        warnings.push(
          `This browser cannot decode the audio codec (${asset.audioCodec ?? 'unknown'}) in “${file.name}”.`,
        );
      }
    }
    return { asset, warnings };
  } finally {
    input.dispose();
  }
}
