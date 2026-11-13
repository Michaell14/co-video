/**
 * What a Yjs update will cost a document, read off its encoding before any of it is applied.
 *
 * A document's memory is spent on structs (Yjs's unit of change), not on bytes: a struct takes a
 * few hundred bytes of heap however little it says, and four bytes of a delete set can cut one
 * struct into three. Yjs cannot take an update back out, so the count has to be known up front.
 * `Y.decodeUpdate` would tell, but it builds every struct first, which is the very cost to avoid,
 * and it builds them even for an update that turns out to be cut short.
 *
 * This walks the v1 update format (the one y-protocols puts on the wire and `Y.encodeStateAsUpdate`
 * writes), skips over content instead of decoding it, and works out where the update would cut
 * structs in two: an item cuts the struct it is inserted into, a deleted range the structs its
 * ends fall into. A well-formed client never asks for a cut in what the document already holds
 * in pieces, so for ordinary updates the answer is simply the structs they carry.
 */
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';

export interface UpdateSize {
  /** Structs the update carries. */
  structs: number;
  /** Structs it adds on top by cutting ones that exist, at most. */
  splits: number;
  /** How many of its structs are documents of their own. */
  subdocuments: number;
}

/**
 * A subdocument is a whole Yjs document hanging off one struct, some 2.4 kB of heap where an
 * ordinary struct takes a few hundred bytes. It is weighed as this many structs more.
 */
const SUBDOCUMENT_STRUCTS = 8;

/** What an update adds to a document's weight (see `weigh`), at most. */
export const weightOf = ({ structs, splits, subdocuments }: UpdateSize): number =>
  structs + splits + SUBDOCUMENT_STRUCTS * subdocuments;

const CONTENT_TYPE = 0b11111;
const HAS_RIGHT_ORIGIN = 0b01000000;
const HAS_LEFT_ORIGIN = 0b10000000;
const HAS_PARENT_SUB = 0b00100000;
/** Shared types that carry a name of their own (YXmlElement, YXmlHook). */
const NAMED_TYPE_REFS = [3, 5];

/** The structs an update carries for one client: where each starts, and where the last one ends. */
interface Run {
  starts: number[];
  end: number;
}

function skipBytes(decoder: decoding.Decoder): void {
  const length = decoding.readVarUint(decoder);
  decoder.pos += length;
}

/** Skip an item's content and return how many clocks it spans. */
function skipContent(decoder: decoding.Decoder, type: number): number {
  switch (type) {
    case 1: // deleted: a length
      return decoding.readVarUint(decoder);
    case 2: {
      // JSON: a list of strings
      const length = decoding.readVarUint(decoder);
      for (let n = length; n > 0; n--) skipBytes(decoder);
      return length;
    }
    case 4: // string: one clock per UTF-16 unit, as Yjs counts them once it has decoded it
      return decoding.readVarString(decoder).length;
    case 3: // binary
    case 5: // embed: one JSON string
      skipBytes(decoder);
      return 1;
    case 6: // format: key and JSON value
      skipBytes(decoder);
      skipBytes(decoder);
      return 1;
    case 7: // a nested shared type
      if (NAMED_TYPE_REFS.includes(decoding.readVarUint(decoder))) skipBytes(decoder);
      return 1;
    case 8: {
      // any: a list of values
      const length = decoding.readVarUint(decoder);
      for (let n = length; n > 0; n--) decoding.readAny(decoder);
      return length;
    }
    case 9: // subdocument: guid and options
      skipBytes(decoder);
      decoding.readAny(decoder);
      return 1;
    default:
      throw new Error(`unknown content type ${type}`);
  }
}

function includes(sorted: number[], value: number): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] === value) return true;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}

/**
 * Structs an update carries, and how many more it makes of the ones `doc` holds or the update
 * brings itself. Throws on an update that is cut short or that uses an encoding Yjs does not have;
 * whatever else is wrong with one is for Yjs to find.
 */
