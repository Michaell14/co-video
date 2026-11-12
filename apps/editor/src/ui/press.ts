/** Telling the second press of a double-click from a new one, for controls that act on press. */

export interface Press {
  time: number;
  x: number;
  y: number;
}

/** How far, in pixels, the pointer may wander from where it went down and still be clicking. */
const SLOP = 5;

/**
 * Whether `next` is the second press of a double-click that began with `prev`. Pointer events
 * carry no click count, so this goes by the usual half second and a few pixels.
 */
export function isDoublePress(prev: Press | null, next: Press): boolean {
  return !!prev && next.time - prev.time < 500 && !isDrag(prev, next.x, next.y);
}

/** Whether the pointer has left the spot where `press` went down: the press has become a drag. */
export function isDrag(press: Press, x: number, y: number): boolean {
  return Math.abs(x - press.x) >= SLOP || Math.abs(y - press.y) >= SLOP;
}
