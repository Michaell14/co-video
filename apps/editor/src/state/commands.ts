/**
 * Editing commands. Everything a user can do to the project goes through here, so the keyboard,
 * the menus, the command palette and the buttons all share one implementation and one undo step.
 */
import {
  applyEdits as applyPreview,
  DEFAULT_GRADE,
  addAssetToTimeline,
  addGenerator,
  addTrack,
  canEdit,
  clipEnd,
  clipsUnderFrame,
  deleteClips,
  deleteRange,
  displayTracks,
  editPoints,
  fpsOf,
  getEffectDef,
  getTransitionDef,
  linkClips,
  makeEffect,
  makeTransition,
  MARKER_COLORS,
  newId,
  parseProjectFile,
  parseSubtitles,
  pasteClips,
  placeClips,
  removeTrack,
  secondsToFrame,
  sequenceEnd,
  serializeProject,
  setTransition,
  splitClips,
  freezeFrame,
  toSrt,
  toEdl,
  trackLabel,
  tracksOf,
  unlinkClips,
  withLinked,
  framesToSeconds,
  DEFAULT_TEXT,
  type AddAssetOptions,
  type Asset,
  type Clip,
  type Edit,
  type ID,
  type Project,
  type ShapeProps,
  type StepOutcome,
  type TextProps,
  LoudnessMeter,
  normalizationGain,
  type LoudnessResult,
  sourcePerFrame,
  clamp,
} from '@tandem/core';
import { AudioBufferSink, renderStill, VoiceRecorder } from '@tandem/engine';
import { navigate } from '../App';
import { fitPanels, windowSize } from '../features/editor/layout';
import { currentSession } from '../session/hooks';
import { copyProjectMedia } from '../session/mediaStore';
import { createProject } from '../session/projects';
import type { Session } from '../session/session';
import { confirm } from '../ui/confirm';
import { toast } from '../ui/core';
import { refuseEdit } from './access';
import {
  attributePatch,
  CAPTION_TRACK,
  captionClips,
  clipBeside,
  clipExtent,
  clipsBeside,
  closeGapAt,
  closeGapOn,
  copiedAttributes,
  duplicateClips,
  markerBeside,
  markerEdits,
  matchFrameAt,
  nearestEdge,
  openGapAt,
  pasteable,
  rippleDeleteClips,
  rippleDeleteRange,
  replaceEdits,
  rippleTrimToFrame,
  selectionAtFrame,
  trackNudge,
  transitionEdits,
  transitionTargets,
  trimEdge,
  trimReference,
  unlocked,
  type AttributeMode,
  type RippleSpan,
} from './edits';
import {
  durationEdits,
  makeRoomEdits,
  moveEdits,
  reverseEdits,
  speedCutShort,
  speedEach,
  speedRippleEdits,
  type CutShort,
} from './timing';
import { FIRST_TRANSITION, useUI, type Tool } from './ui';
import { fitView, zoomView } from './view';

const ui = () => useUI.getState();

function session(): Session | null {
  return currentSession();
}

/** Run `fn` only when the user may edit; otherwise explain why nothing happened. */
function editing(fn: (s: Session, p: Project) => void): void {
  const s = session();
  if (!s) return;
  if (!canEdit(s.getMeta().role)) {
    refuseEdit(s.getMeta().role);
    return;
  }
  fn(s, s.store.get());
}

function frame(): number {
  return Math.floor(session()?.player?.getFrame() ?? 0);
}

function selectedClips(p: Project): Clip[] {
  return unlocked(p, ui().selection).map((id) => p.clips[id]);
}

/**
 * Selection, widened to linked partners when linked selection is on. Clips on locked tracks are
 * never part of it, whichever way they came to be selected or linked.
 */
export function effectiveSelection(p: Project, ids: ID[] = ui().selection): ID[] {
  const valid = ids.filter((id) => p.clips[id]);
  return unlocked(p, ui().linkedSelection ? withLinked(p, valid) : valid);
}

/**
 * The edits of a ripple together with those that take the markers along (see `markerEdits`), to
 * be committed as one step. Just the ripple's while `Markers follow ripple edits` is switched off.
 */
export function withMarkers(p: Project, r: { edits: Edit[]; spans: RippleSpan[] }): Edit[] {
  return ui().markersFollow ? [...r.edits, ...markerEdits(p, r.edits, r.spans)] : r.edits;
}

/** Timeline viewport width in CSS pixels; set by the Timeline component. */
let timelineWidth = 800;
export const setTimelineWidth = (w: number): void => {
  timelineWidth = w;
};
export const getTimelineWidth = (): number => timelineWidth;

/** Scroll the timeline so `f` is visible, with a little breathing room. */
export function revealFrame(f: number): void {
  const { ppf, scrollX } = ui();
  const x = f * ppf;
  const margin = Math.min(120, timelineWidth * 0.15);
  if (x < scrollX + margin) ui().set({ scrollX: Math.max(0, x - margin) });
  else if (x > scrollX + timelineWidth - margin)
    ui().set({ scrollX: Math.max(0, x - timelineWidth + margin) });
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    };
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    input.click();
  });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled';

const LOCKED_TRACK = 'That track is locked. Unlock it to change its clips.';

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What each way of pasting attributes says it pasted. */
const PASTED: Record<AttributeMode, string> = {
  all: 'Attributes',
  grade: 'Grade',
  effects: 'Effects',
  transform: 'Transform and crop',
  sound: 'Volume, pan and fades',
};

/**
 * Move the edge of the selection that is nearest the playhead, by `delta` frames or to the
 * playhead. It is the edge of one clip and of what is trimmed with it (its linked partners). Under
 * ripple editing everything after follows; otherwise a cut is rolled and a free edge trimmed, so
 * that fine-tuning a cut by the keyboard neither opens a hole nor moves the rest of the sequence.
 */
function moveEdge(delta: number | 'playhead'): void {
  editing((s, p) => {
    const f = frame();
    const hit = nearestEdge(p, effectiveSelection(p), f);
    if (!hit) {
      toast('Select a clip to trim its nearest edge.', 'info');
      return;
    }
    const { clip, edge } = hit;
    const by = delta === 'playhead' ? f - (edge === 'start' ? clip.start : clipEnd(clip)) : delta;
    if (by === 0) return;
    const r = trimEdge(p, effectiveSelection(p, [clip.id]), edge, by, ui().rippleMode);
    if (r.refused) toast(r.refused);
    else if (!r.moved) toast('That edge cannot move any further that way.', 'info');
    if (!r.edits.length) return;
    s.store.commit(withMarkers(p, r));
    if (delta === 'playhead') return;
    // Show the frame being cut to, as a trim by dragging does.
    const trimmed = s.store.get().clips[clip.id];
    if (trimmed) cmd.seek(edge === 'start' ? trimmed.start : clipEnd(trimmed) - 1);
  });
}

/**
 * Say that the clip after it cut a change of speed short, and offer to move that clip out of the
 * way. Without ripple editing nothing moves by itself, but a clip that silently plays only part of
 * what it played before is not what was asked for either.
 */
