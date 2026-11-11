import { useMemo } from 'react';
import { clamp, seeded } from '../lib/math';

interface WaveformProps {
  /** Any integer; the same seed always draws the same waveform. */
  seed: number;
  /** Number of sample bars. Each bar is 3 viewBox units wide. */
  bars: number;
  className?: string;
}

function wavePath(seed: number, bars: number): string {
  const rnd = seeded(seed);
  let envelope = 0.5;
  let d = '';
  for (let i = 0; i < bars; i++) {
    envelope = clamp(envelope + (rnd() - 0.5) * 0.34, 0.1, 1);
    const half = Math.max(0.05, envelope * (0.3 + rnd() * 0.7)) * 46;
    d += `M${i * 3 + 1.5} ${(50 - half).toFixed(1)}V${(50 + half).toFixed(1)}`;
  }
  return d;
}

/** A generated, mirrored audio waveform. Stretches to fill its box; stroke colour is `currentColor`. */
export function Waveform({ seed, bars, className }: WaveformProps) {
  const d = useMemo(() => wavePath(seed, bars), [seed, bars]);
  return (
    <svg
      className={className}
      viewBox={`0 0 ${bars * 3} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
