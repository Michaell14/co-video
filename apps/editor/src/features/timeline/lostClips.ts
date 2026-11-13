/**
 * Clips without a track. A clip that one person puts on a track while another removes that track
 * stays in the shared document, but no track shows it. The same happens to a clip added while
 * someone replaces the project with one that has other tracks.
 */
import { addTrack, applyEdits, trackKindFor, type Clip, type Edit, type Project } from '@tandem/core';

/**
 * Edits that give every one of `lost` a track again, as one step: a new track of the right kind
 * for each track that is gone, so that clips which shared a track still do and none lands on
 * another. A clip keeps its place in time.
 */
export function restoreEdits(p: Project, lost: readonly Clip[]): Edit[] {
  const edits: Edit[] = [];
  const tracks = new Map<string, string>();
  let working = p;
  for (const clip of lost) {
    const kind = trackKindFor(clip.type);
    const from = `${kind}:${clip.trackId}`;
    let to = tracks.get(from);
    if (!to) {
      const added = addTrack(working, kind);
      working = applyEdits(working, added.edits);
      edits.push(...added.edits);
      tracks.set(from, (to = added.trackId));
    }
    edits.push({ op: 'updateClip', id: clip.id, patch: { trackId: to } });
  }
  return edits;
}

/** Edits that remove every one of `lost` for good. */
export function discardEdits(lost: readonly Clip[]): Edit[] {
  return lost.map((clip) => ({ op: 'removeClip', id: clip.id }));
}
