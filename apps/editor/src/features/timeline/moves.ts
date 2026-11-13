/**
 * Moving clips so that they go in between the others instead of over them: the drop that puts shot
 * three before shot one. Pure functions of the project, so they can be tested without a browser.
 */
import {
  clipEnd,
  clipsOnTrack,
  trackLabel,
  type Clip,
  type Edit,
  type ID,
  type Placement,
  type Project,
} from '@tandem/core';
import type { RippleSpan } from '../../state/edits';

export interface InsertMove {
  edits: Edit[];
  /** What the move does to time on the tracks that take part, for the markers that go along. */
  spans: RippleSpan[];
  /** The frame the moved clips begin at afterwards: a cut on those tracks, or their end. */
  at: number;
  /** Why the clips cannot go in between here. Nothing is changed then. */
  refused: string | null;
}

/**
 * The tracks an insert rearranges: those the clips leave and those they land on, and every track
 * that holds a clip linked to one on a track already taking part. Picture and its own sound are
 * shifted by the same frames that way, while a title above or a music bed below stays put: only
 * the shots change places.
 */
function tracksTakingPart(p: Project, moved: readonly Clip[], placements: readonly Placement[]): Set<ID> {
  const tracks = new Set<ID>([...moved.map((c) => c.trackId), ...placements.map((m) => m.trackId)]);
  const groups = new Map<ID, Set<ID>>();
  for (const c of Object.values(p.clips)) {
    if (!c.linkId) continue;
    let on = groups.get(c.linkId);
    if (!on) groups.set(c.linkId, (on = new Set()));
    on.add(c.trackId);
  }
  for (let grown = true; grown;) {
    grown = false;
    for (const on of groups.values()) {
      if (![...on].some((id) => tracks.has(id))) continue;
      for (const id of on) {
        if (tracks.has(id)) continue;
        tracks.add(id);
        grown = true;
      }
    }
  }
  return tracks;
}

/**
 * Take the clips named by `placements` out of where they are, close the time they took up, and
 * put them in at the cut nearest to where the placements ask for, pushing what follows along. It
 * all happens on the tracks that take part (see `tracksTakingPart`) and nowhere else, and every
 * one of them is shifted by the same frames, the length the moved clips span: the sequence is as
 * long afterwards as it was, and nothing is cut or overwritten. A placement's track is where its
 * clip goes; its start only says how far the clips were dragged.
 *
 * The move is refused when another clip on one of those tracks lies alongside the moved ones (it
 * would have to move with them and was not picked up), and when one of the tracks is locked.
 */
export function insertMove(p: Project, placements: readonly Placement[]): InsertMove {
  const wanted = placements.filter((m) => p.clips[m.id] && p.tracks[m.trackId]);
  const moved = wanted.map((m) => p.clips[m.id]);
  const none: InsertMove = { edits: [], spans: [], at: 0, refused: null };
  if (!moved.length) return none;
  const ids = new Set(moved.map((c) => c.id));
  const from = Math.min(...moved.map((c) => c.start));
  const to = Math.max(...moved.map(clipEnd));
  const length = to - from;
  const asked = Math.min(...wanted.map((m) => m.start));
  const tracks = tracksTakingPart(p, moved, wanted);
  const name = (trackId: ID): string => p.tracks[trackId].name || trackLabel(p, p.tracks[trackId]);

  const rest: Clip[] = [];
  for (const trackId of tracks) {
    const track = p.tracks[trackId];
    if (!track) continue;
    const others = clipsOnTrack(p, trackId).filter((c) => !ids.has(c.id));
    if (track.locked && others.length) {
      return { ...none, refused: `Unlock ${name(trackId)} to insert here: its clips have to move too.` };
    }
    const beside = others.find((c) => c.start < to && clipEnd(c) > from);
    if (beside) {
      return {
        ...none,
        refused: `A clip on ${name(trackId)} lies alongside the clips being moved, so the others cannot close up. Move it along with them, or drop without the modifier key to overwrite.`,
      };
    }
    rest.push(...others);
  }

  // Where every other clip stands once the moved ones are out and the time they took is closed.
  const closed = new Map<ID, number>(rest.map((c) => [c.id, c.start >= to ? c.start - length : c.start]));
  const begins = (c: Clip): number => closed.get(c.id)!;
  const cuts = new Set<number>([0]);
  for (const c of rest) cuts.add(begins(c)).add(begins(c) + c.duration);
  let at = 0;
  let nearest = Infinity;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    // A cut on one track can lie inside a clip on another: between two clips means on all of them.
    if (rest.some((c) => begins(c) < cut && cut < begins(c) + c.duration)) continue;
    const distance = Math.abs(cut - asked);
    if (distance < nearest) {
      nearest = distance;
      at = cut;
    }
  }

  const edits: Edit[] = [];
  for (const c of rest) {
    const start = begins(c) >= at ? begins(c) + length : begins(c);
    if (start !== c.start) edits.push({ op: 'updateClip', id: c.id, patch: { start } });
  }
  for (const m of wanted) {
    const c = p.clips[m.id];
    const start = c.start + (at - from);
    if (start !== c.start || m.trackId !== c.trackId) {
      edits.push({ op: 'updateClip', id: c.id, patch: { start, trackId: m.trackId } });
    }
  }
  const spans: RippleSpan[] =
    at === from
      ? []
      : [
          { from, by: -length },
          { from: at, by: length },
        ];
  return { edits, spans, at, refused: null };
}
