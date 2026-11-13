/** A selection of files in the media pool, and taking it to the timeline. */
import {
  addAssetToTimeline,
  applyEdits,
  clipEnd,
  type AddAssetOptions,
  type Asset,
  type Edit,
  type ID,
  type OpResult,
  type Project,
} from '@tandem/core';
import { openGapAt, type RippleSpan } from '../../state/edits';

/** How a press on a card changes the selection: it alone, added to or taken from it, or a run up to it. */
export type PickMode = 'only' | 'toggle' | 'range';

/**
 * The selection after a press on `id`, in the order the files were picked: that is the order they
 * are laid out on the timeline in. A plain press selects the file alone, one with Ctrl or ⌘ adds
 * it or takes it out, and one with Shift selects every file from `anchor` (the file pressed last
 * without Shift) to it, in the order the pool shows them, `shown`.
 */
export function picked(shown: ID[], selection: ID[], anchor: ID | null, id: ID, how: PickMode): ID[] {
  if (how === 'toggle')
    return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
  const to = shown.indexOf(id);
  const from = anchor === null ? -1 : shown.indexOf(anchor);
  if (how === 'only' || to < 0 || from < 0) return [id];
  return from <= to ? shown.slice(from, to + 1) : shown.slice(to, from + 1).reverse();
}

/** Clips placed on the timeline, and the stretch of time an insert put into the sequence for them. */
export interface Placed extends OpResult {
  spans: RippleSpan[];
}

/**
 * Several files on the timeline one after another from `target.frame`: each starts where the one
 * before it ends, on the tracks the first of them took, so that a track made for the first is the
 * one the rest go to. With `insert`, what is there from that frame on moves later by their length
 * together and makes room for them. LUTs are not clips and are passed over.
 */
export function placeAssets(p: Project, assets: Asset[], target: AddAssetOptions, insert = false): Placed {
  const start = Math.max(0, Math.round(target.frame));
  const chain = (on: Project): OpResult & { end: number } => {
    const edits: Edit[] = [];
    const created: ID[] = [];
    let { videoTrackId, audioTrackId } = target;
    let end = start;
    for (const asset of assets) {
      if (asset.kind === 'lut') continue;
      const r = addAssetToTimeline(on, asset, { ...target, frame: end, videoTrackId, audioTrackId });
      on = applyEdits(on, r.edits);
      edits.push(...r.edits);
      created.push(...r.created);
      for (const id of r.created) {
        const clip = on.clips[id];
        end = Math.max(end, clipEnd(clip));
        if (clip.type === 'audio') audioTrackId ??= clip.trackId;
        else videoTrackId ??= clip.trackId;
      }
    }
    return { edits, created, end };
  };
  if (!insert) {
    const { edits, created } = chain(p);
    return { edits, created, spans: [] };
  }
  // How long they are together is known once they have been laid out: on the timeline as it is
  // first, to measure, then on the one that has made room.
  const length = chain(p).end - start;
  if (length <= 0) return { edits: [], created: [], spans: [] };
  const room = openGapAt(p, start, length);
  const { edits, created } = chain(applyEdits(p, room.edits));
  return { edits: [...room.edits, ...edits], created, spans: room.spans };
}

/**
 * What follows the first file of a selection that was dragged to the timeline. The timeline places
 * the file the drag carries; `before` and `after` are the project around that drop. The clips it
 * made of `first` say where the rest go: straight after them, on their tracks. Null when the drop
 * made no clip (it missed the timeline, was called off, or replaced a clip's media).
 */
export function restOfDrop(
  before: Project,
  after: Project,
  first: ID,
  rest: Asset[],
  insert: boolean,
): (Placed & { dropped: ID[] }) | null {
  const made = Object.values(after.clips).filter((c) => !before.clips[c.id] && c.assetId === first);
  if (!made.length) return null;
  const placed = placeAssets(
    after,
    rest,
    {
      frame: Math.max(...made.map(clipEnd)),
      videoTrackId: made.find((c) => c.type !== 'audio')?.trackId,
      audioTrackId: made.find((c) => c.type === 'audio')?.trackId,
    },
    insert,
  );
  return { ...placed, dropped: made.map((c) => c.id) };
}
