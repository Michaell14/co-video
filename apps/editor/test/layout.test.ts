import { describe, expect, it } from 'vitest';
import { COMMENTS_WIDTH, fitPanels, GAP, resizePanel, type PanelPrefs } from '../src/features/editor/layout';

const prefs = (over: Partial<PanelPrefs> = {}): PanelPrefs => ({
  leftWidth: 320,
  rightWidth: 316,
  timelineHeight: 320,
  commentsOpen: false,
  workspace: 'edit',
  ...over,
});

/** What is left for the viewer: the window less its padding, the side panels and the gaps. */
const viewerWidth = (width: number, l: ReturnType<typeof fitPanels>): number =>
  width - 4 * GAP - l.left - l.right - (l.comments === 'column' ? COMMENTS_WIDTH + GAP : 0);

/** Height of the row above the timeline: the window less the top bar, the splitter and the padding. */
const topHeight = (height: number, l: ReturnType<typeof fitPanels>): number =>
  height - 46 - 2 * GAP - l.timeline;

describe('fitting the panels to the window', () => {
  it('leaves sizes alone when they fit', () => {
    const l = fitPanels(prefs(), { width: 1440, height: 900 });
    expect(l).toMatchObject({ left: 320, right: 316, timeline: 320, comments: null });
  });

  it('shrinks panels sized on a large monitor so the viewer keeps its place on a small one', () => {
    const big = prefs({ leftWidth: 560, rightWidth: 560, timelineHeight: 900 });
    const l = fitPanels(big, { width: 1100, height: 640 });
    expect(viewerWidth(1100, l)).toBeGreaterThanOrEqual(420);
    expect(topHeight(640, l)).toBeGreaterThanOrEqual(222);
    // Both sides give way, neither below what it needs.
    expect(l.left).toBeLessThan(560);
    expect(l.right).toBeLessThan(560);
    expect(l.left).toBeGreaterThanOrEqual(220);
    expect(l.right).toBeGreaterThanOrEqual(260);
    // The chosen sizes are untouched, so the large monitor gets its layout back.
    expect(fitPanels(big, { width: 2560, height: 1440 })).toMatchObject({
      left: 560,
      right: 560,
      timeline: 900,
    });
  });

  it('never takes a panel below its minimum, however small the window', () => {
    const l = fitPanels(prefs({ leftWidth: 560, rightWidth: 560, timelineHeight: 900 }), {
      width: 640,
      height: 360,
    });
    expect(l).toMatchObject({ left: 220, right: 260, timeline: 160 });
    expect(l.limits.left).toEqual({ min: 220, max: 220 });
    expect(l.limits.timeline).toEqual({ min: 160, max: 160 });
  });

  it('ignores sizes outside what a splitter can set', () => {
    const l = fitPanels(prefs({ leftWidth: 5000, rightWidth: -40, timelineHeight: 3 }), {
      width: 2560,
      height: 1440,
    });
    expect(l).toMatchObject({ left: 560, right: 260, timeline: 160 });
  });

  it('keeps the colour and audio panels wide enough to use', () => {
    expect(fitPanels(prefs({ workspace: 'color' }), { width: 1440, height: 900 }).right).toBe(400);
    expect(fitPanels(prefs({ workspace: 'audio' }), { width: 1440, height: 900 }).right).toBe(360);
    expect(
      fitPanels(prefs({ workspace: 'color', rightWidth: 480 }), { width: 1440, height: 900 }).right,
    ).toBe(480);
  });

  it('gives comments a column of their own only where the viewer stays large', () => {
    const open = prefs({ commentsOpen: true });
    const wide = fitPanels(open, { width: 1700, height: 900 });
    expect(wide.comments).toBe('column');
    expect(viewerWidth(1700, wide)).toBeGreaterThanOrEqual(560);

    // On a laptop they take the inspector's column, and the viewer is as wide as without them.
    for (const width of [1440, 1180]) {
      const narrow = fitPanels(open, { width, height: 800 });
      expect(narrow.comments).toBe('right');
      expect(viewerWidth(width, narrow)).toBe(viewerWidth(width, fitPanels(prefs(), { width, height: 800 })));
    }
  });

  it('makes room for a column of comments out of the side panels, not out of the viewer', () => {
    const window = { width: 1700, height: 900 };
    const wide = prefs({ leftWidth: 560, rightWidth: 560 });
    const l = fitPanels({ ...wide, commentsOpen: true }, window);
    expect(l.comments).toBe('column');
    expect(viewerWidth(1700, l)).toBeGreaterThanOrEqual(560);
    expect(viewerWidth(1700, l)).toBeLessThan(562);
    expect(l.left).toBeLessThan(560);
    expect(l.right).toBeLessThan(560);
    // Nothing is written back: with the comments closed the panels are as wide as they were set.
    expect(fitPanels(wide, window)).toMatchObject({ left: 560, right: 560 });
    // The smallest window with such a column holds the panels at the widths they start with.
    expect(fitPanels(prefs({ commentsOpen: true }), { width: 1526, height: 900 })).toMatchObject({
      left: 320,
      right: 316,
      comments: 'column',
    });
    expect(fitPanels(prefs({ commentsOpen: true }), { width: 1525, height: 900 }).comments).toBe('right');
  });

  it('never gives the comments the panel a workspace is for', () => {
    for (const width of [1440, 1180]) {
      const window = { width, height: 800 };
      for (const workspace of ['color', 'audio'] as const) {
        const closed = fitPanels(prefs({ workspace }), window);
        const open = fitPanels(prefs({ workspace, commentsOpen: true }), window);
        // Scopes or the library make way; the colour panel or the mixer keeps its column and width.
        expect(open.comments).toBe('left');
        expect(open).toMatchObject({ left: closed.left, right: closed.right });
      }
    }
    // Where there is room for a fourth column, every workspace keeps both its panels.
    for (const workspace of ['edit', 'color', 'audio'] as const) {
      const l = fitPanels(prefs({ workspace, commentsOpen: true }), { width: 1526, height: 900 });
      expect(l.comments).toBe('column');
      expect(viewerWidth(1526, l)).toBeGreaterThanOrEqual(560);
    }
  });

  it('lets a splitter go as far as the viewer allows and no further', () => {
    const l = fitPanels(prefs(), { width: 1280, height: 720 });
    // 1280 - 24 of padding and gaps - 420 for the viewer = 836 for the two sides.
    expect(l.limits.left).toEqual({ min: 220, max: 836 - 316 });
    expect(l.limits.right).toEqual({ min: 260, max: 836 - 320 });
    expect(l.limits.timeline).toEqual({ min: 160, max: 720 - 46 - 2 * GAP - 222 });
    const roomy = fitPanels(prefs(), { width: 2560, height: 1440 });
    expect(roomy.limits.left.max).toBe(560);
    expect(roomy.limits.right.max).toBe(560);
  });
});

