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
  getEffectDef,
  getTransitionDef,
  linkClips,
  makeEffect,
  makeTransition,
  MARKER_COLORS,
  newId,
  openGap,
  parseProjectFile,
  parseSubtitles,
  pasteClips,
  placeClips,
  removeTrack,
  rippleCloseGap,
  rippleDelete,
  rippleTrimTo,
  secondsToFrame,
  sequenceEnd,
  serializeProject,
  setSpeed,
  setTransition,
  splitClips,
  freezeFrame,
  toSrt,
  toEdl,
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
  type TextProps,
  LoudnessMeter,
  normalizationGain,
  type LoudnessResult,
  sourcePerFrame,
  clamp,
} from '@tandem/core';
import { AudioBufferSink, renderStill, VoiceRecorder } from '@tandem/engine';
import { navigate } from '../App';
import { currentSession } from '../session/hooks';
import { copyProjectMedia } from '../session/mediaStore';
import { createProject } from '../session/projects';
import type { Session } from '../session/session';
import { toast } from '../ui/core';
import {
  clipsBeside,
  closeGapsAt,
  duplicateClips,
  markerBeside,
  matchFrameAt,
  pasteable,
  rippleDeleteRange,
  unlocked,
} from './edits';
import { useUI, type Tool } from './ui';
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
    toast('You have view-only access to this project.', 'info');
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

let recorder: VoiceRecorder | null = null;
let recorderBusy = false;

export const MEDIA_ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.ts,.cube,.srt,.vtt';

