/**
 * Review comments stand at frames of the sequence and live in a document of their own. An edit
 * that takes time out of the sequence or puts it in leaves a comment on another shot unless the
 * comment moves too, and taking the edit back has to bring the comment back with it.
 *
 * `CommentMover` does both for the person who makes the edit. The comments are moved once, by a
 * write to the review document that everyone receives like any other. Nobody moves them again on
 * seeing the edit arrive, so everyone ends with the same frames. Two people whose edits move the
 * same comment at the same moment each write a frame for it, and one of the two stands for
 * everyone, as with any value that is written twice at once.
 *
 * Only frames are written (`ReviewStore.move`): whose comment it is, what it says, its replies and
 * whether it is resolved are left exactly as they are.
 *
 * The moves are kept with the undo step the edit was recorded as, so that taking the step back is
 * still one step: a comment that stands where the step left it returns to where the step found
 * it, and the redo moves it again. The review document has been changing in between like the
 * project has, and what the step still means is decided the way the project store decides it for
 * the values of a clip:
 *
 * - a comment that was deleted since stays deleted;
 * - a comment that no longer stands where the step left it was moved since, by somebody else's
 *   edit, and stays where that put it: the clip it stands on did not go back either;
 * - a comment made since is not the step's to move;
 * - a step of which nothing was left to take back in the project moves no comment.
 *
 * The frames are noted at the frame rate of the step. A change of rate re-times the comments, and
 * after one by somebody else the frames of the note are read at the present rate.
 */
import type * as Y from 'yjs';
import type { ReviewStore } from './review';
import type { CommitOptions, ProjectStore } from './store';
import { fpsOf, sameRate } from './time';
import type { Edit, ID } from './types';

/**
 * Where a thing that stands at a frame without being a clip goes when an edit has moved time: from
 * the frame before the edit to the frame after it.
 */
export type Follow = (frame: number) => number;

export interface FollowOptions extends CommitOptions {
  follow: Follow;
  /**
   * `follow` starts from the frames of the project as the undo step under way found it, not as
   * this commit finds it. For a gesture that plans every one of its steps anew from where it
   * began: a comment that an earlier step of the gesture moved goes by the frame it had before.
   */
  fromStepStart?: boolean;
}

type UndoStep = Y.UndoManager['undoStack'][number];

/** Frames of comments that a step moved, by comment, as `[before, after]`. */
type Moved = Map<ID, [number, number]>;

interface Note {
  /** The frame rate the frames are counted at. */
  fps: number;
  moved: Moved;
}

/** Where an undo step keeps the comments it moved. */
const STEP_COMMENTS = 'tandem.comments';

export class CommentMover {
  private readonly store: ProjectStore;
  private readonly review: ReviewStore;
  /** The undo step the commit under way was recorded in, once it has been. */
  private recorded: UndoStep | null = null;
  /** The step the undo or redo under way was filed as, once it has changed something. */
  private filed: UndoStep | null = null;

  /** Listens to the history of `store` from here on, and is done with when the store is. */
  constructor(store: ProjectStore, review: ReviewStore) {
    this.store = store;
    this.review = review;
    const history = store.undoManager;
    history.on('stack-item-added', this.onAdded);
    history.on('stack-item-updated', this.onUpdated);
    history.on('stack-item-popped', this.onPopped);
  }

  /**
   * Commit `edits` to the project and take the comments where `follow` says, as part of the same
   * undo step. An edit that changes nothing in the project moves no comment either.
   */
  commit(edits: Edit[], { follow, fromStepStart = false, ...opts }: FollowOptions): void {
    this.recorded = null;
    this.store.commit(edits, opts);
    const step = this.take('recorded');
    if (!step) return;
    // A commit that joins the step before it adds to what that step has moved already.
    const moved: Moved = new Map((step.meta.get(STEP_COMMENTS) as Note | undefined)?.moved);
    const to = new Map<ID, number>();
    for (const c of this.review.get()) {
      const earlier = moved.get(c.id);
      const found = earlier && earlier[1] === c.frame ? earlier[0] : c.frame;
      const frame = follow(fromStepStart ? found : c.frame);
      if (frame !== c.frame) to.set(c.id, frame);
      if (frame === found) moved.delete(c.id);
      else moved.set(c.id, [found, frame]);
    }
    this.review.move(to);
    if (moved.size) {
      step.meta.set(STEP_COMMENTS, { fps: fpsOf(this.store.get().settings), moved } satisfies Note);
    } else step.meta.delete(STEP_COMMENTS);
  }

  /** What one of the two notes holds, which is then cleared: each is good for one commit or one step. */
  private take(note: 'recorded' | 'filed'): UndoStep | null {
    const step = this[note];
    this[note] = null;
    return step;
  }

  private onAdded = ({ stackItem, origin }: { stackItem: UndoStep; origin: unknown }): void => {
    if (origin === this.store.undoManager) this.filed = stackItem;
    else this.recorded = stackItem;
  };

  private onUpdated = ({ stackItem }: { stackItem: UndoStep }): void => {
    this.recorded = stackItem;
  };

  /**
   * A step has been taken back, or made again. The comments it moved go the same way, and what
   * became of them is kept with the step it was filed as, for the opposite step to go by.
   */
  private onPopped = ({ stackItem, type }: { stackItem: UndoStep; type: 'undo' | 'redo' }): void => {
    const filed = this.take('filed');
    const note = stackItem.meta.get(STEP_COMMENTS) as Note | undefined;
    if (!note || !filed) return;
    const fps = fpsOf(this.store.get().settings);
    const k = fps / note.fps;
    const now = (frame: number): number => (sameRate(k) ? frame : Math.round(frame * k));
    const frames = new Map(this.review.get().map((c) => [c.id, c.frame]));
    const to = new Map<ID, number>();
    const moved: Moved = new Map();
    for (const [id, pair] of note.moved) {
      const before = now(pair[0]);
      const after = now(pair[1]);
      if (frames.get(id) !== (type === 'undo' ? after : before)) continue;
      to.set(id, type === 'undo' ? before : after);
      moved.set(id, [before, after]);
    }
    this.review.move(to);
    if (moved.size) filed.meta.set(STEP_COMMENTS, { fps, moved } satisfies Note);
  };
}
