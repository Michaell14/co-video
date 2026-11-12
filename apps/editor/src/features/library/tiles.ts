/** Moving between the tiles of a library grid with the keyboard. */

/** Where a tile sits on screen: the left and top of its box. */
export interface TilePlace {
  left: number;
  top: number;
}

/** Tiles whose tops are within this many pixels of each other stand in one row. */
const SAME_ROW = 2;

/**
 * The tile a key leads to from tile `from`, as an index into `tiles` (which are in reading order),
 * or `undefined` for a key that does not move between tiles. Left and right follow the reading
 * order across rows and stop at the ends; up and down go to the nearest row in that direction and
 * there to the tile closest to the column the move started in, so a short last row is still reached.
 */
export function tileToward(tiles: TilePlace[], from: number, key: string): number | undefined {
  const at = tiles[from];
  if (!at) return undefined;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, from - 1);
    case 'ArrowRight':
      return Math.min(tiles.length - 1, from + 1);
    case 'Home':
      return 0;
    case 'End':
      return tiles.length - 1;
    case 'ArrowUp':
    case 'ArrowDown': {
      const down = key === 'ArrowDown';
      let best = from;
      let bestRow = Infinity;
      let bestColumn = Infinity;
      tiles.forEach((tile, i) => {
        const row = down ? tile.top - at.top : at.top - tile.top;
        if (row <= SAME_ROW) return;
        const column = Math.abs(tile.left - at.left);
        const nearerRow = row < bestRow - SAME_ROW;
        const sameRow = Math.abs(row - bestRow) <= SAME_ROW;
        if (nearerRow || (sameRow && column < bestColumn)) {
          best = i;
          bestRow = nearerRow ? row : bestRow;
          bestColumn = column;
        }
      });
      return best;
    }
    default:
      return undefined;
  }
}
