/**
 * Where the editor's panels go for a given window. The sizes a person dragged are preferences: they
 * are kept as set, and fitted to the window each time it is laid out, so a layout made on a large
 * monitor still shows every panel on a small one and comes back when the window grows again.
 */
import type { Workspace } from '../../state/ui';

export interface PanelPrefs {
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
  commentsOpen: boolean;
  workspace: Workspace;
}

export interface Viewport {
  width: number;
  height: number;
}

interface Range {
  min: number;
  max: number;
}

export interface PanelLayout {
  left: number;
  right: number;
  timeline: number;
  /**
   * Comments sit in a column of their own, or in a window too small for one take a side panel's:
   * the inspector's while editing, the left one where the right-hand panel is what the workspace
   * is for.
   */
  comments: 'column' | 'left' | 'right' | null;
  /** How far each splitter can be dragged in this window. */
  limits: { left: Range; right: Range; timeline: Range };
}

export const windowSize = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/** Space between panels, and around them at the window's edge. */
export const GAP = 6;
export const COMMENTS_WIDTH = 300;

const LEFT: Range = { min: 220, max: 560 };
const RIGHT_MAX = 560;
const TIMELINE_MIN = 160;
/** The top bar and the padding under the panels. */
const CHROME_HEIGHT = 46 + GAP;
/** The viewer keeps room for its transport bar and a picture worth looking at. */
const VIEWER_MIN_WIDTH = 420;
const VIEWER_MIN_HEIGHT = 222;
/** Beside a column of comments the picture is what is being discussed: it keeps more than the least. */
const VIEWER_WITH_COMMENTS = 560;
/** What the two side panels take up until someone drags a splitter. */
const USUAL_SIDES = 320 + 316;
/**
 * The window from which comments get a column of their own: one with room for it beside side
 * panels of the usual widths. It goes by the window alone. Were the panels' present sizes to
 * count, a splitter would move the comments from one place to another under the pointer.
 */
const COMMENTS_COLUMN_FROM = 4 * GAP + USUAL_SIDES + COMMENTS_WIDTH + GAP + VIEWER_WITH_COMMENTS;

/** The colour and audio panels need more width than the inspector to be usable. */
const rightMin = (workspace: Workspace): number =>
  workspace === 'color' ? 400 : workspace === 'audio' ? 360 : 260;

/** A range that has shrunk to nothing keeps its lower end: panels never go below their minimum. */
const clamp = (v: number, { min, max }: Range): number => Math.max(min, Math.min(max, v));

export function fitPanels(prefs: PanelPrefs, viewport: Viewport): PanelLayout {
  const RIGHT: Range = { min: rightMin(prefs.workspace), max: RIGHT_MAX };
  const wantLeft = clamp(prefs.leftWidth, LEFT);
  const wantRight = clamp(prefs.rightWidth, RIGHT);
  // What three columns share: the window less its padding and the two gaps between them.
  const width = viewport.width - 4 * GAP;

  const comments = !prefs.commentsOpen
    ? null
    : viewport.width >= COMMENTS_COLUMN_FROM
      ? 'column'
      : prefs.workspace === 'edit'
        ? 'right'
        : 'left';
  // What the two side panels may take between them. Standing in for one of them, comments cost the
  // viewer nothing; in a column of their own they are paid for by the side panels, not by the viewer.
  const sides =
    comments === 'column' ? width - (COMMENTS_WIDTH + GAP) - VIEWER_WITH_COMMENTS : width - VIEWER_MIN_WIDTH;

  // Too wide for this window: both side panels give way in proportion to what they have to spare.
  const spare = { left: wantLeft - LEFT.min, right: wantRight - RIGHT.min };
  const over = Math.min(Math.max(0, wantLeft + wantRight - sides), spare.left + spare.right);
  const share = over > 0 ? over / (spare.left + spare.right) : 0;
  // Whole pixels, rounded down so the two never take more than there is. A size that fits is used
  // as it is: a splitter adds up small movements, and rounding each would lose them.
  const left = share ? Math.floor(wantLeft - spare.left * share) : wantLeft;
  const right = share ? Math.floor(wantRight - spare.right * share) : wantRight;

  const limits = {
    left: { min: LEFT.min, max: clamp(sides - right, LEFT) },
    right: { min: RIGHT.min, max: clamp(sides - left, RIGHT) },
    timeline: {
      min: TIMELINE_MIN,
      max: Math.max(TIMELINE_MIN, viewport.height - CHROME_HEIGHT - GAP - VIEWER_MIN_HEIGHT),
    },
  };
  return { left, right, timeline: clamp(prefs.timelineHeight, limits.timeline), comments, limits };
}

export type Splitter = keyof PanelLayout['limits'];

/**
 * The sizes to keep after a splitter has moved its panel by `grow` pixels, or null when the panel
 * is at its limit. The panel moves from the size it is drawn at. A side panel the window has
 * squeezed is kept at the size it is drawn at too: left wanting more, it would take back part of
 * what the drag just gave the viewer.
 */
export function resizePanel(
  prefs: PanelPrefs,
  viewport: Viewport,
  splitter: Splitter,
  grow: number,
): Partial<Pick<PanelPrefs, 'leftWidth' | 'rightWidth' | 'timelineHeight'>> | null {
  const now = fitPanels(prefs, viewport);
  const next = clamp(now[splitter] + grow, now.limits[splitter]);
  if (next === now[splitter]) return null;
  if (splitter === 'timeline') return { timelineHeight: next };
  const sides = {
    leftWidth: Math.min(prefs.leftWidth, now.left),
    rightWidth: Math.min(prefs.rightWidth, now.right),
  };
  return { ...sides, [splitter === 'left' ? 'leftWidth' : 'rightWidth']: next };
}
