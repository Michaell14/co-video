import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { ProjectStore, makeClip, newId } from '@tandem/core';
import { measureUpdate, sameSetAside, setAside, weigh, weightOf } from '../src/updateSize';

/** Structs a document holds, straight from Yjs's own store. */
function held(doc: Y.Doc): number {
  let structs = 0;
  for (const client of doc.store.clients.values()) structs += client.length;
  return structs;
}

/** A document with every kind of content Yjs encodes today, built in several transactions. */
function documentOfEverything(gc: boolean): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc({ gc });
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));

  const map = doc.getMap<unknown>('map');
  map.set('string', 'Rough cut');
  map.set('number', 24);
  map.set('object', { nested: [1, 2, { three: null }], flag: true, big: 2 ** 40, real: 0.5 });
  map.set('binary', new Uint8Array([1, 2, 3, 250]));
  map.set('string', 'Fine cut');
  const inner = new Y.Map<unknown>();
  map.set('inner', inner);
  inner.set('array', new Y.Array<number>());
  (inner.get('array') as Y.Array<number>).push([1, 2, 3]);
  map.set('subdocument', new Y.Doc({ guid: 'sub-1', meta: { title: 'nested' } }));

  const array = doc.getArray<unknown>('array');
  array.push(['a', 'b', 'c', 'd', 'e']);
  array.insert(2, [{ x: 1 }, new Uint8Array(40)]);
  array.delete(1, 3);
  array.push([null, 'ünïcödé 🎬']);

  const text = doc.getText('text');
  text.insert(0, 'The quick brown fox jumps over the lazy dog 🎬 and on');
  text.format(4, 5, { bold: true });
  text.insert(10, 'ish');
  text.insertEmbed(3, { image: 'frame.png' });
  text.delete(20, 6);

  const xml = doc.getXmlFragment('xml');
  const element = new Y.XmlElement('clip');
  element.setAttribute('id', 'c1');
  element.insert(0, [new Y.XmlText('caption'), new Y.XmlElement('effect')]);
  // The typings leave hooks out of what a fragment takes; Yjs itself does not.
  xml.insert(0, [element, new Y.XmlHook('hook') as unknown as Y.XmlElement]);
  xml.delete(1, 1);
  return { doc, updates };
}

/** A project as the editor writes it: two thousand clips and a round of edits to them. */
function projectDocument(): Y.Doc {
  const doc = new Y.Doc();
  const store = new ProjectStore(doc);
  store.initIfEmpty();
  const track = Object.values(store.get().tracks)[0];
  const ids: string[] = [];
  for (let i = 0; i < 2000; i += 100) {
    store.commit(
      Array.from({ length: 100 }, (_, j) => {
        const id = newId();
        ids.push(id);
        return {
          op: 'addClip' as const,
          clip: makeClip('video', track.id, { id, start: (i + j) * 60, duration: 60, name: `Clip ${i + j}` }),
        };
      }),
    );
  }
  for (let i = 0; i < 500; i++) {
    store.commit([
      { op: 'updateClip', id: ids[(i * 37) % ids.length], patch: { start: i * 7, opacity: 0.5 } },
    ]);
  }
  store.destroy();
  return doc;
}

/** A small deterministic generator, so that a failure can be reproduced. */
function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % below;
  };
}

