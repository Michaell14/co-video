/**
 * AAC by the browser's other decoder.
 *
 * A browser decodes sound in two places: in its WebCodecs `AudioDecoder`, which the engine uses,
 * and behind `decodeAudioData`, which takes a whole file. Where the first trips over a file the
 * second often does not. It cannot be given a file of an hour (decoded, that is over a gigabyte),
 * so it is given the track's packets a few seconds at a time, each stretch wrapped as an ADTS
 * stream, and what comes back is cut into the buffers the WebCodecs decoder would have given: one
 * per packet, each at the time of its packet.
 *
 * That is only of use if it is the same sound in the same place, to the sample, and three things
 * stand in the way.
 *
 * A decoder joins each packet to the one before it, so the first packet of a stretch decodes to
 * something else than it does in the middle of the stream. Every stretch therefore starts with the
 * packets that precede it in the file, and what those decode to is thrown away.
 *
 * `decodeAudioData` says nothing about where its samples belong, and browsers differ in what they
 * drop from the front of an AAC stream as the encoder's priming: nothing, one packet's worth, or
 * the 2112 samples of Apple's encoder. So before it is trusted with a file it is given a stream
 * made for the purpose (`CLICKS`), silence with two clicks at known samples, and is used only if
 * the clicks come back where a cut at the front alone would put them. That cut is then expected of
 * every stretch, to the sample: a stretch that comes back shorter or longer has lost or gained
 * something somewhere inside (a browser skips a packet it cannot decode), cannot be placed, and
 * counts as not decoded.
 *
 * And it resamples to the rate of its context. The context is made at the rate the track
 * declares; what cannot be seen from outside is a stream that decodes to twice that (spectral band
 * replication that is not announced, which is only found at 24 kHz and below). So this is for
 * plain AAC-LC above 24 kHz and nothing else: the one case that could be measured against the
 * WebCodecs decoder, sample for sample.
 */
import {
  EncodedPacketSink,
  type EncodedPacket,
  type InputAudioTrack,
  type WrappedAudioBuffer,
} from 'mediabunny';

/** Samples in a packet of AAC-LC. */
const FRAME = 1024;
/**
 * Packets decoded in front of a stretch and thrown away: one for the decoder to join on to, and
 * enough for the most a browser is known to cut from the front (2112 samples).
 */
const LEAD = 3;
/** Packets in a stretch: about three seconds, a megabyte of stereo sound once decoded. */
const STRETCH = 128;
/** Declared rates at or below this can hide a stream that decodes to twice the rate. */
const PLAIN_ABOVE = 24000;

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** What an ADTS header says about the stream it is put in front of. */
export interface AacSettings {
  frequencyIndex: number;
  channelConfiguration: number;
}

/**
 * The settings of a stream that is plain AAC-LC as an ADTS header can describe it, from its
 * AudioSpecificConfig; null for anything else (another object type, a rate or a channel layout
 * written out in full, packets of 960 samples).
 */
export function plainAac(description: Uint8Array): AacSettings | null {
  if (description.byteLength < 2) return null;
  const objectType = description[0] >> 3;
  const frequencyIndex = ((description[0] & 7) << 1) | (description[1] >> 7);
  const channelConfiguration = (description[1] >> 3) & 15;
  const shortFrames = (description[1] >> 2) & 1;
  const onCoreCoder = (description[1] >> 1) & 1;
  if (objectType !== 2 || frequencyIndex >= RATES.length || shortFrames || onCoreCoder) return null;
  if (channelConfiguration < 1 || channelConfiguration > 7) return null;
  return { frequencyIndex, channelConfiguration };
}

/** Raw AAC-LC packets as an ADTS stream: each behind a header that says what it is and how long. */
export function adts(settings: AacSettings, packets: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(packets.reduce((sum, p) => sum + 7 + p.byteLength, 0));
  let at = 0;
  for (const packet of packets) {
    const length = 7 + packet.byteLength;
    // Sync word, MPEG-4, no checksum; AAC-LC, the rate, the channels; the length; "variable bitrate".
    out[at] = 0xff;
    out[at + 1] = 0xf1;
    out[at + 2] = 0x40 | (settings.frequencyIndex << 2) | (settings.channelConfiguration >> 2);
    out[at + 3] = ((settings.channelConfiguration & 3) << 6) | (length >> 11);
    out[at + 4] = (length >> 3) & 0xff;
    out[at + 5] = ((length & 7) << 5) | 0x1f;
    out[at + 6] = 0xfc;
    out.set(packet, at + 7);
    at += length;
  }
  return out;
}