function offerRoom(s: Session, short: CutShort[]): void {
  const left = s.store.get();
  const seconds = (frames: number): number => Number(framesToSeconds(frames, left.settings).toFixed(1));
  const [first] = short;
  const alike = short.every((c) => c.duration === first.duration && c.natural === first.natural);
  const text = alike
    ? `The next clip is in the way, so the clip now plays only the first ${seconds(first.duration)} of its ${seconds(first.natural)} seconds.`
    : `The next clip is in the way, so ${short.length} clips are cut short at their new speed.`;
  toast(text, 'info', {
    label: 'Make room',
    run: () =>
      editing((s, p) => {
        // The offer was about the clips as the change of speed left them.
        const wants: Record<ID, number> = {};
        for (const c of short) {
          const now = p.clips[c.id];
          const then = left.clips[c.id];
          if (now && then && now.speed === then.speed && now.duration === c.duration) wants[c.id] = c.natural;
        }
        const r = makeRoomEdits(p, wants);
        if (r.refused) toast(r.refused);
        else if (r.edits.length) s.store.commit(withMarkers(p, r));
      }),
  });
}

/**
 * Say so when an undo or redo passed over steps of which someone else's changes left nothing to
 * take back: otherwise the key seems to do nothing, or to do something other than the last step.
 */
function saySteps(out: StepOutcome, verb: 'undo' | 'redo', done: 'undone' | 'redone'): void {
  if (!out.dropped) return;
  toast(
    out.changed
      ? `${count(out.dropped, 'earlier step')} could not be ${done}: someone else has changed the same things since.`
      : `Nothing left to ${verb}: someone else has changed what those steps touched.`,
  );
}

/** Let the user pick a `.tandem` file and read it. Says so when it is not a project file. */
async function pickProjectFile(): Promise<Project | null> {
  const [file] = await pickFiles('.tandem,application/json', false);
  if (!file) return null;
  const parsed = parseProjectFile(await file.text());
  if (!parsed) toast('That is not a Tandem project file.', 'error');
  return parsed;
}

/** `project` with every asset's `uploaded` flag decided by `onServer`. */
function withUploads(project: Project, onServer: (asset: Asset) => boolean): Project {
  const assets = Object.values(project.assets).map((a) => [a.id, { ...a, uploaded: onServer(a) }]);
  return { ...project, assets: Object.fromEntries(assets) };
}

