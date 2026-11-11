/** Timeline viewport arithmetic: zoom is pixels per frame, scroll is pixels from frame zero. */
import { clampPpf } from './ui';

export interface TimelineView {
  ppf: number;
  scrollX: number;
}

/**
 * Change the zoom by `factor`, keeping the frame `anchorX` pixels into the viewport where it is.
 * Without an anchor that is the playhead, as long as it is in view: an off-screen playhead would
 * hold still somewhere outside the viewport and slide everything being looked at away, so the
 * middle of the viewport is held instead.
 */
export function zoomView(
  view: TimelineView,
  factor: number,
  width: number,
  playhead: number,
  anchorX?: number,
): TimelineView {
  const ppf = clampPpf(view.ppf * factor);
  const playheadX = playhead * view.ppf - view.scrollX;
  const ax = anchorX ?? (playheadX >= 0 && playheadX <= width ? playheadX : width / 2);
  const frame = (view.scrollX + ax) / view.ppf;
  return { ppf, scrollX: Math.max(0, frame * ppf - ax) };
}

/** Space left either side of a span that is fitted to the viewport, in pixels. */
const FIT_MARGIN = 40;

/** The view that shows frames `start`…`end` across a viewport `width` pixels wide. */
export function fitView(start: number, end: number, width: number): TimelineView {
  const ppf = clampPpf((width - FIT_MARGIN * 2) / Math.max(1, end - start));
  return { ppf, scrollX: Math.max(0, start * ppf - FIT_MARGIN) };
}
