/**
 * Changing the project's frame rate. The project document re-times its own clips, keyframes and
 * markers; everything else that counts in frames has to follow by the same ratio, or it ends up
 * pointing at a different moment: review comments (their own document), the marked in/out range,
 * the playhead and the timeline zoom. Undoing or redoing the change takes all of them back with it.
 *
 * Comments are shared, so whoever changes the rate re-times them for everyone. Range, playhead and
 * zoom are each person's own: the session re-times them wherever the change arrives from someone
 * else (`retimeView`).
 *
 * The rate changes in two ways: it is set in the project settings (`changeProjectFrameRate`), or
 * the whole project is replaced by one that has another (`Session.replaceProject`). Both go
 * through `withFrameRate`.
 */
import { changeFrameRate, fpsOf, sameRate } from '@tandem/core';
import type { Session } from '../../session/session';
import { commit } from '../../state/props';
import { retimeComments, type Moved } from '../../state/timing';
import { clampPpf, useUI } from '../../state/ui';

interface Retime {
  /** New rate over old rate. */
  k: number;
  moved: Moved;
}

const META = 'tandem.retime';
const watched = new WeakSet<object>();

/**
 * Re-time what this device alone counts in frames, after the rate changed by the factor `k`: the
 * marked range, the playhead and the timeline zoom. `frame` is the playhead before the change.
 */
export function retimeView(session: Session, k: number, frame: number | null): void {
  const player = session.player;
  if (player) {
    const range = player.getState().range;
    if (range) {
      const start = Math.round(range.in * k);
      player.setRange({ in: start, out: Math.max(start + 1, Math.round(range.out * k)) });
    }
    if (frame !== null) player.seek(Math.round(frame * k));
  }
  // The same stretch of time stays in view.
  const ui = useUI.getState();
  ui.set({ ppf: clampPpf(ui.ppf / k) });
}

/** Re-time what lives outside the project document. `frame` is the playhead before the change. */
function follow(session: Session, k: number, frame: number | null, back: Moved = {}): Moved {
  const moved = retimeComments(session.review.get(), k, back);
  session.reviewDoc.transact(() => {
    for (const [id, [, to]] of Object.entries(moved)) session.review.update(id, { frame: to });
  });
  retimeView(session, k, frame);
  return moved;
}

/**
 * Undo and redo restore the project document only. The rate change is remembered on its undo step
 * so that stepping over it in either direction takes the rest along too.
 */
function watch(session: Session): void {
  const { doc, undoManager } = session.store;
  if (watched.has(undoManager)) return;
  watched.add(undoManager);
  let frame: number | null = null;
  // The player follows the document before the undo manager reports the step, and by then may have
  // pulled the playhead back inside a sequence that has fewer frames.
  doc.on('beforeTransaction', (tr) => {
    if (tr.origin === undoManager) frame = session.player?.getFrame() ?? null;
  });
  undoManager.on('stack-item-added', ({ stackItem }) => {
    // Undoing moves the step to the redo stack as a new item (and back again): carry the note over.
    const retime = undoManager.currStackItem?.meta.get(META) as Retime | undefined;
    if (retime) stackItem.meta.set(META, retime);
  });
  undoManager.on('stack-item-popped', ({ stackItem, type }) => {
    const retime = stackItem.meta.get(META) as Retime | undefined;
    if (!retime) return;
    if (type === 'undo') follow(session, 1 / retime.k, frame, retime.moved);
    else follow(session, retime.k, frame);
  });
}

/**
 * Make a change to the project that may leave it at another frame rate, and have everything
 * outside the document follow. `change` is one commit, so one undo step: the journey is noted on
 * that step, and undoing or redoing it takes comments and view along.
 */
export function withFrameRate(session: Session, change: () => void): void {
  const before = fpsOf(session.store.get().settings);
  const frame = session.player?.getFrame() ?? null;
  const { undoStack } = session.store.undoManager;
  const last = undoStack[undoStack.length - 1]?.meta.get(META) as Retime | undefined;
  change();
  const k = fpsOf(session.store.get().settings) / before;
  if (!session.canEdit || sameRate(k)) return;
  watch(session);
  // Going to the rate that was just left is the same journey as undoing the change.
  const moved = follow(session, k, frame, last && sameRate(last.k * k) ? last.moved : {});
  undoStack[undoStack.length - 1]?.meta.set(META, { k, moved } satisfies Retime);
}

/** Switch the open project to another frame rate, keeping every moment where it was in real time. */
export function changeProjectFrameRate(session: Session, fpsNum: number, fpsDen: number): void {
  withFrameRate(session, () => commit(changeFrameRate(session.store.get(), fpsNum, fpsDen)));
}
