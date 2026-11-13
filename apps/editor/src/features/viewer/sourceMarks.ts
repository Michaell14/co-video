/**
 * The marks of the source monitor: what I and O set, which stretch of a file they stand for, and
 * what is kept of a file between two looks at it. All times are seconds into the file.
 */
import { clamp, sourcePerFrame, type Clip, type ID, type Project } from '@tandem/core';
import { useUI, type SourceMarks } from '../../state/ui';

/** A file the monitor has not shown yet: all of it, from the top. */
export const UNMARKED: SourceMarks = { in: 0, out: null, at: null };

/** What is left of a file, in seconds, when going on from where it was left is not worth it. */
const END_SLACK = 0.1;

/** `marks` with the in point at `time`. An out point at or before it no longer marks anything. */
export function withIn(marks: SourceMarks, time: number, length: number): SourceMarks {
  const at = clamp(time, 0, length);
  return { ...marks, in: at, out: marks.out !== null && marks.out <= at ? null : marks.out };
}

/** `marks` with the out point at `time`. An in point at or after it goes back to the top. */
export function withOut(marks: SourceMarks, time: number, length: number): SourceMarks {
  const at = clamp(time, 0, length);
  return { ...marks, in: marks.in < at ? marks.in : 0, out: at };
}

/**
 * The stretch of a file `length` seconds long that goes to the timeline. Marks can be older than
 * the file is long (a file can be replaced by a shorter one), so they are kept within it, and an
 * out point that marks nothing is the end of the file.
 */
export function markedRange(
  marks: SourceMarks | undefined,
  length: number,
): { sourceIn: number; sourceOut: number } {
  const sourceIn = clamp(marks?.in ?? 0, 0, length);
  const out = Math.min(marks?.out ?? length, length);
  return { sourceIn, sourceOut: out > sourceIn ? out : length };
}

/**
 * The marks that say what `clip` shows of its file. A match frame sets them, so that the monitor
 * opens on the clip as it was cut. A still and a frozen frame show no stretch of anything.
 */
export function clipMarks(clip: Clip, p: Project): Pick<SourceMarks, 'in' | 'out'> | null {
  const asset = clip.assetId ? p.assets[clip.assetId] : undefined;
  if (!asset || asset.kind === 'image' || asset.duration <= 0) return null;
  const start = clamp(clip.sourceIn, 0, asset.duration);
  const end = clamp(clip.sourceIn + clip.duration * sourcePerFrame(clip, p), 0, asset.duration);
  return end > start ? { in: start, out: end } : null;
}

/**
 * Where a file that is opened again goes on from: where it was left. Null when it starts from the
 * top: it has not been watched before, or was left there, or so near its end that nothing is left
 * to play.
 */
export function resumeAt(marks: SourceMarks | undefined, length: number): number | null {
  const at = marks?.at ?? null;
  return at !== null && at > 0 && at < length - END_SLACK ? at : null;
}

/** The entries of `marks` whose file is still in the project: `marks` itself when all of them are. */
export function marksOfKnown(
  marks: Record<ID, SourceMarks>,
  assets: Project['assets'],
): Record<ID, SourceMarks> {
  const gone = Object.keys(marks).filter((id) => !assets[id]);
  if (!gone.length) return marks;
  const kept = { ...marks };
  for (const id of gone) delete kept[id];
  return kept;
}

/** Keep `patch` for the file `assetId`, whatever else is known about it already. */
export function rememberSource(assetId: ID, patch: Partial<SourceMarks>): void {
  const all = useUI.getState().sourceMarks;
  useUI.getState().set({ sourceMarks: { ...all, [assetId]: { ...UNMARKED, ...all[assetId], ...patch } } });
}
