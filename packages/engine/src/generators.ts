/**
 * Rasterises generator clips (text, shapes, solids) with the Canvas 2D API.
 *
 * Output is always produced at the current render resolution so type stays crisp at 8K and cheap at
 * quarter-res preview. Results are cached by a content key; the compositor uploads them as textures.
 */
import type { Clip, ShapeProps, TextProps } from '@tandem/core';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Longest canvas side that is safe to upload as a texture everywhere. */
const MAX_DIM = 8192;
const SHADOW_TILE = MAX_DIM / 2;

function makeCanvas(w: number, h: number): AnyCanvas {
  const cw = Math.max(2, Math.ceil(w));
  const ch = Math.max(2, Math.ceil(h));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  return c;
}

/**
 * Scale at which a `w` × `h` drawing is rasterised: 1, or less when it would not fit a texture.
 * Both axes shrink together, so an oversized block only loses sharpness, never its proportions.
 */
const fitScale = (w: number, h: number): number => Math.min(1, MAX_DIM / w, MAX_DIM / h);

let fontLoads = 0;
const fontListeners = new Set<() => void>();
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener('loadingdone', () => {
    fontLoads++;
    for (const fn of Array.from(fontListeners)) fn();
  });
}

/**
 * Goes up each time fonts finish loading. Text measured or drawn under an earlier value may have
 * used a fallback face (title fonts load on first use), so anything cached from it is stale.
 */
export const fontEpoch = (): number => fontLoads;

/** Call `fn` whenever `fontEpoch` changes. Returns the function that unsubscribes it. */
export function onFontsLoaded(fn: () => void): () => void {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}

/** The families a title's text is set in, as CSS lists them: its own, then what stands in for it. */
export function fontStack(t: TextProps): string {
  return `"${t.font}", "Inter Variable", Inter, system-ui, sans-serif`;
}

export function fontSpec(t: TextProps, px: number): string {
  return `${t.italic ? 'italic ' : ''}${t.weight} ${px}px ${fontStack(t)}`;
}

