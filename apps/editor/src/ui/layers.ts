/**
 * Layers that open on top of the page: dialogs, the command palette, menus and other popovers.
 * The topmost layer owns the keyboard, a modal one puts everything beneath it out of reach, and
 * focus goes back to where it came from when a layer is closed from the keyboard.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface Layer {
  el: HTMLElement;
  /** A modal layer makes the page and every layer under it inert. */
  modal: boolean;
  /** Where focus returns when the layer closes: the first of these that is still in the page. */
  returnTo: Element[];
  /** Every key pressed while this is the top layer, before anything else in the page sees it. */
  onKeyDown: (e: KeyboardEvent) => void;
}

const layers: Layer[] = [];

const top = (): Layer | undefined => layers[layers.length - 1];
const onKeyDown = (e: KeyboardEvent) => top()?.onKeyDown(e);

/** True while a dialog, the palette, a menu or any other popover is open. */
export function layerOpen(): boolean {
  return layers.length > 0;
}

export function isTopLayer(el: HTMLElement | null): boolean {
  return !!el && top()?.el === el;
}

/**
 * Take an element out of reach, or bring it back. `inert` does the work; `aria-hidden` says the
 * same to assistive technology and tools that do not read `inert` yet. Focus leaves first: a
 * hidden subtree must not hold it, and the browser only gets round to that later.
 */
function cover(el: HTMLElement, covered: boolean): void {
  const active = document.activeElement as HTMLElement | null;
  if (covered && active && el.contains(active)) active.blur();
  el.inert = covered;
  if (covered) el.setAttribute('aria-hidden', 'true');
  else el.removeAttribute('aria-hidden');
}

function sync(): void {
  let covered = false;
  for (let i = layers.length - 1; i >= 0; i--) {
    cover(layers[i].el, covered);
    covered ||= layers[i].modal;
  }
  const root = document.getElementById('root');
  if (root) cover(root, covered);
}

/**
 * Where focus should go back to once a layer that is about to open has closed again. Read it
 * before the layer mounts: a field inside it may take focus while mounting. When focus sits in a
 * layer that may be gone by then (a menu whose entry opens a dialog), that layer's own origin
 * follows as the fallback.
 */
export function focusOrigin(preferred?: Element | null): Element[] {
  const active = preferred ?? document.activeElement;
  if (!active || active === document.body) return [];
  const host = layers.find((l) => l.el.contains(active));
  return host ? [active, ...host.returnTo] : [active];
}

/** Put a layer on top. The returned function takes it away again and sees to where focus goes. */
export function openLayer(layer: Layer): () => void {
  if (layers.length === 0) window.addEventListener('keydown', onKeyDown, true);
  layers.push(layer);
  spendKeys();
  sync();
  return () => {
    const i = layers.indexOf(layer);
    if (i < 0) return;
    const active = document.activeElement;
    // Focus that has already moved on (the next dialog took it) is left where it is.
    const held = !active || active === document.body || layer.el.contains(active);
    layers.splice(i, 1);
    spendKeys();
    sync();
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown, true);
    if (!held) return;
    const back = layer.returnTo.find((el) => el.isConnected) as HTMLElement | undefined;
    // In the editor itself a pointer press is left to decide about focus: handing it to the
    // control that opened the layer would give that control the keys pressed next, which someone
    // working with the pointer means for the editor's shortcuts. A control in a layer that is
    // still open (a select in a dialog) gets it back either way, so focus never falls out of the
    // dialog.
    if (back && (usingKeyboard() || layers.some((l) => l.el.contains(back)))) {
      back.focus({ preventScroll: true });
    }
  };
}

/**
 * Keep `ref`'s element registered as a layer for as long as the component is mounted. `trigger`
 * is the control that opened it, when there is one: focus goes back there.
 */
export function useLayer(
  ref: RefObject<HTMLElement | null>,
  modal: boolean,
  onKeyDown: (e: KeyboardEvent) => void,
  trigger?: RefObject<HTMLElement | null>,
): void {
  const [returnTo] = useState(() => focusOrigin(trigger?.current));
  const live = useRef(onKeyDown);
  useLayoutEffect(() => {
    live.current = onKeyDown;
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return openLayer({ el, modal, returnTo, onKeyDown: (e) => live.current(e) });
  }, [ref, modal, returnTo]);
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Elements inside `root` that Tab can reach, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      !el.closest('[inert]'),
  );
}

