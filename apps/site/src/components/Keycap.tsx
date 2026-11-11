import { ArrowBigUp, ArrowLeft, ArrowRight, Command, Delete } from 'lucide-react';
import type { ReactNode } from 'react';
import './Keycap.css';

/** Named keys are drawn as icons, so they look the same whatever fonts the visitor has. */
const GLYPHS: Record<string, { icon: ReactNode; name: string }> = {
  cmd: { icon: <Command size="0.85em" strokeWidth={2.2} />, name: 'Command' },
  shift: { icon: <ArrowBigUp size="1em" strokeWidth={2} />, name: 'Shift' },
  delete: { icon: <Delete size="1em" strokeWidth={2} />, name: 'Delete' },
  left: { icon: <ArrowLeft size="0.9em" strokeWidth={2.4} />, name: 'Left arrow' },
  right: { icon: <ArrowRight size="0.9em" strokeWidth={2.4} />, name: 'Right arrow' },
};

interface KeycapProps {
  /** A literal key such as "J", or one of: cmd, shift, delete, left, right, space. */
  k: string;
}

export function Keycap({ k }: KeycapProps) {
  const glyph = GLYPHS[k];
  if (glyph) {
    return (
      <kbd className="keycap" aria-label={glyph.name}>
        {glyph.icon}
      </kbd>
    );
  }
  if (k === 'space') return <kbd className="keycap keycap--wide">space</kbd>;
  return <kbd className="keycap">{k}</kbd>;
}