describe('measureUpdate', () => {
  it('counts the structs of an update as Yjs decodes them', () => {
    for (const gc of [true, false]) {
      const { doc, updates } = documentOfEverything(gc);
      const whole = Y.encodeStateAsUpdate(doc);
      // A merge of updates that are not next to each other carries gaps as structs of their own.
      const gappy = Y.mergeUpdates([updates[0], updates[updates.length - 1]]);
      const sinceHalfway = Y.diffUpdate(
        whole,
        Y.encodeStateVectorFromUpdate(Y.mergeUpdates(updates.slice(0, 9))),
      );
      for (const update of [whole, gappy, sinceHalfway, ...updates]) {
        expect(measureUpdate(update, new Y.Doc()).structs).toBe(Y.decodeUpdate(update).structs.length);
      }
      expect(measureUpdate(whole, new Y.Doc()).subdocuments).toBe(1);
    }
  });

  it('reads the legacy JSON content that old documents can still hold', () => {
    // No current client writes this content type, so the update is put together by hand: one
    // item on the root array "legacy" holding two JSON values, and an empty delete set.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // one client
    encoding.writeVarUint(encoder, 1); // one struct
    encoding.writeVarUint(encoder, 77); // client id
    encoding.writeVarUint(encoder, 0); // first clock
    encoding.writeUint8(encoder, 2); // JSON content, no neighbours
    encoding.writeVarUint(encoder, 1); // the parent is a root type, named next
    encoding.writeVarString(encoder, 'legacy');
    encoding.writeVarUint(encoder, 2);
    encoding.writeVarString(encoder, '{"a":1}');
    encoding.writeVarString(encoder, '"two"');
    encoding.writeVarUint(encoder, 0);
    const update = encoding.toUint8Array(encoder);

    const doc = new Y.Doc();
    expect(measureUpdate(update, doc)).toEqual({ structs: 1, splits: 0, subdocuments: 0 });
    Y.applyUpdate(doc, update);
    expect(doc.getArray('legacy').toJSON()).toEqual([{ a: 1 }, 'two']);
    // The item spans two clocks: whatever comes next for this client begins at 2.
    const next = new Y.Doc();
    next.clientID = 77;
    Y.applyUpdate(next, update);
    next.getArray('legacy').push(['three']);
    const more = Y.encodeStateAsUpdate(next, Y.encodeStateVector(doc));
    expect(measureUpdate(more, doc)).toEqual({ structs: 1, splits: 0, subdocuments: 0 });
  });

  it('finds nothing to cut in a whole document, and nothing at all in the handshake of a client that is up to date', () => {
    const { doc, updates } = documentOfEverything(true);
    expect(measureUpdate(Y.encodeStateAsUpdate(doc), new Y.Doc()).splits).toBe(0);
    // Taken one edit at a time, the same document does need cuts: formatting the middle of a
    // sentence cuts the sentence, here as at the client that did it.
    const replica = new Y.Doc();
    let cuts = 0;
    for (const update of updates) {
      const size = measureUpdate(update, replica);
      const before = held(replica);
      Y.applyUpdate(replica, update);
      expect(held(replica) - before).toBeLessThanOrEqual(weightOf(size));
      cuts += size.splits;
    }
    expect(cuts).toBeGreaterThan(0);
    expect(cuts).toBeLessThan(40);

    const project = projectDocument();
    const whole = Y.encodeStateAsUpdate(project);
    const size = measureUpdate(whole, new Y.Doc());
    expect(size).toEqual({ structs: Y.decodeUpdate(whole).structs.length, splits: 0, subdocuments: 0 });
    const server = new Y.Doc();
    Y.applyUpdate(server, whole);
    expect(held(server)).toBe(size.structs);
    expect(weigh(server)).toBe(held(server));

    // The handshake: no structs, and every deletion the client knows of.
    const handshake = Y.encodeStateAsUpdate(project, Y.encodeStateVector(server));
    expect(Y.decodeUpdate(handshake).ds.clients.size).toBeGreaterThan(0);
    expect(weightOf(measureUpdate(handshake, server))).toBe(0);
  });

  it('keeps books that are never below what a document holds, whatever order updates arrive in', () => {
    // Three clients edit text, a map and an array at random and exchange updates at random. The
    // server gets every update at some point, late ones included, and keeps count the way a
    // room does: the weight of each update as measured beforehand, and a fresh count whenever
    // Yjs has set something aside.
    const next = random(20240607);
    const clients = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    const server = new Y.Doc();
    const outbox: Uint8Array[] = [];
    const inboxes: Uint8Array[][] = clients.map(() => []);
    clients.forEach((client, i) =>
      client.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'remote') return;
        outbox.push(update);
        inboxes.forEach((inbox, j) => j !== i && inbox.push(update));
      }),
    );

    let books = 0;
    let cuts = 0;
    let recounts = 0;
    for (let step = 0; step < 1500; step++) {
      const i = next(clients.length);
      const client = clients[i];
      const text = client.getText('script');
      const map = client.getMap<number>('fields');
      const array = client.getArray<number>('track');
      switch (next(8)) {
        case 0:
        case 1:
          text.insert(next(text.length + 1), 'xyz'.repeat(1 + next(5)));
          break;
        case 2:
          if (text.length > 0) text.delete(next(text.length), 1 + next(Math.min(4, text.length)));
          break;
        case 3:
          if (text.length > 2) text.format(next(text.length - 1), 1 + next(3), { bold: next(2) === 0 });
          break;
        case 4:
          map.set(`k${next(12)}`, step);
          break;
        case 5:
          array.insert(next(array.length + 1), [step, step + 1]);
          break;
        case 6:
          if (array.length > 0) array.delete(next(array.length), 1);
          break;
        default:
          for (const update of inboxes[i].splice(0)) Y.applyUpdate(client, update, 'remote');
      }
      // The server takes a random one of the updates it has not seen, not the oldest.
      while (outbox.length > 0 && next(3) > 0) {
        const [update] = outbox.splice(next(outbox.length), 1);
        const size = measureUpdate(update, server);
        expect(size.structs).toBe(Y.decodeUpdate(update).structs.length);
        const waiting = setAside(server);
        Y.applyUpdate(server, update);
        if (!sameSetAside(waiting, setAside(server))) {
          books = weigh(server);
          recounts++;
        } else {
          books += weightOf(size);
        }
        expect(weigh(server), `step ${step}`).toBeLessThanOrEqual(books);
        cuts += size.splits;
      }
    }
    for (const update of outbox) Y.applyUpdate(server, update);
    for (const [i, client] of clients.entries()) {
      for (const update of inboxes[i]) Y.applyUpdate(client, update, 'remote');
      expect(client.getText('script').toString()).toBe(server.getText('script').toString());
    }
    // The run did exercise what it is about: text was cut, and updates waited for others.
    expect(cuts).toBeGreaterThan(50);
    expect(recounts).toBeGreaterThan(50);
    expect(held(server)).toBeGreaterThan(500);
    // And the books are not far above the truth either.
    expect(books).toBeLessThan(2 * weigh(server));
  });

  it('counts a few bytes of deletions as the many structs they make', () => {
    const author = new Y.Doc();
    author.getText('t').insert(0, 'x'.repeat(20_000));
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(author));

    const before = Y.encodeStateVector(author);
    author.transact(() => {
      for (let i = 4999; i >= 0; i--) author.getText('t').delete(i * 4, 1);
    });
    const update = Y.encodeStateAsUpdate(author, before);
    const size = measureUpdate(update, server);
    expect(size.structs).toBe(0);
    Y.applyUpdate(server, update);
    // Two structs for every three or four bytes of the update: its size says nothing about this.
    expect(held(server)).toBeGreaterThan(update.byteLength / 2);
    expect(size.splits).toBeGreaterThanOrEqual(held(server) - 1);
    expect(size.splits).toBeLessThanOrEqual(held(server) + 1);
    // Said again, the same deletions cut nothing.
    expect(weightOf(measureUpdate(update, server))).toBe(0);
  });

  it('counts the cuts an update makes in the structs it brings itself', () => {
    // What no client would encode: one long string and, in the same update, items placed in the
    // middle of it and deletions inside it. Built by merging what a client did in two steps
    // with the first step left whole.
    const author = new Y.Doc();
    author.getText('t').insert(0, 'x'.repeat(4000));
    const first = Y.encodeStateAsUpdate(author);
    const before = Y.encodeStateVector(author);
    author.transact(() => {
      for (let i = 0; i < 300; i++) author.getText('t').insert(i * 9 + 4, 'y');
      for (let i = 0; i < 200; i++) author.getText('t').delete(i * 5 + 2000, 1);
    });
    const second = Y.encodeStateAsUpdate(author, before);
    const both = Y.mergeUpdates([first, second]);

    const server = new Y.Doc();
    const size = measureUpdate(both, server);
    Y.applyUpdate(server, both);
    expect(held(server)).toBeGreaterThan(900);
    expect(held(server)).toBeLessThanOrEqual(weightOf(size));
  });

  it('weighs a subdocument as the document it is', () => {
    const author = new Y.Doc();
    author.transact(() => {
      for (let i = 0; i < 50; i++) author.getArray('docs').push([new Y.Doc({ guid: `sub-${i}` })]);
    });
    const update = Y.encodeStateAsUpdate(author);
    const server = new Y.Doc();
    const size = measureUpdate(update, server);
    expect(size.subdocuments).toBe(50);
    expect(weightOf(size)).toBe(50 + 8 * 50);
    Y.applyUpdate(server, update);
    expect(weigh(server)).toBe(weightOf(size));
  });

  it('refuses an update that is cut short, wherever the cut is', () => {
    const { doc } = documentOfEverything(true);
    const whole = Y.encodeStateAsUpdate(doc);
    // A copy with other data behind it, as a message has in a buffer it shares with the next one.
    const shared = new Uint8Array(whole.byteLength * 2).fill(1);
    shared.set(whole);
    for (let length = 0; length < whole.byteLength; length++) {
      expect(() => measureUpdate(shared.subarray(0, length), new Y.Doc()), `cut at ${length}`).toThrow();
    }
    expect(measureUpdate(shared.subarray(0, whole.byteLength), new Y.Doc()).structs).toBe(
      Y.decodeUpdate(whole).structs.length,
    );
  });
});

