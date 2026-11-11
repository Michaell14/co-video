import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode, secondsToFrame, framesToSeconds, frameAtSeconds } from '../src';

const f30 = { fpsNum: 30, fpsDen: 1 };
const f2997 = { fpsNum: 30000, fpsDen: 1001 };
const f24 = { fpsNum: 24, fpsDen: 1 };
const f120 = { fpsNum: 120, fpsDen: 1 };

describe('timecode', () => {
  it('formats non-drop timecode', () => {
    expect(formatTimecode(0, f30)).toBe('00:00:00:00');
    expect(formatTimecode(29, f30)).toBe('00:00:00:29');
    expect(formatTimecode(30, f30)).toBe('00:00:01:00');
    expect(formatTimecode(30 * 3600 + 30 * 61 + 5, f30)).toBe('01:01:01:05');
    expect(formatTimecode(24 * 60, f24)).toBe('00:01:00:00');
  });

  it('uses three frame digits above 100 fps', () => {
    expect(formatTimecode(119, f120)).toBe('00:00:00:119');
  });

  it('formats drop-frame timecode for 29.97', () => {
    // Known reference values for 29.97 DF.
    expect(formatTimecode(1800, f2997)).toBe('00:01:00;02');
    expect(formatTimecode(1799, f2997)).toBe('00:00:59;29');
    expect(formatTimecode(17982, f2997)).toBe('00:10:00;00');
    expect(formatTimecode(107892, f2997)).toBe('01:00:00;00');
  });

  it('round-trips through parse', () => {
    for (const fps of [f30, f24, f2997, f120]) {
      for (const frame of [0, 1, 29, 30, 1799, 1800, 17982, 54321, 107892]) {
        const tc = formatTimecode(frame, fps);
        expect(parseTimecode(tc, fps)?.frame, `${tc} @ ${fps.fpsNum}/${fps.fpsDen}`).toBe(frame);
      }
    }
  });

  it('parses loose input', () => {
    expect(parseTimecode('1:00', f30)?.frame).toBe(30);
    expect(parseTimecode('100', f30)?.frame).toBe(100);
    expect(parseTimecode('+15', f30)).toEqual({ frame: 15, relative: true });
    expect(parseTimecode('-15', f30)).toEqual({ frame: -15, relative: true });
    expect(parseTimecode('2.5s', f30)?.frame).toBe(75);
    expect(parseTimecode('abc', f30)).toBeNull();
  });

  it('converts between frames and seconds without drift', () => {
    for (let f = 0; f < 5000; f += 37) {
      expect(secondsToFrame(framesToSeconds(f, f2997), f2997)).toBe(f);
      expect(frameAtSeconds(framesToSeconds(f, f2997), f2997)).toBe(f);
    }
  });
});
