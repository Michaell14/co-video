import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/state/shortcuts';

const keysOf = (id: string): string[] => COMMANDS.find((c) => c.id === id)?.keys ?? [];

describe('command catalogue', () => {
  it('binds every shortcut to one command only', () => {
    const owners = new Map<string, string[]>();
    for (const c of COMMANDS) for (const k of c.keys ?? []) owners.set(k, [...(owners.get(k) ?? []), c.id]);
    const clashes = [...owners].filter(([, ids]) => ids.length > 1);
    expect(clashes).toEqual([]);
  });

  it('gives every command its own id', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('zooms in on every way of typing +', () => {
    expect(keysOf('zoom-in')).toEqual(expect.arrayContaining(['equal', 'shift+equal', 'mod+shift+equal']));
  });

  it('offers marker stepping, side selection and zoom to selection', () => {
    expect(keysOf('next-marker')).toContain('shift+m');
    expect(keysOf('prev-marker')).toContain('mod+shift+m');
    for (const id of ['select-left', 'select-right', 'zoom-selection', 'replace-file']) {
      expect(COMMANDS.some((c) => c.id === id)).toBe(true);
    }
  });
});