describe('dragging a splitter', () => {
  const laptop = { width: 1100, height: 640 };
  const big = prefs({ leftWidth: 560, rightWidth: 560, timelineHeight: 900 });

  it('stores the new size of the panel it moves', () => {
    expect(resizePanel(prefs(), { width: 1440, height: 900 }, 'left', -30)).toEqual({
      leftWidth: 290,
      rightWidth: 316,
    });
    expect(resizePanel(prefs(), { width: 1440, height: 900 }, 'timeline', 25)).toEqual({
      timelineHeight: 345,
    });
  });

  it('moves a squeezed panel from where it is drawn, by exactly as much as the pointer went', () => {
    const drawn = fitPanels(big, laptop);
    const sizes = resizePanel(big, laptop, 'left', -40);
    const after = fitPanels({ ...big, ...sizes }, laptop);
    expect(after.left).toBe(drawn.left - 40);
    // The viewer gets what the library gave up; the inspector stays as it was drawn.
    expect(after.right).toBe(drawn.right);
    expect(viewerWidth(1100, after)).toBe(viewerWidth(1100, drawn) + 40);

    const shorter = resizePanel(big, laptop, 'timeline', -60);
    expect(fitPanels({ ...big, ...shorter }, laptop).timeline).toBe(drawn.timeline - 60);
  });

  it('adds up movements of less than a pixel', () => {
    const window = { width: 1440, height: 900 };
    let sizes = prefs();
    for (let i = 0; i < 8; i++) {
      sizes = { ...sizes, ...resizePanel(sizes, window, 'timeline', -3.75) };
      sizes = { ...sizes, ...resizePanel(sizes, window, 'left', 1.25) };
    }
    expect(fitPanels(sizes, window)).toMatchObject({ timeline: 290, left: 330 });
  });

  it('stops at the limit and then changes nothing', () => {
    // A window in which the squeezed panels and the smallest viewer add up to the pixel.
    const tight = { width: 1116, height: 640 };
    const drawn = fitPanels(big, tight);
    expect(viewerWidth(1116, drawn)).toBe(420);
    // The viewer is at its minimum, so neither side can grow, and the timeline is as tall as it gets.
    expect(resizePanel(big, tight, 'left', 25)).toBeNull();
    expect(resizePanel(big, tight, 'right', 25)).toBeNull();
    expect(resizePanel(big, tight, 'timeline', 25)).toBeNull();
    expect(resizePanel(big, tight, 'left', -5000)).toEqual({ leftWidth: 220, rightWidth: drawn.right });
  });

  it('leaves the comments where they are, however far a splitter goes', () => {
    const places = [
      { width: 1440, place: 'right', viewer: 420 },
      { width: 1600, place: 'column', viewer: 560 },
    ] as const;
    for (const { width, place, viewer } of places) {
      const window = { width, height: 900 };
      for (const splitter of ['left', 'right'] as const) {
        const other = splitter === 'left' ? 'right' : 'left';
        for (const step of [-1, 1]) {
          let sizes = prefs({ commentsOpen: true });
          // To one end of the splitter's travel and back to the other, a pixel at a time.
          for (const grow of [...Array<number>(400).fill(step), ...Array<number>(800).fill(-step)]) {
            const before = fitPanels(sizes, window);
            sizes = { ...sizes, ...resizePanel(sizes, window, splitter, grow) };
            const after = fitPanels(sizes, window);
            expect(after.comments).toBe(place);
            // The panel under the pointer follows it or has stopped, and the other one stays put.
            expect([0, grow]).toContain(after[splitter] - before[splitter]);
            expect(after[other]).toBe(before[other]);
            expect(viewerWidth(width, after)).toBeGreaterThanOrEqual(viewer);
          }
        }
      }
    }
    // Beside a column of comments a side panel stops where the viewer is down to what it keeps there.
    const wide = { width: 1600, height: 900 };
    const grown = {
      ...prefs({ commentsOpen: true }),
      ...resizePanel(prefs({ commentsOpen: true }), wide, 'right', 500),
    };
    expect(fitPanels(grown, wide)).toMatchObject({ left: 320, right: 390, comments: 'column' });
    expect(viewerWidth(1600, fitPanels(grown, wide))).toBe(560);
  });

  it('does not write the width the colour panel insists on into the inspector’s own', () => {
    const grading = prefs({ workspace: 'color' });
    const window = { width: 1440, height: 900 };
    expect(fitPanels(grading, window).right).toBe(400);
    expect(resizePanel(grading, window, 'right', -30)).toBeNull();
    expect(resizePanel(grading, window, 'left', 10)).toEqual({ leftWidth: 330, rightWidth: 316 });
    expect(resizePanel(grading, window, 'right', 30)).toEqual({ leftWidth: 320, rightWidth: 430 });
  });
});
