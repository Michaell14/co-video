/**
 * A file's sound as decoded buffers, for the mixer and for whatever else reads it.
 *
 * The buffers come from the browser's WebCodecs decoder. When that fails, the stretch that would
 * not decode is left out and decoding starts again behind it: packets of sound are each decodable
 * on their own, and one that is damaged costs the packets around it, not the rest of the file.
 * Where the decoder gives nothing of the file's sound, or will not give the rest of what was asked
 * for, the browser's other decoder is asked for the same buffers (see `adts.ts`), and once that has
 * worked for a file it is what the file is decoded with for as long as the page lives.
 */
import { AudioBufferSink, type InputAudioTrack, type WrappedAudioBuffer } from 'mediabunny';
import { describeCause } from '../media/cause';
import { aacByBrowser, type AacByBrowser } from './adts';

/** Sound that was asked for and could not be given. */
export interface SoundTrouble {
  /**
   * `stretch`: a part could not be decoded, and what follows it could, where anything was asked
   * for behind it. `rest`: decoding stopped and would not start again. `all`: nothing of what was
   * asked for could be decoded, where what a decoder gives in front of the file's sound (its
   * priming) is nothing.
   */
  lost: 'stretch' | 'rest' | 'all';
  /** Where the silence begins, in the timestamps of the track (seconds). */
  from: number;
  /** What the decoder said: see `describeCause`. */
  cause: string;
}

/**
 * A decoder that fails without having given anything since it was started is started further on,
 * twice as far from where it first stopped each time, and this often before the rest is given up:
 * about half a minute of damage.
 */
const FRUITLESS_STARTS = 10;
/** Starts after a failure in one pass over a clip's sound, damage being rarely in one place only. */
const MOST_STARTS = 64;
/** Seconds: how long a packet is taken to be until a decoded buffer has shown it. */
const PACKET_GUESS = 0.025;
/** Seconds by which a buffer may start after the place asked for without anything being missing. */
const NO_GAP = 1e-3;

/** What the page has learnt about the sound of a file. */
interface Known {
  /** Set once the browser's own decoder has taken over: what the WebCodecs decoder said. */
  byBrowser: string | null;
  /** The sample rate of its decoded buffers, which the file may declare otherwise. */
  rate: number | null;
  /** Failures the console has been told about. */
  said: Set<string>;
}

const known = new Map<string, Known>();

function knownOf(assetId: string): Known {
  let k = known.get(assetId);
  if (!k) known.set(assetId, (k = { byBrowser: null, rate: null, said: new Set() }));
  return k;
}

/** An asset's file changed: what was learnt about its sound is asked anew. */
export function forgetSound(assetId: string): void {
  known.delete(assetId);
}

const disposed = (err: unknown): boolean => (err as Error | null)?.name === 'InputDisposedError';

export class Sound {
  private sink: AudioBufferSink | null = null;
  private other: Promise<AacByBrowser | null> | null = null;
  /** The browser's own decoder was tried on this file and gave nothing either. */
  private otherFailed = false;
  private begins: Promise<number> | null = null;

  constructor(
    readonly assetId: string,
    private readonly track: InputAudioTrack,
  ) {}

  /** The sample rate the file's sound has been seen to decode to; null until a buffer was. */
  get rate(): number | null {
    return known.get(this.assetId)?.rate ?? null;
  }

  private byBrowser(): Promise<AacByBrowser | null> {
    this.other ??= aacByBrowser(this.track).catch(() => null);
    return this.other;
  }

  /**
   * Where the file's sound begins (track time, seconds): one pre-roll into what the file plays.
   * Before that lie the encoder's priming, which a file leaves out of what it plays, and the
   * packet a decoder needs to get going on. A decoder that gives nothing behind that has given
   * nothing of the file: some give the first few packets and fail on the first that is sound.
   */
  private soundFrom(): Promise<number> {
    this.begins ??= Promise.all([
      this.track.getFirstTimestamp().catch(() => 0),
      this.track.getPreRollDuration().catch(() => null),
    ]).then(([first, lead]) => Math.max(0, first) + (lead ?? 0));
    return this.begins;
  }