/**
 * Twelve packets of mono AAC-LC at 44.1 kHz: silence with a click of one sample at each of the
 * two places in `at`, counted in the samples the packets decode to when none is dropped.
 * Made with `ffmpeg -f lavfi -i "aevalsrc=0.8*eq(n\,3000)+0.8*eq(n\,7500):s=44100:d=0.25" -c:a aac
 * -b:a 48k -ac 1 clicks.aac` (the encoder puts 1024 samples of priming in front), and the packets
 * taken out of their ADTS headers.
 */
const CLICKS = {
  settings: { frequencyIndex: 4, channelConfiguration: 1 },
  sizes: [21, 4, 4, 297, 4, 4, 4, 189, 4, 4, 4, 4],
  packets:
    '3gIATGF2YzYwLjMxLjEwMgACMEAOARggBwEYQAcA7Jma/b9D0PX2PuA/RzxXz9R3OAAABKdAu2qAAHl/4gAAPwf3QAAPK/JgAAIx5BKkgAAAAAlyuTrrIUZROLUAAAAACBLGC1iT5xGbBAAAAAMCqkLASdWGQmTwAAAAAAACbq1oVyJqZKNJI0U2vXAAAAAAAAIV1E6MkhGpky17erEXTwAAAAAAACUyGRqgx/YIVYRObPIPrAAAAAAAAAABddgkSmRiyiVFcs1yddJClJJx6ZKlfIuwtaYUnDukIC8Dj49wxLByCNOkSiW59HUAv79SAou4RupJWJZGbXJPwsp4UhCuk6s8hgU3dhiOEjkrdgjLwRIeGuuGQO0m8kyQ8CiEYSST4pEcmupJMcUg9pOMCpcMSwkUjbrkpmCIlwxAWDJyrBC1H4ABGOAHARggBwEYQAcBGJmwPQ9v2/QAPxQ76AKKBQAyYAW4OtQ/hpkHj8N0Dn0P7qXB4GHBByiL9tQgrvFkAVci/XcIKzxZUFO4vwUsisceTBSeP6tKoanHnQM/j/VTKGsx50DW47SBRIKLGQAC0x1sCsQTOPKo66H9zoQFjByCCUg/Jy4Cpg6RzNc94VkH/jUQfb/ZKCD/xrYP0fxkzB/8bSD8/8pKwf7NvBk8H2iWg3aC6gzuD8hQwbNBgwOOg+4WuCxQ5CBOoeABGOAHARggBwEYIAcBGCAH',
  rate: 44100,
  at: [4024, 8524],
};

/** The packets of `CLICKS`, as an ADTS stream. */
export function clicksStream(): Uint8Array {
  const bytes = Uint8Array.from(atob(CLICKS.packets), (c) => c.charCodeAt(0));
  let at = 0;
  return adts(
    CLICKS.settings,
    CLICKS.sizes.map((size) => bytes.subarray(at, (at += size))),
  );
}

/**
 * How many samples a decoder cut from the front of `CLICKS`, given what it made of it. Throws
 * when that is not all it did: samples are missing that a cut at the front does not explain, or
 * the clicks are not where such a cut leaves them.
 */
export function cutFromFront(decoded: Float32Array): number {
  const whole = CLICKS.sizes.length * FRAME;
  const cut = whole - decoded.length;
  if (cut < 0 || cut > LEAD * FRAME) throw new Error(`It gave ${decoded.length} samples for ${whole}.`);
  const left = decoded.slice();
  const found: number[] = [];
  for (let n = 0; n < CLICKS.at.length; n++) {
    let peak = 0;
    for (let i = 1; i < left.length; i++) if (Math.abs(left[i]) > Math.abs(left[peak])) peak = i;
    found.push(peak);
    // What rings around a click is not the other click.
    left.fill(0, Math.max(0, peak - 64), peak + 64);
  }
  found.sort((a, b) => a - b);
  if (found.some((peak, n) => peak !== CLICKS.at[n] - cut))
    throw new Error(
      `With ${cut} samples cut it put the test clicks at ${found.join(' and ')}, not at ${CLICKS.at.map((c) => c - cut).join(' and ')}.`,
    );
  return cut;
}

const contexts = new Map<number, OfflineAudioContext>();

/** Decode a whole stream with the browser's own decoder, at `rate`. The bytes are given away. */
function decode(stream: Uint8Array, rate: number): Promise<AudioBuffer> {
  let ctx = contexts.get(rate);
  if (!ctx) contexts.set(rate, (ctx = new OfflineAudioContext(1, 1, rate)));
  return ctx.decodeAudioData(stream.buffer as ArrayBuffer);
}

let measured: Promise<number | null> | null = null;

/**
 * The samples this browser's own decoder cuts from the front of an AAC stream, or null when it
 * cannot be relied on to do only that. Asked once for as long as the page lives.
 */
