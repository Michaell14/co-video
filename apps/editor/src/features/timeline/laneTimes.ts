/**
 * Which media the lane canvas draws where: the time a filmstrip tile shows, the sound under a
 * column of a waveform, and how far along a clip its file has been analysed.
 *
 * A clip on a speed ramp is drawn by the maps it is played by: a tile shows what the renderer
 * shows at its frame, and a column holds the sound the mixer runs through while the playhead
 * crosses it. A clip at one speed is drawn by the arithmetic the canvas has always done, in the
 * order it has always done it, so that a project without ramps paints the pixels it painted.
 */
import { frameOfMedia, mediaAt, sourcePerFrame, sourceTimeAt, type Clip, type Project } from '@tandem/core';
import { FilmstripCache, type Waveform } from './mediaCache';

/**
 * The second of its media a filmstrip tile shows, for a tile that begins `local` frames into the
 * clip (a real number: tiles do not fall on frames). It can lie before the file or beyond it: the
 * caller holds the first or the last picture there, as the renderer does.
 */
export function tileTime(clip: Clip, p: Project, local: number): number {
  if (!clip.ramp) {
    const per = sourcePerFrame(clip, p);
    // As the canvas has always counted: backwards, a frame of media later than the renderer shows.
    return clip.reverse ? clip.sourceIn + (clip.duration - local) * per : clip.sourceIn + local * per;
  }
  return sourceTimeAt(clip, local, p);
}

/**
 * How far apart the thumbnails are asked for, in seconds, for the tile at `local` that is `frames`
 * wide. Along a ramp each tile covers another stretch of media, so each has a step of its own: one
 * step for the whole clip would ask a fast stretch for pictures far finer than it can show, and a
 * slow one for pictures too coarse.
 */
export function tileStep(clip: Clip, p: Project, local: number, frames: number): number {
  if (!clip.ramp) return FilmstripCache.stepFor(frames * sourcePerFrame(clip, p));
  return FilmstripCache.stepFor(Math.abs(tileTime(clip, p, local + frames) - tileTime(clip, p, local)));
}

/**
 * The stretch of its media a clip's sound runs through under one pixel column of its waveform, in
 * seconds, lower end first: the column that begins `px` pixels into the clip, at `ppf` pixels to
 * the frame. A clip that plays backwards runs through its media from the top, so its first column
 * holds the end of its stretch.
 */
export function columnRange(clip: Clip, p: Project, px: number, ppf: number): [number, number] {
  if (!clip.ramp) {
    const per = sourcePerFrame(clip, p);
    const secPerPx = per / ppf;
    const srcEnd = clip.sourceIn + clip.duration * per;
    const local = px * secPerPx;
    const t = clip.reverse ? srcEnd - local - secPerPx : clip.sourceIn + local;
    return [t, t + secPerPx];
  }
  // One expression gives the right edge of a column and the left edge of the next, so nothing of
  // the media falls between two columns.
  const u0 = px / ppf;
  const u1 = (px + 1) / ppf;
  return clip.reverse
    ? [mediaAt(clip, clip.duration - u1, p), mediaAt(clip, clip.duration - u0, p)]
    : [mediaAt(clip, u0, p), mediaAt(clip, u1, p)];
}

/** The loudest of a file's peaks under one pixel column of a clip's waveform (see `columnRange`). */
export function columnPeak(
  clip: Clip,
  p: Project,
  px: number,
  ppf: number,
  wave: Pick<Waveform, 'peaks' | 'perSecond'>,
): number {
  const { peaks, perSecond: pps } = wave;
  const [from, to] = columnRange(clip, p, px, ppf);
  // Before its file begins a clip has no sound to draw. A clip at one speed goes on showing the
  // file's first peak there, as it always has.
  if (clip.ramp && to <= 0) return 0;
  const a = Math.max(0, Math.floor(from * pps));
  const b = Math.min(peaks.length - 1, Math.max(a, Math.floor(to * pps)));
  let peak = 0;
  for (let i = a; i <= b; i++) if (peaks[i] > peak) peak = peaks[i];
  return peak;
}

/**
 * Where on a clip the analysed part of its file ends, when the first `loaded` seconds of the file
 * have been read: the clip's frame there (a real number, before or beyond the clip as well), and
 * the side of it on which the sound not read yet lies.
 */
export function loadedEdge(
  clip: Clip,
  p: Project,
  loaded: number,
): { frame: number; pending: 'after' | 'before' } {
  // As the canvas has always counted: forwards, for a clip that plays backwards as well.
  if (!clip.ramp) return { frame: (loaded - clip.sourceIn) / sourcePerFrame(clip, p), pending: 'after' };
  const at = frameOfMedia(clip, loaded, p);
  return clip.reverse ? { frame: clip.duration - at, pending: 'before' } : { frame: at, pending: 'after' };
}
