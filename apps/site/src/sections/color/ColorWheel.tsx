import { RotateCcw } from 'lucide-react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Point } from '../../lib/math';

interface ColorWheelProps {
  label: string;
  hint: string;
  value: Point;
  onChange: (value: Point) => void;
}

const STEP = 0.05;
const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

/** Describe a puck position for assistive tech, e.g. "32% toward cyan". */
function describe(p: Point): string {
  const amount = Math.round(Math.min(1, Math.hypot(p.x, p.y)) * 100);
  if (amount === 0) return 'Neutral';
  const turn = (Math.atan2(p.x, -p.y) / (Math.PI * 2) + 1) % 1;
  return `${amount}% toward ${HUES[Math.round(turn * 6) % 6]}`;
}

const limit = (p: Point): Point => {
  const m = Math.hypot(p.x, p.y);
  return m > 1 ? { x: p.x / m, y: p.y / m } : p;
};

/** A draggable lift/gamma/gain wheel. Arrow keys nudge it; double-click or the button resets. */
export function ColorWheel({ label, hint, value, onChange }: ColorWheelProps) {
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const radius = r.width / 2;
    onChange(
      limit({
        x: (e.clientX - (r.left + radius)) / (radius * 0.84),
        y: (e.clientY - (r.top + radius)) / (radius * 0.84),
      }),
    );
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    fromPointer(e);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, Point> = {
      ArrowLeft: { x: -STEP, y: 0 },
      ArrowRight: { x: STEP, y: 0 },
      ArrowUp: { x: 0, y: -STEP },
      ArrowDown: { x: 0, y: STEP },
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      onChange(limit({ x: value.x + move.x, y: value.y + move.y }));
    } else if (e.key === 'Home' || e.key === 'Escape') {
      onChange({ x: 0, y: 0 });
    }
  };

  const neutral = value.x === 0 && value.y === 0;

  return (
    <div className="cw">
      <div
        className="cw__pad"
        role="slider"
        tabIndex={0}
        aria-label={`${label} colour balance. Arrow keys to adjust, Home to reset.`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, Math.hypot(value.x, value.y)) * 100)}
        aria-valuetext={describe(value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={() => onChange({ x: 0, y: 0 })}
        onKeyDown={onKeyDown}
      >
        <span className="cw__puck" style={{ left: `${50 + value.x * 42}%`, top: `${50 + value.y * 42}%` }} />
      </div>
      <div className="cw__meta">
        <span className="cw__label">{label}</span>
        <span className="cw__hint">{hint}</span>
        <button
          type="button"
          className="cw__reset"
          onClick={() => onChange({ x: 0, y: 0 })}
          disabled={neutral}
          aria-label={`Reset ${label}`}
        >
          <RotateCcw size="0.8rem" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
