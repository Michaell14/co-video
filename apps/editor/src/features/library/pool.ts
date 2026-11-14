/** A selection of files in the media pool, and taking it to the timeline. */
import {
  addAssetToTimeline,
  addTrack,
  applyEdits,
  clipEnd,
  findFreeTrack,
  isRegionFree,
  type AddAssetOptions,
  type Asset,
  type Clip,
  type Edit,
  type ID,
  type OpResult,
  type Project,
  type TrackKind,
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

/**
 * The clip a file from the pool would take the place of when the person asks to replace 'the
 * selected clip': the one clip that is selected. A picture selected together with what is linked
 * to it is one clip to the person, and it is the picture that is replaced: its sound from the same
 * file goes with it (see `replaceEdits`). Null when nothing is selected, or more than that.
 */
export function replaceTarget(p: Project, selection: readonly ID[]): ID | null {
  const clips = selection.flatMap((id) => (p.clips[id] ? [p.clips[id]] : []));
  if (clips.length < 2) return clips[0]?.id ?? null;
  const { linkId } = clips[0];
  if (!linkId || clips.some((c) => c.linkId !== linkId)) return null;
  const pictures = clips.filter((c) => c.type !== 'audio');
  return pictures.length === 1 ? pictures[0].id : null;
}

/** Clips placed on the timeline, and the stretch of time an insert put into the sequence for them. */
export interface Placed extends OpResult {
  spans: RippleSpan[];
}

/** The files as clips from `target.frame`, each starting where the one before it ends. */
function endToEnd(on: Project, assets: Asset[], target: AddAssetOptions): OpResult & { clips: Clip[] } {
  const edits: Edit[] = [];
  const clips: Clip[] = [];
  let frame = target.frame;
  for (const asset of assets) {
    const r = addAssetToTimeline(on, asset, { ...target, frame });
    on = applyEdits(on, r.edits);
    edits.push(...r.edits);
    for (const id of r.created) {
      clips.push(on.clips[id]);
      frame = Math.max(frame, clipEnd(on.clips[id]));
    }
  }
  return { edits, created: clips.map((c) => c.id), clips };
}

/**
 * Several files on the timeline one after another from `target.frame`: each starts where the one
 * before it ends. Nothing that is there is replaced. Their pictures go to one track that is free
 * for the whole stretch of them, and so do their sounds: the track `target` names where it has that
 * room, else the first that has, else a new one. A track that is free for the first file alone is
 * not enough: the files after it would be laid over what stands further along it. With `insert`,
 * what is there from that frame on moves later by their length together and makes room for them.
 * LUTs are not clips and are passed over.
 */
export function placeAssets(p: Project, assets: Asset[], target: AddAssetOptions, insert = false): Placed {
  const media = assets.filter((a) => a.kind !== 'lut');
  const frame = Math.max(0, Math.round(target.frame));
  // Where each clip comes to lie does not depend on its track, so the files are laid out twice:
  // once to measure them, and then on the tracks that have room for what was measured.
  const measured = endToEnd(p, media, { ...target, frame, videoTrackId: null, audioTrackId: null }).clips;
  if (!measured.length) return { edits: [], created: [], spans: [] };
  const room = insert
    ? openGapAt(p, frame, Math.max(...measured.map(clipEnd)) - frame)
    : { edits: [], spans: [] };
  const edits = [...room.edits];
  let on = applyEdits(p, edits);
  const trackFor = (kind: TrackKind, named: ID | null | undefined): ID | undefined => {
    const run = measured.filter((c) => (c.type === 'audio') === (kind === 'audio'));
    if (!run.length) return undefined;
    const from = Math.min(...run.map((c) => c.start));
    const to = Math.max(...run.map(clipEnd));
    const wanted = named ? on.tracks[named] : undefined;
    if (wanted?.kind === kind && !wanted.locked && isRegionFree(on, wanted.id, from, to)) return wanted.id;
    const free = findFreeTrack(on, kind, from, to);
    if (free) return free.id;
    const made = addTrack(on, kind);
    edits.push(...made.edits);
    on = applyEdits(on, made.edits);
    return made.trackId;
  };
  const videoTrackId = trackFor('video', target.videoTrackId);
  const audioTrackId = trackFor('audio', target.audioTrackId);
  const placed = endToEnd(on, media, { ...target, frame, videoTrackId, audioTrackId });
  return { edits: [...edits, ...placed.edits], created: placed.created, spans: room.spans };
}

/**
 * What follows the first file of a selection that was dragged to the timeline. The timeline places
 * the file the drag carries; `before` and `after` are the project around that drop. The clips it
 * made of `first` say where the rest go: straight after them, and on their tracks where those have
 * room for all that follows (see `placeAssets`). Null when the drop made no clip (it missed the
 * timeline, was called off, or replaced a clip's media).
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
