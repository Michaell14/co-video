import { scaleKeyframes } from './keyframes';
import type { Clip, ProjectSettings } from './types';

export interface Fps {
  fpsNum: number;
  fpsDen: number;
}

export const fpsOf = (s: Fps): number => s.fpsNum / s.fpsDen;

export const framesToSeconds = (frames: number, s: Fps): number => (frames * s.fpsDen) / s.fpsNum;

export const secondsToFrames = (seconds: number, s: Fps): number => (seconds * s.fpsNum) / s.fpsDen;

/** Nearest whole frame for a time in seconds. */
export const secondsToFrame = (seconds: number, s: Fps): number =>
  Math.round(secondsToFrames(seconds, s) + 1e-9);

/** The frame that is on screen at `seconds`. */
export const frameAtSeconds = (seconds: number, s: Fps): number =>
  Math.floor(secondsToFrames(seconds, s) + 1e-6);

export const isDropFrame = (s: Fps): boolean => {
  const fps = fpsOf(s);
  return s.fpsDen === 1001 && (Math.round(fps) === 30 || Math.round(fps) === 60);
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** SMPTE timecode. Uses drop-frame (`;` separator) for 29.97 / 59.94. */
export function formatTimecode(frame: number, s: Fps): string {
  const neg = frame < 0;
  let f = Math.abs(Math.round(frame));
  const base = Math.round(fpsOf(s));
  const drop = isDropFrame(s);
  if (drop) {
    const dropFrames = base === 60 ? 4 : 2;
    const framesPer10Min = base * 600 - dropFrames * 9;
    const framesPerMin = base * 60 - dropFrames;
    const d = Math.floor(f / framesPer10Min);
    const m = f % framesPer10Min;
    f += dropFrames * 9 * d + (m > dropFrames ? dropFrames * Math.floor((m - dropFrames) / framesPerMin) : 0);
  }
  const ff = f % base;
  const totalSeconds = Math.floor(f / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const fw = base > 100 ? 3 : 2;
  return `${neg ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}${drop ? ';' : ':'}${pad(ff, fw)}`;
}

/**
 * Parses loosely formatted timecode. Accepts `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF`, a bare frame count
 * (`+12`, `-12` are relative and returned via `relative`), or seconds with an `s` suffix (`12.5s`).
 */
export function parseTimecode(input: string, s: Fps): { frame: number; relative: boolean } | null {
  const raw = input.trim();
  if (!raw) return null;
  const relative = raw.startsWith('+') || raw.startsWith('-');
  const sign = raw.startsWith('-') ? -1 : 1;
  const body = raw.replace(/^[+-]/, '');
  if (/^\d+(\.\d+)?s$/i.test(body)) {
    return { frame: sign * secondsToFrame(parseFloat(body), s), relative };
  }
  const parts = body.split(/[:;.]/).map((p) => p.trim());
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => parseInt(p, 10));
  const base = Math.round(fpsOf(s));
  while (nums.length < 4) nums.unshift(0);
  const [hh, mm, ss, ff] = nums.slice(-4);
  let frame = ((hh * 60 + mm) * 60 + ss) * base + ff;
  if (isDropFrame(s)) {
    const dropFrames = base === 60 ? 4 : 2;
    const totalMinutes = hh * 60 + mm;
    frame -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return { frame: sign * frame, relative };
}

/** `1:23.4` style clock used in compact UI. */
export function formatClock(seconds: number, showTenths = false): string {
  const sAbs = Math.max(0, seconds);
  const h = Math.floor(sAbs / 3600);
  const m = Math.floor(sAbs / 60) % 60;
  const sec = Math.floor(sAbs % 60);
  const t = Math.floor((sAbs % 1) * 10);
  const tail = showTenths ? `.${t}` : '';
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}${tail}` : `${m}:${pad(sec)}${tail}`;
}

/** Whether `k`, one frame rate over another, says they are the same rate (30000/1000 and 30/1). */
export const sameRate = (k: number): boolean => Math.abs(k - 1) < 1e-9;

/**
 * Everything a clip counts in frames, at a frame rate `k` times the present one, so that the clip
 * keeps its place and its length in real time. The two ends are rounded each on their own: clips
 * that touch still touch afterwards.
 */
export function clipAtRate(c: Clip, k: number): Partial<Clip> {
  const r = (v: number) => Math.round(v * k);
  const start = r(c.start);
  const end = Math.max(start + 1, r(c.start + c.duration));
  return {
    start,
    duration: end - start,
    fadeIn: r(c.fadeIn),
    fadeOut: r(c.fadeOut),
    keyframes: scaleKeyframes(c.keyframes, k),
    transIn: c.transIn ? { ...c.transIn, duration: Math.max(1, r(c.transIn.duration)) } : null,
    transOut: c.transOut ? { ...c.transOut, duration: Math.max(1, r(c.transOut.duration)) } : null,
    text: c.text
      ? {
          ...c.text,
          animIn: { ...c.text.animIn, duration: r(c.text.animIn.duration) },
          animOut: { ...c.text.animOut, duration: r(c.text.animOut.duration) },
        }
      : null,
  };
}

export const FRAME_RATE_PRESETS: { label: string; fpsNum: number; fpsDen: number }[] = [
  { label: '23.976', fpsNum: 24000, fpsDen: 1001 },
  { label: '24', fpsNum: 24, fpsDen: 1 },
  { label: '25', fpsNum: 25, fpsDen: 1 },
  { label: '29.97', fpsNum: 30000, fpsDen: 1001 },
  { label: '30', fpsNum: 30, fpsDen: 1 },
  { label: '48', fpsNum: 48, fpsDen: 1 },
  { label: '50', fpsNum: 50, fpsDen: 1 },
  { label: '59.94', fpsNum: 60000, fpsDen: 1001 },
  { label: '60', fpsNum: 60, fpsDen: 1 },
  { label: '90', fpsNum: 90, fpsDen: 1 },
  { label: '100', fpsNum: 100, fpsDen: 1 },
  { label: '120', fpsNum: 120, fpsDen: 1 },
  { label: '144', fpsNum: 144, fpsDen: 1 },
  { label: '240', fpsNum: 240, fpsDen: 1 },
];

export const RESOLUTION_PRESETS: { label: string; group: string; width: number; height: number }[] = [
  { label: 'HD 720p', group: 'Landscape 16:9', width: 1280, height: 720 },
  { label: 'Full HD 1080p', group: 'Landscape 16:9', width: 1920, height: 1080 },
  { label: 'QHD 1440p', group: 'Landscape 16:9', width: 2560, height: 1440 },
  { label: '4K UHD', group: 'Landscape 16:9', width: 3840, height: 2160 },
  { label: '5K', group: 'Landscape 16:9', width: 5120, height: 2880 },
  { label: '8K UHD', group: 'Landscape 16:9', width: 7680, height: 4320 },
  { label: 'DCI 2K', group: 'Cinema', width: 2048, height: 1080 },
  { label: 'DCI 4K', group: 'Cinema', width: 4096, height: 2160 },
  { label: 'Scope 2.39:1 4K', group: 'Cinema', width: 4096, height: 1716 },
  { label: 'Vertical 1080 × 1920', group: 'Social', width: 1080, height: 1920 },
  { label: 'Vertical 4K', group: 'Social', width: 2160, height: 3840 },
  { label: 'Square 1080', group: 'Social', width: 1080, height: 1080 },
  { label: 'Portrait 4:5', group: 'Social', width: 1080, height: 1350 },
  { label: 'Ultrawide 21:9', group: 'Other', width: 2560, height: 1080 },
  { label: 'Classic 4:3', group: 'Other', width: 1440, height: 1080 },
];

export function describeFps(s: Fps): string {
  const fps = fpsOf(s);
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, '');
}

export function describeSettings(s: ProjectSettings): string {
  return `${s.width}×${s.height} · ${describeFps(s)} fps`;
}
