/**
 * What the ruler and the lane canvases paint with. The values are stated once, in the timeline's
 * stylesheet, as custom properties derived from the design tokens. A canvas cannot use those as
 * they stand, so they are resolved here the first time one is drawn.
 */
export interface CanvasTheme {
  rulerLabel: string;
  tick: string;
  tickMinor: string;
  /** Laid over thumbnails so that labels and handles stay readable on bright footage. */
  thumbShade: string;
  /** Laid over the part of a waveform that a fade turns down. */
  fadeShade: string;
  /** The stretch of a waveform that has not been analysed yet. */
  pending: string;
  /** The label strip of a clip whose media is missing. */
  offlineLabel: string;
  clipRadius: number;
  narrowClipRadius: number;
}

const COLORS = {
  rulerLabel: '--tl-ruler-label',
  tick: '--tl-tick',
  tickMinor: '--tl-tick-minor',
  thumbShade: '--tl-thumb-shade',
  fadeShade: '--tl-fade-shade',
  pending: '--tl-pending',
  offlineLabel: '--tl-offline-label',
} as const;

let theme: CanvasTheme | null = null;

/** `canvas` is any canvas inside the timeline, whose root carries the properties. */
export function canvasTheme(canvas: HTMLCanvasElement): CanvasTheme {
  if (theme) return theme;
  // A colour that is mixed from tokens only becomes one the canvas understands as the computed
  // value of a real property, so each is read through an element that has it as its colour.
  const probe = document.createElement('i');
  (canvas.parentElement ?? canvas).appendChild(probe);
  const style = getComputedStyle(probe);
  const color = (property: string): string => {
    probe.style.color = `var(${property})`;
    return style.color;
  };
  const length = (property: string): number => parseFloat(style.getPropertyValue(property)) || 0;
  const read: CanvasTheme = {
    rulerLabel: color(COLORS.rulerLabel),
    tick: color(COLORS.tick),
    tickMinor: color(COLORS.tickMinor),
    thumbShade: color(COLORS.thumbShade),
    fadeShade: color(COLORS.fadeShade),
    pending: color(COLORS.pending),
    offlineLabel: color(COLORS.offlineLabel),
    clipRadius: length('--tl-clip-r'),
    narrowClipRadius: length('--tl-clip-r-narrow'),
  };
  // Kept only once the stylesheet has been seen to apply: before that every colour would read as
  // the text colour, for good.
  if (style.getPropertyValue(COLORS.tick)) theme = read;
  probe.remove();
  return read;
}
