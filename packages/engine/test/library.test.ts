import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decoderGap,
  MediaLibrary,
  posterSize,
  undecodableWarning,
  type MediaLocation,
} from '../src/media/library';

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

  it('says once why an asset cannot be had, however often it is asked for again', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return new Response('gone', { status: 500 });
    });
    const refused = new MediaLibrary(async () => ({ url: 'https://example.test/media/a' }));
    // Whatever shows the asset asks again every few seconds.
    for (let i = 0; i < 4; i++) {
      expect(await refused.read('a')).toBe('unreadable');
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(requests).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[media] could not fetch a');
    // The session says the file changed: what happens to the next request is news again.
    refused.invalidate('a');
    expect(await refused.read('a')).toBe('unreadable');
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    let reachable = false;
    const lost = new MediaLibrary(async () => {
      if (!reachable) throw new Error('storage unavailable');
      return null;
    });
    for (let i = 0; i < 3; i++) {
      expect(await lost.open('b')).toBe('missing');
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    // A resolver that answered and then fails again has a new problem.
    reachable = true;
    expect(await lost.open('b')).toBe('missing');
    reachable = false;
    expect(await lost.open('b')).toBe('missing');
    expect(warn).toHaveBeenCalledTimes(2);
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

describe('posterSize', () => {
  /** What a portrait frame at the poster's width holds: the most a poster may. */
  const MOST = 320 * 569;

  it('makes the poster of a frame as wide as posters get', () => {
    expect(posterSize(1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(posterSize(3840, 2160)).toEqual({ width: 320, height: 180 });
    expect(posterSize(1080, 1920)).toEqual({ width: 320, height: 569 });
  });

  it('gives a picture taller than a portrait frame fewer pixels across instead of more in all', () => {
    for (const [width, height] of [
      [1000, 4000],
      [600, 3600],
      [320, 1280],
      [750, 16000],
    ]) {
      const poster = posterSize(width, height);
      expect(poster.width * poster.height).toBeLessThanOrEqual(MOST * 1.01);
      expect(poster.width * poster.height).toBeGreaterThan(MOST * 0.95);
      // Its proportions are the picture's, to within the rounding of a side to whole pixels.
      expect(Math.abs(poster.height / poster.width / (height / width) - 1)).toBeLessThan(0.02);
    }
    expect(posterSize(600, 3600)).toEqual({ width: 174, height: 1045 });
  });

  it('never enlarges a picture', () => {
    expect(posterSize(100, 600)).toEqual({ width: 100, height: 600 });
    expect(posterSize(64, 64)).toEqual({ width: 64, height: 64 });
  });
});

describe('undecodableWarning', () => {
  it('names the codec when the browser has a decoder and the decoder will not take it', () => {
    expect(undecodableWarning('video', 'hev1.1.6.L93.B0', 'clip.mp4', null)).toBe(
      'This browser cannot decode the video codec (hev1.1.6.L93.B0) in “clip.mp4”.',
    );
    expect(undecodableWarning('audio', null, 'clip.mp4', null)).toBe(
      'This browser cannot decode the audio codec (unknown) in “clip.mp4”.',
    );
  });

  it('blames the address, not the file, on a page the browser gives no decoder', () => {
    const video = undecodableWarning('video', 'avc1.64001f', 'clip.mp4', 'insecure');
    expect(video).toBe(
      'The video in “clip.mp4” will not play: this address is neither HTTPS nor localhost, so the browser has switched off video decoding.',
    );
    expect(video).not.toContain('avc1');
    expect(undecodableWarning('audio', 'mp4a.40.2', 'clip.mp4', 'insecure')).toBe(
      'The audio in “clip.mp4” will not play: this address is neither HTTPS nor localhost, so the browser has switched off audio decoding.',
    );
  });

  it('says so when the browser has no decoder of that kind for any page', () => {
    const audio = undecodableWarning('audio', 'mp4a.40.2', 'clip.mp4', 'absent');
    expect(audio).toBe(
      'This browser has no audio decoder for web pages (WebCodecs), so the audio in “clip.mp4” will not play.',
    );
    expect(audio).not.toContain('mp4a');
  });

  it('finds out for itself what the page is missing', () => {
    // Node has neither decoder, and does not call itself a secure context or an insecure one.
    expect(decoderGap('video')).toBe('absent');
    expect(undecodableWarning('video', 'avc1.64001f', 'clip.mp4')).toMatch(
      /^This browser has no video decoder/,
    );

    vi.stubGlobal('isSecureContext', false);
    expect(decoderGap('video')).toBe('insecure');
    expect(decoderGap('audio')).toBe('insecure');
    expect(undecodableWarning('audio', 'opus', 'take.webm')).toMatch(/neither HTTPS nor localhost/);

    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('VideoDecoder', class {});
    expect(decoderGap('video')).toBeNull();
    expect(decoderGap('audio')).toBe('absent');
    expect(undecodableWarning('video', 'vp09.00.10.08', 'take.webm')).toMatch(
      /video codec \(vp09\.00\.10\.08\)/,
    );
  });
});
