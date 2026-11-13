import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorForId } from '@tandem/core';

const KEY = 'tandem.projects.v1';
const ASIDE_KEY = 'tandem.links-aside.v1';

/** A `localStorage` with room for `quota` characters of values, like the real one. */
class FakeStorage {
  readonly data = new Map<string, string>();
  quota = Infinity;

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    let size = value.length;
    for (const [k, v] of this.data) if (k !== key) size += v.length;
    if (size > this.quota) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const b64url = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenFor = (role: string, n = 1): string => `${b64url(JSON.stringify({ p: 'x', r: role, n }))}.sig`;

let storage: FakeStorage;
let storageEvent: (e: { key: string }) => void;

/** The module as a tab that has just loaded would have it: it keeps what it read. */
async function load() {
  vi.resetModules();
  return import('../src/session/registry');
}

const stored = (): { id: string; name: string; token: string | null; thumb: string | null }[] =>
  JSON.parse(storage.getItem(KEY) ?? '[]');
const poster = (chars: number): string => `data:image/jpeg;base64,${'A'.repeat(chars)}`;

beforeEach(() => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    addEventListener: (_type: string, fn: (e: { key: string }) => void) => (storageEvent = fn),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the project list', () => {
  it('cuts a name and refuses a poster that a shared document made too large', async () => {
    const { registry, MAX_ENTRY_NAME, MAX_ENTRY_THUMB } = await load();
    const entry = registry.upsert({
      id: 'a',
      name: 'N'.repeat(6 * 1024 * 1024),
      thumb: poster(MAX_ENTRY_THUMB),
    });
    expect(entry.name).toHaveLength(MAX_ENTRY_NAME);
    expect(entry.thumb).toBeNull();
    expect(storage.getItem(KEY)!.length).toBeLessThan(1000);

    expect(registry.upsert({ id: 'a', thumb: poster(4800) }).thumb).toBe(poster(4800));
    for (const bad of ['javascript:alert(1)', 'https://example.com/a.png', 7, {}]) {
      expect(registry.upsert({ id: 'a', thumb: bad as string }).thumb).toBeNull();
    }
    // A name is not cut in the middle of a character.
    const cut = registry.upsert({ id: 'a', name: 'x'.repeat(MAX_ENTRY_NAME - 1) + '🎬' }).name;
    expect(cut).toBe('x'.repeat(MAX_ENTRY_NAME - 1));
  });

  it('reads whatever storage holds without falling over', async () => {
    for (const junk of ['{"a":1}', '7', 'null', 'not json', '[1,null,"x",{"name":"no id"},{"id":"ok"}]']) {
      storage.data.set(KEY, junk);
      const { registry } = await load();
      expect(registry.list().map((p) => p.id)).toEqual(junk.includes('"ok"') ? ['ok'] : []);
      expect(registry.get('nothing')).toBeUndefined();
    }
  });

  it('gives up the posters before it gives up the list', async () => {
    const { registry } = await load();
    registry.upsert({ id: 'a', name: 'A', thumb: poster(5000) });
    registry.upsert({ id: 'b', name: 'B', thumb: poster(5000) });
    storage.quota = 6000;
    registry.upsert({ id: 'c', name: 'C', token: tokenFor('owner'), thumb: poster(5000) });
    expect(registry.saved()).toBe(true);
    expect(stored().map((p) => [p.id, p.thumb])).toEqual([
      ['a', null],
      ['b', null],
      ['c', null],
    ]);
    expect(stored()[2].token).toBe(tokenFor('owner'));
    // This tab still shows them.
    expect(registry.get('a')!.thumb).toBe(poster(5000));
  });

  it('says so when the list cannot be saved, and again for every link that is not', async () => {
    const { registry } = await load();
    const told = vi.fn();
    registry.whenUnsaved(told);
    const changes = vi.fn();
    registry.subscribe(changes);
    registry.upsert({ id: 'a', name: 'First' });
    expect(registry.saved()).toBe(true);

    storage.quota = 10;
    registry.upsert({ id: 'a', name: 'Renamed' });
    expect(registry.saved()).toBe(false);
    expect(told).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(stored()[0].name).toBe('First');

    // More of the same is not said again; a link that would be lost is.
    registry.upsert({ id: 'a', duration: 4 });
    expect(told).toHaveBeenCalledTimes(1);
    registry.upsert({ id: 'b', name: 'New', token: tokenFor('owner') });
    expect(told).toHaveBeenCalledTimes(2);
    registry.upsert({ id: 'b', role: 'owner' });
    expect(told).toHaveBeenCalledTimes(2);
    expect(registry.get('b')!.token).toBe(tokenFor('owner'));

    // Room again: the next write takes everything this tab knows.
    storage.quota = Infinity;
    registry.upsert({ id: 'a', duration: 5 });
    expect(registry.saved()).toBe(true);
    expect(stored().map((p) => [p.id, p.name, p.token])).toEqual([
      ['a', 'Renamed', null],
      ['b', 'New', tokenFor('owner')],
    ]);
  });

  it('keeps what only this tab knows when another tab writes the list', async () => {
    const { registry } = await load();
    registry.upsert({ id: 'a', name: 'First' });
    storage.quota = 10;
    registry.upsert({ id: 'b', name: 'Mine', token: tokenFor('owner') });
    expect(registry.saved()).toBe(false);

    // Another tab, which had room: it deleted a poster and added a project.
    storage.quota = Infinity;
    storage.data.set(
      KEY,
      JSON.stringify([
        { id: 'a', name: 'First' },
        { id: 'c', name: 'Theirs' },
      ]),
    );
    storageEvent({ key: KEY });
    expect(
      registry
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    expect(registry.saved()).toBe(true);
    expect(stored().find((p) => p.id === 'b')!.token).toBe(tokenFor('owner'));

    // A saved tab simply follows the other one.
    storage.data.set(KEY, JSON.stringify([{ id: 'c', name: 'Theirs' }]));
    storageEvent({ key: KEY });
    expect(registry.list().map((p) => p.id)).toEqual(['c']);
  });
});

describe('a link the server refused', () => {
  it('leaves the entry but not the device', async () => {
    const { registry } = await load();
    const token = tokenFor('owner');
    registry.upsert({ id: 'a', name: 'Mine', token, role: 'owner' });
    expect(registry.linkAside('a')).toBeNull();

    expect(registry.setLinkAside('a')).toBe(true);
    expect(registry.get('a')).toMatchObject({ token: null, role: undefined });
    expect(registry.linkAside('a')).toMatchObject({ token, role: 'owner' });
    expect(stored()[0].token).toBeNull();
    expect(JSON.parse(storage.getItem(ASIDE_KEY)!).a.token).toBe(token);

    // It survives the tab, and the entry going.
    registry.remove('a');
    const again = await load();
    expect(again.registry.linkAside('a')).toMatchObject({ token, role: 'owner' });
    again.registry.dropLinkAside('a');
    expect(again.registry.linkAside('a')).toBeNull();
    expect(storage.getItem(ASIDE_KEY)).toBe('{}');
  });

  it('stays in the entry when it cannot be put aside', async () => {
    const { registry } = await load();
    const token = tokenFor('owner');
    registry.upsert({ id: 'a', name: 'Mine', token, role: 'owner' });
    storage.quota = storage.getItem(KEY)!.length + 5;
    expect(registry.setLinkAside('a')).toBe(false);
    expect(registry.get('a')!.token).toBe(token);
    expect(stored()[0].token).toBe(token);
    expect(registry.linkAside('a')).toBeNull();
  });

  it('is let go of only once the entry that carries it again is in storage', async () => {
    const { registry } = await load();
    const token = tokenFor('owner');
    registry.upsert({ id: 'a', name: 'Mine', token, role: 'owner' });
    registry.setLinkAside('a');
    // Nothing has taken its place yet.
    registry.releaseLinkAside('a');
    expect(registry.linkAside('a')).toMatchObject({ token });

    // The server takes the link again, but storage has no room for a list with the link in it.
    storage.quota = storage.getItem(KEY)!.length + storage.getItem(ASIDE_KEY)!.length + 5;
    registry.upsert({ id: 'a', token, role: 'owner' });
    expect(registry.saved()).toBe(false);
    registry.releaseLinkAside('a');
    expect(registry.get('a')!.token).toBe(token);
    expect(stored()[0].token).toBeNull();
    expect(JSON.parse(storage.getItem(ASIDE_KEY)!).a.token).toBe(token);
    // So a reload finds it where it was kept.
    const later = await load();
    expect(later.registry.get('a')!.token).toBeNull();
    expect(later.registry.linkAside('a')).toMatchObject({ token, role: 'owner' });

    // Once the list is saved with the link, one copy is enough.
    storage.quota = Infinity;
    later.registry.upsert({ id: 'a', token, role: 'owner' });
    later.registry.releaseLinkAside('a');
    expect(stored()[0].token).toBe(token);
    expect(later.registry.linkAside('a')).toBeNull();
    expect(storage.getItem(ASIDE_KEY)).toBe('{}');
  });

  it('reads the role off a link that was stored without one', async () => {
    const { registry } = await load();
    registry.upsert({ id: 'a', token: tokenFor('commenter') });
    registry.setLinkAside('a');
    expect(registry.linkAside('a')!.role).toBe('commenter');
    registry.upsert({ id: 'b', token: 'not-a-token' });
    registry.setLinkAside('b');
    expect(registry.linkAside('b')!.role).toBe('viewer');
  });

  it('is not pushed out by a lesser link that is refused later', async () => {
    const { registry } = await load();
    const owner = tokenFor('owner');
    registry.upsert({ id: 'a', token: owner, role: 'owner' });
    registry.setLinkAside('a');
    registry.upsert({ id: 'a', token: tokenFor('viewer'), role: 'viewer' });
    expect(registry.setLinkAside('a')).toBe(true);
    expect(registry.get('a')!.token).toBeNull();
    expect(registry.linkAside('a')!.token).toBe(owner);

    // One that allows as much or more takes its place.
    const newer = tokenFor('owner', 2);
    registry.upsert({ id: 'a', token: newer, role: 'owner' });
    registry.setLinkAside('a');
    expect(registry.linkAside('a')!.token).toBe(newer);
  });

  it('makes nothing of junk kept under its key', async () => {
    for (const junk of ['[]', '7', 'not json', '{"a":null,"b":{"token":5},"c":{"token":""}}']) {
      storage.data.set(ASIDE_KEY, junk);
      const { registry } = await load();
      for (const id of ['a', 'b', 'c']) expect(registry.linkAside(id)).toBeNull();
    }
    storage.data.set(ASIDE_KEY, JSON.stringify({ a: { token: tokenFor('editor'), role: 'admin' } }));
    const { registry } = await load();
    expect(registry.linkAside('a')).toEqual({ token: tokenFor('editor'), role: 'editor', refusedAt: 0 });
  });
});

describe('the stored profile', () => {
  it('is read like anyone else’s presence', async () => {
    storage.data.set('tandem.user.v1', JSON.stringify({ id: 'me1', name: 7, color: 'url(x)' }));
    const { getUser } = await load();
    expect(getUser()).toEqual({ id: 'me1', name: 'Guest', color: colorForId('me1') });
  });

  it('is made anew when nothing usable is stored', async () => {
    storage.data.set('tandem.user.v1', '"junk"');
    const { getUser } = await load();
    const user = getUser();
    expect(user.id).toHaveLength(10);
    expect(user.color).toBe(colorForId(user.id));
    expect(JSON.parse(storage.getItem('tandem.user.v1')!)).toEqual(user);
  });
});
