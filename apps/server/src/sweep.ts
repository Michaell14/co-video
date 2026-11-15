/**
 * Media that nothing can need any more leaves the server.
 *
 * A finished asset is deleted when all of this holds at the moment it goes:
 *   - no asset of the project document, as the server holds it then, has its id;
 *   - no stored version of the project refers to it;
 *   - an earlier sweep already found both to be so, at least the grace period ago, and the
 *     document has had nothing to do with the asset since;
 *   - its upload ended at least the grace period ago;
 *   - no request holds it.
 *
 * Taking a file out of a project does not delete it, then: an undo, a collaborator's undo or a
 * version brings the asset back, and with it the need for the file. What a sweep notes about a
 * file is forgotten the moment the document refers to its asset again (rooms.ts sees to that),
 * and by the next sweep that finds it in a version. So the grace period is counted from the first
 * sweep after the document and the versions last referred to the file, whether or not a sweep
 * came by while they did. A file that is uploaded before the edit that adds its asset has arrived
 * is younger than the grace period and is safe for that reason alone.
 *
 * What cannot be judged is kept: a project whose document or versions cannot be read right now
 * is left as it is until they can.
 */
import type { MediaStore } from './media';
import { assetIdsOf } from './references';
import type { RoomManager } from './rooms';
import type { VersionStore } from './versions';

export interface SweepStores {
  versions: VersionStore;
  rooms: RoomManager;
  media: MediaStore;
}

const sameNotes = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean =>
  a.size === b.size && [...a].every(([assetId, since]) => b.get(assetId) === since);

/**
 * Go through the finished assets of one project at the time `now`: note the ones that nothing
 * refers to, forget the note of one that a version refers to again, and delete those whose note
 * and whose upload are both `graceMs` old. Resolves to how many were deleted. Rejects when the
 * project's document cannot be had (no memory for it, larger than is loaded, deleted meanwhile);
 * nothing was changed then.
 */
export async function sweepUnusedMedia(
  { versions, rooms, media }: SweepStores,
  projectId: string,
  now: number,
  graceMs: number,
): Promise<number> {
  const stored = await media.finished(projectId);
  if (stored.length === 0) {
    media.noteUnreferenced(projectId, new Map());
    return 0;
  }

  const inVersions = await versions.references(projectId, (state) =>
    rooms.readState('project', state, assetIdsOf),
  );
  try {
    if (!inVersions.assets) return 0;
    const { assets } = inVersions;
    // Most files are in some version, which the index says without a document being read.
    const candidates = stored.filter((file) => !assets.has(file.assetId));
    if (candidates.length === 0) {
      media.noteUnreferenced(projectId, new Map());
      return 0;
    }
    return await rooms.peek(projectId, 'project', (doc) => {
      // Nothing else runs until this function returns. What it finds is therefore still so when
      // a file is deleted in it: the document cannot take an edit in between, and a version made
      // since the index was read shows in `current`. The notes are read here and not earlier for
      // the same reason: one that was forgotten a moment ago, because the document referred to
      // its asset again, is not among them.
      if (!inVersions.current()) return 0;
      const noted = media.unreferenced(projectId);
      const notes = new Map<string, number>();
      const live = new Set(assetIdsOf(doc));
      let removed = 0;
      for (const { assetId, uploadedAt } of candidates) {
        if (live.has(assetId)) continue;
        const since = noted.get(assetId);
        const due = since !== undefined && now - since >= graceMs && now - uploadedAt >= graceMs;
        if (due && media.removeNow(projectId, assetId)) removed++;
        else notes.set(assetId, since ?? now);
      }
      if (!sameNotes(notes, noted)) media.noteUnreferenced(projectId, notes);
      return removed;
    });
  } finally {
    inVersions.release();
  }
}
