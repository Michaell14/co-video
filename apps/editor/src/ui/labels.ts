/**
 * How a project's format is worded. The same options are offered when a project is made and in
 * its settings, and shown on cards and in the top bar: one wording for all of them.
 */
import type { ColorMode } from '@tandem/core';

/** A frame size, written as `describeSettings` in @tandem/core writes it: `1920×1080`. */
export function describeSize(width: number, height: number): string {
  return `${width}×${height}`;
}

/** A named frame size in a list of them: `Full HD 1080p · 1920×1080`. */
export function describeResolution(named: { label: string; width: number; height: number }): string {
  return `${named.label} · ${describeSize(named.width, named.height)}`;
}

/** The colour modes a project can work in, as the options of a select. */
export const COLOR_MODE_OPTIONS: { value: ColorMode; label: string }[] = [
  { value: 'sdr', label: 'SDR · Rec.709' },
  { value: 'hdr-pq', label: 'HDR · Rec.2100 PQ' },
  { value: 'hdr-hlg', label: 'HDR · Rec.2100 HLG' },
];
