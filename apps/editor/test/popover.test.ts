import { describe, expect, it } from 'vitest';
import { placePopover } from '../src/ui/layers';

const WINDOW = { width: 1440, height: 900 };
const control = (top: number, left = 600, width = 200) => ({ left, top, width, height: 26 });
const at = (x: number, y: number) => ({ left: x, top: y, width: 0, height: 0 });
const below = { side: 'bottom', align: 'start', control: true } as const;

describe('placing a popover', () => {
  it('opens under its control when there is room', () => {
    const place = placePopover(control(100), { width: 200, height: 300 }, WINDOW, below);
    expect(place).toEqual({ left: 600, top: 132, origin: 'top left', maxHeight: undefined });
  });

  it('opens above when it only fits there, growing from its lower edge', () => {
    const place = placePopover(control(700), { width: 200, height: 300 }, WINDOW, below);
    expect(place).toMatchObject({ top: 700 - 6 - 300, origin: 'bottom left', maxHeight: undefined });
  });

  it('keeps to the side asked for when it fits there, and leaves it only for one that fits', () => {
    const above = { ...below, side: 'top' } as const;
    expect(placePopover(control(700), { width: 200, height: 300 }, WINDOW, above).top).toBe(394);
    expect(placePopover(control(100), { width: 200, height: 300 }, WINDOW, above)).toMatchObject({
      top: 132,
      origin: 'top left',
    });
  });

  it('scrolls a list that fits on neither side in the roomier one, clear of its control', () => {
    // 551 px above, 295 px below, a list of 560.
    const up = placePopover(control(565), { width: 200, height: 560 }, WINDOW, below);
    expect(up).toMatchObject({ top: 8, maxHeight: 551, origin: 'bottom left' });
    expect(up.top + up.maxHeight!).toBe(565 - 6);

    // 232 px above, 614 px below, a list of 640.
    const down = placePopover(control(246), { width: 200, height: 640 }, WINDOW, below);
    expect(down).toMatchObject({ top: 278, maxHeight: 614, origin: 'top left' });
    expect(down.top + down.maxHeight!).toBe(900 - 8);
  });

  it('never lays a list over its control while there is room worth scrolling in', () => {
    for (const height of [200, 420, 560, 640, 900]) {
      for (let top = 0; top <= 874; top += 23) {
        const anchor = control(top);
        const place = placePopover(anchor, { width: 200, height }, WINDOW, below);
        const shown = place.maxHeight ?? height;
        const roomy = Math.max(top - 14, 900 - 14 - top - 26) >= 152;
        const clear = place.top >= top + 26 + 6 || place.top + shown <= top - 6;
        expect(clear, `list of ${height} for a control at ${top}`).toBe(roomy);
        expect(place.top).toBeGreaterThanOrEqual(8);
        expect(place.top + shown).toBeLessThanOrEqual(900 - 8);
      }
    }
  });

  it('slides a menu at the pointer into the window whole, however little room there is', () => {
    const low = placePopover(at(500, 850), { width: 240, height: 600 }, WINDOW, { ...below, control: false });
    expect(low).toMatchObject({ top: 850 - 6 - 600, maxHeight: undefined });
    const tall = placePopover(at(500, 450), { width: 240, height: 880 }, WINDOW, {
      ...below,
      control: false,
    });
    expect(tall).toMatchObject({ top: 12, maxHeight: undefined });
  });

  it('slides a list in rather than showing a sliver of it', () => {
    const short = { width: 1440, height: 300 };
    const place = placePopover(control(140), { width: 200, height: 280 }, short, below);
    expect(place).toMatchObject({ top: 8, maxHeight: undefined });
    expect(place.top + 280).toBeLessThanOrEqual(300 - 8);
  });

  it('lines up with the wanted edge of its control and stays inside the window sideways', () => {
    const size = { width: 300, height: 100 };
    expect(placePopover(control(100), size, WINDOW, { ...below, align: 'end' })).toMatchObject({
      left: 500,
      origin: 'top right',
    });
    expect(placePopover(control(100), size, WINDOW, { ...below, align: 'center' }).left).toBe(550);
    expect(placePopover(control(100, 1300), size, WINDOW, below).left).toBe(1440 - 300 - 8);
    expect(placePopover(control(100, 0, 100), size, WINDOW, { ...below, align: 'end' }).left).toBe(8);
  });

  it('opens beside its anchor, on the other side when the window ends first', () => {
    const size = { width: 240, height: 200 };
    const beside = { side: 'right', align: 'start', control: true } as const;
    expect(placePopover(control(300), size, WINDOW, beside)).toMatchObject({ left: 806, top: 300 });
    expect(placePopover(control(300, 1150), size, WINDOW, beside).left).toBe(1150 - 240 - 6);
  });
});
