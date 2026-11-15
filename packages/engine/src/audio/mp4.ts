/**
 * AAC packets in an MP4 file of their own, for the browser's own decoder (see `adts.ts`).
 *
 * An ADTS header can only say what plain AAC-LC is. Everything else (spectral band replication
 * and parametric stereo, i.e. HE-AAC v1 and v2, and AAC-LC at 24 kHz and below, which may carry
 * either without saying so) is told to a decoder by the track's AudioSpecificConfig, and is
 * decoded the way a browser plays it: from an MP4 file, which carries that config as it is.
 */

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Channels of each channel configuration an AudioSpecificConfig can name. */
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
/** Core rates at or below this can carry spectral band replication without saying so. */
const SBR_UP_TO = 24000;

/** How a stream of AAC decodes, as far as placing what it decodes to goes. */
export interface AacStream {
  /** Samples a second it decodes to: twice its core's where spectral band replication may double them. */
  rate: number;
  /** Samples each packet decodes to, at `rate`. */
  frame: number;
  /** The channels an MP4 file says it has: two for a mono core that may carry parametric stereo. */
  channels: number;
}

/** The extension that announces spectral band replication behind a config of plain AAC-LC, and the one for parametric stereo. */
const SBR_SYNC = 0x2b7;
const PS_SYNC = 0x548;

/**
 * How AAC with this AudioSpecificConfig decodes: AAC-LC, with or without spectral band
 * replication and parametric stereo, in packets of 1024 core samples, with one of the channel
 * configurations 1 to 7. Null for anything else (AAC Main, LTP, xHE-AAC, low delay, packets of
 * 960 samples, channels described in the stream).
 *
 * Spectral band replication doubles a core rate of 24 kHz or less, and leaves a higher one as it
 * is. The config says whether there is any (object type 5 or 29, or an extension behind a config
 * of plain AAC-LC, with the rate it doubles to), or leaves it for the decoder to find in the
 * stream. So a core of 24 kHz or less that says nothing is asked for at twice its rate: if it is
 * plain, its samples are then simply twice as many, and in the same place.
 */
export function aacStream(description: Uint8Array): AacStream | null {
  const bits = description.byteLength * 8;
  let at = 0;
  const read = (n: number): number => {
    if (at + n > bits) throw new RangeError('The config ends early.');
    let value = 0;
    for (let i = 0; i < n; i++, at++) value = value * 2 + ((description[at >> 3] >> (7 - (at & 7))) & 1);
    return value;
  };
  const objectType = (): number => {
    const type = read(5);
    return type === 31 ? 32 + read(6) : type;
  };
  const sampleRate = (): number => {
    const index = read(4);
    return index === 15 ? read(24) : (RATES[index] ?? 0);
  };
  try {
    let type = objectType();
    const core = sampleRate();
    const configuration = read(4);
    // Spectral band replication: the rate it doubles to, 0 where the config says there is none,
    // null where it does not say; and whether it says there is parametric stereo.
    let doubled: number | null = null;
    let stereo = false;
    if (type === 5 || type === 29) {
      doubled = sampleRate();
      stereo = type === 29;
      type = objectType();
    }
    const shortFrames = read(1);
    const onCoreCoder = read(1);
    if (type !== 2 || !core || shortFrames || onCoreCoder) return null;
    if (configuration < 1 || configuration > 7) return null;
    // The last of the core's settings: a flag, and behind it, when set, one for later versions.
    if (read(1)) read(1);
    if (doubled === null && bits - at >= 16 && read(11) === SBR_SYNC && objectType() === 5) {
      doubled = read(1) ? sampleRate() : 0;
      if (doubled && bits - at >= 12 && read(11) === PS_SYNC) stereo = read(1) === 1;
    }
    const rate = doubled || (doubled === null && core <= SBR_UP_TO ? 2 * core : core);
    const frame = (1024 * rate) / core;
    if (!rate || !Number.isInteger(frame)) return null;
    const mono = configuration === 1 && (stereo || (doubled !== 0 && rate > core));
    return { rate, frame, channels: mono ? 2 : CHANNELS[configuration] };
  } catch {
    return null;
  }
}

type Bytes = ArrayLike<number>;