function hexA(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha))})`;
}

function gradientFor(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  g: { from: string; to: string; angle: number },
) {
  const a = (g.angle * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
  const grad = ctx.createLinearGradient(
    cx - Math.cos(a) * r,
    cy - Math.sin(a) * r,
    cx + Math.cos(a) * r,
    cy + Math.sin(a) * r,
  );
  grad.addColorStop(0, g.from);
  grad.addColorStop(1, g.to);
  return grad;
}

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Split into user-perceived characters so emoji and combining marks survive the typewriter. */
function graphemes(s: string): string[] {
  if (!segmenter) return Array.from(s);
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/**
 * White space that takes no room where a line ends: a space, a tab, the wide space of East Asian
 * text. A no-break space is not among it, nor are the spaces of a set width (see `breaksBetween`).
 */
const WHITE = /[ \t　]/;

/** `line` without the white space it ends with. */
const withoutTrail = (line: string): string => line.replace(/[ \t　]+$/, '');

const ASCII = /[!-~]/;
/**
 * What a line is broken after when a character beyond ASCII is next to it: hyphens, dashes and
 * the upright bar, and the spaces of a set width, which act like them.
 */
const BREAK_AFTER = /[-|‐‒–  -  -  ]/;
/** What ends a phrase or closes a bracket stays with what it follows, and so does a quotation mark. */
const CLINGS = /[!),./:;?\]}"'‘’“”«»…]/;
/** What opens a bracket, a quotation or a Spanish question stays with what follows it. */
const OPENS = /[([{"'‘’“”«»¡¿]/;
/** No-break spaces, the no-break hyphen and the invisible characters that join words. */
const GLUE = /[   ‑⁠﻿]/;
/** Marks that belong to the character before them. */
const MARK = /[\p{M}‍]/u;
const EM_DASH = '—';
const ELLIPSIS = '…';

/**
 * Whether a line may be broken between `a` and `b`, two characters side by side that are not
 * white space. `before` is the character in front of `a`, if there is one.
 *
 * These are the rules Chromium wraps text by, as far as a title needs them: the field a title is
 * typed into lies over the title and is wrapped by the browser, and the two have to break alike.
 *
 * - Between two ASCII characters, all of the browser's rules: a line breaks after a hyphen and
 *   after a question mark unless what follows closes a phrase (`well-|known`, `watch?|v=1`, but
 *   `(-)` and `?!` stay whole), not between a minus sign and its number (`-5`, but `route-|66`),
 *   and before an opening bracket that follows punctuation (`a.|(b)`).
 * - With a character beyond ASCII on either side: after a hyphen, a dash, an ellipsis and a space
 *   of a set width; on both sides of an em dash; after `!`, `?`, `/` and `}`. Never before what
 *   clings to the character in front of it, nor after what opens, nor next to a no-break space.
 *
 * Everything else counts as a letter. That leaves out what a browser does for emoji, for scripts
 * written without spaces between the words, and for the signs of currencies and units.
 */
function breaksBetween(before: string, a: string, b: string): boolean {
  if (ASCII.test(a) && ASCII.test(b)) {
    if (a === '-') return /[0-9]/.test(b) ? /[0-9A-Za-z]/.test(before) : !'!$),./:;?]}'.includes(b);
    if (a === '?') return !'!"\'),./:;?]}'.includes(b);
    return '(<[{'.includes(b) && '!"#%&)*+,.:;=>\\]|}~'.includes(a);
  }
  if (MARK.test(b) || CLINGS.test(b) || BREAK_AFTER.test(b) || OPENS.test(a) || GLUE.test(a)) return false;
  // A hyphen or a dash lets go of anything else, a no-break space after it included.
  if (BREAK_AFTER.test(a)) return true;
  if (GLUE.test(b) || (a === EM_DASH && b === EM_DASH)) return false;
  return a === EM_DASH || b === EM_DASH || a === ELLIPSIS || '!?/}'.includes(a);
}

/**
 * A paragraph as the pieces its lines are made of: runs of white space, and between them the
 * stretches no line is broken inside.
 */
function pieces(para: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 1; i < para.length; i++) {
    const white = WHITE.test(para[i]);
    if (
      white !== WHITE.test(para[i - 1]) ||
      (!white && breaksBetween(para[i - 2] ?? '', para[i - 1], para[i]))
    ) {
      out.push(para.slice(from, i));
      from = i;
    }
  }
  out.push(para.slice(from));
  return out;
}

/**
 * The lines `text` is set in when a line may be no wider than `maxWidth`: broken where it says so,
 * and where it has to be, at the places a browser breaks preformatted text (see `breaksBetween`).
 *
 * - White space never takes a line of its own. Where a line is broken, the white space there
 *   belongs to neither line. At the end of a paragraph it stays, and may reach over the edge of
 *   the box (see `layoutText` for how wide such a line counts).
 * - A hyphen or a dash a line is broken after stays on that line.
 * - A piece wider than the box is broken between characters, never inside one.
 */
export function wrapLines(
  text: string,
  maxWidth: number | null,
  measure: (line: string) => number,
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxWidth || measure(para) <= maxWidth) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const piece of pieces(para)) {
      if (WHITE.test(piece[0])) {
        line += piece;
        continue;
      }
      if (line && measure(line + piece) > maxWidth) {
        out.push(withoutTrail(line));
        line = piece;
      } else line += piece;
      if (measure(line) <= maxWidth) continue;
      // A single piece wider than the box.
      const units = graphemes(line);
      line = '';
      for (const unit of units) {
        if (line && measure(line + unit) > maxWidth) {
          out.push(line);
          line = unit;
        } else line += unit;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * How the text of a title is set: everything about its drawing that is measured rather than
 * painted. The rasteriser draws by it, the layer is laid out by its size, and the editor lays the
 * element a title is typed into over the title by the same numbers.
 */
export interface TextLayout {
  /** The font as a canvas takes it, and its size in pixels. */
  font: string;
  size: number;
  /** Space added after each character, in pixels. */
  spacing: number;
  /** Height of a line, in pixels. */
  lineHeight: number;
  /** The lines as they are drawn (in capitals where the title asks for that), and how wide each is. */
  lines: string[];
  widths: number[];
  /** Where in the drawing the area lies that the lines are set in, and its size. */
  x: number;
  y: number;
  textWidth: number;
  textHeight: number;
  /** Size of the whole drawing: stroke, shadow and background need room around the lines. */
  width: number;
  height: number;
}

/**
 * Tell a context how to set type: by the font's own measures at every size. Left to itself a
 * canvas may fit the letters to the pixel grid, which gives a line another width at each size and
 * another one than the same line has in the page.
 */
function setType(ctx: Ctx2D, layout: Pick<TextLayout, 'font' | 'spacing'>): void {
  ctx.font = layout.font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${layout.spacing}px`;
  if ('textRendering' in ctx) ctx.textRendering = 'geometricPrecision';
}

