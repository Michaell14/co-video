import { afterEach, describe, expect, it, vi } from 'vitest';
import { keyDown, keyUp, layerOpen, openLayer, placeTip, typeAhead, type Layer } from '../src/ui/layers';
import { isDoublePress, isDrag } from '../src/ui/press';
import { handleKey } from '../src/state/shortcuts';
import { useUI } from '../src/state/ui';

describe('type-ahead in menus and selects', () => {
  const blend = ['Normal', 'Darken', 'Multiply', 'Color Burn', 'Subtract', 'Lighten', 'Screen', 'Soft Light'];

  it('goes to the next entry that starts with the letter, wrapping round', () => {
    expect(typeAhead(blend, 's', 0)).toBe(4);
    expect(typeAhead(blend, 's', 4)).toBe(6);
    expect(typeAhead(blend, 's', 7)).toBe(4);
  });

  it('steps through the entries when the same letter is typed again and again', () => {
    expect(typeAhead(blend, 'ss', 4)).toBe(6);
    expect(typeAhead(blend, 'sss', 6)).toBe(7);
  });

  it('narrows down on a longer prefix, staying on the current entry while it still matches', () => {
    expect(typeAhead(blend, 'so', 4)).toBe(7);
    expect(typeAhead(blend, 'sc', 6)).toBe(6);
    expect(typeAhead(blend, 'color b', -1)).toBe(3);
  });

  it('ignores case and leading space, and reports no match as -1', () => {
    expect(typeAhead(['  Export…', 'import media…'], 'I', -1)).toBe(1);
    expect(typeAhead(blend, 'x', 2)).toBe(-1);
    expect(typeAhead([], 'a', -1)).toBe(-1);
    expect(typeAhead(blend, '', 0)).toBe(-1);
  });
});

describe('tooltip placement', () => {
  const viewport = { width: 1000, height: 600 };
  const size = { width: 200, height: 24 };
  const inside = (p: { left: number; top: number }) =>
    p.left >= 0 &&
    p.top >= 0 &&
    p.left + size.width <= viewport.width &&
    p.top + size.height <= viewport.height;

  it('centres under the anchor when there is room', () => {
    expect(placeTip({ left: 480, top: 100, width: 40, height: 20 }, size, viewport, 'bottom')).toEqual({
      left: 400,
      top: 127,
    });
  });

  it('moves in from the left and right edges instead of being cut off', () => {
    const left = placeTip({ left: 2, top: 100, width: 16, height: 16 }, size, viewport, 'bottom');
    const right = placeTip({ left: 980, top: 100, width: 16, height: 16 }, size, viewport, 'bottom');
    expect(left.left).toBe(6);
    expect(right.left).toBe(1000 - 200 - 6);
    expect(inside(left) && inside(right)).toBe(true);
  });

  it('flips above an anchor at the bottom edge and below one at the top edge', () => {
    const low = placeTip({ left: 480, top: 570, width: 40, height: 24 }, size, viewport, 'bottom');
    const high = placeTip({ left: 480, top: 4, width: 40, height: 24 }, size, viewport, 'top');
    expect(low.top).toBe(570 - 7 - 24);
    expect(high.top).toBe(4 + 24 + 7);
    expect(inside(low) && inside(high)).toBe(true);
  });

  it('stays inside a viewport too small to clear the anchor on either side', () => {
    const p = placeTip(
      { left: 10, top: 10, width: 40, height: 30 },
      size,
      { width: 1000, height: 50 },
      'top',
    );
    expect(p.top).toBeGreaterThanOrEqual(6);
    expect(p.top + size.height).toBeLessThanOrEqual(50 - 6);
  });
});

