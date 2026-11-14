/** What is offered to someone depends on whether they may change the project. */
import { useSyncExternalStore } from 'react';
import { useSession } from '../../session/hooks';
import type { MenuEntry } from '../../ui/core';

/**
 * Whether the person may change the project. Their access can change while the project is open,
 * and whatever reads it here is drawn again when it does.
 */
export function useCanEdit(): boolean {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, () => session.canEdit);
}

type MenuItem = Extract<MenuEntry, { label: string }>;

/**
 * Marks the menu entries that change the project. Someone who may not edit still finds them in
 * the menu, to read what there is, and cannot choose them: choosing one would only be refused.
 */
export const editEntry =
  (editable: boolean) =>
  (entry: MenuItem | false | null | undefined): MenuEntry =>
    entry && !editable ? { ...entry, disabled: true } : entry;
