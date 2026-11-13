/** Helpers for writing clip properties from UI controls (keyframe-aware, gesture-aware). */
import { clamp, writeProp, type Clip, type Edit, type ID, type Project } from '@tandem/core';
import { currentSession } from '../session/hooks';
import { toast } from '../ui/core';
import { refuseEdit } from './access';
import { unlocked } from './edits';

/** Clip-local frame under the playhead, clamped into the clip. */
export function localFrameOf(clip: Clip): number {
  const f = Math.floor(currentSession()?.player?.getFrame() ?? 0);
  return clamp(f - clip.start, 0, Math.max(0, clip.duration - 1));
}

/** Write several numeric properties at once, honouring keyframes on each. */
export function writeProps(clip: Clip, values: Record<string, number>, localFrame: number): Partial<Clip> {
  let working = clip;
  const patch: Partial<Clip> = {};
  for (const [path, v] of Object.entries(values)) {
    const p = writeProp(working, path, v, localFrame);
    Object.assign(patch, p);
    working = { ...working, ...p };
  }
  return patch;
}

let warned = 0;

function guard(): ReturnType<typeof currentSession> {
  const s = currentSession();
  if (!s) return null;
  if (!s.canEdit) {
    if (performance.now() - warned > 4000) {
      warned = performance.now();
      refuseEdit(s.getMeta().role);
    }
    return null;
  }
  return s;
}

let lockWarned = 0;

/**
 * The clips among `ids` a control may write to. A lock protects a track from every control, also
 * from a panel that shows a clip without it being selected; when nothing is left, that is said.
 */
function writable(p: Project, ids: ID[]): ID[] {
  const free = unlocked(p, ids);
  if (!free.length && ids.some((id) => p.clips[id]) && performance.now() - lockWarned > 4000) {
    lockWarned = performance.now();
    toast('That track is locked. Unlock it to change its clips.', 'info');
  }
  return free;
}

/** Start an undo step for a continuous interaction (slider drag, gizmo drag). */
export function beginGesture(): void {
  currentSession()?.store.beginGesture();
}

/** Set animatable numeric properties on clips. Inside a gesture, pass `merge`. */
export function setClipValues(ids: ID[], values: Record<string, number>, merge = true): void {
  const s = guard();
  if (!s) return;
  const p = s.store.get();
  const edits: Edit[] = [];
  for (const id of writable(p, ids)) {
    const c = p.clips[id];
    edits.push({ op: 'updateClip', id, patch: writeProps(c, values, localFrameOf(c)) });
  }
  s.store.commit(edits, { merge });
}

/** Patch arbitrary clip fields, as one undo step however many clips it touches. */
export function patchClips(
  ids: ID[],
  patch: Partial<Clip> | ((c: Clip) => Partial<Clip>),
  merge = false,
): void {
  const s = guard();
  if (!s) return;
  const p = s.store.get();
  const edits: Edit[] = [];
  for (const id of writable(p, ids)) {
    const next = typeof patch === 'function' ? patch(p.clips[id]) : patch;
    // A patch can come back empty (nothing to change on this clip); that is not an edit.
    if (Object.keys(next).length) edits.push({ op: 'updateClip', id, patch: next });
  }
  if (edits.length) s.store.commit(edits, { merge });
}

/** Commit raw edits if the user may edit. */
export function commit(edits: Edit[], merge = false): void {
  const s = guard();
  if (s && edits.length) s.store.commit(edits, { merge });
}
