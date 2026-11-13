/**
 * What a connection and a room may make the server hold and send.
 *
 * Every participant, a viewer included, can make the server work: it stores their presence, keeps
 * the document they write in memory and queues whatever they have not read yet. Each of those is
 * bounded here, so that the worst a link can do is use up its own allowance.
 *
 *   document    bytes one document may hold, and all loaded documents together
 *   presence    one entry per connection, bytes per update, updates and bytes per second, and
 *               what the connections made with one link, and a room, show taken together
 *   sending     document copies queued for clients that have not read them yet
 */
import { getHeapStatistics } from 'node:v8';
import type { DocKind } from '@tandem/core';

const MIB = 1024 * 1024;

/**
 * A project document never shrinks: every edit leaves about fifteen bytes behind for good. Two
 * thousand clips are a third of a megabyte when new and one and a half after eighty thousand
 * edits, so this is room for some two million edits.
 */
export const DEFAULT_MAX_PROJECT_DOC_BYTES = 32 * MIB;
/** A comment is a few hundred bytes; this is several thousand of them with their replies. */
export const DEFAULT_MAX_REVIEW_DOC_BYTES = 2 * MIB;
/**
 * A document is also held to one struct (Yjs's unit of change) per this many bytes of its limit.
 * Memory goes by structs, 250 to 700 bytes of heap each however little they say, and an ordinary
 * project averages thirteen to twenty-five bytes per struct. Without this a document of minimal
 * structs would cost several times the memory its size suggests.
 */
export const STRUCT_BYTES = 16;
/**
 * A stored document is loaded up to this many times its limit. Updates are refused at the
 * limit, but its size is only measured now and then. In between it is taken to be the sum of
 * the updates applied, which is not quite it: structs that an update cuts in two encode larger
 * than the update did. And after a crash the log can repeat what the snapshot already holds.
 * Whatever the server wrote itself must load again, which is also why no document's limit is
 * more than this fraction of what all loaded documents may hold together.
 */
export const LOAD_HEADROOM = 2;
/**
 * Presence carries the whole selection and the clips being dragged, which for a select-all in a
 * large project is a few hundred kilobytes. The editor's usual update is a few hundred bytes.
 */
export const DEFAULT_MAX_PRESENCE_BYTES = 256 * 1024;
export const DEFAULT_MAX_SYNC_BACKLOG_BYTES = 128 * MIB;

/**
 * At one struct per STRUCT_BYTES a document costs up to about forty times its size limit in heap
 * (some fifteen times its size for an ordinary project), so a hundredth of the heap for all
 * loaded documents keeps even the worst case under half of it.
 */
export function defaultMaxOpenDocBytes(): number {
  return Math.floor(getHeapStatistics().heap_size_limit / 100);
}

export interface Limits {
  /** Sockets one room holds at a time. */
  maxConnectionsPerRoom: number;
  /**
   * Encoded size a document may reach, by kind. It may hold one struct per STRUCT_BYTES of it.
   * See `docLimit` for how far a configured value goes.
   */
  maxDocBytes: Record<DocKind, number>;
  /** The same for all documents that are loaded at the same time, taken together. */
  maxOpenDocBytes: number;
  /** Size of one presence update, and of what the connections made with one link show in a room. */
  maxPresenceBytes: number;
  /** Document copies queued for clients that have not read them yet, across all rooms. */
  maxSyncBacklogBytes: number;
}

/**
 * The limit of one document on a server that holds `maxOpenDocBytes` of them in all: what was
 * asked for, as far as a document loaded with its headroom still fits the server by itself.
 */
export function docLimit(configured: number, maxOpenDocBytes: number): number {
  return Math.min(configured, Math.floor(maxOpenDocBytes / LOAD_HEADROOM));
}

/** A running total that must stay under a limit, shared by everything that draws on it. */
export class Budget {
  private total = 0;

  constructor(readonly limit: number) {}

  get used(): number {
    return this.total;
  }

  fits(amount: number): boolean {
    return this.total + amount <= this.limit;
  }

  /** Add to the total, or give back with a negative amount. */
  add(amount: number): void {
    this.total = Math.max(0, this.total + amount);
  }
}

/**
 * A token bucket: `perSecond` units trickle in, up to `burst` can be saved up. A burst allowance
 * matters because clients do send in bursts (a reconnect announces presence twice at once).
 */
export class Allowance {
  private available: number;
  private updatedAt: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.available = burst;
    this.updatedAt = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.available = Math.min(this.burst, this.available + (elapsed / 1000) * this.perSecond);
    this.updatedAt = now;
  }

  has(cost: number, now = Date.now()): boolean {
    this.refill(now);
    return this.available >= cost;
  }

  /** Spend `cost`. Call only after `has(cost)` said yes. */
  spend(cost: number): void {
    this.available -= cost;
  }
}
