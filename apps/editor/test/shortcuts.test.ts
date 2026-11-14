import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTransitionDef } from '@tandem/core';
import { setCurrentSession } from '../src/session/hooks';
import type { Session } from '../src/session/session';
import { ACCESS_NAME, accessNotice } from '../src/state/access';
import { COMMANDS, handleKey, spaceOperates, watchFocus } from '../src/state/shortcuts';
import { FIRST_TRANSITION, useUI } from '../src/state/ui';

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

  it('reaches clips, the marked range and a cut without the pointer', () => {
    expect(keysOf('select-under')).toEqual(['shift+v']);
    expect(keysOf('select-next')).toEqual(['mod+arrowdown']);
    expect(keysOf('select-prev')).toEqual(['mod+arrowup']);
    expect(keysOf('select-next-add')).toEqual(['mod+shift+arrowdown']);
    expect(keysOf('select-prev-add')).toEqual(['mod+shift+arrowup']);
    expect(keysOf('mark-clip')).toEqual(['x']);
    expect(keysOf('go-in')).toEqual(['shift+i']);
    expect(keysOf('go-out')).toEqual(['shift+o']);
    expect(keysOf('trim-edge-left')).toEqual(['mod+arrowleft']);
    expect(keysOf('trim-edge-right')).toEqual(['mod+arrowright']);
    expect(keysOf('trim-edge-left-5')).toEqual(['mod+shift+arrowleft']);
    expect(keysOf('trim-edge-right-5')).toEqual(['mod+shift+arrowright']);
    expect(keysOf('extend-edit')).toEqual(['e']);
    expect(keysOf('default-transition')).toEqual(['shift+d']);
    // Held down, the stepping and trimming keys keep going; the one-off ones do not.
    const repeats = (id: string) => !!COMMANDS.find((c) => c.id === id)?.repeat;
    expect(['select-next', 'select-prev', 'trim-edge-left', 'trim-edge-right-5'].every(repeats)).toBe(true);
    expect(['select-under', 'mark-clip', 'extend-edit', 'default-transition'].some(repeats)).toBe(false);
  });

  it('keeps clear of the keys a browser does not give up', () => {
    const reserved = ['mod+t', 'mod+n', 'mod+w', 'mod+shift+t', 'mod+shift+n', 'mod+shift+w', 'mod+q', 'f11'];
    const bound = new Set(COMMANDS.flatMap((c) => c.keys ?? []));
    expect(reserved.filter((k) => bound.has(k))).toEqual([]);
  });

  it('offers every way of pasting attributes, and the marker switch, in the palette', () => {
    for (const id of ['paste-attrs', 'paste-grade', 'paste-effects', 'paste-transform', 'paste-sound']) {
      expect(COMMANDS.find((c) => c.id === id)?.title, id).toMatch(/^Paste attributes/);
    }
    expect(COMMANDS.find((c) => c.id === 'markers-follow')?.title).toBe('Toggle markers follow ripple edits');
  });

  it('starts the default transition from one that exists', () => {
    expect(getTransitionDef(FIRST_TRANSITION)?.name).toBe('Cross Dissolve');
  });
});

