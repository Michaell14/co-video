import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForFence, type FenceWait } from '../src/gl/fence';

const SIGNALED = 0x911a;
const TIMEOUT_EXPIRED = 0x911b;
const WAIT_FAILED = 0x911d;

/** A context whose fence answers what `status` says each time it is looked at. */
function fakeContext(status: () => number) {
  const gl = {
    TIMEOUT_EXPIRED,
    WAIT_FAILED,
    looks: 0,
    clientWaitSync(): number {
      gl.looks++;
      return status();
    },
  };
  return gl;
}

const sync = {} as WebGLSync;

/** Start a wait and note how it ends, without waiting for it. */
function begin(gl: ReturnType<typeof fakeContext>, limitMs: number, abandoned = () => false) {
  const wait = { ended: null as FenceWait | null };
  void waitForFence(gl, sync, limitMs, abandoned).then((ended) => (wait.ended = ended));
  return wait;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('waitForFence', () => {
  it('ends as soon as the fence has signalled', async () => {
    let status = TIMEOUT_EXPIRED;
    const gl = fakeContext(() => status);
    const wait = begin(gl, 250);
    await vi.advanceTimersByTimeAsync(40);
    expect(wait.ended).toBeNull();
    status = SIGNALED;
    await vi.advanceTimersByTimeAsync(4);
    expect(wait.ended).toBe('signalled');
  });

  it('does not wait at all for a fence that has signalled already', async () => {
    const gl = fakeContext(() => SIGNALED);
    const wait = begin(gl, 250);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.ended).toBe('signalled');
    expect(gl.looks).toBe(1);
  });

  it('gives a fence that never signals the time allowed and no more', async () => {
    const gl = fakeContext(() => TIMEOUT_EXPIRED);
    const wait = begin(gl, 250);
    await vi.advanceTimersByTimeAsync(248);
    expect(wait.ended).toBeNull();
    await vi.advanceTimersByTimeAsync(4);
    expect(wait.ended).toBe('overdue');

    // Nothing is left running: the fence is not looked at again.
    const looks = gl.looks;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(gl.looks).toBe(looks);
  });

  it('ends a wait whose timers were held back as soon as one of them runs', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const gl = fakeContext(() => TIMEOUT_EXPIRED);
    const wait = begin(gl, 250);
    // A page in the background gets its timers once a second: by the time the fence is looked at
    // again the limit is long past, and that one look ends the wait.
    now.mockReturnValue(1000);
    await vi.advanceTimersByTimeAsync(4);
    expect(wait.ended).toBe('overdue');
    expect(gl.looks).toBe(2);
  });

  it('stops when the caller has nothing left to wait for, without looking at the fence', async () => {
    let gone = false;
    const gl = fakeContext(() => TIMEOUT_EXPIRED);
    const wait = begin(gl, 250, () => gone);
    await vi.advanceTimersByTimeAsync(20);
    expect(wait.ended).toBeNull();
    const looks = gl.looks;
    gone = true;
    await vi.advanceTimersByTimeAsync(4);
    expect(wait.ended).toBe('abandoned');
    expect(gl.looks).toBe(looks);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a fence the context no longer knows', async () => {
    let status = TIMEOUT_EXPIRED;
    const gl = fakeContext(() => status);
    const wait = begin(gl, 250);
    await vi.advanceTimersByTimeAsync(12);
    status = WAIT_FAILED;
    await vi.advanceTimersByTimeAsync(4);
    expect(wait.ended).toBe('abandoned');
    expect(vi.getTimerCount()).toBe(0);
  });
});
