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

export function fontSpec(t: TextProps, px: number): string {
  return `${t.italic ? 'italic ' : ''}${t.weight} ${px}px "${t.font}", "Inter Variable", Inter, system-ui, sans-serif`;
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

function wrapLines(ctx: Ctx2D, text: string, maxWidth: number | null): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxWidth || ctx.measureText(para).width <= maxWidth) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const candidate = line + word;
      if (line && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = candidate;
      // A single word wider than the box: break it by character.
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
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
  const px = Math.max(1, t.size * frameH);
  const probe = makeCanvas(2, 2).getContext('2d') as Ctx2D;
  const font = fontSpec(t, px);
  probe.font = font;
  const spacing = `${(t.letterSpacing * px).toFixed(2)}px`;
  if ('letterSpacing' in probe) (probe as unknown as { letterSpacing: string }).letterSpacing = spacing;

  const content = t.uppercase ? t.content.toUpperCase() : t.content;
  const maxWidth = t.boxWidth ? t.boxWidth * frameW : null;
  const lines = wrapLines(probe, content, maxWidth);
  const widths = lines.map((l) => probe.measureText(l).width);
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

  const w = Math.ceil(textW + padX * 2);
  const h = Math.ceil(textH + padY * 2);
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

  ctx.font = font;
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = spacing;
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
    return `t|${frameW}x${frameH}|${c}|${fontEpoch}|${JSON.stringify(clip.text, (k, v) => (k === 'animIn' || k === 'animOut' ? undefined : v))}`;
  }
  if (clip.type === 'shape' && clip.shape) return `s|${frameW}x${frameH}|${JSON.stringify(clip.shape)}`;
  if (clip.type === 'solid')
    return `c|${JSON.stringify(clip.shape?.gradient.enabled ? clip.shape : clip.shape?.fill)}`;
  return '';
}

export function rasterizeGenerator(clip: Clip, frameW: number, frameH: number, chars: number): Raster | null {
  if (clip.type === 'text' && clip.text) return rasterizeText(clip.text, frameW, frameH, chars);
  if (clip.type === 'shape' && clip.shape) return rasterizeShape(clip.shape, frameW, frameH);
  if (clip.type === 'solid') return rasterizeSolid(clip.shape);
  return null;
}
