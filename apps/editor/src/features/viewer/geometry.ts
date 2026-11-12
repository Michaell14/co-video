/** Plane geometry for the viewer's transform handles. */

/** Whether the point lies inside the convex quadrilateral `q` (corners in order, either winding). */
export function pointInQuad(q: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

/**
 * Whether the convex quadrilateral `outer` hides all of `inner`. `inner` is drawn in towards its
 * centre by a thousandth first, so that two quads meant to be the same cover each other even when
 * their corners differ in the last digit.
 */
export function quadCovers(outer: [number, number][], inner: [number, number][]): boolean {
  const cx = inner.reduce((sum, [x]) => sum + x, 0) / inner.length;
  const cy = inner.reduce((sum, [, y]) => sum + y, 0) / inner.length;
  return inner.every(([x, y]) => pointInQuad(outer, x + (cx - x) / 1000, y + (cy - y) / 1000));
}

/**
 * The turn from angle `from` to angle `to` (radians, as `Math.atan2` gives them), taken the short
 * way round: in (-π, π]. `atan2` jumps by a whole turn where a pointer crosses the negative x axis;
 * adding up these steps does not.
 */
export function angleStep(from: number, to: number): number {
  const turn = 2 * Math.PI;
  const step = (to - from) % turn;
  if (step > Math.PI) return step - turn;
  if (step <= -Math.PI) return step + turn;
  return step;
}

/** The same direction as `degrees`, named within half a turn of zero: in (-180, 180]. */
export function wrapDegrees(degrees: number): number {
  const d = degrees % 360;
  if (d > 180) return d - 360;
  if (d <= -180) return d + 360;
  return d;
}
