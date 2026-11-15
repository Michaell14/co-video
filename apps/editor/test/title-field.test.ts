import { describe, expect, it } from 'vitest';
import { layerPoint, type LayerBox } from '@tandem/engine';
import {
  MIN_TYPE_PX,
  titleField,
  type TextMeasures,
  type TitleField,
} from '../src/features/viewer/titleField';
import { TypingHistory, type TextState } from '../src/features/viewer/typingHistory';

/** A drawing 400 by 120 with its lines set in the 360 by 80 at (20, 20): type of 60 pixels. */
const text: TextMeasures = {
  size: 60,
  spacing: 3,
  lineHeight: 80,
  x: 20,
  y: 20,
  textWidth: 360,
  textHeight: 80,
  width: 400,
  height: 120,
};

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  boxW: text.width,
  boxH: text.height,
  sx: 1,
  sy: 1,
  px: 960,
  py: 540,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
  ...over,
});

/** Where a point of the element lands in the viewer, in CSS pixels. */
function onScreen(field: TitleField, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = field.matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

/** The same point of the drawing as the compositor places it, at the viewer's scale. */
function drawn(b: LayerBox, scale: number, u: number, v: number): [number, number] {
  const [x, y] = layerPoint(b, u, v);
  return [x * scale, y * scale];
}

function expectOnDrawing(b: LayerBox, scale: number): void {
  const field = titleField(b, text, scale);
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0.3, 0.8],
  ]) {
    const [x, y] = onScreen(field, u * field.width, v * field.height);
    const [wantX, wantY] = drawn(b, scale, u, v);
    expect(x).toBeCloseTo(wantX, 6);
    expect(y).toBeCloseTo(wantY, 6);
  }
}

describe('titleField', () => {
  it('lies on the drawing, corner for corner', () => {
    expectOnDrawing(box(), 1);
    expectOnDrawing(box(), 0.42);
    expectOnDrawing(box({ px: 300, py: 900 }), 2);
  });

  it('follows the layer when it is turned, scaled, stretched, mirrored or hung by a corner', () => {
    expectOnDrawing(box({ rotation: (17 * Math.PI) / 180 }), 0.5);
    expectOnDrawing(box({ sx: 1.4, sy: 1.4, rotation: -1.2 }), 0.5);
    expectOnDrawing(box({ sx: 2, sy: 0.5 }), 0.75);
    expectOnDrawing(box({ sx: -1, sy: 1, rotation: 0.3 }), 1);
    expectOnDrawing(box({ sx: 1, sy: -1.5 }), 1);
    expectOnDrawing(box({ anchorX: 0, anchorY: 1, rotation: 2 }), 0.3);
  });

  it('sets its type at the size the text has on screen, so the caret is a pixel wide', () => {
    const field = titleField(box({ sx: 1.5, sy: 1.5, rotation: 0.4 }), text, 0.5);
    expect(field.fontSize).toBeCloseTo(45);
    expect(field.lineHeight).toBeCloseTo(60);
    expect(field.letterSpacing).toBeCloseTo(2.25);
    expect([field.width, field.height]).toEqual([300, 90]);
    // What is left to the matrix is the turn alone.
    const [a, b, c, d] = field.matrix;
    expect(Math.hypot(a, b)).toBeCloseTo(1);
    expect(Math.hypot(c, d)).toBeCloseTo(1);
  });

  it('keeps the lines in the same place within the element at every size', () => {
    for (const scale of [0.25, 1, 3]) {
      const field = titleField(box(), text, scale);
      const [top, right, bottom, left] = field.padding;
      const q = field.fontSize / text.size;
      expect([top / q, left / q]).toEqual([20, 20]);
      expect((field.width - left - right) / q).toBeCloseTo(text.textWidth);
      expect((field.height - top - bottom) / q).toBeCloseTo(text.textHeight);
    }
  });

  it('never sets type smaller than a browser may refuse to, and scales the element down instead', () => {
    const field = titleField(box(), text, 0.1);
    expect(field.fontSize).toBe(MIN_TYPE_PX);
    expect(field.matrix[0]).toBeCloseTo((0.1 * text.size) / MIN_TYPE_PX);
    expectOnDrawing(box(), 0.1);
    expectOnDrawing(box({ sx: 0.2, sy: 0.2, rotation: 1 }), 0.5);
  });

  it('gives a layer scaled to nothing an element of no size, not a broken one', () => {
    const field = titleField(box({ sx: 0, sy: 0 }), text, 1);
    expect(field.matrix.every(Number.isFinite)).toBe(true);
    expect(field.matrix.slice(0, 4).every((value) => value === 0)).toBe(true);
  });
});

