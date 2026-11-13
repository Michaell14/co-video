/**
 * Capability tokens seen from the client: comparing the access two tokens give, and reading what a
 * token says about itself. Only the server can tell whether a token is genuine (see
 * apps/server/src/auth.ts); nothing here grants anything.
 */
import type { Role } from '@tandem/core';

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && Object.hasOwn(RANK, value);

/** Does role `a` allow more than role `b`? */
export const outranks = (a: Role, b: Role): boolean => RANK[a] > RANK[b];

/**
 * The role a token was issued for, read from its payload (`base64url(JSON) "." signature`). The
 * signature is not checked, so this is only good for a token the server accepted before, such as
 * the one stored for a project, when the server cannot be asked.
 */
export function claimedRole(token: string): Role | null {
  try {
    const body = token.slice(0, token.indexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(atob(body));
    const role = (payload as { r?: unknown } | null)?.r;
    return isRole(role) ? role : null;
  } catch {
    return null;
  }
}

/** How the server answered when asked about a token. */
export type Verdict = { token: string; role: Role } | 'refused' | 'unreachable';

export interface AccessChoice {
  /** The token to work with and the role it gives; `null` when no token was accepted. */
  granted: { token: string; role: Role } | null;
  /**
   * What became of the token a link offered: `adopted` as the one to use, `surplus` when the stored
   * one already allows as much, or `refused` by the server. `null` when no link token was judged.
   */
  offered: 'adopted' | 'surplus' | 'refused' | null;
}

/**
 * Pick between the token stored for a project and the one a link just offered, given the server's
 * verdict on each. A link can add access but never take it away: the offered token is adopted only
 * when it was accepted and allows more than the stored one, or when no stored one is left.
 */
export function chooseAccess(
  stored: Exclude<Verdict, 'unreachable'> | null,
  offered: Exclude<Verdict, 'unreachable'> | null,
): AccessChoice {
  const kept = stored && stored !== 'refused' ? stored : null;
  if (!offered) return { granted: kept, offered: null };
  if (offered === 'refused') return { granted: kept, offered: 'refused' };
  if (kept && !outranks(offered.role, kept.role)) return { granted: kept, offered: 'surplus' };
  return { granted: offered, offered: 'adopted' };
}

/** What this device holds of a project, as far as it could be read. */
export interface LocalCopy {
  /** The stored document was read. Until it is, an empty document says nothing about the device. */
  loaded: boolean;
  empty: boolean;
}

/**
 * What becomes of a project's entry in the project list once the server has answered about the
 * token stored for it. Only a refusal changes anything: a server that could not be reached, or was
 * busy, may accept the same token tomorrow. Refused with a copy on this device, the entry loses its
 * link (`unlink`) and the copy stays, to be worked on as a local project. Refused with nothing on
 * the device, an entry that was reached through someone's link led nowhere but to the server, and
 * goes (`forget`). The entry of a project made here (`own`) stays even then: its link is the only
 * owner link there is, and opening the project again is how its owner asks the server once more.
 *
 * Whatever the entry loses, the link itself is kept aside (see `registry.setLinkAside`). A refusal
 * is only what one server said at one moment.
 */
export function entryFate(
  stored: Verdict | null,
  local: LocalCopy,
  own: boolean,
): 'keep' | 'unlink' | 'forget' {
  if (stored !== 'refused') return 'keep';
  if (!local.empty) return 'unlink';
  return local.loaded && !own ? 'forget' : 'keep';
}