/** Integrated loudness of the stretch of source audio a clip plays. */
async function measureClip(s: Session, clip: Clip, p: Project): Promise<LoudnessResult | null> {
  if (!clip.assetId) return null;
  const media = await s.thumbs.library.get(clip.assetId);
  if (!media?.audio || !media.audioDecodable) return null;
  const start = media.audioStart + clip.sourceIn;
  const end = start + Math.max(clip.duration * sourcePerFrame(clip, p), 0.05);
  const sink = new AudioBufferSink(media.audio);
  let meter: LoudnessMeter | null = null;
  let lastYield = performance.now();
  for await (const { buffer, timestamp } of sink.buffers(start, end)) {
    meter ??= new LoudnessMeter(buffer.sampleRate, buffer.numberOfChannels);
    const from = Math.max(0, Math.round((start - timestamp) * buffer.sampleRate));
    const to = Math.min(buffer.length, Math.round((end - timestamp) * buffer.sampleRate));
    if (to <= from) continue;
    const planes: Float32Array[] = [];
    for (let c = 0; c < Math.min(meter.channels, buffer.numberOfChannels); c++)
      planes.push(buffer.getChannelData(c).subarray(from, to));
    meter.push(planes);
    if (performance.now() - lastYield > 12) {
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  return meter ? meter.result() : null;
}

/**
 * Make room for the side panel a command is about to use. In a window too small for a column of
 * comments they stand in for one of the side panels, and give that column back when it is asked for.
 */
function uncover(side: 'left' | 'right'): void {
  if (fitPanels(ui(), windowSize()).comments === side) ui().set({ commentsOpen: false });
}

/**
 * Focus the inspector's text field for `clipId` and select what is in it. The inspector draws the
 * field after the selection has changed (and only in an open section), so this looks again over
 * the next few frames and gives up if the selection has moved on by then.
 */
function focusTextField(clipId: ID, tries = 12): void {
  requestAnimationFrame(() => {
    const sel = ui().selection;
    if (sel.length !== 1 || sel[0] !== clipId) return;
    const panel = document.querySelector('[aria-label="Inspector"]');
    const field = panel?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text content"]');
    if (field) {
      field.focus();
      field.select();
      return;
    }
    for (const head of panel?.querySelectorAll<HTMLElement>('.section__head[aria-expanded="false"]') ?? []) {
      if (head.textContent?.trim() === 'Text') head.click();
    }
    if (tries > 0) focusTextField(clipId, tries - 1);
  });
}

/**
 * Paste the copied clips at the playhead. They overwrite what is there, or with `insert` what is
 * there is pushed later first by as much as the clips span, cut where a clip lies across the
 * playhead: the room an insert from the source monitor makes.
 */
function pasteClipboard(insert: boolean): void {
  editing((s, p) => {
    if (!ui().clipboard.length) return;
    const { clips, missing } = pasteable(p, ui().clipboard, ui().clipboardFps);
    if (missing) {
      const what = missing === 1 ? 'One clip was' : `${missing} clips were`;
      toast(`${clips.length ? `${what} left out` : 'Nothing was pasted'}: the media is not in this project.`);
    }
    if (!clips.length) return;
    const span = Math.max(...clips.map(clipEnd)) - Math.min(...clips.map((c) => c.start));
    const room = insert ? openGapAt(p, frame(), span) : null;
    const r = pasteClips(room ? applyPreview(p, room.edits) : p, clips, frame());
    s.store.commit(room ? [...withMarkers(p, room), ...r.edits] : r.edits);
    ui().select(r.created);
  });
}

let recorder: VoiceRecorder | null = null;
let recorderBusy = false;

export const MEDIA_ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.ts,.cube,.srt,.vtt';

export const cmd = {
  // ───────────────────────────────────────────────────────────── history ──
  undo(): void {
    editing((s) => saySteps(s.store.undo(), 'undo', 'undone'));
  },
  redo(): void {
    editing((s) => saySteps(s.store.redo(), 'redo', 'redone'));
  },

  // ─────────────────────────────────────────────────────────── transport ──
  togglePlay(): void {
    session()?.player?.toggle();
  },
  shuttle(dir: -1 | 0 | 1): void {
    session()?.player?.shuttle(dir);
  },
  seek(f: number, reveal = true): void {
    const s = session();
    if (!s?.player) return;
    s.player.seek(f);
    if (reveal) revealFrame(s.player.getFrame());
    if (ui().following !== null) ui().set({ following: null });
  },
  step(delta: number): void {
    const s = session();
    if (!s?.player) return;
    s.player.step(delta);
    revealFrame(s.player.getFrame());
  },
  goStart(): void {
    cmd.seek(0);
  },
  goEnd(): void {
    const s = session();
    if (s) cmd.seek(sequenceEnd(s.store.get()));
  },
  prevEdit(): void {
    const s = session();
    if (!s) return;
    const f = frame();
    const pts = editPoints(s.store.get()).filter((p) => p < f);
    cmd.seek(pts.length ? pts[pts.length - 1] : 0);
  },
  nextEdit(): void {
    const s = session();
    if (!s) return;
    const f = frame();
    const next = editPoints(s.store.get()).find((p) => p > f);
    cmd.seek(next ?? sequenceEnd(s.store.get()));
  },
  toggleLoop(): void {
    const p = session()?.player;
    if (p) p.setLoop(!p.getState().loop);
  },
  markIn(): void {
    const p = session()?.player;
    if (!p) return;
    const f = frame();
    const r = p.getState().range;
    const end = sequenceEnd(p.getProject());
    p.setRange({ in: f, out: r && r.out > f ? r.out : Math.max(f + 1, end) });
  },
  markOut(): void {
    const p = session()?.player;
    if (!p) return;
    const f = frame() + 1;
    const r = p.getState().range;
    p.setRange({ in: r && r.in < f ? r.in : 0, out: f });
  },
  clearRange(): void {
    session()?.player?.setRange(null);
  },
  /** Mark the extent of the selected clips, else of the clip seen under the playhead, as the range. */
  markClip(): void {
    const s = session();
    if (!s?.player) return;
    const extent = clipExtent(s.store.get(), frame(), ui().selection);
    if (extent) s.player.setRange(extent);
    else toast('Select a clip, or put the playhead on one, to mark it.', 'info');
  },
  /** Move the playhead to the in point, or to the last frame of the marked range. */
  goToRange(end: 'in' | 'out'): void {
    const range = session()?.player?.getState().range;
    if (range) cmd.seek(end === 'in' ? range.in : range.out - 1);
    else toast('There is no range yet. Press I and O to mark one, or X to mark a clip.', 'info');
  },
  /**
   * Match frame: open the source monitor on the media under the playhead, at the frame the
   * timeline is showing. A clip named by a menu that is not under the playhead opens at its start.
   */
  matchFrame(clipId?: ID): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const named = clipId ? p.clips[clipId] : undefined;
    const f = frame();
    const at = named && (f < named.start || f >= clipEnd(named)) ? named.start : f;
    const m = matchFrameAt(p, at, clipId ? [clipId] : ui().selection);
    if (!m || (clipId && m.clip.id !== clipId)) {
      toast(
        clipId ? 'That clip has no media to match.' : 'Put the playhead on a clip to match its frame.',
        'info',
      );
      return;
    }
    const assetId = m.clip.assetId!;
    ui().set({ sourceAsset: assetId, sourceCue: { assetId, time: m.time } });
  },
  /**
   * Show where a clip's media sits in the pool: the clip a menu names, else the first selected
   * clip that has media, else the one under the playhead.
   */
  revealInPool(clipId?: ID): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const hasMedia = (c: Clip | undefined): c is Clip & { assetId: ID } =>
      !!c?.assetId && !!p.assets[c.assetId];
    const clip = clipId
      ? p.clips[clipId]
      : (ui()
          .selection.map((id) => p.clips[id])
          .find(hasMedia) ?? matchFrameAt(p, frame())?.clip);
    if (!hasMedia(clip)) {
      toast(
        clipId ? 'That clip has no media in the pool.' : 'Select a clip to find its media in the pool.',
        'info',
      );
      return;
    }
    // Only the colour workspace has no library; the audio one keeps its mixer.
    const workspace = ui().workspace === 'color' ? 'edit' : ui().workspace;
    ui().set({ workspace, libraryTab: 'media', revealAsset: clip.assetId });
    uncover('left');
  },

  // ─────────────────────────────────────────────────────────── selection ──
  selectAll(): void {
    const s = session();
    if (s) ui().select(unlocked(s.store.get(), Object.keys(s.store.get().clips)));
  },
  /** Select everything still to play from the playhead (`right`) or everything begun before it. */
  selectBeside(side: 'left' | 'right'): void {
    const s = session();
    if (s) ui().select(clipsBeside(s.store.get(), frame(), side));
  },
  /**
   * Select the clip under the playhead on the top-most unlocked track. Asked again, it goes down
   * the tracks one clip at a time, so every clip there can be reached without the pointer.
   */
  selectUnderPlayhead(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const ids = selectionAtFrame(p, frame(), ui().selection, (id) => effectiveSelection(p, [id]));
    if (ids) ui().select(ids);
    else toast('There is no clip under the playhead to select.', 'info');
  },
  /**
   * Select the clip after (`1`) or before (`-1`) the selected one on its track; `extend` keeps
   * what is selected. With nothing selected it starts from the clip at the playhead.
   */
  selectClip(dir: 1 | -1, extend = false): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const selected = unlocked(p, ui().selection);
    const to = clipBeside(p, selected, frame(), dir);
    if (!to) {
      toast(
        selected.length
          ? `That is the ${dir === 1 ? 'last' : 'first'} clip on its track.`
          : 'There is no clip to select.',
        'info',
      );
      return;
    }
    ui().select(effectiveSelection(p, [to.id]), extend);
    revealFrame(to.start);
  },
  deselect(): void {
    ui().clearSelection();
  },
  setTool(tool: Tool): void {
    ui().set({ tool });
  },

  // ───────────────────────────────────────────────────────────── editing ──
  /** Hold the frame under the playhead for two seconds (on the selected clip, else the top-most video). */
  freezeFrame(): void {
    editing((s, p) => {
      const f = frame();
      const under = (id: string): boolean => {
        const c = p.clips[id];
        return !!c && c.type === 'video' && !!c.assetId && c.start <= f && f < clipEnd(c);
      };
      const order = new Map(tracksOf(p).video.map((t, i) => [t.id, i]));
      const pick =
        unlocked(p, ui().selection).find(under) ??
        clipsUnderFrame(p, f)
          .filter(under)
          .sort((a, b) => (order.get(p.clips[b].trackId) ?? 0) - (order.get(p.clips[a].trackId) ?? 0))[0];
      if (!pick) {
        toast('Put the playhead on a video clip to freeze a frame.');
        return;
      }
      const hold = Math.max(1, Math.round(fpsOf(p.settings) * 2));
      const r = freezeFrame(p, pick, f, hold);
      if (!r.edits.length) return;
      s.store.commit(withMarkers(p, { edits: r.edits, spans: [{ from: f, by: hold }] }));
      ui().select(r.created);
    });
  },

  split(): void {
    editing((s, p) => {
      const f = frame();
      const sel = effectiveSelection(p).filter((id) => {
        const c = p.clips[id];
        return c && c.start < f && f < clipEnd(c);
      });
      // With nothing selected under the playhead, cut straight through every unlocked track.
      const ids = sel.length ? sel : effectiveSelection(p, clipsUnderFrame(p, f));
      const r = splitClips(p, ids, f);
      if (!r.edits.length) return;
      s.store.commit(r.edits);
    });
  },
  delete(ripple = false): void {
    editing((s, p) => {
      const tr = ui().selectedTransition;
      if (tr) {
        s.store.commit(setTransition(p, tr.clipId, tr.side, null));
        ui().set({ selectedTransition: null });
        return;
      }
      const ids = effectiveSelection(p);
      if (!ids.length) {
        // No selection: delete the marked range, if any.
        const range = s.player?.getState().range;
        if (range && ripple) {
          const r = rippleDeleteRange(p, range.in, range.out);
          if (r.refused) {
            toast(r.refused);
            return;
          }
          s.store.commit(withMarkers(p, r));
          s.player?.setRange(null);
        } else if (range) {
          const tracks = Object.values(p.tracks)
            .filter((t) => !t.locked)
            .map((t) => t.id);
          s.store.commit(deleteRange(p, tracks, range.in, range.out, false));
        }
        return;
      }
      if (ripple || ui().rippleMode) {
        const r = rippleDeleteClips(p, ids);
        if (r.refused) {
          toast(r.refused);
          return;
        }
        s.store.commit(withMarkers(p, r));
      } else s.store.commit(deleteClips(p, ids));
      ui().clearSelection();
    });
  },
  copy(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const clips = effectiveSelection(p).map((id) => p.clips[id]);
    if (clips.length) {
      ui().set({ clipboard: clips, clipboardFps: fpsOf(p.settings) });
      toast(`Copied ${clips.length} clip${clips.length > 1 ? 's' : ''}`, 'info');
    }
  },
  cut(): void {
    cmd.copy();
    cmd.delete(false);
  },
  paste(): void {
    pasteClipboard(false);
  },
  /** Paste at the playhead and push what is there later, on every unlocked track, instead of overwriting it. */
  pasteInsert(): void {
    pasteClipboard(true);
  },
  duplicate(): void {
    editing((s, p) => {
      const r = duplicateClips(p, effectiveSelection(p));
      if (!r.edits.length) return;
      s.store.commit(withMarkers(p, r));
      ui().select(r.created);
    });
  },
  nudge(delta: number): void {
    editing((s, p) => {
      const ids = effectiveSelection(p);
      if (!ids.length) return;
      const min = Math.min(...ids.map((id) => p.clips[id].start));
      const d = Math.max(delta, -min);
      if (d === 0) return;
      s.store.commit(
        placeClips(
          p,
          ids.map((id) => ({ id, start: p.clips[id].start + d, trackId: p.clips[id].trackId })),
        ),
      );
    });
  },
  /**
   * Move the selection one track up (+1) or down (-1) in the timeline. Of a sync clip selected
   * with its sound the picture moves and the sound stays on its track (see `trackNudge`).
   */
  nudgeTrack(dir: 1 | -1): void {
    editing((s, p) => {
      const r = trackNudge(p, ui().selection, dir);
      if (r.refused) toast(r.refused, 'info');
      else if (r.edits.length) s.store.commit(r.edits);
    });
  },
  toggleEnabled(): void {
    editing((s, p) => {
      const clips = selectedClips(p);
      if (!clips.length) return;
      const enabled = !clips.every((c) => c.enabled);
      s.store.commit(clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { enabled } }) as Edit));
    });
  },
  link(): void {
    editing((s, p) => s.store.commit(linkClips(p, unlocked(p, ui().selection))));
  },
  unlink(): void {
    editing((s, p) => s.store.commit(unlinkClips(p, effectiveSelection(p))));
  },
  /**
   * Ripple-trim the head (Q) or tail (W) to the playhead: of the selected clips that lie under it,
   * else of the one clip the cut there is about and its linked partners (see `trimReference`).
   */
  trimToPlayhead(edge: 'start' | 'end'): void {
    editing((s, p) => {
      const f = frame();
      const under = (id: ID): boolean => p.clips[id].start < f && f < clipEnd(p.clips[id]);
      let ids = effectiveSelection(p).filter(under);
      if (!ids.length) {
        const ref = trimReference(p, f);
        if (!ref) {
          toast('Put the playhead inside a clip to trim it.', 'info');
          return;
        }
        ids = unlocked(p, withLinked(p, [ref.id]));
      }
      // One plan for all of them: the time they give up in common closes once, on every track.
      const r = rippleTrimToFrame(p, ids, edge, f);
      if (r.refused) {
        toast(r.refused);
        return;
      }
      if (!r.edits.length) return;
      s.store.commit(withMarkers(p, r));
      // The cut the trim was made at: where the trimmed clips begin now.
      const after = s.store.get();
      if (edge === 'start') cmd.seek(Math.min(...ids.filter(under).map((id) => after.clips[id].start)));
    });
  },
  closeGapAtPlayhead(): void {
    editing((s, p) => {
      const r = closeGapAt(p, frame());
      if (r.refused) toast(r.refused);
      else if (r.edits.length) s.store.commit(withMarkers(p, r));
      else toast('There is no gap under the playhead to close.', 'info');
    });
  },
  /** Close the gap under `at` on one track; the other tracks follow where they can. */
  closeGap(trackId: ID, at: number): void {
    editing((s, p) => {
      if (p.tracks[trackId]?.locked) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      const r = closeGapOn(p, trackId, at);
      if (r.refused) toast(r.refused);
      else if (r.edits.length) s.store.commit(withMarkers(p, r));
    });
  },
  /** Move the edge of the selection nearest the playhead by `delta` frames (see `moveEdge`). */
  trimEdge(delta: number): void {
    moveEdge(delta);
  },
  /** Take the edge of the selection nearest the playhead to the playhead. */
  extendEdit(): void {
    moveEdge('playhead');
  },
  /**
   * Set the speed of the selected clips. With ripple editing on, what follows moves by as much as
   * they grow or shrink; without, a clip stops at the next one, and when that cuts it short the
   * toast offers to make room.
   */
  setSpeed(speed: number, reverse?: boolean): void {
    editing((s, p) => {
      const ids = effectiveSelection(p);
      if (ui().rippleMode) {
        const r = speedRippleEdits(p, ids, speed, reverse);
        if (r.edits.length) s.store.commit(withMarkers(p, r));
        if (r.refused) toast(r.refused);
        return;
      }
      const edits = speedEach(p, ids, speed, reverse);
      if (!edits.length) return;
      const short = speedCutShort(p, ids, speed, reverse);
      s.store.commit(edits);
      if (short.length) offerRoom(s, short);
    });
  },
  /**
   * Offer to make room for clips that a change of speed left cut short. For a control that sets
   * the speed in steps of its own and knows, when its gesture ends, what that left short.
   */
  offerSpeedRoom(short: CutShort[]): void {
    const s = session();
    if (s && short.length) offerRoom(s, short);
  },
  /** Play the selected clips backwards or forwards, each at the speed it already has. */
  setReverse(reverse: boolean): void {
    editing((s, p) => s.store.commit(reverseEdits(p, effectiveSelection(p), reverse)));
  },
  /**
   * Give the selected clips, or `clipIds`, an exact length by moving their ends, linked partners
   * included. With ripple mode on, what follows moves along; without it a clip stops at the next one.
   */
  setDuration(frames: number, clipIds: ID[] = ui().selection): void {
    editing((s, p) => {
      const groups = unlocked(p, clipIds).map((id) => [
        id,
        ...effectiveSelection(p, [id]).filter((other) => other !== id),
      ]);
      const r = durationEdits(p, groups, frames, ui().rippleMode);
      if (r.edits.length) s.store.commit(withMarkers(p, r));
      if (r.refused) toast(r.refused);
      else if (r.limited) toast('Stopped at the end of the media or at the next clip.', 'info');
    });
  },
  /** Move the selected clips, or `clipIds`, together, so that the earliest of them starts at `frame`. */
  moveTo(frame: number, clipIds: ID[] = ui().selection): void {
    editing((s, p) => {
      const r = moveEdits(p, effectiveSelection(p, clipIds), frame);
      if (r.edits.length) s.store.commit(r.edits);
      if (r.limited) toast('Another clip is in the way, so the move stops there.', 'info');
    });
  },
  /**
   * Put another file from the pool behind a clip where it stands, keeping what was done to the
   * clip (see `replaceEdits`). This swaps one clip's media; `replaceMedia` swaps the file itself.
   */
  replaceClip(clipId: ID, assetId: ID, sourceIn = 0): void {
    editing((s, p) => {
      const asset = p.assets[assetId];
      if (!p.clips[clipId] || !asset) return;
      if (!unlocked(p, [clipId]).length) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      const r = replaceEdits(p, clipId, asset, sourceIn);
      if (r.refused) {
        toast(r.refused, 'info');
        return;
      }
      s.store.commit(r.edits);
      ui().select(effectiveSelection(s.store.get(), [clipId]));
      if (r.shortened) toast(`“${asset.name}” is shorter than the clip was, so the clip now ends earlier.`, 'info');
    });
  },
  updateSelected(patch: Partial<Clip>, merge = false): void {
    editing((s, p) => {
      const clips = selectedClips(p);
      if (clips.length)
        s.store.commit(
          clips.map((c) => ({ op: 'updateClip', id: c.id, patch }) as Edit),
          { merge },
        );
    });
  },

  // ───────────────────────────────────────────────────── adding content ──
  addAsset(
    asset: Asset,
    opts: {
      frame?: number;
      videoTrackId?: ID | null;
      audioTrackId?: ID | null;
      sourceIn?: number;
      sourceOut?: number;
      insert?: boolean;
      /** Only the picture, or only the sound, of a video that has both. */
      only?: 'video' | 'audio';
    } = {},
  ): void {
    editing((s, p) => {
      if (asset.kind === 'lut') {
        cmd.applyLut(asset.id);
        return;
      }
      const at = opts.frame ?? frame();
      let working = p;
      const pre: Edit[] = [];
      if (opts.insert) {
        const len =
          asset.kind === 'image'
            ? secondsToFrame(5, p.settings)
            : secondsToFrame((opts.sourceOut ?? asset.duration) - (opts.sourceIn ?? 0), p.settings);
        const room = openGapAt(p, at, Math.max(1, len));
        pre.push(...withMarkers(p, room));
        // Compute placement against the timeline as it will look once the gap is open.
        working = applyPreview(p, pre);
      }
      const r = addAssetToTimeline(working, asset, { frame: at, ...opts });
      s.store.commit([...pre, ...r.edits]);
      ui().select(r.created);
      const end = Math.max(...r.created.map((id) => clipEnd(s.store.get().clips[id])));
      if (opts.frame === undefined) cmd.seek(end);
    });
  },
  addText(text: Partial<TextProps> = {}, init: Partial<Clip> = {}): void {
    editing((s, p) => {
      const r = addGenerator(p, 'text', { frame: frame(), text, init });
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  /**
   * Add a title and go straight to typing it. This is what asking for a title by hand does (the T
   * key, the toolbar, the menus); `addText` only places the clip.
   */
  addTitle(text: Partial<TextProps> = {}, init: Partial<Clip> = {}): void {
    editing((s, p) => {
      const r = addGenerator(p, 'text', { frame: frame(), text, init });
      s.store.commit(r.edits);
      cmd.editText(r.created[0]);
    });
  },
  /**
   * Select a title and put the keyboard in its text field, with the text selected so that typing
   * replaces it.
   */
  editText(clipId: ID): void {
    editing((_s, p) => {
      const clip = p.clips[clipId];
      if (!clip || clip.type !== 'text') return;
      if (p.tracks[clip.trackId]?.locked) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      ui().set({ selection: [clip.id], selectedTransition: null, workspace: 'edit' });
      uncover('right');
      focusTextField(clip.id);
    });
  },
  addShape(shape: Partial<ShapeProps> = {}): void {
    editing((s, p) => {
      const r = addGenerator(p, 'shape', { frame: frame(), shape });
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  addSolid(fill = '#1f2937'): void {
    editing((s, p) => {
      const r = addGenerator(p, 'solid', { frame: frame(), shape: { fill } });
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  addAdjustment(): void {
    editing((s, p) => {
      const r = addGenerator(p, 'adjustment', { frame: frame() });
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  addTrack(kind: 'video' | 'audio'): void {
    editing((s, p) => s.store.commit(addTrack(p, kind).edits));
  },
  removeTrack(id: ID): void {
    editing((s, p) => s.store.commit(removeTrack(p, id)));
  },
  /** Toggle a marker at the playhead, or add one at `at` (a place picked with the pointer). */
  addMarker(at?: number): void {
    editing((s, p) => {
      const f = at ?? frame();
      const existing = Object.values(p.markers).find((m) => m.frame === f);
      if (existing) {
        // Only the playhead form toggles: pointing at a place never takes a marker away.
        if (at === undefined) s.store.commit([{ op: 'removeMarker', id: existing.id }]);
        return;
      }
      const n = Object.keys(p.markers).length;
      s.store.commit([
        {
          op: 'setMarker',
          marker: {
            id: newId(8),
            frame: f,
            name: `Marker ${n + 1}`,
            color: MARKER_COLORS[n % MARKER_COLORS.length],
            note: '',
          },
        },
      ]);
    });
  },

  /** Move the playhead to the nearest marker after (`1`) or before (`-1`) it. */
  goToMarker(dir: 1 | -1): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const to = markerBeside(p, frame(), dir);
    if (to !== null) cmd.seek(to);
    else if (!Object.keys(p.markers).length) toast('There are no markers yet. Press M to add one.', 'info');
  },

  /** Switch whether markers move with the shots they stand on when a ripple edit moves those. */
  toggleMarkersFollow(): void {
    const follow = !ui().markersFollow;
    ui().set({ markersFollow: follow });
    // Run from the palette there is no switch to look at, so the command says which way it now is.
    toast(follow ? 'Markers follow ripple edits.' : 'Markers stay where they are through ripple edits.');
  },

  // ─────────────────────────────────────────────── effects & transitions ──
  applyEffect(type: string, clipIds?: ID[]): void {
    editing((s, p) => {
      const def = getEffectDef(type);
      if (!def) return;
      const wanted = (clipIds ?? ui().selection).filter((id) => p.clips[id] && p.clips[id].type !== 'audio');
      const ids = unlocked(p, wanted);
      if (!ids.length) {
        toast(wanted.length ? LOCKED_TRACK : 'Select a clip to apply the effect to.', 'info');
        return;
      }
      s.store.commit(
        ids.map(
          (id) =>
            ({
              op: 'updateClip',
              id,
              patch: { effects: [...p.clips[id].effects, makeEffect(type)] },
            }) as Edit,
        ),
      );
      if (!clipIds) toast(`${def.name} added`, 'success');
    });
  },
  /**
   * Put a transition on one side of `clipId`. Without a clip it goes on the cuts of the selection,
   * else on the cut nearest the playhead (see `transitionTargets`), and becomes the transition
   * `Add default transition` applies from then on.
   */
  applyTransition(type: string, clipId?: ID, side: 'in' | 'out' = 'in'): void {
    editing((s, p) => {
      const def = getTransitionDef(type);
      if (!def) return;
      if (clipId && !unlocked(p, [clipId]).length) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      const targets = clipId ? [clipId] : transitionTargets(p, ui().selection, frame());
      if (!targets.length) {
        toast('Add a clip first, then drop a transition on a cut.', 'info');
        return;
      }
      const at = clipId ? side : 'in';
      const dur = secondsToFrame(0.6, p.settings);
      s.store.commit(transitionEdits(p, targets, at, makeTransition(type, dur)));
      // One transition is selected, ready to be adjusted. Several leave their clips selected.
      if (targets.length === 1) {
        ui().set({ selectedTransition: { clipId: targets[0], side: at }, selection: [] });
      } else toast(`${def.name} added to ${count(targets.length, 'clip')}`, 'success');
      ui().set({ defaultTransition: type });
    });
  },
  /** Put the transition last chosen (a cross dissolve to begin with) on the selected cuts. */
  addDefaultTransition(): void {
    const last = ui().defaultTransition;
    cmd.applyTransition(getTransitionDef(last) ? last : FIRST_TRANSITION);
  },
  applyLut(assetId: ID): void {
    editing((s, p) => {
      const clips = selectedClips(p).filter((c) => c.type !== 'audio');
      if (!clips.length) {
        toast('Select a clip to apply the LUT to.', 'info');
        return;
      }
      s.store.commit(
        clips.map(
          (c) =>
            ({
              op: 'updateClip',
              id: c.id,
              patch: { grade: { ...(c.grade ?? defaultGrade()), lutId: assetId, enabled: true } },
            }) as Edit,
        ),
      );
    });
  },
  /**
   * Copy the attributes of the selection: the look of its first picture clip and the sound
   * settings of its first audio clip. `clipId` copies from that clip alone, for a panel that shows
   * a clip of its own.
   */
  copyAttributes(clipId?: ID): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const from = clipId ? [p.clips[clipId]].filter(Boolean) : selectedClips(p);
    const attributes = copiedAttributes(from, fpsOf(p.settings));
    if (!attributes) {
      toast('Select a clip to copy its attributes.', 'info');
      return;
    }
    ui().set({ attributes });
    toast('Attributes copied', 'info');
  },
  /**
   * Paste copied attributes onto the selected clips, or onto `clipIds`: all of them, or only the
   * grade, the effects, the transform and crop, or the sound settings (see `attributePatch`).
   */
  pasteAttributes(what: AttributeMode = 'all', clipIds?: ID[]): void {
    editing((s, p) => {
      const a = ui().attributes;
      if (!a) {
        toast('Copy the attributes of a clip first.', 'info');
        return;
      }
      const wanted = (clipIds ?? ui().selection).filter((id) => p.clips[id]);
      const clips = unlocked(p, wanted).map((id) => p.clips[id]);
      if (!clips.length) {
        toast(wanted.length ? LOCKED_TRACK : 'Select the clips to paste the attributes onto.', 'info');
        return;
      }
      const edits: Edit[] = [];
      for (const c of clips) {
        const patch = attributePatch(p, c, a, what);
        if (patch) edits.push({ op: 'updateClip', id: c.id, patch });
      }
      if (!edits.length) {
        toast('Nothing was pasted: what was copied does not go onto this kind of clip.', 'info');
        return;
      }
      s.store.commit(edits);
      toast(`${PASTED[what]} pasted onto ${count(edits.length, 'clip')}`, 'info');
    });
  },

  // ───────────────────────────────────────────────────────────────── view ──
  zoom(factor: number, anchorX?: number): void {
    ui().set(zoomView(ui(), factor, timelineWidth, frame(), anchorX));
  },
  zoomFit(): void {
    const s = session();
    if (!s) return;
    const end = Math.max(sequenceEnd(s.store.get()), secondsToFrame(10, s.store.get().settings));
    ui().set(fitView(0, end, timelineWidth));
  },
  /** Fill the timeline with the selected clips, or with the marked range when nothing is selected. */
  zoomToSelection(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const clips = ui()
      .selection.map((id) => p.clips[id])
      .filter(Boolean);
    const range = s.player?.getState().range;
    if (clips.length) {
      ui().set(
        fitView(Math.min(...clips.map((c) => c.start)), Math.max(...clips.map(clipEnd)), timelineWidth),
      );
    } else if (range) ui().set(fitView(range.in, range.out, timelineWidth));
    else toast('Select clips or mark a range to zoom to.', 'info');
  },

  // ───────────────────────────────────────────────────────────────── files ──
  /**
   * Voiceover: the first call starts recording the microphone and plays the timeline from the
   * playhead; the second stops, and the take lands on a free audio track where it began.
   */
  async toggleVoiceover(): Promise<void> {
    const s = session();
    if (!s || recorderBusy) return;
    if (!recorder) {
      if (!s.canEdit) {
        refuseEdit(s.getMeta().role, 'error');
        return;
      }
      recorderBusy = true;
      try {
        const rec = await VoiceRecorder.start();
        // A capture that breaks ends the take there and then. Left recording, the take would only
        // turn out to be lost when it is stopped, however long the person went on talking.
        rec.onError = (err) => {
          if (recorder !== rec) return;
          recorder = null;
          ui().set({ recording: null });
          s.getMeta().player?.pause();
          toast(`The recording stopped. ${err.message}`, 'error');
        };
        recorder = rec;
      } catch (err) {
        const name = (err as Error)?.name;
        toast(
          name === 'NotAllowedError'
            ? 'Microphone access was blocked. Allow it for this site to record a voiceover.'
            : name === 'NotFoundError'
              ? 'No microphone was found.'
              : err instanceof Error
                ? err.message
                : 'Could not start recording.',
          'error',
        );
        return;
      } finally {
        recorderBusy = false;
      }
      ui().set({ recording: { startFrame: frame(), startedAt: performance.now() } });
      s.getMeta().player?.play();
      return;
    }
    const rec = recorder;
    const info = ui().recording;
    recorder = null;
    recorderBusy = true;
    ui().set({ recording: null });
    s.getMeta().player?.pause();
    try {
      const blob = await rec.stop();
      const taken = new Set(Object.values(s.store.get().assets).map((a) => a.name));
      let n = 1;
      while (taken.has(`Voiceover ${n}.wav`)) n++;
      const [asset] = await s.importFiles([new File([blob], `Voiceover ${n}.wav`, { type: 'audio/wav' })]);
      if (!asset) return;
      // Start the clip where recording began; skip the input latency so speech lines up with picture.
      const r = addAssetToTimeline(s.store.get(), asset, {
        frame: info?.startFrame ?? 0,
        sourceIn: rec.latency,
      });
      s.store.commit(r.edits);
      ui().select(r.created);
      toast('Voiceover added to the timeline.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The recording could not be saved.', 'error');
    } finally {
      recorderBusy = false;
    }
  },

  /** Throw away a recording in progress (the project is closing). */
  cancelVoiceover(): void {
    const rec = recorder;
    recorder = null;
    if (ui().recording) ui().set({ recording: null });
    void rec?.cancel();
  },

  /** Microphone peak, 0…1, while recording. */
  voiceoverLevel(): number {
    return recorder?.level() ?? 0;
  },

  /**
   * Loudness normalisation: measure each selected audio clip (ITU-R BS.1770 integrated loudness of
   * the part of the source it uses) and set its gain so it plays at `target` LUFS, never letting
   * the peak past −1 dBFS.
   */
  async normalizeLoudness(target = -14): Promise<void> {
    const s = session();
    if (!s) return;
    if (!s.canEdit) {
      refuseEdit(s.getMeta().role, 'error');
      return;
    }
    const p = s.store.get();
    const clips = effectiveSelection(p)
      .map((id) => p.clips[id])
      .filter((c) => c && c.type === 'audio' && c.assetId);
    if (!clips.length) {
      toast('Select one or more audio clips to normalise.');
      return;
    }
    toast(`Measuring ${clips.length === 1 ? 'the clip' : `${clips.length} clips`}…`);
    const edits: Edit[] = [];
    let skipped = 0;
    for (const clip of clips) {
      const measured = await measureClip(s, clip, p).catch(() => null);
      const gain = measured ? normalizationGain(measured, target) : null;
      // A clip with a volume envelope already has a deliberate shape; leave it alone.
      if (gain === null || clip.keyframes.volume?.length) {
        skipped++;
        continue;
      }
      edits.push({
        op: 'updateClip',
        id: clip.id,
        patch: { volume: clamp(Math.round(gain * 10) / 10, -48, 24) },
      });
    }
    // The measurement was asynchronous: only touch clips that still exist.
    const now = s.store.get();
    const live = edits.filter((e) => e.op === 'updateClip' && now.clips[e.id]);
    if (live.length) s.store.commit(live);
    const done = live.length;
    toast(
      done
        ? `Normalised ${done === 1 ? 'the clip' : `${done} clips`} to ${target} LUFS${skipped ? ` (${skipped} skipped)` : ''}.`
        : 'Nothing to normalise: the selection is silent, offline, or has a volume envelope.',
      done ? 'success' : 'info',
    );
  },

  /** Make preview proxies for every large video that has none. */
  createProxies(): void {
    const s = session();
    if (!s) return;
    const n = s.createProxies();
    if (n) {
      toast(
        `Making ${n === 1 ? 'a proxy' : `${n} proxies`} in the background. Exports always use the originals.`,
      );
      if (!s.getMeta().proxies) s.setProxies(true);
    } else toast('Nothing to do: no large videos without a proxy.');
  },

  toggleProxies(): void {
    const s = session();
    if (!s) return;
    s.setProxies(!s.getMeta().proxies);
    toast(
      s.getMeta().proxies ? 'Previewing from proxies where they exist.' : 'Previewing from original media.',
    );
  },

  /** Pick a file to stand in for an asset: relink offline media or drop in a new version. */
  async replaceMedia(assetId: string): Promise<void> {
    const s = session();
    const asset = s?.store.get().assets[assetId];
    if (!s || !asset) return;
    const accept =
      asset.kind === 'video'
        ? 'video/*,.mkv,.mov,.ts'
        : asset.kind === 'audio'
          ? 'audio/*'
          : asset.kind === 'image'
            ? 'image/*'
            : '.cube';
    const [file] = await pickFiles(accept, false);
    if (!file) return;
    const next = await s.replaceAsset(assetId, file);
    if (next) toast(`Replaced "${asset.name}" with "${next.name}".`);
  },

  async importMedia(): Promise<void> {
    const s = session();
    if (!s) return;
    const files = await pickFiles(MEDIA_ACCEPT, true);
    if (files.length) await cmd.importFiles(files);
  },
  async importFiles(files: File[]): Promise<Asset[]> {
    const s = session();
    if (!s) return [];
    const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name));
    const media = files.filter((f) => !/\.(srt|vtt)$/i.test(f.name));
    for (const f of subs) cmd.importSubtitles(await f.text());
    if (!media.length) return [];
    const assets = await s.importFiles(media);
    if (assets.length) toast(`Imported ${assets.length} file${assets.length > 1 ? 's' : ''}`, 'success');
    // Footage beyond 1080p is where proxies start to pay off: offer, never impose.
    if (assets.some((a) => s.canProxy(a) && Math.min(a.width, a.height) > 1100)) {
      toast('Large footage imported. Proxies make it lighter to edit.', 'info', {
        label: 'Create proxies',
        run: () => cmd.createProxies(),
      });
    }
    return assets;
  },
  /** Fetch the bundled sample media and assemble a short demo edit from it. */
  async loadSample(): Promise<void> {
    const s = session();
    if (!s) return;
    if (!canEdit(s.getMeta().role)) {
      refuseEdit(s.getMeta().role);
      return;
    }
    const names = ['dusk.mp4', 'fractal.mp4', 'aurora.mp4', 'pulse.ogg'];
    let files: File[];
    try {
      files = await Promise.all(
        names.map(async (name) => {
          const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          return new File([blob], name, { type: name.endsWith('.ogg') ? 'audio/ogg' : 'video/mp4' });
        }),
      );
    } catch {
      toast('Could not load the sample media.', 'error');
      return;
    }
    const assets = await s.importFiles(files);
    const by = (n: string) => assets.find((a) => a.name === n);
    const [a, b, c, music] = [by('dusk.mp4'), by('fractal.mp4'), by('aurora.mp4'), by('pulse.ogg')];
    if (!a || !b || !c) return;
    let p = s.store.get();
    if (sequenceEnd(p) > 0) {
      toast('Sample media added to the pool', 'success');
      return;
    }
    const fps = p.settings.fpsNum / p.settings.fpsDen;
    const { video, audio } = tracksOf(p);
    const edits: Edit[] = [];
    const place = (
      asset: Asset,
      start: number,
      track: ID | undefined,
      extra: Partial<AddAssetOptions> = {},
    ) => {
      const r = addAssetToTimeline(p, asset, {
        frame: start,
        videoTrackId: track,
        audioTrackId: audio[0]?.id,
        ...extra,
      });
      edits.push(...r.edits);
      p = applyPreview(p, r.edits);
      return r.created;
    };
    const len = Math.round(4 * fps);
    const [ca] = place(a, 0, video[0]?.id, { sourceOut: 4 });
    const [cb] = place(b, len, video[0]?.id, { sourceIn: 1, sourceOut: 5 });
    const [cc] = place(c, len * 2, video[0]?.id, { sourceOut: 4 });
    if (music) place(music, 0, undefined, { sourceOut: 12 });
    const dur = Math.round(0.8 * fps);
    edits.push(
      { op: 'updateClip', id: cb, patch: { transIn: makeTransition('crossZoom', dur) } },
      {
        op: 'updateClip',
        id: cc,
        patch: { transIn: makeTransition('lumaFade', dur), transOut: makeTransition('dipToBlack', dur) },
      },
      {
        op: 'updateClip',
        id: ca,
        patch: {
          transIn: makeTransition('dipToBlack', Math.round(0.5 * fps)),
          effects: [makeEffect('filmGrain')],
        },
      },
    );
    p = applyPreview(p, edits.slice(-3));
    const musicClip = Object.values(p.clips).find((x) => x.type === 'audio');
    if (musicClip)
      edits.push({
        op: 'updateClip',
        id: musicClip.id,
        patch: { fadeIn: Math.round(0.5 * fps), fadeOut: Math.round(1.5 * fps), volume: -4 },
      });
    const title = addGenerator(p, 'text', {
      frame: Math.round(0.6 * fps),
      duration: Math.round(3 * fps),
      trackId: video[1]?.id,
      text: {
        ...DEFAULT_TEXT,
        content: 'Edit in tandem',
        size: 0.13,
        weight: 800,
        letterSpacing: -0.02,
        animIn: { type: 'slideUp', duration: Math.round(0.5 * fps) },
        animOut: { type: 'fade', duration: Math.round(0.4 * fps) },
        shadow: { ...DEFAULT_TEXT.shadow, enabled: true },
      },
    });
    edits.push(...title.edits);
    edits.push({
      op: 'setMarker',
      marker: { id: newId(8), frame: len, name: 'First cut', color: MARKER_COLORS[0], note: '' },
    });
    s.store.commit(edits);
    cmd.seek(Math.round(1.5 * fps));
    cmd.zoomFit();
    toast('Sample project loaded — press Space to play', 'success');
  },
  importSubtitles(text: string): void {
    editing((s, p) => {
      const cues = parseSubtitles(text);
      if (!cues.length) {
        toast('No subtitles found in that file.', 'error');
        return;
      }
      // Captions get a track of their own on top.
      const t = addTrack(p, 'video');
      const edits: Edit[] = [
        ...t.edits,
        { op: 'updateTrack', id: t.trackId, patch: { name: CAPTION_TRACK } },
      ];
      let working = applyPreview(p, edits);
      for (const cue of cues) {
        const start = secondsToFrame(cue.start, p.settings);
        const r = addGenerator(working, 'text', {
          frame: start,
          trackId: t.trackId,
          duration: Math.max(1, secondsToFrame(cue.end, p.settings) - start),
          text: {
            ...DEFAULT_TEXT,
            content: cue.text,
            size: 0.05,
            weight: 600,
            boxWidth: 0.8,
            bg: { ...DEFAULT_TEXT.bg, enabled: true },
          },
          init: { y: 0.36, name: cue.text.slice(0, 40) },
        });
        edits.push(...r.edits);
        working = applyPreview(working, r.edits);
      }
      s.store.commit(edits);
      toast(`Added ${cues.length} captions`, 'success');
    });
  },
  /** A CMX 3600 edit decision list of the cut, for conforming in another editor. */
  exportEdl(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const edl = toEdl(p);
    if (!/^\d{3} /m.test(edl)) {
      toast('There are no media clips to list.', 'info');
      return;
    }
    downloadBlob(new Blob([edl], { type: 'text/plain' }), `${safeName(p.settings.name)}.edl`);
    toast('EDL exported: cuts, source ranges and speed changes. Effects and titles are not part of an EDL.');
  },

  /**
   * Write captions as an .srt file: the selected text clips, else what is on the caption tracks,
   * so that titles and lower thirds do not come out as subtitles (see `captionClips`). `trackId`
   * exports one track, whatever it is called.
   */
  exportSubtitles(trackId?: ID): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const { clips, from, tracks } = captionClips(p, ui().selection, trackId);
    const where =
      tracks.length === 1 ? tracks[0].name || trackLabel(p, tracks[0]) : `${tracks.length} caption tracks`;
    if (!clips.length) {
      toast(
        from === 'everything'
          ? 'There are no text clips to export.'
          : `There is no text on ${where} to export.`,
        'info',
      );
      return;
    }
    const cues = clips.map((c) => ({
      start: framesToSeconds(c.start, p.settings),
      end: framesToSeconds(clipEnd(c), p.settings),
      text: c.text!.content,
    }));
    downloadBlob(
      new Blob([toSrt(cues)], { type: 'application/x-subrip' }),
      `${safeName(p.settings.name)}.srt`,
    );
    const several = tracks.length > 1 ? ' Hide a caption track to leave it out.' : '';
    toast(
      from === 'selection'
        ? `Exported ${count(cues.length, 'selected caption')}.`
        : from === 'everything'
          ? `Exported all ${count(cues.length, 'text clip')}, titles included. To leave titles out, select the captions or keep them on a track named “${CAPTION_TRACK}”.`
          : `Exported ${count(cues.length, 'caption')} from ${where}.${several}`,
      from === 'everything' ? 'info' : 'success',
    );
  },
  saveProjectFile(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    downloadBlob(
      new Blob([serializeProject(p)], { type: 'application/json' }),
      `${safeName(p.settings.name)}.tandem`,
    );
  },
  /**
   * Open a project file as a project of its own. The open project is left alone: a file can come
   * from anywhere, and loading it over a shared timeline would replace that for everyone in it.
   */
  async openProjectFile(): Promise<void> {
    const parsed = await pickProjectFile();
    if (!parsed) return;
    const from = session();
    try {
      // What the file says about uploads was true of the project it was saved from, not of this one.
      const id = await createProject(
        parsed.settings,
        withUploads(parsed, () => false),
      );
      const ids = Object.keys(parsed.assets);
      // Media of the open project that the file also uses comes along, so a file saved from this
      // project opens with its footage instead of everything offline.
      const local = from
        ? ids.filter((a) => from.media.get(a).local && from.media.get(a).unsaved === null)
        : [];
      if (from && local.length) {
        toast(`Copying ${count(local.length, 'media file')} into the new project…`);
        await copyProjectMedia(from.id, id, local);
      }
      navigate(id);
      toast(
        local.length === ids.length
          ? `Opened “${parsed.settings.name}” as a new project.`
          : `Opened “${parsed.settings.name}” as a new project. Media that is not on this device shows as offline until it is relinked.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the project file', 'error');
    }
  },
  /** Load a project file over the open project, after spelling out what that removes. */
  async replaceWithProjectFile(): Promise<void> {
    const s = session();
    if (!s) return;
    if (!s.canEdit) {
      refuseEdit(s.getMeta().role);
      return;
    }
    const parsed = await pickProjectFile();
    if (!parsed) return;
    const open = s.store.get();
    const contents = [
      count(Object.keys(open.clips).length, 'clip'),
      count(Object.keys(open.tracks).length, 'track'),
      count(Object.keys(open.assets).length, 'media file'),
    ];
    const everyone = s.getMeta().shared ? ' for everyone working on it' : '';
    const go = await confirm({
      title: `Replace “${open.settings.name}” with “${parsed.settings.name}”?`,
      message:
        `Everything in the open project is removed${everyone}: ${contents[0]}, ${contents[1]} and ${contents[2]}. ` +
        'Undo brings it back only until the project is closed or reloaded. After that, media that is ' +
        'not part of the new project is deleted from this device as well.',
      confirmLabel: 'Replace project',
      danger: true,
    });
    // The question was about the project that was open when it was asked.
    if (!go || session() !== s) return;
    editing((s) => {
      // What the file says about uploads was true of the project it was saved from. The session
      // keeps what the server holds of this one.
      s.replaceProject(withUploads(parsed, () => false));
      ui().clearSelection();
      toast(
        `Replaced with “${parsed.settings.name}”. Media that is not on this device or the server shows as offline.`,
        'success',
      );
    });
  },
  async captureStill(): Promise<void> {
    const s = session();
    if (!s) return;
    try {
      const p = s.store.get();
      const resolver = s.exportResolver();
      const blob = await renderStill(p, resolver, frame(), (w) => toast(w.message));
      downloadBlob(blob, `${safeName(p.settings.name)}-frame-${frame()}.png`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not capture the frame', 'error');
    }
  },
  renameProject(name: string): void {
    editing((s) => s.store.commit([{ op: 'settings', patch: { name: name.trim() || 'Untitled project' } }]));
  },
};

function defaultGrade() {
  return structuredClone(DEFAULT_GRADE);
}

export { displayTracks };