describe('weigh', () => {
  it('includes what updates waiting for missing structs can still add', () => {
    const author = new Y.Doc();
    author.getText('t').insert(0, 'x'.repeat(4000));
    const text = Y.encodeStateAsUpdate(author);
    const before = Y.encodeStateVector(author);
    author.transact(() => {
      for (let i = 999; i >= 0; i--) author.getText('t').delete(i * 4, 1);
    });
    const deletions = Y.encodeStateAsUpdate(author, before);

    // The deletions arrive first. Yjs sets them aside: there is nothing yet for them to delete.
    const server = new Y.Doc();
    const cost = weightOf(measureUpdate(deletions, server));
    expect(cost).toBeGreaterThanOrEqual(1999);
    Y.applyUpdate(server, deletions);
    expect(held(server)).toBe(0);
    expect(weigh(server)).toBeGreaterThanOrEqual(cost);

    // Then the text does, and what was set aside cuts it up without another update.
    const textCost = weightOf(measureUpdate(text, server));
    Y.applyUpdate(server, text);
    expect(held(server)).toBeGreaterThan(1000);
    expect(held(server)).toBeLessThanOrEqual(cost + textCost);
    expect(textCost).toBe(1);
    expect(server.store.pendingDs).toBeNull();
    expect(weigh(server)).toBe(held(server));
  });
});