function cutByBrowser(): Promise<number | null> {
  measured ??= decode(clicksStream(), CLICKS.rate)
    .then((buffer) => cutFromFront(buffer.getChannelData(0)))
    .catch((err: unknown) => {
      console.warn('[audio] the browser’s own decoder cannot stand in for the WebCodecs one', err);
      return null;
    });
  return measured;
}

const bytesOf = (source: AllowSharedBufferSource): Uint8Array =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);

/** A track's sound from the browser's own decoder, in the buffers the WebCodecs decoder gives. */
export class AacByBrowser {
  constructor(
    private readonly track: InputAudioTrack,
    private readonly settings: AacSettings,
    private readonly rate: number,
    /** Samples the browser cuts from the front of every stream it decodes. */
    private readonly cut: number,
  ) {}

  /**
   * The buffers `AudioBufferSink.buffers(from, to)` gives for the track: from the one that holds
   * `from` (the first, when that is left out) up to, and without, the first that starts at `to`
   * or later. Throws when a stretch does not decode, or not to what its packets hold.
   */
  async *buffers(from?: number, to = Infinity): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    const sink = new EncodedPacketSink(this.track);
    const span = FRAME / this.rate;
    const first = (from === undefined ? null : await sink.getPacket(from)) ?? (await sink.getFirstPacket());
    if (!first) return;
    const start =
      (await sink.getPacket(first.timestamp - (LEAD - 0.5) * span)) ?? (await sink.getFirstPacket()) ?? first;
    let lead: EncodedPacket[] = [];
    let wanted: { packet: EncodedPacket; time: number }[] = [];
    // Packets follow one another to the sample, whatever their container made of their times
    // (Matroska rounds them to milliseconds): each is timed from the one the count began at, and
    // only one that is a packet or more away from there is taken at its word.
    let anchor = start.timestamp;
    let counted = 0;
    for await (const packet of sink.packets(start)) {
      const apart = Math.abs(packet.timestamp - (anchor + counted * span)) >= span;
      if (apart) [anchor, counted] = [packet.timestamp, 0];
      // Rounded to a whole sample, as the times of the WebCodecs decoder's buffers are.
      const time = Math.round((anchor + counted++ * span) * this.rate) / this.rate;
      if (time >= to) break;
      if (packet.timestamp < first.timestamp - span / 2) {
        lead = [...lead, packet].slice(-LEAD);
        continue;
      }
      if (wanted.length === STRETCH || (apart && wanted.length)) {
        yield* this.decoded(lead, wanted);
        lead = [...lead, ...wanted.map((w) => w.packet)].slice(-LEAD);
        wanted = [];
      }
      wanted.push({ packet, time });
    }
    if (wanted.length) yield* this.decoded(lead, wanted);
  }

  /** One stretch, decoded behind the packets that lead up to it. */
  private async *decoded(
    lead: readonly EncodedPacket[],
    wanted: readonly { packet: EncodedPacket; time: number }[],
  ): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    const packets = [...lead, ...wanted.map((w) => w.packet)];
    const out = await decode(
      adts(
        this.settings,
        packets.map((p) => p.data),
      ),
      this.rate,
    );
    const expected = packets.length * FRAME - this.cut;
    if (out.length !== expected)
      throw new Error(
        `The browser’s own decoder gave ${out.length} samples for ${packets.length} packets, not ${expected}.`,
      );
    const channels = Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c));
    for (let i = 0; i < wanted.length; i++) {
      // Where the packet's samples begin in what came back. Before its first sample lies only
      // what the browser cut from the very start of the file: that stays silent.
      const at = (lead.length + i) * FRAME - this.cut;
      const buffer = new AudioBuffer({
        numberOfChannels: channels.length,
        length: FRAME,
        sampleRate: this.rate,
      });
      if (at + FRAME > 0)
        for (let c = 0; c < channels.length; c++)
          buffer.copyToChannel(channels[c].subarray(Math.max(0, at), at + FRAME), c, Math.max(0, -at));
      yield { buffer, timestamp: wanted[i].time, duration: FRAME / this.rate };
    }
  }
}

/**
 * The browser's own decoder for a track's sound, where it can be shown to give what the WebCodecs
 * decoder would: for plain AAC-LC, in a browser whose decoder places a known stream exactly.
 * Null for every other track and browser.
 */
export async function aacByBrowser(track: InputAudioTrack): Promise<AacByBrowser | null> {
  if ((await track.getCodec()) !== 'aac') return null;
  const description = (await track.getDecoderConfig())?.description;
  const settings = description ? plainAac(bytesOf(description)) : null;
  if (!settings) return null;
  const rate = RATES[settings.frequencyIndex];
  if (rate <= PLAIN_ABOVE || rate !== (await track.getSampleRate())) return null;
  const cut = await cutByBrowser();
  return cut === null ? null : new AacByBrowser(track, settings, rate, cut);
}
