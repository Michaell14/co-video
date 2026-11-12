import { describe, expect, it } from 'vitest';
import { tileToward, type TilePlace } from '../src/features/library/tiles';

/** A grid of `count` tiles, `columns` to a row, 100 by 80 pixels each, in reading order. */
const grid = (count: number, columns: number): TilePlace[] =>
  Array.from({ length: count }, (_, i) => ({ left: (i % columns) * 100, top: Math.floor(i / columns) * 80 }));

describe('moving between library tiles', () => {
  const tiles = grid(8, 3);

  it('goes left and right in reading order, across rows, and stops at the ends', () => {
    expect(tileToward(tiles, 0, 'ArrowRight')).toBe(1);
    expect(tileToward(tiles, 2, 'ArrowRight')).toBe(3);
    expect(tileToward(tiles, 3, 'ArrowLeft')).toBe(2);
    expect(tileToward(tiles, 0, 'ArrowLeft')).toBe(0);
    expect(tileToward(tiles, 7, 'ArrowRight')).toBe(7);
  });

  it('goes up and down within the column', () => {
    expect(tileToward(tiles, 1, 'ArrowDown')).toBe(4);
    expect(tileToward(tiles, 4, 'ArrowDown')).toBe(7);
    expect(tileToward(tiles, 4, 'ArrowUp')).toBe(1);
    expect(tileToward(tiles, 0, 'ArrowUp')).toBe(0);
    expect(tileToward(tiles, 7, 'ArrowDown')).toBe(7);
  });

  it('reaches a short last row from the column that has no tile in it', () => {
    expect(tileToward(tiles, 5, 'ArrowDown')).toBe(7);
    // Up again leads to the tile straight above, not back to where the move began.
    expect(tileToward(tiles, 7, 'ArrowUp')).toBe(4);
  });

  it('takes rows that are a pixel out of line as rows', () => {
    const uneven = tiles.map((t, i) => ({ ...t, top: t.top + (i % 2) }));
    expect(tileToward(uneven, 0, 'ArrowDown')).toBe(3);
    expect(tileToward(uneven, 4, 'ArrowUp')).toBe(1);
  });

  it('goes to the first and the last tile', () => {
    expect(tileToward(tiles, 4, 'Home')).toBe(0);
    expect(tileToward(tiles, 4, 'End')).toBe(7);
  });

  it('leaves every other key alone', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'PageDown', 'Escape'])
      expect(tileToward(tiles, 4, key)).toBeUndefined();
    expect(tileToward(tiles, 9, 'ArrowRight')).toBeUndefined();
    expect(tileToward([], 0, 'Home')).toBeUndefined();
  });

  it('moves along a single row or a single column', () => {
    const row = grid(7, 7);
    expect(tileToward(row, 3, 'ArrowDown')).toBe(3);
    expect(tileToward(row, 3, 'ArrowRight')).toBe(4);
    const column = grid(2, 1);
    expect(tileToward(column, 0, 'ArrowDown')).toBe(1);
    expect(tileToward(column, 0, 'ArrowRight')).toBe(1);
  });
});