describe('double-press detection', () => {
  const first = { time: 1000, x: 100, y: 50 };

  it('takes a quick press in the same place as the second half of a double-click', () => {
    expect(isDoublePress(first, { time: 1180, x: 102, y: 51 })).toBe(true);
  });

  it('takes a late or distant press as a new one', () => {
    expect(isDoublePress(first, { time: 1600, x: 100, y: 50 })).toBe(false);
    expect(isDoublePress(first, { time: 1100, x: 130, y: 50 })).toBe(false);
    expect(isDoublePress(null, first)).toBe(false);
  });

  it('tells a press that wanders off from one that stays put', () => {
    expect(isDrag(first, 103, 48)).toBe(false);
    expect(isDrag(first, 106, 50)).toBe(true);
    expect(isDrag(first, 100, 44)).toBe(true);
  });
});

const element = () => ({
  inert: false,
  contains: () => false,
  setAttribute: () => {},
  removeAttribute: () => {},
});
const layer = (modal: boolean): Layer => ({
  el: element() as unknown as HTMLElement,
  modal,
  returnTo: [],
  onKeyDown: () => {},
});
const stubPage = (root = element()) => {
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', { getElementById: () => root, activeElement: null, body: {} });
  return root;
};

describe('keys held while a layer opens or closes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ['Enter', 'Escape', 'ArrowDown']) keyUp(key);
  });

  it('lets the press that opens a layer act once, and not again inside it', () => {
    stubPage();
    expect(keyDown('Enter', false)).toBe(true);
    const close = openLayer(layer(true));
    expect(keyDown('Enter', true)).toBe(false);
    expect(keyDown('Enter', true)).toBe(false);
    keyUp('Enter');
    expect(keyDown('Enter', false)).toBe(true);
    close();
  });

  it('keeps the press that closes a layer from acting on what is under it', () => {
    stubPage();
    const close = openLayer(layer(false));
    expect(keyDown('Escape', false)).toBe(true);
    close();
    expect(keyDown('Escape', true)).toBe(false);
    keyUp('Escape');
    expect(keyDown('Escape', false)).toBe(true);
  });

  it('leaves alone the repeat of a key pressed inside the layer', () => {
    stubPage();
    const close = openLayer(layer(false));
    expect(keyDown('ArrowDown', false)).toBe(true);
    expect(keyDown('ArrowDown', true)).toBe(true);
    close();
  });

  it('takes a new press as new when the release before it went unseen', () => {
    stubPage();
    expect(keyDown('Enter', false)).toBe(true);
    openLayer(layer(false))();
    expect(keyDown('Enter', true)).toBe(false);
    expect(keyDown('Enter', false)).toBe(true);
    expect(keyDown('Enter', true)).toBe(true);
  });
});

describe('global shortcuts and open layers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useUI.getState().set({ dialog: null, snapping: true });
  });

  const press = (key: string) => {
    const e = { key, code: '', target: null, preventDefault: vi.fn() };
    return { consumed: handleKey(e as unknown as KeyboardEvent), event: e };
  };

  it('runs a shortcut when nothing is open', () => {
    expect(press('n').consumed).toBe(true);
    expect(useUI.getState().snapping).toBe(false);
  });

  it('does nothing behind the command palette', () => {
    useUI.getState().set({ dialog: 'palette' });
    const { consumed, event } = press('n');
    expect(consumed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useUI.getState().snapping).toBe(true);
  });

  it('does nothing behind a dialog or menu the UI state does not know about', () => {
    const root = stubPage();

    const confirmation = layer(true);
    const close = openLayer(confirmation);
    expect(layerOpen()).toBe(true);
    expect(root.inert).toBe(true);
    expect(press('n').consumed).toBe(false);
    expect(useUI.getState().snapping).toBe(true);

    // A menu opened from the dialog leaves the dialog usable underneath it; a second dialog does not.
    const menu = layer(false);
    const closeMenu = openLayer(menu);
    expect(confirmation.el.inert).toBe(false);
    closeMenu();
    const second = layer(true);
    const closeSecond = openLayer(second);
    expect(confirmation.el.inert).toBe(true);
    closeSecond();
    expect(confirmation.el.inert).toBe(false);

    close();
    expect(layerOpen()).toBe(false);
    expect(root.inert).toBe(false);
    expect(press('n').consumed).toBe(true);
  });
});
