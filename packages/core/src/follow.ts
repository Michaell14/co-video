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
 *
 * An edit writes the frames of all the comments it moves as one change, which everyone in the
 * project is sent. A gesture that commits at every move of the pointer writes them when it rests
 * (see `FollowOptions.gesture`).
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
   * For a gesture that plans every one of its steps anew from where it began: something that is
   * the same at each step of one gesture, and that no other gesture has. `follow` then starts from
   * the frames of the project as the gesture found it, not as this commit finds it: a comment that
   * an earlier step of the gesture moved goes by the frame it had before the gesture. One that
   * somebody made or moved while the gesture was under way has no such frame, and goes by the
   * frame it stands at.
   *
   * Where the gesture found the comments is kept with the gesture, not with an undo step, because
   * a gesture is not always recorded as one. An edit of another kind that lands between two of
   * its steps (media that has finished importing), or an undo and its redo, leave the rest of the
   * gesture in another undo step. Each undo step is noted with what was moved while it was the
   * one recorded, so each still takes back just its own part.
   *
   * Such a gesture commits many times a second, and every write of the comments is sent to
   * everyone in the project. So after its first step its comments are written when it rests
   * (`GESTURE_REST_MS`), or sooner when something else needs them in place: another edit, or an
   * undo.
   */
  gesture?: object;
}

/** How long a gesture has made no step before the comments are written where it has them. */
export const GESTURE_REST_MS = 120;

type UndoStep = Y.UndoManager['undoStack'][number];

/** Frames of comments that an undo step, or a gesture, moved: by comment, as `[before, after]`. */
type Moved = Map<ID, [number, number]>;

interface Note {
  /** The frame rate the frames are counted at. */
  fps: number;
  moved: Moved;
}

/** Where an undo step keeps the comments it moved. */
const STEP_COMMENTS = 'tandem.comments';

/** Frames a gesture has for the comments and has not written yet. */
interface Waiting {
  gesture: object;
  /** The undo step the gesture's last step was recorded in. */
  step: UndoStep;
  /** By comment: the frame the gesture found it at, and the frame it is to stand at. */
  want: Moved;
  timer: ReturnType<typeof setTimeout>;
}

export class CommentMover {
  private readonly store: ProjectStore;
  private readonly review: ReviewStore;
  /** The undo step the commit under way was recorded in, once it has been. */
  private recorded: UndoStep | null = null;
  /** The step the undo or redo under way was filed as, once it has changed something. */
  private filed: UndoStep | null = null;
  /** What each gesture has moved so far, from where it found it to where it last wrote it. */
  private readonly gestures = new WeakMap<object, Moved>();
  private waiting: Waiting | null = null;

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
   * undo step. An edit that changes nothing in the project moves no comment either. The two
   * documents are written one after the other: the project first, then the review.
   */
  commit(edits: Edit[], { follow, gesture, ...opts }: FollowOptions): void {
    this.recorded = null;
    this.store.commit(edits, opts);
    const step = this.taken();
    if (!step) return;
    // Only the next step of the same gesture, in the same undo step, goes on from what is waiting.
    // Anything else counts from where the comments are, so the gesture before it has to have put
    // them there.
    const waiting = this.waiting;
    if (waiting && (waiting.gesture !== gesture || waiting.step !== step)) this.settle();
    const begun = gesture && this.gestures.get(gesture);
    const want: Moved = new Map();
    for (const c of this.review.get()) {
      // What the gesture has moved goes by where the gesture found it, for as long as it stands
      // where the gesture put it.
      const earlier = begun?.get(c.id);
      const found = earlier && earlier[1] === c.frame ? earlier[0] : c.frame;
      const frame = follow(found);
      if (earlier || frame !== c.frame) want.set(c.id, [found, frame]);
    }
    if (!gesture) {
      this.write(step, want);
      return;
    }
    // The first step of a gesture is written like any edit: a gesture of one step, a key that
    // was pressed, has nothing to wait for.
    if (!begun) {
      const moved: Moved = new Map();
      this.gestures.set(gesture, moved);
      this.write(step, want, moved);
      return;
    }
    clearTimeout(this.waiting?.timer);
    this.waiting = { gesture, step, want, timer: setTimeout(this.settle, GESTURE_REST_MS) };
  }

  /** Write the comments where the gesture that is waiting has them. */
  private settle = (): void => {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    this.write(waiting.step, waiting.want, this.gestures.get(waiting.gesture));
  };

  /**
   * Put the comments at the frames `want` has for them. What that moved is noted on `step`, for
   * its undo, and in `gesture` for the gesture these frames are of, for its next step.
   */
  private write(step: UndoStep, want: Moved, gesture?: Moved): void {
    const moved: Moved = new Map((step.meta.get(STEP_COMMENTS) as Note | undefined)?.moved);
    const stands = new Map(this.review.get().map((c) => [c.id, c.frame]));
    const to = new Map<ID, number>();
    for (const [id, [found, frame]] of want) {
      const at = stands.get(id);
      if (at === undefined) continue;
      to.set(id, frame);
      gesture?.set(id, [found, frame]);
      // The step takes the comment from where the step found it. That is where the gesture found
      // it only while all of the gesture is in this step.
      const earlier = moved.get(id);
      const from = earlier && earlier[1] === at ? earlier[0] : at;
      if (frame === from) moved.delete(id);
      else moved.set(id, [from, frame]);
    }
    this.review.move(to);
    if (moved.size) {
      step.meta.set(STEP_COMMENTS, { fps: fpsOf(this.store.get().settings), moved } satisfies Note);
    } else step.meta.delete(STEP_COMMENTS);
  }

  /** Where the commit that was just made was recorded: the history has said so meanwhile, or not. */
  private taken(): UndoStep | null {
    const recorded = this.recorded;
    this.recorded = null;
    return recorded;
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
    // The step of a gesture that was still waiting is taken back from where it had the comments.
    this.settle();
    const filed = this.filed;
    this.filed = null;
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
