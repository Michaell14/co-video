import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, ASSET_DEFAULTS, emptyProject, makeClip, makeTrack, type Asset } from '@tandem/core';
import type { TransferResult } from '../src/session/mediaStore';
import { byUrgency, TransferQueue, TRANSFER_SLOTS, type Transfer } from '../src/session/transfers';

/** A runner whose transfers finish when the test says so. */
function runner() {
  const started: string[] = [];
  const open = new Map<string, (r: TransferResult) => void>();
  const run = (t: Transfer): Promise<TransferResult> => {
    const key = `${t.kind}:${t.assetId}`;
    started.push(key);
    return new Promise((resolve) => open.set(key, resolve));
  };
  const finish = async (key: string, result: TransferResult): Promise<void> => {
    const resolve = open.get(key);
    if (!resolve) throw new Error(`${key} is not running`);
    open.delete(key);
    resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { started, open, run, finish };
}

const downloads = (n: number): Transfer[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'download' as const, assetId: `d${i}` }));

describe('TransferQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves connections free: a few transfers at a time, in the order given', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want([
      ...downloads(9),
      { kind: 'upload', assetId: 'u0' },
      { kind: 'upload', assetId: 'u1' },
      { kind: 'upload', assetId: 'u2' },
    ]);
    expect(r.started).toEqual(['download:d0', 'download:d1', 'upload:u0', 'upload:u1']);
    expect(r.open.size).toBe(TRANSFER_SLOTS.download + TRANSFER_SLOTS.upload);
    expect(r.open.size).toBeLessThanOrEqual(4);

    await r.finish('download:d0', 'done');
    expect(r.started.at(-1)).toBe('download:d2');
    await r.finish('upload:u1', 'done');
    expect(r.started.at(-1)).toBe('upload:u2');
    expect(r.open.size).toBe(4);
    q.stop();
  });

  it('does not start a finished transfer again while it is still on the list', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(1));
    await r.finish('download:d0', 'done');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.started).toEqual(['download:d0']);
    q.stop();
  });

  it('tries a failed transfer again by itself, waiting longer each time', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(1));
    await r.finish('download:d0', 'retry');
    expect(r.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1900);
    expect(r.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.started).toHaveLength(2);

    await r.finish('download:d0', 'retry');
    await vi.advanceTimersByTimeAsync(3900);
    expect(r.started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.started).toHaveLength(3);

    await r.finish('download:d0', 'done');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.started).toHaveLength(3);
    q.stop();
  });

  it('never waits longer than a minute between attempts', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(1));
    for (let i = 0; i < 12; i++) {
      await r.finish('download:d0', 'retry');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(r.started).toHaveLength(i + 2);
    }
    q.stop();
  });

  it('a waiting transfer does not hold up the ones behind it', async () => {
    const r = runner();
    const q = new TransferQueue(r.run, { upload: 1, download: 1 });
    q.want(downloads(3));
    await r.finish('download:d0', 'retry');
    expect(r.started).toEqual(['download:d0', 'download:d1']);
    await r.finish('download:d1', 'done');
    expect(r.started).toEqual(['download:d0', 'download:d1', 'download:d2']);
    q.stop();
  });

  it('retries at once when asked: everything, or one asset', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(2));
    await r.finish('download:d0', 'retry');
    await r.finish('download:d1', 'retry');
    expect(r.started).toHaveLength(2);
    q.retryNow('d1');
    expect(r.started).toEqual(['download:d0', 'download:d1', 'download:d1']);
    q.retryNow();
    expect(r.started.at(-1)).toBe('download:d0');
    q.stop();
  });

  it('leaves a refused transfer alone until someone asks for it again', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(1));
    await r.finish('download:d0', 'failed');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(r.started).toHaveLength(1);
    q.retryNow();
    expect(r.started).toHaveLength(2);
    q.stop();
  });

  it('treats a transfer that throws as one to retry', async () => {
    let calls = 0;
    const q = new TransferQueue(() => {
      calls++;
      return Promise.reject(new Error('boom'));
    });
    q.want(downloads(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls).toBe(2);
    q.stop();
  });

  it('forgets what is no longer wanted and stops for good when told to', async () => {
    const r = runner();
    const q = new TransferQueue(r.run);
    q.want(downloads(1));
    await r.finish('download:d0', 'retry');
    q.want([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.started).toHaveLength(1);

    q.want(downloads(3));
    q.stop();
    await r.finish('download:d0', 'done');
    q.want(downloads(3));
    expect(r.started).toEqual(['download:d0', 'download:d0', 'download:d1']);
  });
});

describe('byUrgency', () => {
  const asset = (id: string, createdAt: number): Asset => ({
    ...ASSET_DEFAULTS,
    id,
    name: id,
    kind: 'video',
    createdAt,
  });
  const v1 = makeTrack('video', 0);
  const assets = [
    asset('pool-old', 1),
    asset('far', 2),
    asset('under', 3),
    asset('near', 4),
    asset('pool-new', 5),
  ];
  const p = applyEdits(emptyProject(), [
    { op: 'addTrack', track: v1 },
    ...assets.map((a) => ({ op: 'addAsset' as const, asset: a })),
    { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'far', start: 900, duration: 30 }) },
    { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'under', start: 90, duration: 30 }) },
    { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'near', start: 120, duration: 30 }) },
    { op: 'addClip', clip: makeClip('video', v1.id, { assetId: 'far', start: 0, duration: 10 }) },
  ]);
  const order = (playhead: number): string[] =>
    Object.values(p.assets)
      .sort(byUrgency(p, playhead))
      .map((a) => a.id);

  it('puts what is under the playhead first, then what is nearest, then the pool', () => {
    expect(order(100)).toEqual(['under', 'near', 'far', 'pool-old', 'pool-new']);
  });

  it('follows the playhead', () => {
    expect(order(905)).toEqual(['far', 'near', 'under', 'pool-old', 'pool-new']);
    expect(order(0)).toEqual(['far', 'under', 'near', 'pool-old', 'pool-new']);
  });
});
