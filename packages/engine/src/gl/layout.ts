/**
 * Layer layout: where a clip's picture lands in the frame. Shared by the compositor (to draw) and
 * by the editor's on-canvas transform handles (to hit-test and drag), so the two can never disagree.
 */
import type { Clip, ClipLayer, Project } from '@tandem/core';
import { generatorKey, rasterizeGenerator } from '../generators';

export interface LayerBox {
  /** Un-scaled layout box in frame pixels. */
  boxW: number;
  boxH: number;
  /** Effective scale including animation presets. */
  sx: number;
  sy: number;
  /** Pivot position in frame pixels. */
  px: number;
  py: number;
  /** Radians, clockwise. */
  rotation: number;
  anchorX: number;
  anchorY: number;
}

const DEG = Math.PI / 180;

/**
 * @param srcW / srcH  upright source size in its own pixels
 * @param W / H        frame size being laid out into
 * @param nativeScale  frame pixels per sequence pixel (render height ÷ project height)
 */
export function layoutLayer(L: ClipLayer, srcW: number, srcH: number, W: number, H: number, nativeScale: number): LayerBox {
  const clip = L.clip;
  const media = clip.type === 'video' || clip.type === 'image';
  let boxW: number;
  let boxH: number;
  switch (media ? clip.fit : clip.type === 'solid' || clip.type === 'adjustment' ? 'stretch' : 'none') {
    case 'cover': {
      const k = Math.max(W / srcW, H / srcH);
      boxW = srcW * k;
      boxH = srcH * k;
      break;
    }
    case 'stretch':
      boxW = W;
      boxH = H;
      break;
    case 'none':
      // Generators are rasterised for this frame size already; media maps 1:1 to sequence pixels.
      boxW = media ? srcW * nativeScale : srcW;
      boxH = media ? srcH * nativeScale : srcH;
      break;
    default: {
      const k = Math.min(W / srcW, H / srcH);
      boxW = srcW * k;
      boxH = srcH * k;
    }
  }
  return {
    boxW,
    boxH,
    sx: L.v.scaleX * L.anim.scale,
    sy: L.v.scaleY * L.anim.scale,
    px: W / 2 + (L.v.x + L.anim.dx) * W + (clip.anchorX - 0.5) * boxW,
    py: H / 2 + (L.v.y + L.anim.dy) * H + (clip.anchorY - 0.5) * boxH,
    rotation: (L.v.rotation + L.anim.rotation) * DEG,
    anchorX: clip.anchorX,
    anchorY: clip.anchorY,
  };
}

/** Column-major mat3 mapping the unit quad to clip space for a layout box. */
export function layerMatrix(b: LayerBox, W: number, H: number): Float32Array {
  const a = b.boxW * b.sx;
  const d = b.boxH * b.sy;
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  const m00 = (2 / W) * c * a;
  const m01 = (2 / W) * -s * d;
  const m02 = (2 / W) * (b.px - c * a * b.anchorX + s * d * b.anchorY) - 1;
  const m10 = (2 / H) * s * a;
  const m11 = (2 / H) * c * d;
  const m12 = (2 / H) * (b.py - s * a * b.anchorX - c * d * b.anchorY) - 1;
  return new Float32Array([m00, m10, 0, m01, m11, 0, m02, m12, 1]);
}

/** Map a point in layer space (0…1) to frame pixels. */
export function layerPoint(b: LayerBox, u: number, v: number): [number, number] {
  const x = (u - b.anchorX) * b.boxW * b.sx;
  const y = (v - b.anchorY) * b.boxH * b.sy;
  const c = Math.cos(b.rotation);
  const s = Math.sin(b.rotation);
  return [b.px + c * x - s * y, b.py + s * x + c * y];
}

/** Corners (TL, TR, BR, BL) of a layout box in frame pixels. */
export function layerCorners(b: LayerBox): [number, number][] {
  return [layerPoint(b, 0, 0), layerPoint(b, 1, 0), layerPoint(b, 1, 1), layerPoint(b, 0, 1)];
}

const measureCache = new Map<string, { w: number; h: number }>();

/** Natural size of a clip's picture in sequence pixels (for the editor's transform handles). */
export function measureClip(clip: Clip, project: Project): { w: number; h: number } | null {
  const { width, height } = project.settings;
  if (clip.type === 'video' || clip.type === 'image') {
    const a = clip.assetId ? project.assets[clip.assetId] : undefined;
    return a && a.width > 0 && a.height > 0 ? { w: a.width, h: a.height } : { w: width, h: height };
  }
  if (clip.type === 'solid' || clip.type === 'adjustment') return { w: width, h: height };
  if (clip.type === 'audio') return null;
  const key = generatorKey(clip, width, height, 1, 0);
  let m = measureCache.get(key);
  if (!m) {
    const r = rasterizeGenerator(clip, width, height, 1);
    if (!r) return null;
    m = { w: r.width, h: r.height };
    if (measureCache.size > 200) measureCache.clear();
    measureCache.set(key, m);
  }
  return m;
}