export function measureUpdate(update: Uint8Array, doc: Y.Doc): UpdateSize {
  const decoder = decoding.createDecoder(update);
  // Skipping moves the position without looking, and a single byte read past the end is just
  // `undefined`, so the position is what tells a truncated update from a complete one.
  const assertInside = (): void => {
    if (decoder.pos > update.byteLength) throw new Error('update ends in the middle of a struct');
  };
  const runs = new Map<number, Run>();
  /** Where an item of the update needs a struct to begin: client and clock, in pairs. */
  const neighbours: number[] = [];
  let structs = 0;
  let subdocuments = 0;

  for (let clients = decoding.readVarUint(decoder); clients > 0; clients--) {
    let count = decoding.readVarUint(decoder);
    const client = decoding.readVarUint(decoder);
    let clock = decoding.readVarUint(decoder);
    const run: Run = { starts: [], end: clock };
    runs.set(client, run);
    for (; count > 0; count--) {
      const info = decoding.readUint8(decoder);
      assertInside();
      const type = info & CONTENT_TYPE;
      structs++;
      run.starts.push(clock);
      if (type === 0 || type === 10) {
        clock += decoding.readVarUint(decoder); // garbage-collected range or gap: a length
        continue;
      }
      if (info & HAS_LEFT_ORIGIN) {
        // The id of the last clock of the left neighbour: the struct after it begins one further.
        neighbours.push(decoding.readVarUint(decoder), decoding.readVarUint(decoder) + 1);
      }
      if (info & HAS_RIGHT_ORIGIN) {
        neighbours.push(decoding.readVarUint(decoder), decoding.readVarUint(decoder));
      }
      if ((info & (HAS_LEFT_ORIGIN | HAS_RIGHT_ORIGIN)) === 0) {
        // With no neighbour to copy it from, the parent is spelled out: a root name or an id.
        if (decoding.readVarUint(decoder) === 1) {
          skipBytes(decoder);
        } else {
          decoding.readVarUint(decoder);
          decoding.readVarUint(decoder);
        }
        if (info & HAS_PARENT_SUB) skipBytes(decoder);
      }
      if (type === 9) subdocuments++;
      clock += skipContent(decoder, type);
      assertInside();
    }
    run.end = clock;
  }

  /**
   * Whether a struct begins at `clock` once the update is in, so that nothing has to be cut
   * there. Unknown territory (structs neither the document nor the update has) counts as "no":
   * Yjs sets such references aside and acts on them when the structs arrive.
   */
  const begins = (client: number, clock: number, deletedIsNotCut: boolean): boolean => {
    const held = doc.store.clients.get(client) ?? [];
    const last = held[held.length - 1];
    const known = last ? last.id.clock + last.length : 0;
    if (clock < known) {
      const struct = held[Y.findIndexSS(held, clock)];
      // What is garbage-collected is never cut; what is merely deleted is not cut by a deletion.
      return struct.id.clock === clock || struct instanceof Y.GC || (deletedIsNotCut && struct.deleted);
    }
    const run = runs.get(client);
    if (run && clock >= run.starts[0] && clock < run.end) return includes(run.starts, clock);
    return clock === known || clock === run?.end;
  };

  let splits = 0;
  for (let i = 0; i < neighbours.length; i += 2) {
    if (!begins(neighbours[i], neighbours[i + 1], false)) splits++;
  }
  for (let clients = decoding.readVarUint(decoder); clients > 0; clients--) {
    const client = decoding.readVarUint(decoder);
    for (let ranges = decoding.readVarUint(decoder); ranges > 0; ranges--) {
      const clock = decoding.readVarUint(decoder);
      const length = decoding.readVarUint(decoder);
      if (!begins(client, clock, true)) splits++;
      if (!begins(client, clock + length, true)) splits++;
    }
  }
  return { structs, splits, subdocuments };
}

/**
 * Weights add up to more than a document comes to hold: Yjs also joins structs back together,
 * and what one update overwrites the next one may collect. Whoever keeps a running total should
 * weigh the document itself again after adding this much to it.
 */
export const RECOUNT_AFTER_STRUCTS = 4096;

/**
 * What Yjs has set aside in a document for later. Compare before and after an update with
 * `sameSetAside` to learn whether the update added to it or let some of it through.
 */
export function setAside(doc: Y.Doc): readonly [Uint8Array | undefined, Uint8Array | null] {
  return [doc.store.pendingStructs?.update, doc.store.pendingDs];
}

export const sameSetAside = (a: ReturnType<typeof setAside>, b: ReturnType<typeof setAside>): boolean =>
  a[0] === b[0] && a[1] === b[1];

/** Stands in for a document of which nothing is known. */
const UNKNOWN = new Y.Doc();

/**
 * The weight of a document: the structs it holds (subdocuments counted for what they cost), plus
 * the ones it can still come to hold without another update. Yjs sets aside what refers to
 * structs it has not seen yet, and applies it when they arrive.
 */
export function weigh(doc: Y.Doc): number {
  let weight = SUBDOCUMENT_STRUCTS * doc.subdocs.size;
  for (const client of doc.store.clients.values()) weight += client.length;
  for (const waiting of setAside(doc)) {
    if (!waiting) continue;
    // Kept in the v2 format; converting streams struct by struct, like the walk above. Weighed
    // as if it could cut wherever it points: where the document's structs begin and end today
    // says little about the day this is applied, since Yjs also joins structs back together.
    weight += weightOf(measureUpdate(Y.convertUpdateFormatV2ToV1(waiting), UNKNOWN));
  }
  return weight;
}
