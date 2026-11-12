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