/** Lay out the text of a title for a frame of the given size. Nothing is drawn. */
export function layoutText(t: TextProps, frameW: number, frameH: number): TextLayout {
  const px = Math.max(1, t.size * frameH);
  const font = fontSpec(t, px);
  const spacing = Number((t.letterSpacing * px).toFixed(2));
  const probe = makeCanvas(2, 2).getContext('2d') as Ctx2D;
  setType(probe, { font, spacing });
  const measure = (line: string): number => probe.measureText(line).width;

  const content = t.uppercase ? t.content.toUpperCase() : t.content;
  const maxWidth = t.boxWidth ? t.boxWidth * frameW : null;
  const lines = wrapLines(content, maxWidth, measure);
  // In a box, white space that ends a line counts as far as the box goes and no further: typing a
  // space at the edge neither widens the box nor moves a centred line by more than is left of it.
  const widths = lines.map((line) => {
    const width = measure(line);
    return maxWidth && width > maxWidth ? Math.max(maxWidth, measure(withoutTrail(line))) : width;
  });
  const textW = Math.max(1, maxWidth ?? 0, ...widths);
  const lineH = px * t.lineHeight;
  const textH = Math.max(lineH, lines.length * lineH);

  const strokePad = t.stroke.enabled ? t.stroke.width * px : 0;
  const shadowPad = t.shadow.enabled
    ? t.shadow.blur * px * 2 + Math.max(Math.abs(t.shadow.x), Math.abs(t.shadow.y)) * px
    : 0;
  const bgPadX = t.bg.enabled ? t.bg.padX * px : 0;
  const bgPadY = t.bg.enabled ? t.bg.padY * px : 0;
  const overhang = px * 0.25;
  const padX = Math.ceil(Math.max(strokePad + overhang, bgPadX) + shadowPad);
  const padY = Math.ceil(Math.max(strokePad + overhang, bgPadY) + shadowPad);

  return {
    font,
    size: px,
    spacing,
    lineHeight: lineH,
    lines,
    widths,
    x: padX,
    y: padY,
    textWidth: textW,
    textHeight: textH,
    width: Math.ceil(textW + padX * 2),
    height: Math.ceil(textH + padY * 2),
  };
}

export interface Raster {
  canvas: AnyCanvas;
  /** Size of the drawing in frame pixels. The canvas is smaller when that would not fit a texture. */
  width: number;
  height: number;
}

/**
 * Draw a text block. `chars` (0…1) reveals a prefix of the characters for typewriter animations
 * while keeping the layout of the full text, so nothing jumps as letters appear.
 */