/**
 * Keep Tab inside `root`: leaving from either end comes back in at the other, and focus that has
 * strayed outside is brought in. Steps between elements inside are left to the browser, which
 * takes them in document order: it may go on as long as a stop lies on that side of the focused
 * element, which need not be a stop itself.
 */
export function trapTab(root: HTMLElement, e: KeyboardEvent): void {
  const list = focusables(root);
  const active = document.activeElement;
  const ahead = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  const inside = !!active && active !== root && root.contains(active);
  if (inside && list.some((el) => active.compareDocumentPosition(el) & ahead)) return;
  e.preventDefault();
  (list[e.shiftKey ? list.length - 1 : 0] ?? root).focus();
}

/** Whether keys typed into this element are text for it rather than commands. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'].includes(type);
}

let pointer = false;

/**
 * Whether the person is working from the keyboard: their last press was not one of the pointer.
 * Activation that comes with neither (assistive technology clicks on the person's behalf) counts
 * as keyboard use.
 */
export function usingKeyboard(): boolean {
  return !pointer;
}

/** Keys that are down, and those among them that were down while a layer opened or closed. */
const down = new Set<string>();
const spent = new Set<string>();

function spendKeys(): void {
  for (const key of down) spent.add(key);
}

/**
 * Note a key going down and say whether it may act. A key that was down while a layer opened or
 * closed has done its work: the press that opens a dialog must not answer it as well, nor the one
 * that chooses from a menu open it again. Until it comes up, its auto-repeat does nothing.
 */
export function keyDown(key: string, repeat: boolean): boolean {
  // A new press is never spent, also when the release before it went unseen (macOS reports none
  // for a key let go while ⌘ is held).
  if (!repeat) spent.delete(key);
  down.add(key);
  return !spent.has(key);
}

export function keyUp(key: string): void {
  down.delete(key);
  spent.delete(key);
}

if (typeof window !== 'undefined') {
  const name = (e: KeyboardEvent) => e.code || e.key;
  // Registered before any other key listener, so a spent key reaches nothing at all.
  window.addEventListener(
    'keydown',
    (e) => {
      pointer = false;
      if (keyDown(name(e), e.repeat)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener('keyup', (e) => keyUp(name(e)), true);
  window.addEventListener('pointerdown', () => (pointer = true), true);
  // Keys let go while another window has the keyboard are never reported.
  window.addEventListener('blur', () => {
    down.clear();
    spent.clear();
  });
}

/**
 * Type-ahead in a list: the index of the entry the typed text selects, or -1. Typing one letter
 * again and again steps through the entries that start with it; anything longer goes to the
 * first entry starting with all of it, looking from the current entry onwards.
 */
export function typeAhead(labels: string[], typed: string, current: number): number {
  const text = typed.toLowerCase();
  if (!text || labels.length === 0) return -1;
  const repeated = text.length > 1 && text.split('').every((ch) => ch === text[0]);
  const needle = repeated ? text[0] : text;
  const start = text.length === 1 || repeated ? current + 1 : Math.max(0, current);
  for (let n = 0; n < labels.length; n++) {
    const i = (start + n) % labels.length;
    if (labels[i].trim().toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Top-left corner for a tooltip of `size` next to `anchor`: centred on it, on the wanted side
 * unless only the other side has room, and always wholly inside the viewport.
 */
export function placeTip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  place: 'top' | 'bottom',
): { left: number; top: number } {
  const gap = 7;
  const edge = 6;
  const above = anchor.top - gap - size.height;
  const below = anchor.top + anchor.height + gap;
  const fitsAbove = above >= edge;
  const fitsBelow = below + size.height <= viewport.height - edge;
  const top =
    place === 'top' ? (fitsAbove || !fitsBelow ? above : below) : fitsBelow || !fitsAbove ? below : above;
  const left = anchor.left + anchor.width / 2 - size.width / 2;
  return {
    left: Math.max(edge, Math.min(viewport.width - size.width - edge, left)),
    top: Math.max(edge, Math.min(viewport.height - size.height - edge, top)),
  };
}