export const cmd = {
  // ───────────────────────────────────────────────────────────── history ──
  undo(): void {
    editing((s) => s.store.undo());
  },
  redo(): void {
    editing((s) => s.store.redo());
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
      const fps = p.settings.fpsNum / p.settings.fpsDen;
      const r = freezeFrame(p, pick, f, Math.round(fps * 2));
      if (!r.edits.length) return;
      s.store.commit(r.edits);
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
          s.store.commit(r.edits);
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
        const r = rippleDelete(p, ids);
        if (r.refused) {
          toast(r.refused);
          return;
        }
        s.store.commit(r.edits);
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
      ui().set({ clipboard: clips });
      toast(`Copied ${clips.length} clip${clips.length > 1 ? 's' : ''}`, 'info');
    }
  },
  cut(): void {
    cmd.copy();
    cmd.delete(false);
  },
  paste(): void {
    editing((s, p) => {
      if (!ui().clipboard.length) return;
      const { clips, missing } = pasteable(p, ui().clipboard);
      if (missing) {
        const what = missing === 1 ? 'One clip was' : `${missing} clips were`;
        toast(
          `${clips.length ? `${what} left out` : 'Nothing was pasted'}: the media is not in this project.`,
        );
      }
      if (!clips.length) return;
      const r = pasteClips(p, clips, frame());
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  duplicate(): void {
    editing((s, p) => {
      const r = duplicateClips(p, effectiveSelection(p));
      if (!r.edits.length) return;
      s.store.commit(r.edits);
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
  /** Move the selection one track up (+1) or down (-1) in stacking order. */
  nudgeTrack(dir: 1 | -1): void {
    editing((s, p) => {
      const ids = unlocked(p, ui().selection);
      if (!ids.length) return;
      const { video, audio } = tracksOf(p);
      const placements = [];
      for (const id of ids) {
        const c = p.clips[id];
        const list = p.tracks[c.trackId]?.kind === 'audio' ? audio : video;
        const i = list.findIndex((t) => t.id === c.trackId);
        // Audio is listed top-down, so "up" means a lower index there.
        const j = p.tracks[c.trackId]?.kind === 'audio' ? i - dir : i + dir;
        if (j < 0 || j >= list.length || list[j].locked) return;
        placements.push({ id, start: c.start, trackId: list[j].id });
      }
      s.store.commit(placeClips(p, placements));
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
  /** Ripple-trim the head (Q) or tail (W) of the clips under the playhead to the playhead. */
  trimToPlayhead(edge: 'start' | 'end'): void {
    editing((s, p) => {
      const f = frame();
      let ids = effectiveSelection(p).filter((id) => p.clips[id].start < f && f < clipEnd(p.clips[id]));
      if (!ids.length) ids = unlocked(p, withLinked(p, clipsUnderFrame(p, f)));
      if (!ids.length) return;
      // One plan for all of them: the time they give up in common closes once, on every track.
      const r = rippleTrimTo(p, ids, edge, f);
      if (r.refused) {
        toast(r.refused);
        return;
      }
      if (!r.edits.length) return;
      s.store.commit(r.edits);
      if (edge === 'start') cmd.seek(Math.min(...ids.map((id) => p.clips[id].start)));
    });
  },
  closeGapAtPlayhead(): void {
    editing((s, p) => {
      const r = closeGapsAt(p, frame());
      if (r.refused) toast(r.refused);
      else if (r.edits.length) s.store.commit(r.edits);
    });
  },
  /** Close the gap under `at` on one track; the other tracks follow where they can. */
  closeGap(trackId: ID, at: number): void {
    editing((s, p) => {
      if (p.tracks[trackId]?.locked) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      const r = rippleCloseGap(p, trackId, at);
      if (r.refused) toast(r.refused);
      else if (r.edits.length) s.store.commit(r.edits);
    });
  },
  setSpeed(speed: number, reverse?: boolean): void {
    editing((s, p) => s.store.commit(setSpeed(p, effectiveSelection(p), speed, reverse)));
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
        const tracks = Object.values(p.tracks)
          .filter((t) => !t.locked)
          .map((t) => t.id);
        pre.push(...openGap(p, tracks, at, Math.max(1, len)));
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
  applyTransition(type: string, clipId?: ID, side: 'in' | 'out' = 'in'): void {
    editing((s, p) => {
      const def = getTransitionDef(type);
      if (!def) return;
      const dur = secondsToFrame(0.6, p.settings);
      let target = clipId;
      if (target && !unlocked(p, [target]).length) {
        toast(LOCKED_TRACK, 'info');
        return;
      }
      if (!target) {
        const sel = unlocked(p, ui().selection).filter((id) => p.clips[id].type !== 'audio');
        if (sel.length) target = sel[0];
        else {
          // Nearest cut to the playhead on a video track.
          const f = frame();
          let best: Clip | null = null;
          for (const c of Object.values(p.clips)) {
            if (c.type === 'audio' || p.tracks[c.trackId]?.locked) continue;
            if (!best || Math.abs(c.start - f) < Math.abs(best.start - f)) best = c;
          }
          target = best?.id;
        }
      }
      if (!target) {
        toast('Add a clip first, then drop a transition on a cut.', 'info');
        return;
      }
      s.store.commit(setTransition(p, target, side, makeTransition(type, dur)));
      ui().set({ selectedTransition: { clipId: target, side }, selection: [] });
    });
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
  copyAttributes(): void {
    const s = session();
    if (!s) return;
    const c = selectedClips(s.store.get())[0];
    if (!c) return;
    ui().set({
      attributes: {
        effects: c.effects,
        grade: c.grade,
        transform: {
          x: c.x,
          y: c.y,
          scaleX: c.scaleX,
          scaleY: c.scaleY,
          rotation: c.rotation,
          opacity: c.opacity,
          blend: c.blend,
          cropL: c.cropL,
          cropT: c.cropT,
          cropR: c.cropR,
          cropB: c.cropB,
        },
      },
    });
    toast('Attributes copied', 'info');
  },
  pasteAttributes(what: 'all' | 'grade' | 'effects' = 'all'): void {
    editing((s, p) => {
      const a = ui().attributes;
      const clips = selectedClips(p).filter((c) => c.type !== 'audio');
      if (!a || !clips.length) return;
      // Attributes can be carried between projects; a LUT that is not in this one stays behind.
      const grade = a.grade?.lutId && !p.assets[a.grade.lutId] ? { ...a.grade, lutId: null } : a.grade;
      s.store.commit(
        clips.map((c) => {
          const patch: Partial<Clip> = {};
          if (what !== 'effects') patch.grade = grade;
          if (what !== 'grade') patch.effects = a.effects.map((e) => ({ ...e, id: newId(8) }));
          if (what === 'all') Object.assign(patch, a.transform);
          return { op: 'updateClip', id: c.id, patch } as Edit;
        }),
      );
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
        toast('You have view-only access to this project.', 'error');
        return;
      }
      recorderBusy = true;
      try {
        recorder = await VoiceRecorder.start();
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
      toast('You have view-only access to this project.', 'error');
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
      toast('You have view-only access to this project.', 'info');
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
      const edits: Edit[] = [...t.edits, { op: 'updateTrack', id: t.trackId, patch: { name: 'Captions' } }];
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

  exportSubtitles(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const cues = Object.values(p.clips)
      .filter((c) => c.type === 'text' && c.text && c.enabled)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({
        start: framesToSeconds(c.start, p.settings),
        end: framesToSeconds(clipEnd(c), p.settings),
        text: c.text!.content,
      }));
    if (!cues.length) {
      toast('There are no text clips to export.', 'info');
      return;
    }
    downloadBlob(
      new Blob([toSrt(cues)], { type: 'application/x-subrip' }),
      `${safeName(p.settings.name)}.srt`,
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
      toast('You have view-only access to this project.', 'info');
      return;
    }
    const parsed = await pickProjectFile();
    if (!parsed) return;
    editing((s, p) => {
      const contents = [
        count(Object.keys(p.clips).length, 'clip'),
        count(Object.keys(p.tracks).length, 'track'),
        count(Object.keys(p.assets).length, 'media file'),
      ];
      const everyone = s.getMeta().shared ? ' for everyone working on it' : '';
      if (
        !confirm(
          `Replace “${p.settings.name}” with “${parsed.settings.name}”?\n\n` +
            `Everything in the open project is removed${everyone}: ${contents[0]}, ${contents[1]} and ${contents[2]}. ` +
            'Undo brings it back only until the project is closed or reloaded. After that, media that is ' +
            'not part of the new project is deleted from this device as well.',
        )
      )
        return;
      // The server holds what was uploaded to this project, whatever the file remembers.
      s.store.replaceAll(withUploads(parsed, (a) => !!p.assets[a.id]?.uploaded));
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
      const blob = await renderStill(p, resolver, frame());
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