export function rasterizeText(t: TextProps, frameW: number, frameH: number, chars = 1): Raster {
  const layout = layoutText(t, frameW, frameH);
  const { size: px, lines, widths, lineHeight: lineH, width: w, height: h } = layout;
  const { x: padX, y: padY, textWidth: textW, textHeight: textH } = layout;
  const bgPadX = t.bg.enabled ? t.bg.padX * px : 0;
  const bgPadY = t.bg.enabled ? t.bg.padY * px : 0;
  const k = fitScale(w, h);
  // Text layer without shadow; composited once so stroke + fill cast a single shadow.
  const layer = makeCanvas(w * k, h * k);
  const ctx = layer.getContext('2d') as Ctx2D;
  ctx.scale(layer.width / w, layer.height / h);

  if (t.bg.enabled) {
    ctx.fillStyle = hexA(t.bg.color, t.bg.opacity);
    const bx = padX - bgPadX;
    const by = padY - bgPadY;
    const bw = textW + bgPadX * 2;
    const bh = textH + bgPadY * 2;
    const r = Math.min(t.bg.radius * px, bw / 2, bh / 2);
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, r);
    ctx.fill();
  }

  setType(ctx, layout);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const total = lines.reduce((n, l) => n + graphemes(l).length, 0);
  let budget = chars >= 1 ? Infinity : Math.floor(Math.max(0, chars) * total + 1e-6);

  const fill = t.gradient.enabled ? gradientFor(ctx, padX, padY, textW, textH, t.gradient) : t.color;
  lines.forEach((line, i) => {
    if (budget <= 0) return;
    let visible = line;
    if (budget !== Infinity) {
      const g = graphemes(line);
      visible = g.slice(0, budget).join('');
      budget -= g.length;
    }
    const lw = widths[i];
    const x = padX + (t.align === 'center' ? (textW - lw) / 2 : t.align === 'right' ? textW - lw : 0);
    const y = padY + i * lineH + lineH / 2;
    if (t.stroke.enabled && t.stroke.width > 0) {
      ctx.strokeStyle = t.stroke.color;
      ctx.lineWidth = t.stroke.width * px * 2;
      ctx.strokeText(visible, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(visible, x, y);
  });

  if (!t.shadow.enabled) return { canvas: layer, width: w, height: h };

  const out = makeCanvas(layer.width, layer.height);
  const octx = out.getContext('2d') as Ctx2D;
  octx.shadowColor = hexA(t.shadow.color, t.shadow.opacity);
  octx.shadowBlur = t.shadow.blur * px * k;
  octx.shadowOffsetX = t.shadow.x * px * k;
  octx.shadowOffsetY = t.shadow.y * px * k;
  // A shadow is rendered through an off-screen layer the size of the area being painted. For a
  // canvas near the size limit that layer does not fit a texture and nothing is drawn at all, so
  // the copy is made a tile at a time.
  for (let y = 0; y < out.height; y += SHADOW_TILE) {
    for (let x = 0; x < out.width; x += SHADOW_TILE) {
      octx.save();
      octx.beginPath();
      octx.rect(x, y, SHADOW_TILE, SHADOW_TILE);
      octx.clip();
      octx.drawImage(layer, 0, 0);
      octx.restore();
    }
  }
  return { canvas: out, width: w, height: h };
}

function shapePath(ctx: Ctx2D, s: ShapeProps, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.beginPath();
  switch (s.kind) {
    case 'ellipse':
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(cx, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      break;
    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.round(s.sides));
      const steps = s.kind === 'star' ? n * 2 : n;
      for (let i = 0; i < steps; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
        const r = s.kind === 'star' && i % 2 === 1 ? 0.45 : 1;
        const px = cx + (Math.cos(a) * w * r) / 2;
        const py = cy + (Math.sin(a) * h * r) / 2;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'line':
      ctx.moveTo(x, cy);
      ctx.lineTo(x + w, cy);
      break;
    case 'arrow': {
      const head = Math.min(w * 0.35, h * 0.9);
      ctx.moveTo(x, cy);
      ctx.lineTo(x + w - head * 0.5, cy);
      ctx.moveTo(x + w - head, y + h * 0.1);
      ctx.lineTo(x + w, cy);
      ctx.lineTo(x + w - head, y + h * 0.9);
      break;
    }
    default: {
      const r = Math.min(s.radius * Math.min(w, h) * 0.5, w / 2, h / 2);
      ctx.roundRect(x, y, w, h, r);
    }
  }
}

export function rasterizeShape(s: ShapeProps, frameW: number, frameH: number): Raster {
  const w = Math.max(2, s.w * frameW);
  const h = Math.max(2, s.h * frameH);
  const open = s.kind === 'line' || s.kind === 'arrow';
  const sw = (open ? Math.max(s.strokeWidth, 0.004) : s.strokeWidth) * frameH;
  const pad = Math.ceil(sw / 2 + 2);
  const fullW = Math.ceil(w + pad * 2);
  const fullH = Math.ceil(h + pad * 2);
  const k = fitScale(fullW, fullH);
  const canvas = makeCanvas(fullW * k, fullH * k);
  const ctx = canvas.getContext('2d') as Ctx2D;
  ctx.scale(canvas.width / fullW, canvas.height / fullH);
  shapePath(ctx, s, pad, pad, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!open && s.fillEnabled) {
    ctx.fillStyle = s.gradient.enabled ? gradientFor(ctx, pad, pad, w, h, s.gradient) : s.fill;
    ctx.fill();
  }
  if (sw > 0) {
    ctx.strokeStyle = open && s.strokeWidth <= 0 ? s.fill : s.stroke;
    ctx.lineWidth = sw;
    ctx.stroke();
  }
  return { canvas, width: fullW, height: fullH };
}

export function rasterizeSolid(s: ShapeProps | null): Raster {
  const size = s?.gradient.enabled ? 256 : 4;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d') as Ctx2D;
  ctx.fillStyle = s ? (s.gradient.enabled ? gradientFor(ctx, 0, 0, size, size, s.gradient) : s.fill) : '#000';
  ctx.fillRect(0, 0, size, size);
  return { canvas, width: size, height: size };
}

/**
 * What a title or a shape looks like, written out. A project snapshot never changes an object it
 * holds (an edit puts a new one in its place), so each is written out once and not again on every
 * frame it is drawn in.
 */
const written = new WeakMap<TextProps | ShapeProps, string>();

function describe(props: TextProps | ShapeProps): string {
  let json = written.get(props);
  if (json === undefined) {
    // How a title comes and goes changes where its pixels are put, not the pixels.
    json = JSON.stringify(props, (k, v) => (k === 'animIn' || k === 'animOut' ? undefined : v));
    written.set(props, json);
  }
  return json;
}

/** Cache key covering everything that affects a generator's pixels. */
export function generatorKey(
  clip: Clip,
  frameW: number,
  frameH: number,
  chars: number,
  fontEpoch: number,
): string {
  if (clip.type === 'text' && clip.text) {
    const c = chars >= 1 ? 1 : Math.round(chars * 1000);
    return `t|${frameW}x${frameH}|${c}|${fontEpoch}|${describe(clip.text)}`;
  }
  if (clip.type === 'shape' && clip.shape) return `s|${frameW}x${frameH}|${describe(clip.shape)}`;
  if (clip.type === 'solid')
    return `c|${clip.shape?.gradient.enabled ? describe(clip.shape) : clip.shape?.fill}`;
  return '';
}

export function rasterizeGenerator(clip: Clip, frameW: number, frameH: number, chars: number): Raster | null {
  if (clip.type === 'text' && clip.text) return rasterizeText(clip.text, frameW, frameH, chars);
  if (clip.type === 'shape' && clip.shape) return rasterizeShape(clip.shape, frameW, frameH);
  if (clip.type === 'solid') return rasterizeSolid(clip.shape);
  return null;
}
