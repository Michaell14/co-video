/**
 * What a ripple takes along besides the clips: the markers and the review comments, which stand at
 * frames of the sequence without being clips. Both go by one rule (`rippleFollower`) and one
 * switch. The markers are in the project and follow as edits of their own. The comments are in a
 * document of their own: the edits of a ripple are marked with where it takes whatever stands at
 * a frame (`following`), and committing them moves the comments by that, as part of the same undo
 * step (`commitEdits`).
 */
import {
  CommentMover,
  type CommitOptions,
  type Edit,
  type Follow,
  type Project,
  type ProjectStore,
  type ReviewStore,
} from '@tandem/core';
import { markerEdits, rippleFollower, type RippleSpan } from './edits';
import { useUI } from './ui';

interface Ripple {
  follow: Follow;
  fromStepStart: boolean;
}

const ripples = new WeakMap<readonly Edit[], Ripple>();

/**
 * Mark `edits` as those of a ripple that takes what stands at a frame to where `follow` says. The
 * mark is on this very list. A copy of it, or a list it was spread into, is committed like any
 * other edits and takes no comment along. `fromStepStart` is for a gesture that plans each of its
 * steps from where it began (see `FollowOptions`).
 */
export function following(edits: Edit[], follow: Follow, fromStepStart = false): Edit[] {
  ripples.set(edits, { follow, fromStepStart });
  return edits;
}

/**
 * The edits of a ripple together with those that take the markers along (see `markerEdits`), to
 * be committed as one step. The list is marked, so that committing it with `commitEdits` or with
 * `commit` moves the review comments by the same rule. `then` is more for the same step that is
 * not the ripple's own: what goes into the room an insert made. Just the edits while
 * `Comments and markers follow ripple edits` is switched off, and for a ripple that moved no time.
 */
export function withMarkers(
  p: Project,
  r: { edits: Edit[]; spans: RippleSpan[] },
  then: Edit[] = [],
): Edit[] {
  if (!useUI.getState().markersFollow || !r.spans.length) {
    return then.length ? [...r.edits, ...then] : r.edits;
  }
  return following(
    [...r.edits, ...markerEdits(p, r.edits, r.spans), ...then],
    rippleFollower(p, r.edits, r.spans),
  );
}

const movers = new WeakMap<ProjectStore, CommentMover>();

/**
 * Commit `edits` to the project. Those of a ripple (see `following`) take the review comments
 * along: whoever makes the edit moves them, for everyone, and their undo brings them back.
 */
export function commitEdits(
  session: { store: ProjectStore; review: ReviewStore },
  edits: Edit[],
  opts: CommitOptions = {},
): void {
  const ripple = ripples.get(edits);
  if (!ripple) {
    session.store.commit(edits, opts);
    return;
  }
  // Made with the first ripple of a session: before it there is no step with comments to take back.
  let mover = movers.get(session.store);
  if (!mover) movers.set(session.store, (mover = new CommentMover(session.store, session.review)));
  mover.commit(edits, { ...opts, ...ripple });
}