describe('Space on a focused control', () => {
  /** An element as far as the rule looks at it. */
  const element = (selector: string) =>
    ({ matches: (query: string) => query.split(', ').includes(selector) }) as unknown as EventTarget;
  const CONTROLS = ['button', '[role=switch]', '[role=tab]', '[role=option]'];

  it('operates a button, switch, tab or option that the keyboard brought focus to', () => {
    for (const control of CONTROLS) expect(spaceOperates(element(control), true), control).toBe(true);
  });

  it('stays with the transport on a control that a click left focused', () => {
    for (const control of CONTROLS) expect(spaceOperates(element(control), false), control).toBe(false);
  });

  it('stays with the transport everywhere else', () => {
    expect(spaceOperates(element('div'), true)).toBe(false);
    expect(spaceOperates(element('a'), true)).toBe(false);
    expect(spaceOperates(null, true)).toBe(false);
    // The window and the document are event targets without a `matches`.
    expect(spaceOperates({} as EventTarget, true)).toBe(false);
  });

  /** The tracker with the events of a window fed to it by hand. */
  function tracker() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const window = {
      addEventListener: (type: string, listener: (e: unknown) => void) => void (listeners[type] = listener),
    };
    const byKeyboard = watchFocus(window as unknown as Window);
    return {
      byKeyboard,
      key: (key: string, modifiers: Partial<KeyboardEvent> = {}) => listeners.keydown({ key, ...modifiers }),
      press: () => listeners.pointerdown({}),
      focus: (target: object) => listeners.focusin({ target }),
      /** Focus leaves `target`; with none given, the window itself goes to the back. */
      blur: (target: object = window) => listeners.blur({ target }),
    };
  }

  it('knows whether the keyboard or the pointer brought the focus', () => {
    const { byKeyboard, key, press, focus } = tracker();
    const snapping = {};
    const ripple = {};
    expect(byKeyboard()).toBe(false);
    // A click on a button focuses it; pressing Space afterwards does not make that a keyboard focus.
    press();
    focus(snapping);
    key(' ');
    expect(byKeyboard()).toBe(false);
    // Tab moves the focus on.
    key('Tab');
    focus(ripple);
    expect(byKeyboard()).toBe(true);
    // A press on the control that already has the focus moves none, and still ends it.
    press();
    expect(byKeyboard()).toBe(false);
    // An arrow key takes the focus along a row of tabs.
    key('ArrowRight');
    focus(snapping);
    expect(byKeyboard()).toBe(true);
  });

  it('leaves a clicked button to the transport when a menu, a dialog or the palette hands focus back', () => {
    const { byKeyboard, key, press, focus } = tracker();
    const button = {};
    const field = {};
    const entry = {};
    // A click on a toolbar button, then the palette: typing, the arrow keys, Enter.
    press();
    focus(button);
    key('Control');
    key('k', { ctrlKey: true });
    focus(field);
    key('f');
    key('ArrowDown');
    key('Enter');
    focus(button);
    expect(byKeyboard()).toBe(false);
    // The transport's own arrow keys move no focus, and change nothing about the button.
    key('ArrowRight');
    expect(byKeyboard()).toBe(false);
    // The same with a menu opened by the click and closed with Escape, after a walk through it.
    press();
    key('ArrowDown');
    focus(entry);
    expect(byKeyboard()).toBe(true);
    key('Escape');
    focus(button);
    expect(byKeyboard()).toBe(false);
  });

  it('keeps a button that Tab reached operable when focus comes back to it', () => {
    const { byKeyboard, key, press, focus } = tracker();
    const button = {};
    const entry = {};
    key('Tab');
    focus(button);
    key('Enter');
    focus(entry);
    expect(byKeyboard()).toBe(false);
    key('Escape');
    focus(button);
    expect(byKeyboard()).toBe(true);
    // Until the pointer presses it: from then on it is a clicked button like any other.
    press();
    key('Enter');
    focus(entry);
    key('Escape');
    focus(button);
    expect(byKeyboard()).toBe(false);
  });

  it('does not take a switch of tab or window for a move of focus', () => {
    const { byKeyboard, key, press, focus, blur } = tracker();
    const button = {};
    press();
    focus(button);
    // Ctrl+Tab and back: the browser focuses the button again when the page returns.
    key('Control');
    key('Tab', { ctrlKey: true });
    focus(button);
    expect(byKeyboard()).toBe(false);
    key('ArrowLeft', { altKey: true });
    focus(button);
    expect(byKeyboard()).toBe(false);
    // A few frames stepped with the arrow keys, then away to another window and back.
    key('ArrowRight');
    blur(button);
    blur();
    focus(button);
    expect(byKeyboard()).toBe(false);
    // A button that Tab reached is still the keyboard's after the same trip.
    key('Tab', { shiftKey: true });
    focus(button);
    expect(byKeyboard()).toBe(true);
    blur(button);
    blur();
    focus(button);
    expect(byKeyboard()).toBe(true);
    // Focus that only leaves a control inside the window is no such trip.
    key('Tab');
    blur(button);
    focus({});
    expect(byKeyboard()).toBe(true);
  });
});

describe('shortcuts and a project that is not there', () => {
  afterEach(() => {
    setCurrentSession(null);
    useUI.getState().set({ snapping: true });
  });

  /** A session whose document was, or was never, given anything. */
  const open = (empty: boolean): void =>
    setCurrentSession({ store: { isEmpty: () => empty } } as unknown as Session);
  const press = (key: string) => {
    const e = { key, code: '', target: null, preventDefault: vi.fn() };
    return { consumed: handleKey(e as unknown as KeyboardEvent), event: e };
  };

  it('run in a project that holds something', () => {
    open(false);
    expect(press('n').consumed).toBe(true);
    expect(useUI.getState().snapping).toBe(false);
  });

  it('do nothing while the document is one nothing was ever put into', () => {
    open(true);
    const { consumed, event } = press('n');
    expect(consumed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useUI.getState().snapping).toBe(true);
  });
});

describe('the notice that an edit was not allowed', () => {
  it('names the access the person has, so a commenter is not told they can only view', () => {
    expect(accessNotice('viewer')).toBe('You have view-only access to this project.');
    expect(accessNotice('commenter')).toBe('You have comment-only access to this project.');
    expect(Object.keys(ACCESS_NAME).sort()).toEqual(['commenter', 'editor', 'owner', 'viewer']);
  });
});
