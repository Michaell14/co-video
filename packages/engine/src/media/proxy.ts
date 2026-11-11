/**
 * Proxy media: a small, easy-to-decode stand-in for a heavy video file.
 *
 * Editing 4K / 8K / high-frame-rate footage means decoding far more pixels than the viewer shows.
 * A proxy is the same picture at preview size, encoded with short key-frame intervals so scrubbing
 * is instant. The player and the timeline thumbnails read the proxy; exports always read the
 * original. Timestamps are preserved, so a source time means the same frame in both files.
 */
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';

export interface ProxyOptions {
  /** Length of the picture's short side, in pixels. */
  shortSide?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface ProxyResult {
  width: number;
  height: number;
  codec: VideoCodec;
}

export class ProxyCancelled extends Error {
  constructor() {
    super('Proxy creation was cancelled');
    this.name = 'ProxyCancelled';
  }
}

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2);

/** The proxy size for a picture of the given display size, or null when it is already small. */
export function proxySize(width: number, height: number, shortSide = 540): { width: number; height: number } | null {
  const short = Math.min(width, height);
  if (short <= shortSide * 1.34) return null;
  const k = shortSide / short;
  return { width: even(width * k), height: even(height * k) };
}

/**
 * Transcode `source` into a proxy written to `writable` (an OPFS file stream). Resolves with what
 * was made; rejects with {@link ProxyCancelled} when aborted.
 */
export async function createProxy(source: Blob, writable: FileSystemWritableFileStream, opts: ProxyOptions = {}): Promise<ProxyResult> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video cannot be decoded in this browser.');
    const size = proxySize(track.displayWidth, track.displayHeight, opts.shortSide) ?? {
      width: even(track.displayWidth),
      height: even(track.displayHeight),
    };
    const stats = await track.computePacketStats(120).catch(() => null);
    const fps = Math.min(120, Math.max(1, stats?.averagePacketRate ?? 30));
    // Generous for the size: proxies are cut and scrubbed, so quality per frame matters more than size.
    const bitrate = Math.round(Math.max(600_000, size.width * size.height * fps * 0.14));

    let codec: VideoCodec | null = null;
    for (const c of ['avc', 'vp9', 'vp8'] as VideoCodec[]) {
      if (await canEncodeVideo(c, { width: size.width, height: size.height, bitrate }).catch(() => false)) {
        codec = c;
        break;
      }
    }
    if (!codec) throw new Error('This browser cannot encode video, so proxies are unavailable.');

    const output = new Output({
      format: codec === 'avc' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
      target: new StreamTarget(
        new WritableStream({
          write: (chunk) => writable.write({ type: 'write', data: chunk.data, position: chunk.position }),
        }),
        { chunked: true, chunkSize: 4 * 1024 * 1024 },
      ),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: {
        width: size.width,
        height: size.height,
        fit: 'fill',
        codec,
        bitrate,
        // Half-second GOPs: a seek never has to decode more than a handful of frames.
        keyFrameInterval: 0.5,
        forceTranscode: true,
        alpha: 'discard',
      },
      audio: { discard: true },
    });
    if (!conversion.isValid) throw new Error('This video cannot be converted to a proxy.');
    conversion.onProgress = (p) => opts.onProgress?.(p);
    const abort = (): void => void conversion.cancel();
    if (opts.signal?.aborted) throw new ProxyCancelled();
    opts.signal?.addEventListener('abort', abort, { once: true });
    try {
      await conversion.execute();
    } catch (err) {
      if (opts.signal?.aborted) throw new ProxyCancelled();
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', abort);
    }
    return { ...size, codec };
  } finally {
    input.dispose();
  }
}