function join(parts: readonly Bytes[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u16 = (v: number): number[] => [(v >>> 8) & 255, v & 255];
const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const text = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...parts: Bytes[]): Uint8Array => {
  const body = join(parts);
  return join([u32(8 + body.length), text(type), body]);
};
const fullBox = (type: string, flags: number, ...parts: Bytes[]): Uint8Array =>
  box(type, [0, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
/** An MPEG-4 descriptor: a tag, its length seven bits a byte, and what it holds. */
const descriptor = (tag: number, ...parts: Bytes[]): Uint8Array => {
  const body = join(parts);
  const size = [body.length & 127];
  for (let rest = body.length >>> 7; rest; rest >>>= 7) size.unshift(128 | (rest & 127));
  return join([[tag], size, body]);
};
const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);

/**
 * An MP4 file of one track of AAC that holds `packets`, `stream.frame` samples each, timed in
 * samples at `stream.rate` so that its edit is exact to the sample. The edit leaves the first
 * `lead` packets out of what the file plays: they are there for the decoder to get going on, as
 * an encoder's priming is in a file of its own.
 */
export function aacMp4(
  description: Uint8Array,
  stream: AacStream,
  packets: readonly Uint8Array[],
  lead: number,
): Uint8Array {
  const { rate, frame } = stream;
  const held = packets.length * frame;
  const shown = held - lead * frame;
  const esds = fullBox(
    'esds',
    0,
    descriptor(
      3,
      u16(1),
      [0],
      // AAC as an MPEG-4 audio stream, with its config; buffer size and bit rates left unsaid.
      descriptor(4, [0x40, 0x15, 0, 0, 0], u32(0), u32(0), descriptor(5, description)),
      descriptor(6, [2]),
    ),
  );
  const entry = box(
    'mp4a',
    [0, 0, 0, 0, 0, 0],
    u16(1),
    u32(0),
    u32(0),
    u16(stream.channels),
    u16(16),
    u32(0),
    u32(rate <= 0xffff ? rate * 0x10000 : 0),
    esds,
  );
  const moov = (offset: number): Uint8Array =>
    box(
      'moov',
      fullBox(
        'mvhd',
        0,
        u32(0),
        u32(0),
        u32(rate),
        u32(shown),
        u32(0x10000),
        u16(0x100),
        new Uint8Array(10),
        IDENTITY,
        new Uint8Array(24),
        u32(2),
      ),
      box(
        'trak',
        fullBox(
          'tkhd',
          3,
          u32(0),
          u32(0),
          u32(1),
          u32(0),
          u32(shown),
          new Uint8Array(8),
          u32(0),
          u16(0x100),
          u16(0),
          IDENTITY,
          u32(0),
          u32(0),
        ),
        box('edts', fullBox('elst', 0, u32(1), u32(shown), u32(lead * frame), u16(1), u16(0))),
        box(
          'mdia',
          fullBox('mdhd', 0, u32(0), u32(0), u32(rate), u32(held), u16(0x55c4), u16(0)),
          fullBox('hdlr', 0, u32(0), text('soun'), new Uint8Array(12), text('SoundHandler'), [0]),
          box(
            'minf',
            fullBox('smhd', 0, u32(0)),
            box('dinf', fullBox('dref', 0, u32(1), fullBox('url ', 1))),
            box(
              'stbl',
              fullBox('stsd', 0, u32(1), entry),
              fullBox('stts', 0, u32(1), u32(packets.length), u32(frame)),
              fullBox('stsc', 0, u32(1), u32(1), u32(packets.length), u32(1)),
              fullBox('stsz', 0, u32(0), u32(packets.length), ...packets.map((p) => u32(p.byteLength))),
              fullBox('stco', 0, u32(1), u32(offset)),
            ),
          ),
        ),
      ),
    );
  const ftyp = box('ftyp', text('isom'), u32(0x200), text('isomiso2mp41'));
  // The packets follow the header, whose length does not depend on where they are.
  const media = ftyp.length + moov(0).length + 8;
  const size = packets.reduce((sum, p) => sum + p.byteLength, 0);
  return join([ftyp, moov(media), u32(8 + size), text('mdat'), ...packets]);
}
