import { describe, expect, it } from 'vitest';
import { chooseAccess, claimedRole, entryFate, outranks } from '../src/session/access';

const b64url = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (payload: unknown): string => `${b64url(JSON.stringify(payload))}.c2lnbmF0dXJl`;

describe('claimedRole', () => {
  it('reads the role a token was issued for', () => {
    expect(claimedRole(tokenFor({ p: 'abc', r: 'owner', iat: 1 }))).toBe('owner');
    expect(claimedRole(tokenFor({ p: 'abc', r: 'viewer', iat: 1 }))).toBe('viewer');
    // A payload long enough to need the URL-safe alphabet.
    expect(claimedRole(tokenFor({ p: '???>>>~~~', r: 'commenter', iat: 1 }))).toBe('commenter');
  });

  it('makes nothing of junk', () => {
    for (const junk of [
      '',
      'junk',
      'a.b',
      '.',
      tokenFor({ r: 'admin' }),
      tokenFor('owner'),
      tokenFor(null),
    ]) {
      expect(claimedRole(junk)).toBeNull();
    }
    expect(claimedRole(tokenFor({ r: 'toString' }))).toBeNull();
  });
});

describe('chooseAccess', () => {
  const owner = { token: 'own', role: 'owner' as const };
  const editor = { token: 'edit', role: 'editor' as const };
  const editor2 = { token: 'edit2', role: 'editor' as const };
  const viewer = { token: 'view', role: 'viewer' as const };

  it('ranks roles', () => {
    expect(outranks('owner', 'editor')).toBe(true);
    expect(outranks('editor', 'commenter')).toBe(true);
    expect(outranks('commenter', 'viewer')).toBe(true);
    expect(outranks('viewer', 'viewer')).toBe(false);
    expect(outranks('viewer', 'owner')).toBe(false);
  });

  it('keeps the stored token when nothing was offered', () => {
    expect(chooseAccess(owner, null)).toEqual({ granted: owner, offered: null });
    expect(chooseAccess('refused', null)).toEqual({ granted: null, offered: null });
    expect(chooseAccess(null, null)).toEqual({ granted: null, offered: null });
  });

  it('never trades stored access for a lesser link', () => {
    expect(chooseAccess(owner, viewer)).toEqual({ granted: owner, offered: 'surplus' });
    expect(chooseAccess(editor, viewer)).toEqual({ granted: editor, offered: 'surplus' });
    expect(chooseAccess(editor, editor2)).toEqual({ granted: editor, offered: 'surplus' });
  });

  it('never trades stored access for a link the server refuses', () => {
    expect(chooseAccess(owner, 'refused')).toEqual({ granted: owner, offered: 'refused' });
    expect(chooseAccess(null, 'refused')).toEqual({ granted: null, offered: 'refused' });
    expect(chooseAccess('refused', 'refused')).toEqual({ granted: null, offered: 'refused' });
  });

  it('adopts a link that gives more, or the only access there is', () => {
    expect(chooseAccess(viewer, editor)).toEqual({ granted: editor, offered: 'adopted' });
    expect(chooseAccess(null, viewer)).toEqual({ granted: viewer, offered: 'adopted' });
    expect(chooseAccess('refused', viewer)).toEqual({ granted: viewer, offered: 'adopted' });
  });
});

describe('entryFate', () => {
  const editor = { token: 'edit', role: 'editor' as const };
  const nothing = { loaded: true, empty: true };
  const content = { loaded: true, empty: false };
  const unread = { loaded: false, empty: true };

  it('forgets a project reached through a link that is refused, of which nothing is on the device', () => {
    expect(entryFate('refused', nothing, false)).toBe('forget');
  });

  it('never takes the card of a project made here: its link is the only owner link there is', () => {
    expect(entryFate('refused', nothing, true)).toBe('keep');
    expect(entryFate('refused', unread, true)).toBe('keep');
  });

  it('keeps the copy on the device and takes only the refused link out of the entry', () => {
    for (const own of [true, false]) {
      expect(entryFate('refused', content, own)).toBe('unlink');
      // Content that arrived before the stored copy was read is content all the same.
      expect(entryFate('refused', { loaded: false, empty: false }, own)).toBe('unlink');
    }
  });

  it('never touches the entry when the server could not be asked', () => {
    for (const own of [true, false]) {
      expect(entryFate('unreachable', nothing, own)).toBe('keep');
      expect(entryFate('unreachable', content, own)).toBe('keep');
      expect(entryFate('unreachable', unread, own)).toBe('keep');
    }
  });

  it('leaves an accepted link, and an entry without one, alone', () => {
    for (const own of [true, false]) {
      expect(entryFate(editor, nothing, own)).toBe('keep');
      expect(entryFate(editor, content, own)).toBe('keep');
      expect(entryFate(null, nothing, own)).toBe('keep');
      expect(entryFate(null, content, own)).toBe('keep');
    }
  });

  it('does not take an unread device for an empty one', () => {
    expect(entryFate('refused', unread, false)).toBe('keep');
  });
});
