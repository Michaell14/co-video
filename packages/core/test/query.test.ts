import { describe, expect, it } from 'vitest';
import { applyEdits, linkedIds, makeClip, newId, withLinked } from '../src';
import type { Edit } from '../src';
import { addClip, fixture } from './helpers';

describe('linked clips', () => {
  it('finds the partners of a clip', () => {
    const f = fixture();
    const v = makeClip('video', f.v1.id, { start: 0, duration: 10, linkId: 'pair' });
    const a = makeClip('audio', f.a1.id, { start: 0, duration: 10, linkId: 'pair' });
    let p = applyEdits(f.p, [
      { op: 'addClip', clip: v },
      { op: 'addClip', clip: a },
    ]);
    const solo = addClip(p, f.v2.id, 0, 10);
    p = solo.p;
    expect(linkedIds(p, v.id)).toEqual([v.id, a.id]);
    expect(linkedIds(p, a.id)).toEqual([v.id, a.id]);
    expect(linkedIds(p, solo.clip.id)).toEqual([solo.clip.id]);
    expect(linkedIds(p, 'missing')).toEqual([]);
    expect(withLinked(p, [a.id, solo.clip.id, 'missing', a.id])).toEqual([v.id, a.id, solo.clip.id]);

    // The result is the caller's to change, and the index follows the snapshot.
    linkedIds(p, v.id).push('junk');
    expect(linkedIds(p, v.id)).toEqual([v.id, a.id]);
    const q = applyEdits(p, [{ op: 'updateClip', id: a.id, patch: { linkId: null } }]);
    expect(linkedIds(q, v.id)).toEqual([v.id]);
    expect(linkedIds(q, a.id)).toEqual([a.id]);
    expect(linkedIds(p, a.id)).toEqual([v.id, a.id]);
  });

  it('expands a selection of thousands of linked clips without scanning the project per clip', () => {
    const f = fixture();
    const edits: Edit[] = [];
    const pairs = 10000;
    for (let i = 0; i < pairs; i++) {
      const linkId = newId();
      edits.push({
        op: 'addClip',
        clip: makeClip('video', f.v1.id, { start: i * 10, duration: 10, linkId }),
      });
      edits.push({
        op: 'addClip',
        clip: makeClip('audio', f.a1.id, { start: i * 10, duration: 10, linkId }),
      });
    }
    const p = applyEdits(f.p, edits);
    const videos = Object.values(p.clips)
      .filter((c) => c.type === 'video')
      .map((c) => c.id);
    const t0 = performance.now();
    const all = withLinked(p, videos);
    const elapsed = performance.now() - t0;
    expect(all).toHaveLength(pairs * 2);
    expect(new Set(all).size).toBe(pairs * 2);
    // A scan per clip took minutes at this size; the index takes a few milliseconds.
    expect(elapsed).toBeLessThan(1000);
  });
});
