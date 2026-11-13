/** The keyboard in a row of tabs. */
import type { KeyboardEvent } from 'react';
import { spaceOperates } from '../../state/shortcuts';

/**
 * Left and Right step through the tabs of the list the key was pressed in, round its ends; Home
 * and End go to the first and the last. The tab arrived at is chosen and takes the keyboard, so
 * Tab goes on from there into its panel. Put it on the `tablist`; `select` is told the tab's place.
 *
 * A tab that only kept the focus of the click that chose it is not being worked from the
 * keyboard: there the arrow keys stay the transport's, as Space does.
 */
export function onTabListKey(e: KeyboardEvent<HTMLElement>, select: (index: number) => void): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !spaceOperates(e.target)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const to = tabToward(tabs.indexOf(e.target as HTMLElement), tabs.length, e.key);
  if (to === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  tabs[to].focus();
  select(to);
}

/** The place of the tab `key` leads to from tab `from` of `count`, or undefined for any other key. */
export function tabToward(from: number, count: number, key: string): number | undefined {
  if (from < 0 || count === 0) return undefined;
  switch (key) {
    case 'ArrowRight':
      return (from + 1) % count;
    case 'ArrowLeft':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}
