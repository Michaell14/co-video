/** Decisions of the export dialog that need no browser to make, so they can be tested without one. */
import type { ExportWarning } from '@tandem/engine';

/**
 * The codec an export will really use: the wanted one where this browser can encode it for the
 * chosen format, size and bit depth, otherwise the browser's first choice. Null while the encoders
 * are still being asked, and when there is none.
 */
export function usableCodec<T>(wanted: T, supported: readonly T[] | null): T | null {
  if (!supported || !supported.length) return null;
  return supported.includes(wanted) ? wanted : supported[0];
}

export interface ProblemPlace {
  clipId: string;
  /** Project frame where the problem starts. */
  frame: number;
}

export interface ProblemGroup {
  key: string;
  /** One finished sentence naming the file. */
  message: string;
  /** The clips it affects, in timeline order. */
  places: ProblemPlace[];
}

const kindOf = (w: ExportWarning): string => `${w.assetId}|${w.part}|${w.reason}`;

/** Export problems with the clips that share a file and a fault gathered under one sentence. */
export function groupProblems(warnings: readonly ExportWarning[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  for (const w of warnings) {
    const key = kindOf(w);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, message: w.message, places: [] }));
    if (!g.places.some((p) => p.clipId === w.clipId)) g.places.push({ clipId: w.clipId, frame: w.frame });
  }
  const out = Array.from(groups.values());
  for (const g of out) g.places.sort((a, b) => a.frame - b.frame);
  return out.sort((a, b) => a.places[0].frame - b.places[0].frame);
}

/** Whether `found` holds a problem that is not among the ones already `shown` to the person. */
export function hasUnseen(found: readonly ExportWarning[], shown: readonly ExportWarning[]): boolean {
  const seen = new Set(shown.map((w) => `${w.clipId}|${kindOf(w)}`));
  return found.some((w) => !seen.has(`${w.clipId}|${kindOf(w)}`));
}

/**
 * The highest whole number from `lowest` up to, but not including, `refused` that `accepts`, or
 * null when not even `lowest` is accepted. `refused` is a number already known not to be, and what
 * is asked about has a ceiling: above the first number that is refused, every number is. The
 * ceiling is found by halving, in about as many questions as `refused - lowest` has binary digits.
 */
export async function highestAccepted(
  lowest: number,
  refused: number,
  accepts: (n: number) => Promise<boolean>,
): Promise<number | null> {
  if (lowest >= refused || !(await accepts(lowest))) return null;
  let accepted = lowest;
  let above = refused;
  while (above - accepted > 1) {
    const middle = Math.floor((accepted + above) / 2);
    if (await accepts(middle)) accepted = middle;
    else above = middle;
  }
  return accepted;
}

/** What the video encoder said to the settings an export would give it. */
export type EncoderVerdict =
  | { accepted: true }
  | {
      accepted: false;
      /** The highest bitrate it does take with everything else as chosen, in bits per second. */
      limit: number | null;
      /** It would take the settings were the choice of encoder left to the browser. */
      acceleration: boolean;
    };

/** A bitrate as the dialog writes it: `200 Mbps`, `12.5 Mbps`. */
export const describeBitrate = (bits: number): string => `${Math.round(bits / 1e5) / 10} Mbps`;

/**
 * What the dialog says about settings the encoder refuses, and what to change: the ceiling on the
 * bitrate where there is one, the choice of encoder where that is what stands in the way.
 */
export function refusalNotice(
  verdict: Extract<EncoderVerdict, { accepted: false }>,
  asked: {
    codec: string;
    size: string;
    bitrate: number;
    hardware: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  },
): string {
  if (verdict.limit !== null)
    return `${asked.codec} at ${asked.size} takes at most ${describeBitrate(verdict.limit)} in this browser. Lower the bitrate, or choose another codec.`;
  if (verdict.acceleration)
    return `This browser has no ${asked.hardware === 'prefer-software' ? 'software' : 'GPU'} encoder for ${asked.codec} at ${asked.size}. Set Acceleration to Automatic.`;
  return `This browser’s ${asked.codec} encoder does not take ${asked.size} at ${describeBitrate(asked.bitrate)}. Choose another codec, size or frame rate.`;
}
