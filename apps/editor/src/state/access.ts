/** Telling a person that the access they have does not allow what they just tried. */
import type { Role } from '@tandem/core';
import { toast } from '../ui/core';

/** What the access of each role is called in a sentence. */
export const ACCESS_NAME: Record<Role, string> = {
  owner: 'owner',
  editor: 'edit',
  commenter: 'comment-only',
  viewer: 'view-only',
};

/** The sentence that says which access a person has: a commenter is not told they can only view. */
export const accessNotice = (role: Role): string => `You have ${ACCESS_NAME[role]} access to this project.`;

/** Say why an edit did nothing. */
export function refuseEdit(role: Role, kind: 'info' | 'error' = 'info'): void {
  toast(accessNotice(role), kind);
}
