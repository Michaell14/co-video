import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, Command, Delete } from 'lucide-react';
import type { ReactNode } from 'react';
import type { NamedKey } from '../lib/shortcuts';
import './Keycap.css';

/** Decided as the editor decides it (apps/editor/src/ui/core.tsx), so both show the same keys. */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type Legend = { icon: ReactNode; name: string } | { word: string; wide?: boolean };

/**
 * What stands on each named key. Modifiers follow the visitor's keyboard the way the editor's
 * shortcut sheet does: symbols on a Mac, words everywhere else. Symbols are drawn as icons, so
 * they look the same whatever fonts the visitor has.
 */
const LEGENDS: Record<NamedKey, Legend> = {
  mod: isMac ? { icon: <Command size="0.85em" strokeWidth={2.2} />, name: 'Command' } : { word: 'Ctrl' },
  shift: isMac ? { icon: <ArrowBigUp size="1em" strokeWidth={2} />, name: 'Shift' } : { word: 'Shift' },
  delete: isMac ? { icon: <Delete size="1em" strokeWidth={2} />, name: 'Delete' } : { word: 'Del' },
  space: { word: 'space', wide: true },
  arrowleft: { icon: <ArrowLeft size="0.9em" strokeWidth={2.4} />, name: 'Left arrow' },
  arrowright: { icon: <ArrowRight size="0.9em" strokeWidth={2.4} />, name: 'Right arrow' },
  arrowdown: { icon: <ArrowDown size="0.9em" strokeWidth={2.4} />, name: 'Down arrow' },
};

const isNamed = (k: string): k is NamedKey => Object.hasOwn(LEGENDS, k);

interface KeycapProps {
  /** A key as the editor's shortcuts name it: a character such as `j`, or a `NamedKey`. */
  k: string;
}

export function Keycap({ k }: KeycapProps) {
  if (!isNamed(k)) return <kbd className="keycap">{k.toUpperCase()}</kbd>;
  const legend = LEGENDS[k];
  if ('word' in legend) {
    return (
      <kbd className={legend.wide ? 'keycap keycap--word keycap--wide' : 'keycap keycap--word'}>
        {legend.word}
      </kbd>
    );
  }
  return (
    <kbd className="keycap">
      {legend.icon}
      <span className="sr-only">{legend.name}</span>
    </kbd>
  );
}
