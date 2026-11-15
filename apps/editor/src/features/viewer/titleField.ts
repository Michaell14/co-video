/** Where the element a title is typed into has to lie for its text to fall on the title's own. */
import type { LayerBox, TextLayout } from '@tandem/engine';

/**
 * The smallest size, in CSS pixels, the element sets its type in. A browser can be told never to
 * set type smaller than some size, 24 pixels at most, and would then break the lines of a small
 * title elsewhere than the title does. Below this the element is laid out larger and scaled down.
 */
export const MIN_TYPE_PX = 24;

/** The measures of a title's text that decide where the element lies (see `layoutText`). */
export type TextMeasures = Pick<
  TextLayout,
  'size' | 'spacing' | 'lineHeight' | 'x' | 'y' | 'textWidth' | 'textHeight' | 'width' | 'height'
>;

export interface TitleField {
  /** Size of the element, in its own pixels. */
  width: number;
  height: number;
  /** From the element's edges to the area the lines are set in: top, right, bottom, left. */
  padding: [number, number, number, number];
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /**
   * The CSS `matrix()` that takes the element, lying in the top left corner of the frame, to where
   * the title is drawn.
   */
  matrix: [number, number, number, number, number, number];
}

/**
 * The element for a title drawn in `box`, in a viewer that shows the frame at `scale` CSS pixels
 * for each of its own.
 *
 * The element is not the title's drawing scaled to the screen: it is laid out at the size the
 * text has on screen and only turned into place. The caret a browser draws is one pixel of the
 * element wide, and scaled with the picture it would all but vanish in a large frame shown small.
 * What the layout scale cannot give (a title wider than tall, or mirrored) is left to the matrix.
 */
export function titleField(box: LayerBox, text: TextMeasures, scale: number): TitleField {
  const kx = scale * box.sx;
  const ky = scale * box.sy;
  const q = Math.max(Math.abs(ky), MIN_TYPE_PX / text.size);
  const cos = Math.cos(box.rotation);
  const sin = Math.sin(box.rotation);
  // The pivot, in the pixels of the drawing: it is the point that lands on (px, py).
  const ax = box.anchorX * box.boxW;
  const ay = box.anchorY * box.boxH;
  return {
    width: text.width * q,
    height: text.height * q,
    padding: [
      text.y * q,
      (text.width - text.x - text.textWidth) * q,
      (text.height - text.y - text.textHeight) * q,
      text.x * q,
    ],
    fontSize: text.size * q,
    lineHeight: text.lineHeight * q,
    letterSpacing: text.spacing * q,
    matrix: [
      (cos * kx) / q,
      (sin * kx) / q,
      (-sin * ky) / q,
      (cos * ky) / q,
      scale * box.px - (cos * kx * ax - sin * ky * ay),
      scale * box.py - (sin * kx * ax + cos * ky * ay),
    ],
  };
}
