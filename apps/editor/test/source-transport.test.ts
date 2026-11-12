import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceTransport } from '../src/features/viewer/sourceTransport';

/** The slice of a media element the transport drives. */
class FakeMedia {
  currentTime = 0;
  duration = 10;
  paused = true;
  playbackRate = 1;
  seeking = false;
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

describe('SourceTransport', () => {
  let frames: ((now: number) => void)[] = [];
  let now = 0;
  const run = (count: number, ms = 20): void => {
    for (let i = 0; i < count; i++) {
      const due = frames;
      frames = [];
      now += ms;
      for (const fn of due) fn(now);
    }
  };
  let el: FakeMedia;
  let transport: SourceTransport;

  beforeEach(() => {
    frames = [];
    now = 5000;
    vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    el = new FakeMedia();
    transport = new SourceTransport();
    transport.attach(el as unknown as HTMLMediaElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toggles between playing and paused', () => {
    transport.toggle();
    expect(el.paused).toBe(false);
    transport.toggle();
    expect(el.paused).toBe(true);
  });

  it('doubles the speed on each further press of L and resets it on K', () => {
    transport.shuttle(1);
    expect([el.paused, el.playbackRate]).toEqual([false, 1]);
    transport.shuttle(1);
    transport.shuttle(1);
    expect(el.playbackRate).toBe(4);
    for (let i = 0; i < 5; i++) transport.shuttle(1);
    expect(el.playbackRate).toBe(8);
    transport.pause();
    expect([el.paused, el.playbackRate]).toEqual([true, 1]);
  });

  it('winds back on J by seeking, at the speed of the clock', () => {
    el.currentTime = 4;
    transport.shuttle(-1);
    expect(el.paused).toBe(true);
    run(50);
    expect(el.currentTime).toBeCloseTo(3, 1);
    expect(transport.moving).toBe(true);
    transport.shuttle(-1);
    run(50);
    expect(el.currentTime).toBeCloseTo(1, 1);
  });

  it('keeps to the clock while the element is still busy with the last seek', () => {
    el.currentTime = 4;
    transport.shuttle(-1);
    el.seeking = true;
    run(50);
    expect(el.currentTime).toBe(4);
    expect(transport.time).toBeCloseTo(3, 1);
    el.seeking = false;
    run(1);
    expect(el.currentTime).toBeCloseTo(2.98, 1);
  });

  it('stops winding at the start of the source', () => {
    el.currentTime = 0.3;
    transport.shuttle(-1);
    run(40);
    expect(el.currentTime).toBe(0);
    expect(transport.moving).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('goes from winding back straight to playing, from where the winding got to', () => {
    el.currentTime = 4;
    transport.shuttle(-1);
    el.seeking = true;
    run(25);
    transport.shuttle(1);
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeCloseTo(3.5, 1);
    expect(frames).toHaveLength(0);
  });

  it('steps and seeks within the source, stopping playback', () => {
    transport.toggle();
    el.currentTime = 2;
    transport.step(0.5);
    expect([el.paused, el.currentTime]).toEqual([true, 2.5]);
    transport.step(-100);
    expect(el.currentTime).toBe(0);
    transport.seek(Infinity);
    expect(el.currentTime).toBe(10);
  });

  it('does nothing without an element, and lets go of the old one', () => {
    transport.shuttle(-1);
    transport.attach(null);
    expect(frames).toHaveLength(0);
    transport.toggle();
    transport.shuttle(1);
    transport.shuttle(-1);
    transport.step(1);
    expect(transport.time).toBe(0);
    expect(el.paused).toBe(true);
  });
});