describe('TypingHistory', () => {
  const at = (value: string, start = value.length, end = start): TextState => ({ text: value, start, end });

  /** Type `chars` one at a time at the end of what `history` holds. */
  function type(history: TypingHistory, from: string, chars: string): string {
    let value = from;
    for (const ch of chars) {
      history.record(at(value), at(value + ch), 'insertText');
      value += ch;
    }
    return value;
  }

  it('takes a run of typing back word by word', () => {
    const history = new TypingHistory(at(''));
    type(history, '', 'hello big world');
    expect(history.undo()).toEqual(at('hello big '));
    expect(history.undo()).toEqual(at('hello big'));
    expect(history.undo()).toEqual(at('hello '));
    expect(history.undo()).toEqual(at('hello'));
    expect(history.undo()).toEqual(at(''));
    expect(history.undo()).toBeNull();
  });

  it('gives back the selection that typing replaced', () => {
    const history = new TypingHistory(at('Your text here', 0, 14));
    history.record(at('Your text here', 0, 14), at('N'), 'insertText');
    type(history, 'N', 'ew');
    expect(history.undo()).toEqual(at('Your text here', 0, 14));
    expect(history.redo()).toEqual(at('New'));
    expect(history.redo()).toBeNull();
  });

  it('starts a new step where the caret was moved, and for anything that is not typing', () => {
    const history = new TypingHistory(at(''));
    const typed = type(history, '', 'abc');
    // The caret goes to the front, and typing goes on there.
    history.record(at(typed, 0), at('xabc', 1), 'insertText');
    history.record(at('xabc', 1), at('xyabc', 2), 'insertText');
    history.record(at('xyabc', 2), at('xyabc\n', 6), 'insertLineBreak');
    history.record(at('xyabc\n', 6), at('xyabc\npasted', 12), 'insertFromPaste');
    expect(history.undo()).toEqual(at('xyabc\n', 6));
    expect(history.undo()).toEqual(at('xyabc', 2));
    expect(history.undo()).toEqual(at(typed, 0));
    expect(history.undo()).toEqual(at(''));
  });

  it('keeps erasing apart from typing, and one run of erasing together', () => {
    const history = new TypingHistory(at(''));
    const typed = type(history, '', 'abcd');
    history.record(at(typed), at('abc'), 'deleteContentBackward');
    history.record(at('abc'), at('ab'), 'deleteContentBackward');
    type(history, 'ab', 'x');
    expect(history.undo()).toEqual(at('ab'));
    expect(history.undo()).toEqual(at('abcd'));
    expect(history.undo()).toEqual(at(''));
  });

  it('forgets what was undone once something new is typed', () => {
    const history = new TypingHistory(at(''));
    type(history, '', 'one two');
    history.undo();
    type(history, 'one ', 'x');
    expect(history.redo()).toBeNull();
    expect(history.undo()).toEqual(at('one '));
  });

  it('has nothing to take back after the text was set from outside', () => {
    const history = new TypingHistory(at(''));
    type(history, '', 'mine');
    history.reset(at('theirs'));
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    type(history, 'theirs', '!');
    expect(history.undo()).toEqual(at('theirs'));
  });
});
