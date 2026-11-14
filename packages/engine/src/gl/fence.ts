/**
 * Waiting for the GPU without stalling on it.
 *
 * A fence signals once the GPU has done what it was asked to do before the fence was made. A
 * browser lets its state change only between tasks, so it is looked at from a timer until it has
 * signalled.
 *
 * That can take long, and nothing says it must end. With software rendering a fence has been seen
 * to stay unsignalled for seconds while the browser's GPU process was busy drawing the page anew,
 * although a synchronous read on the same context came back within a fraction of that. So a wait
 * also ends when it has taken too long, and the caller decides what to do without the signal.
 */

/**
 * How a wait ended: the fence signalled; it had not when the time allowed was up (`overdue`); or
 * there is nothing left to wait for (`abandoned`), because the caller said so or the fence is no
 * longer valid, as after the loss of the context.
 */
export type FenceWait = 'signalled' | 'overdue' | 'abandoned';

/** Between two looks at a fence. */
const POLL_MS = 4;

type FenceContext = Pick<WebGL2RenderingContext, 'clientWaitSync' | 'TIMEOUT_EXPIRED' | 'WAIT_FAILED'>;

/**
 * Resolves when `sync` has signalled, `limitMs` have passed, or `abandoned` answers true, whichever
 * is seen first. It always resolves, and looks at the fence no more once it has.
 */
export function waitForFence(
  gl: FenceContext,
  sync: WebGLSync,
  limitMs: number,
  abandoned: () => boolean,
): Promise<FenceWait> {
  const start = performance.now();
  return new Promise((resolve) => {
    const look = (): void => {
      if (abandoned()) return resolve('abandoned');
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) return resolve('abandoned');
      if (status !== gl.TIMEOUT_EXPIRED) return resolve('signalled');
      if (performance.now() - start >= limitMs) return resolve('overdue');
      setTimeout(look, POLL_MS);
    };
    look();
  });
}