  /**
   * The buffers `AudioBufferSink.buffers(from, to)` gives, without its exceptions: what cannot be
   * decoded is missing from them, `report` is told where, and what can be decoded behind it
   * follows at its own time. Only the end of the file itself is still thrown (the project was
   * closed, or the file moved).
   */
  async *buffers(
    from: number | undefined,
    to: number | undefined,
    report: (trouble: SoundTrouble) => void,
  ): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    const { assetId } = this;
    // Taken once: a read that began before the file changed (`forgetSound`) learns into what was
    // known then, not into what the next read of the new file starts from.
    const k = knownOf(assetId);
    let way: 'webcodecs' | 'browser' =
      k.byBrowser != null && (await this.byBrowser()) ? 'browser' : 'webcodecs';
    const begins = await this.soundFrom();
    // Where the next start asks from, the end of what was given last, and where a hole began.
    let pos = from;
    let end: number | null = null;
    let hole: number | null = null;
    let cause = '';
    // Sound of the file has been given: see `soundFrom`.
    let sounded = false;
    let packet = PACKET_GUESS;
    let fruitless = 0;
    let starts = 0;
    // Where the WebCodecs decoder was when the other took over, for it to go on from there.
    let handed: [number, number] = [0, 0];
    /** Whether the browser's own decoder takes over here: once for a read, unless it is on it already. */
    const handOver = async (): Promise<boolean> => {
      if (way !== 'webcodecs' || this.otherFailed) return false;
      if (await this.byBrowser()) return true;
      this.otherFailed = true;
      return false;
    };
    for (;;) {
      let moved = false;
      try {
        const source =
          way === 'browser'
            ? (await this.byBrowser())!.buffers(pos, to)
            : (this.sink ??= new AudioBufferSink(this.track)).buffers(pos, to);
        for await (const wb of source) {
          // A decoder started again begins with what it needs to get going, which was given before.
          if (end !== null && wb.timestamp < end - NO_GAP) continue;
          if (hole !== null) {
            // Sound is back. Something is missing before it only if this start was put behind
            // the place of the failure: a decoder that begins there and gives nothing until
            // later (a track that starts late, a gap in the file) has left nothing out.
            const skipped = pos !== undefined && pos > hole + NO_GAP;
            if (skipped && wb.timestamp > hole + NO_GAP) report({ lost: 'stretch', from: hole, cause });
            hole = null;
          }
          if (way === 'browser' && k.byBrowser === null) {
            k.byBrowser = cause;
            console.warn(
              `[audio] ${assetId}: the WebCodecs decoder failed (${cause}); its sound is decoded by the browser’s own decoder instead`,
            );
          }
          k.rate = wb.buffer.sampleRate;
          moved = true;
          if (wb.timestamp >= begins - NO_GAP) sounded = true;
          packet = wb.duration;
          end = wb.timestamp + wb.duration;
          yield wb;
        }
        // Started where the hole begins, and at its end without a failure: there was nothing there.
        if (hole !== null && pos !== undefined && pos <= hole + NO_GAP) hole = null;
        break;
      } catch (err) {
        if (disposed(err)) throw err;
        const said = describeCause(err);
        cause ||= said;
        if (!k.said.has(`${way}|${said}`)) {
          k.said.add(`${way}|${said}`);
          console.warn(`[audio] ${assetId}: decoding failed (${way})`, err);
        }
        hole ??= end ?? pos ?? (await this.track.getFirstTimestamp().catch(() => 0));
        const base: number = end ?? hole;
        if (way === 'browser' && k.byBrowser === null) {
          // No better than the decoder it was to stand in for: that one goes on as it would have.
          this.otherFailed = true;
          way = 'webcodecs';
          [fruitless, starts] = handed;
        } else fruitless = moved ? 0 : fruitless + 1;
        const spent = fruitless > FRUITLESS_STARTS || starts >= MOST_STARTS;
        if ((spent || !sounded) && (await handOver())) {
          // Nothing of the file, or nothing any more: the browser's own decoder takes it from here.
          handed = [fruitless, starts];
          way = 'browser';
          pos = base;
          continue;
        }
        if (spent) {
          report({ lost: sounded ? 'rest' : 'all', from: hole, cause });
          return;
        }
        // Behind the packets the decoder needs to get going, so that it does not begin on the
        // one that stopped it; and half a packet in, so that it is not rounding that decides
        // which packet a start falls on.
        const lead = (await this.track.getPreRollDuration().catch(() => null)) ?? 0;
        const next = base + (fruitless ? (lead + 2 * packet) * 2 ** (fruitless - 1) + packet / 2 : 0);
        if (to !== undefined && next >= to) {
          // This decoder gives nothing more of what was asked for: the other is asked for the rest.
          if (await handOver()) {
            handed = [fruitless, starts];
            way = 'browser';
            pos = base;
            continue;
          }
          break;
        }
        starts++;
        pos = next;
      }
    }
    if (hole !== null) report({ lost: sounded ? 'stretch' : 'all', from: hole, cause });
  }
}
