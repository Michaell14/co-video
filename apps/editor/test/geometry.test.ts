import { describe, expect, it } from 'vitest';
import { angleStep, pointInQuad, quadCovers, wrapDegrees } from '../src/features/viewer/geometry';

const deg = (d: number): number => (d * Math.PI) / 180;

describe('angleStep', () => {
  it('is the plain difference for a small turn', () => {
    expect(angleStep(deg(10), deg(25))).toBeCloseTo(deg(15));
    expect(angleStep(deg(25), deg(10))).toBeCloseTo(deg(-15));
  });

  it('goes the short way across the jump in atan2', () => {
    // From just below the negative x axis to just above it: atan2 goes from -179° to +179°.
    expect(angleStep(deg(-179), deg(179))).toBeCloseTo(deg(-2));
    expect(angleStep(deg(179), deg(-179))).toBeCloseTo(deg(2));
  });

  it('adds up to the angle actually turned through, however far', () => {
    // A pointer dragged counter-clockwise from the top of a box, 15° at a time, for two full turns.
    let at = Math.atan2(-1, 0);
    let total = 0;
    for (let i = 1; i <= 48; i++) {
      const a = deg(-90 - i * 15);
      const next = Math.atan2(Math.sin(a), Math.cos(a));
      total += angleStep(at, next);
      at = next;
    }
    expect((total * 180) / Math.PI).toBeCloseTo(-720);
  });
});

describe('wrapDegrees', () => {
  it('keeps what is already within half a turn', () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(-90)).toBe(-90);
    expect(wrapDegrees(180)).toBe(180);
  });

  it('names the same direction within half a turn of zero', () => {
    expect(wrapDegrees(270)).toBe(-90);
    expect(wrapDegrees(-270)).toBe(90);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(725)).toBe(5);
  });
});

describe('pointInQuad', () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('tells inside from outside for either winding', () => {
    expect(pointInQuad(square, 5, 5)).toBe(true);
    expect(pointInQuad(square, 15, 5)).toBe(false);
    expect(pointInQuad([...square].reverse(), 5, 5)).toBe(true);
    expect(pointInQuad([...square].reverse(), 5, -1)).toBe(false);
  });

  it('counts the edge as inside', () => {
    expect(pointInQuad(square, 10, 5)).toBe(true);
  });
});

describe('quadCovers', () => {
  const frame: [number, number][] = [
    [0, 0],
    [1920, 0],
    [1920, 1080],
    [0, 1080],
  ];
  const title: [number, number][] = [
    [700, 480],
    [1220, 480],
    [1220, 600],
    [700, 600],
  ];

  it('holds for a quad that lies inside another, and not the other way round', () => {
    expect(quadCovers(frame, title)).toBe(true);
    expect(quadCovers(title, frame)).toBe(false);
  });

  it('does not hold when part of the inner quad sticks out', () => {
    expect(quadCovers(frame, [...title.slice(0, 2), [1220, 1200], [700, 1200]])).toBe(false);
  });

  it('holds between two quads that are the same but for rounding', () => {
    const again = frame.map(([x, y]): [number, number] => [x + 1e-9, y - 1e-9]);
    expect(quadCovers(frame, frame)).toBe(true);
    expect(quadCovers(frame, again)).toBe(true);
    expect(quadCovers(again, frame)).toBe(true);
  });

  it('follows a turned quad', () => {
    const diamond: [number, number][] = [
      [960, 0],
      [1500, 540],
      [960, 1080],
      [420, 540],
    ];
    expect(quadCovers(diamond, title)).toBe(true);
    expect(quadCovers(diamond, frame)).toBe(false);
  });
});
