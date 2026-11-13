/**
 * Scheduling of media uploads and downloads.
 *
 * Every transfer is a long request to the same origin the preview streams from and the API lives
 * on, and a browser opens only six connections to one host. So only a few transfers run at a time,
 * most urgent first, which always leaves connections free for range requests and API calls.
 * Transfers that fail are tried again by themselves, at growing intervals.
 *
 * A `check` is the question that comes before a transfer nobody knows to be possible: does the
 * server hold a file that the project says was never uploaded? It is one short request, and it is
 * scheduled and tried again like the rest.
 */
import { clipEnd, type Asset, type Project } from '@tandem/core';
import type { TransferResult } from './mediaStore';

export type TransferKind = 'upload' | 'download' | 'check';

export interface Transfer {
  kind: TransferKind;
  assetId: string;
}

/**
 * Transfers running at once, per kind. Uploads and downloads together leave two of six connections
 * free; checks go one at a time and are over at once.
 */
export const TRANSFER_SLOTS: Record<TransferKind, number> = { upload: 2, download: 2, check: 1 };

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 60_000;

interface Failure {
  attempts: number;
  /** When to try again (`performance.now()` time); `Infinity` until someone asks for it. */
  retryAt: number;
}

const keyOf = (t: Transfer): string => `${t.kind}:${t.assetId}`;

export class TransferQueue {
  private wanted: Transfer[] = [];
  private readonly running = new Map<string, TransferKind>();
  private readonly failures = new Map<string, Failure>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly run: (transfer: Transfer) => Promise<TransferResult>,
    private readonly slots: Record<TransferKind, number> = TRANSFER_SLOTS,
  ) {}

  /**
   * Say what should be transferred, most urgent first. This replaces the previous list: something
   * left out is no longer started (a transfer already under way is for its owner to stop).
   */
  want(transfers: Transfer[]): void {
    this.wanted = transfers;
    const keys = new Set(transfers.map(keyOf));
    for (const key of this.failures.keys()) if (!keys.has(key)) this.failures.delete(key);
    this.pump();
  }

  /**
   * Stop waiting and try failed transfers again now: all of them (the connection is back), or the
   * ones of a single asset (the user asked).
   */
  retryNow(assetId?: string): void {
    for (const [key, failure] of this.failures) {
      if (assetId === undefined || key.endsWith(`:${assetId}`)) failure.retryAt = 0;
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = performance.now();
    const busy: Record<TransferKind, number> = { upload: 0, download: 0, check: 0 };
    for (const kind of this.running.values()) busy[kind]++;
    let wake = Infinity;
    for (const transfer of this.wanted) {
      const key = keyOf(transfer);
      if (this.running.has(key)) continue;
      const retryAt = this.failures.get(key)?.retryAt ?? 0;
      if (retryAt > now) {
        wake = Math.min(wake, retryAt);
        continue;
      }
      if (busy[transfer.kind] >= this.slots[transfer.kind]) continue;
      busy[transfer.kind]++;
      this.start(transfer, key);
    }
    if (wake !== Infinity) this.timer = setTimeout(() => this.pump(), wake - now);
  }

  private start(transfer: Transfer, key: string): void {
    this.running.set(key, transfer.kind);
    void this.run(transfer)
      .catch((): TransferResult => 'retry')
      .then((result) => {
        this.running.delete(key);
        if (result === 'done') {
          this.failures.delete(key);
          // The list is only as fresh as the last `want`; without this it would start over at once.
          this.wanted = this.wanted.filter((t) => keyOf(t) !== key);
        } else {
          const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
          const wait = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));
          this.failures.set(key, {
            attempts,
            retryAt: result === 'retry' ? performance.now() + wait : Infinity,
          });
        }
        this.pump();
      });
  }
}

/**
 * Orders assets by how soon the person editing will miss them: what is under the playhead first,
 * then what is nearest to it on the timeline, and last what is only in the pool.
 */
export function byUrgency(p: Project, playhead: number): (a: Asset, b: Asset) => number {
  const distance = new Map<string, number>();
  for (const c of Object.values(p.clips)) {
    const d = Math.max(0, c.start - playhead, playhead - (clipEnd(c) - 1));
    for (const id of [c.assetId, c.grade?.lutId]) {
      if (id) distance.set(id, Math.min(distance.get(id) ?? Infinity, d));
    }
  }
  const of = (a: Asset): number => distance.get(a.id) ?? Infinity;
  // Infinity - Infinity is NaN, so equal distances are settled before subtracting.
  return (a, b) => (of(a) === of(b) ? a.createdAt - b.createdAt : of(a) < of(b) ? -1 : 1);
}

/**
 * `next`, about to take the open project's place, with what is known about uploads carried over.
 * A snapshot says what was uploaded when it was taken; a file that reached the server since is
 * still there. Everyone without a copy of their own goes by this flag, so one that fell back to
 * "not uploaded" would put the media out of their reach.
 */
export function keepUploads(next: Project, open: Project): Project {
  const assets = Object.values(next.assets).map((a) => [
    a.id,
    { ...a, uploaded: a.uploaded || !!open.assets[a.id]?.uploaded },
  ]);
  return { ...next, assets: Object.fromEntries(assets) };
}
