/**
 * A keycap of the shortcut strip stands for a key of the visitor's own keyboard: Ctrl, Shift and
 * Del where the editor's shortcut sheet says so, the Mac's symbols on a Mac. Both decide by the
 * platform once, when their module loads, so each case here loads them afresh.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MODIFIERS = ['mod', 'shift', 'delete'];

/** What a visitor on `platform` reads on the site's keycaps and on the editor's, key by key. */
async function legends(platform: string, keys: string[]): Promise<{ site: string[]; editor: string[] }> {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform });
  const { Keycap } = await import('../src/components/Keycap');
  const { Kbd } = await import('../../editor/src/ui/core');
  const text = (html: string): string => html.replace(/<svg.*?<\/svg>/gs, '').replace(/<[^>]+>/g, '');
  return {
    site: keys.map((k) => text(renderToStaticMarkup(createElement(Keycap, { k })))),
    editor: keys.map((k) => text(renderToStaticMarkup(createElement(Kbd, { keys: k })))),
  };
}

describe('keycap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['Win32', 'Linux x86_64'])(
    'spells the modifiers out as the editor does on %s',
    async (platform) => {
      const { site, editor } = await legends(platform, MODIFIERS);
      expect(site).toEqual(['Ctrl', 'Shift', 'Del']);
      expect(site).toEqual(editor);
    },
  );

  it.each(['MacIntel', 'iPad'])('draws the Mac’s symbols on %s and names them', async (platform) => {
    const { site, editor } = await legends(platform, MODIFIERS);
    expect(site).toEqual(['Command', 'Shift', 'Delete']);
    expect(editor).toEqual(['⌘', '⇧', '⌫']);
  });

  it('sets a letter in capitals, as the editor does', async () => {
    const { site, editor } = await legends('Win32', ['j', 'x']);
    expect(site).toEqual(['J', 'X']);
    expect(site).toEqual(editor);
  });
});
