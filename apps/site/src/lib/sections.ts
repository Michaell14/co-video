/**
 * The feature chapters of the page, in the order they appear. The nav, its scroll-spy and the
 * footer all read this list, so they cannot disagree about what a section is called or which one
 * comes next.
 */
export const FEATURE_SECTIONS = [
  { id: 'multiplayer', label: 'Multiplayer' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'effects', label: 'Effects' },
  { id: 'color', label: 'Colour' },
] as const;

export const OPEN_SOURCE_SECTION = { id: 'open-source', label: 'Open source' } as const;
