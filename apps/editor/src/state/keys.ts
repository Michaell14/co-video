/** Turning keyboard events into the canonical shortcut strings the command catalogue is keyed by. */

const KEY_NAMES: Record<string, string> = {
  ' ': 'space',
  '=': 'equal',
  '+': 'equal',
  '-': 'minus',
  _: 'minus',
  ',': 'comma',
  '<': 'comma',
  '.': 'period',
  '>': 'period',
  '/': 'slash',
  '?': 'slash',
  '\\': 'backslash',
  "'": 'quote',
  '"': 'quote',
  '!': '1',
  '@': '2',
  '#': '3',
};

/** Punctuation keys by position, for layouts that print something else on them. */
const CODE_NAMES: Record<string, string> = {
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Backslash: 'backslash',
  Quote: 'quote',
  Minus: 'minus',
  Equal: 'equal',
};

/** What the key at this position is on a US keyboard, for the keys shortcuts are bound to. */
function physicalKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return CODE_NAMES[code] ?? null;
}

/** The slice of a keyboard event that decides which shortcut it is. */
export type KeyStroke = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** Canonical string for a keyboard event, e.g. `mod+shift+z`. */
export function eventKeys(e: KeyStroke): string {
  let key = KEY_NAMES[e.key] ?? e.key.toLowerCase();
  // Shifted digits arrive as symbols on most layouts; fall back to the physical key.
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  // A Cyrillic, Greek, Hebrew or Arabic layout types its own letters, and Option on macOS turns
  // letters into symbols (⌥X is "≈"). Neither is what the shortcut table means, so such a key
  // counts as the one in its place on a US keyboard. A Latin letter is taken as typed, which keeps
  // Dvorak and AZERTY shortcuts on the keys that carry their letters.
  else if (e.key === 'Dead' || e.key.charCodeAt(0) > 0x7f) key = physicalKey(e.code) ?? key;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}
