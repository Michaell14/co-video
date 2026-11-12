import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaLibrary, type MediaLocation } from '../src/media/library';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MediaLibrary', () => {
  it('asks again for media that was not available, and keeps an answer once there is one', async () => {
    let calls = 0;
    let location: MediaLocation | null = null;
    const library = new MediaLibrary(async () => {
      calls++;
      return location;
    });
    expect(await library.get('a')).toBeNull();
    expect(await library.get('a')).toBeNull();
    expect(await library.blob('a')).toBeNull();
    expect(calls).toBe(3);

    // The upload finished on a peer: the very next request sees the file.
    location = { blob: new Blob(['pixels']) };
    expect(await library.blob('a')).toBe(location.blob);
    expect(await library.blob('a')).toBe(location.blob);
    expect(calls).toBe(4);
  });

  it('shares one request between callers that ask at the same time', async () => {
    let calls = 0;
    let answer: (location: MediaLocation | null) => void = () => {};
    const library = new MediaLibrary(() => {
      calls++;
      return new Promise((resolve) => (answer = resolve));
    });
    const both = Promise.all([library.blob('a'), library.blob('a')]);
    const blob = new Blob(['pixels']);
    answer({ blob });
    expect(await both).toEqual([blob, blob]);
    expect(calls).toBe(1);
  });

  it('lets a failure stand for a moment instead of asking on every frame', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const library = new MediaLibrary(async () => {
      calls++;
      throw new Error('server unreachable');
    });
    expect(await library.blob('a')).toBeNull();
    expect(await library.blob('a')).toBeNull();
    expect(await library.get('a')).toBeNull();
    expect(await library.get('a')).toBeNull();
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await library.blob('a')).toBeNull();
    expect(calls).toBe(3);
  });

  it('tells a file that is not there from one that will not open', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    let location: MediaLocation | null = null;
    const library = new MediaLibrary(async () => {
      calls++;
      return location;
    });
    expect(await library.open('a')).toBe('missing');
    expect(await library.read('a')).toBe('missing');
    expect(warn).not.toHaveBeenCalled();

    // The upload finished, but what arrived is not media.
    location = { blob: new Blob(['not a video file at all'.repeat(40)]) };
    expect(await library.open('a')).toBe('unreadable');
    expect(await library.open('a')).toBe('unreadable');
    expect(await library.get('a')).toBeNull();
    expect(calls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    // The bytes themselves are there for whoever wants them as they are.
    expect(await library.read('a')).toBe(location.blob);

    // The file is replaced by a good one and the session says so.
    location = null;
    library.invalidate('a');
    expect(await library.open('a')).toBe('missing');
  });

  it('reports bytes the server will not hand over as unreadable, and a resolver that fails as missing', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 500 }));
    const refused = new MediaLibrary(async () => ({ url: 'https://example.test/media/a' }));
    expect(await refused.read('a')).toBe('unreadable');
    expect(await refused.blob('a')).toBeNull();

    const lost = new MediaLibrary(async () => {
      throw new Error('storage unavailable');
    });
    expect(await lost.open('a')).toBe('missing');
    expect(await lost.read('a')).toBe('missing');
  });

  it('does not let an old failure displace the answer that replaced it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const blob = new Blob(['pixels']);
    const library = new MediaLibrary(async () => {
      if (++calls === 1) throw new Error('server unreachable');
      return { blob };
    });
    expect(await library.blob('a')).toBeNull();
    // The session learns the file has arrived and says so.
    library.invalidate('a');
    expect(await library.blob('a')).toBe(blob);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await library.blob('a')).toBe(blob);
    expect(calls).toBe(2);
  });
});
