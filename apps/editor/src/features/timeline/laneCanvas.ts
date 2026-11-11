/** Canvas painting for a track lane: filmstrips for picture clips, waveforms for sound. */
import { CLIP_TYPE_COLORS, dbToGain, hexToRgb, sourcePerFrame, type Clip, type Project } from '@tandem/core';
import { LABEL_H } from './layout';
import { FilmstripCache, type TimelineMedia } from './mediaCache';

export interface LaneView {
  scrollX: number;
  ppf: number;
  width: number;
  height: number;
  dpr: number;
}

const RADIUS = 5;

function tint(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

export function drawLane(ctx: CanvasRenderingContext2D, project: Project, clips: readonly Clip[], view: LaneView, media: TimelineMedia): void {
  const { scrollX, ppf, width, height, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const fps = project.settings.fpsNum / project.settings.fpsDen;
  const compact = height < 40;
  const top = compact ? 0 : LABEL_H;
  const bodyH = height - top;

  for (const clip of clips) {
    if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'audio') continue;
    const x0 = clip.start * ppf - scrollX;
    const w = clip.duration * ppf;
    if (x0 + w < 0 || x0 > width) continue;
    const color = clip.label ?? CLIP_TYPE_COLORS[clip.type];
    const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
    const visL = Math.max(0, x0);
    const visR = Math.min(width, x0 + w);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0, 0, Math.max(1, w - 1), height, Math.min(RADIUS, w / 2));
    ctx.clip();
    ctx.globalAlpha = clip.enabled ? 1 : 0.35;
    ctx.fillStyle = tint(color, clip.type === 'audio' ? 0.3 : 0.22);
    ctx.fillRect(visL, 0, visR - visL, height);

    if (clip.type === 'audio') {
      drawWaveform(ctx, project, clip, asset?.duration ?? 0, { x0, visL, visR, top, bodyH, fps, ppf }, media, color);
    } else if (asset && bodyH > 8) {
      const aspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;
      const th = bodyH;
      const tw = Math.max(20, th * aspect);
      const first = Math.max(0, Math.floor((visL - x0) / tw));
      const last = Math.floor((visR - x0) / tw);
      const per = sourcePerFrame(clip, project);
      const step = FilmstripCache.stepFor(((tw / ppf) * per) / 1);
      const poster = clip.assetId ? media.poster(clip.assetId, asset.thumb) : null;
      for (let i = first; i <= last; i++) {
        const tx = x0 + i * tw;
        let img: CanvasImageSource | null = null;
        if (clip.type === 'video' && clip.assetId) {
          const local = (i * tw) / ppf;
          const t = clip.reverse ? clip.sourceIn + (clip.duration - local) * per : clip.sourceIn + local * per;
          img = media.film.get(clip.assetId, Math.max(0, Math.min(t, Math.max(0, asset.duration - 0.05))), step);
        }
        img ??= poster;
        if (img) ctx.drawImage(img, tx, top, tw, th);
      }
      // A soft shade so the label strip and trim handles stay readable over bright footage.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.fillRect(visL, top, visR - visL, th);
    }
    ctx.restore();
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  project: Project,
  clip: Clip,
  assetDuration: number,
  g: { x0: number; visL: number; visR: number; top: number; bodyH: number; fps: number; ppf: number },
  media: TimelineMedia,
  color: string,
): void {
  if (!clip.assetId || g.bodyH < 6) return;
  const wave = media.wave.get(clip.assetId, assetDuration);
  if (!wave) return;
  const per = sourcePerFrame(clip, project); // source seconds per frame
  const mid = g.top + g.bodyH / 2;
  const amp = (g.bodyH / 2 - 1) * Math.min(2, dbToGain(clip.volume));
  const secPerPx = per / g.ppf;
  const srcEnd = clip.sourceIn + clip.duration * per;
  const peaks = wave.peaks;
  const pps = wave.perSecond;
  const xs: number[] = [];
  const ys: number[] = [];
  const startX = Math.floor(g.visL);
  const endX = Math.ceil(g.visR);
  for (let x = startX; x <= endX; x++) {
    const local = (x - g.x0) * secPerPx;
    const t = clip.reverse ? srcEnd - local - secPerPx : clip.sourceIn + local;
    const a = Math.max(0, Math.floor(t * pps));
    const b = Math.min(peaks.length - 1, Math.max(a, Math.floor((t + secPerPx) * pps)));
    let p = 0;
    for (let i = a; i <= b; i++) if (peaks[i] > p) p = peaks[i];
    xs.push(x);
    ys.push(Math.max(0.5, Math.min(1, p) * amp));
  }
  ctx.beginPath();
  ctx.moveTo(xs[0], mid - ys[0]);
  for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], mid - ys[i]);
  for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], mid + ys[i]);
  ctx.closePath();
  ctx.fillStyle = tint(color, 0.95);
  ctx.fill();

  // Fades: shade the attenuated region.
  ctx.fillStyle = 'rgba(8, 8, 10, 0.55)';
  if (clip.fadeIn > 0) {
    const fw = clip.fadeIn * g.ppf;
    ctx.beginPath();
    ctx.moveTo(g.x0, g.top);
    ctx.lineTo(g.x0 + fw, g.top);
    ctx.quadraticCurveTo(g.x0 + fw * 0.3, g.top + g.bodyH * 0.3, g.x0, g.top + g.bodyH);
    ctx.closePath();
    ctx.fill();
  }
  if (clip.fadeOut > 0) {
    const end = g.x0 + clip.duration * g.ppf;
    const fw = clip.fadeOut * g.ppf;
    ctx.beginPath();
    ctx.moveTo(end, g.top);
    ctx.lineTo(end - fw, g.top);
    ctx.quadraticCurveTo(end - fw * 0.3, g.top + g.bodyH * 0.3, end, g.top + g.bodyH);
    ctx.closePath();
    ctx.fill();
  }
  if (!wave.done) {
    // Still analysing: hatch the part we have not reached yet.
    const loadedX = g.x0 + ((wave.loaded - clip.sourceIn) / per) * g.ppf;
    if (loadedX < g.visR) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(Math.max(g.visL, loadedX), g.top, g.visR - Math.max(g.visL, loadedX), g.bodyH);
    }
  }
}
