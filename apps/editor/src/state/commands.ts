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
  closeGap,
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
  secondsToFrame,
  sequenceEnd,
  serializeProject,
  setSpeed,
  setTransition,
  splitClips,
  toSrt,
  tracksOf,
  trimClips,
  unlinkClips,
  withLinked,
  framesToSeconds,
  DEFAULT_TEXT,
  type Asset,
  type Clip,
  type Edit,
  type ID,
  type Project,
  type ShapeProps,
  type TextProps,
} from '@tandem/core';
import { renderStill } from '@tandem/engine';
import { currentSession } from '../session/hooks';
import type { Session } from '../session/session';
import { toast } from '../ui/core';
import { clampPpf, useUI, type Tool } from './ui';

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
  return ui()
    .selection.map((id) => p.clips[id])
    .filter(Boolean);
}

/** Selection, widened to linked partners when linked selection is on. */
export function effectiveSelection(p: Project, ids: ID[] = ui().selection): ID[] {
  const valid = ids.filter((id) => p.clips[id]);
  return ui().linkedSelection ? withLinked(p, valid) : valid;
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
  else if (x > scrollX + timelineWidth - margin) ui().set({ scrollX: Math.max(0, x - timelineWidth + margin) });
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

  // ─────────────────────────────────────────────────────────── selection ──
  selectAll(): void {
    const s = session();
    if (s) ui().select(Object.keys(s.store.get().clips));
  },
  deselect(): void {
    ui().clearSelection();
  },
  setTool(tool: Tool): void {
    ui().set({ tool });
  },

  // ───────────────────────────────────────────────────────────── editing ──
  split(): void {
    editing((s, p) => {
      const f = frame();
      const sel = effectiveSelection(p).filter((id) => {
        const c = p.clips[id];
        return c && c.start < f && f < clipEnd(c);
      });
      // With nothing selected under the playhead, cut straight through every unlocked track.
      const ids = sel.length ? sel : ui().linkedSelection ? withLinked(p, clipsUnderFrame(p, f)) : clipsUnderFrame(p, f);
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
        if (range) {
          const tracks = Object.values(p.tracks).filter((t) => !t.locked).map((t) => t.id);
          s.store.commit(deleteRange(p, tracks, range.in, range.out, ripple));
          if (ripple) s.player?.setRange(null);
        }
        return;
      }
      s.store.commit(deleteClips(p, ids, ripple || ui().rippleMode));
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
      const items = ui().clipboard;
      if (!items.length) return;
      const r = pasteClips(p, items, frame());
      s.store.commit(r.edits);
      ui().select(r.created);
    });
  },
  duplicate(): void {
    editing((s, p) => {
      const clips = effectiveSelection(p).map((id) => p.clips[id]);
      if (!clips.length) return;
      const end = Math.max(...clips.map(clipEnd));
      const r = pasteClips(p, clips, end);
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
      s.store.commit(placeClips(p, ids.map((id) => ({ id, start: p.clips[id].start + d, trackId: p.clips[id].trackId }))));
    });
  },
  /** Move the selection one track up (+1) or down (-1) in stacking order. */
  nudgeTrack(dir: 1 | -1): void {
    editing((s, p) => {
      const ids = ui().selection.filter((id) => p.clips[id]);
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
    editing((s, p) => s.store.commit(linkClips(p, ui().selection)));
  },
  unlink(): void {
    editing((s, p) => s.store.commit(unlinkClips(p, effectiveSelection(p))));
  },
  /** Ripple-trim the head (Q) or tail (W) of the clips under the playhead to the playhead. */
  trimToPlayhead(edge: 'start' | 'end'): void {
    editing((s, p) => {
      const f = frame();
      let ids = effectiveSelection(p).filter((id) => p.clips[id].start < f && f < clipEnd(p.clips[id]));
      if (!ids.length) ids = withLinked(p, clipsUnderFrame(p, f));
      if (!ids.length) return;
      const edits: Edit[] = [];
      let working = p;
      // Clips can have different lengths either side of the playhead, so trim one link group at a time.
      const seen = new Set<ID>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        const group = withLinked(working, [id]).filter((x) => ids.includes(x));
        group.forEach((x) => seen.add(x));
        const c = working.clips[id];
        const delta = edge === 'start' ? f - c.start : f - clipEnd(c);
        const e = trimClips(working, group, edge, delta, true);
        edits.push(...e);
      }
      void working;
      s.store.commit(edits);
      if (edge === 'start') {
        const first = Math.min(...ids.map((id) => p.clips[id].start));
        cmd.seek(first);
      }
    });
  },
  closeGapAtPlayhead(): void {
    editing((s, p) => {
      const f = frame();
      const edits: Edit[] = [];
      for (const t of Object.values(p.tracks)) if (!t.locked) edits.push(...closeGap(p, t.id, f));
      if (edits.length) s.store.commit(edits);
    });
  },
  setSpeed(speed: number, reverse?: boolean): void {
    editing((s, p) => s.store.commit(setSpeed(p, effectiveSelection(p), speed, reverse)));
  },
  updateSelected(patch: Partial<Clip>, merge = false): void {
    editing((s, p) => {
      const clips = selectedClips(p);
      if (clips.length) s.store.commit(clips.map((c) => ({ op: 'updateClip', id: c.id, patch }) as Edit), { merge });
    });
  },

  // ───────────────────────────────────────────────────── adding content ──
  addAsset(asset: Asset, opts: { frame?: number; videoTrackId?: ID | null; audioTrackId?: ID | null; sourceIn?: number; sourceOut?: number; insert?: boolean } = {}): void {
    editing((s, p) => {
      if (asset.kind === 'lut') {
        cmd.applyLut(asset.id);
        return;
      }
      const at = opts.frame ?? frame();
      let working = p;
      const pre: Edit[] = [];
      if (opts.insert) {
        const len = asset.kind === 'image' ? secondsToFrame(5, p.settings) : secondsToFrame((opts.sourceOut ?? asset.duration) - (opts.sourceIn ?? 0), p.settings);
        const tracks = Object.values(p.tracks).filter((t) => !t.locked).map((t) => t.id);
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
  addMarker(): void {
    editing((s, p) => {
      const f = frame();
      const existing = Object.values(p.markers).find((m) => m.frame === f);
      if (existing) {
        s.store.commit([{ op: 'removeMarker', id: existing.id }]);
        return;
      }
      const n = Object.keys(p.markers).length;
      s.store.commit([{ op: 'setMarker', marker: { id: newId(8), frame: f, name: `Marker ${n + 1}`, color: MARKER_COLORS[n % MARKER_COLORS.length], note: '' } }]);
    });
  },

  // ─────────────────────────────────────────────── effects & transitions ──
  applyEffect(type: string, clipIds?: ID[]): void {
    editing((s, p) => {
      const def = getEffectDef(type);
      if (!def) return;
      const ids = (clipIds ?? ui().selection).filter((id) => p.clips[id] && p.clips[id].type !== 'audio');
      if (!ids.length) {
        toast('Select a clip to apply the effect to.', 'info');
        return;
      }
      s.store.commit(ids.map((id) => ({ op: 'updateClip', id, patch: { effects: [...p.clips[id].effects, makeEffect(type)] } }) as Edit));
      if (!clipIds) toast(`${def.name} added`, 'success');
    });
  },
  applyTransition(type: string, clipId?: ID, side: 'in' | 'out' = 'in'): void {
    editing((s, p) => {
      const def = getTransitionDef(type);
      if (!def) return;
      const dur = secondsToFrame(0.6, p.settings);
      let target = clipId;
      if (!target) {
        const sel = ui().selection.filter((id) => p.clips[id] && p.clips[id].type !== 'audio');
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
        clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { grade: { ...(c.grade ?? defaultGrade()), lutId: assetId, enabled: true } } }) as Edit),
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
        transform: { x: c.x, y: c.y, scaleX: c.scaleX, scaleY: c.scaleY, rotation: c.rotation, opacity: c.opacity, blend: c.blend, cropL: c.cropL, cropT: c.cropT, cropR: c.cropR, cropB: c.cropB },
      },
    });
    toast('Attributes copied', 'info');
  },
  pasteAttributes(what: 'all' | 'grade' | 'effects' = 'all'): void {
    editing((s, p) => {
      const a = ui().attributes;
      const clips = selectedClips(p).filter((c) => c.type !== 'audio');
      if (!a || !clips.length) return;
      s.store.commit(
        clips.map((c) => {
          const patch: Partial<Clip> = {};
          if (what !== 'effects') patch.grade = a.grade;
          if (what !== 'grade') patch.effects = a.effects.map((e) => ({ ...e, id: newId(8) }));
          if (what === 'all') Object.assign(patch, a.transform);
          return { op: 'updateClip', id: c.id, patch } as Edit;
        }),
      );
    });
  },

  // ───────────────────────────────────────────────────────────────── view ──
  zoom(factor: number, anchorX?: number): void {
    const { ppf, scrollX } = ui();
    const next = clampPpf(ppf * factor);
    const ax = anchorX ?? (frame() * ppf - scrollX);
    const f = (scrollX + ax) / ppf;
    ui().set({ ppf: next, scrollX: Math.max(0, f * next - ax) });
  },
  zoomFit(): void {
    const s = session();
    if (!s) return;
    const end = Math.max(sequenceEnd(s.store.get()), secondsToFrame(10, s.store.get().settings));
    ui().set({ ppf: clampPpf((timelineWidth - 80) / end), scrollX: 0 });
  },

  // ───────────────────────────────────────────────────────────────── files ──
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
    return assets;
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
          text: { ...DEFAULT_TEXT, content: cue.text, size: 0.05, weight: 600, boxWidth: 0.8, bg: { ...DEFAULT_TEXT.bg, enabled: true } },
          init: { y: 0.36, name: cue.text.slice(0, 40) },
        });
        edits.push(...r.edits);
        working = applyPreview(working, r.edits);
      }
      s.store.commit(edits);
      toast(`Added ${cues.length} captions`, 'success');
    });
  },
  exportSubtitles(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    const cues = Object.values(p.clips)
      .filter((c) => c.type === 'text' && c.text && c.enabled)
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ start: framesToSeconds(c.start, p.settings), end: framesToSeconds(clipEnd(c), p.settings), text: c.text!.content }));
    if (!cues.length) {
      toast('There are no text clips to export.', 'info');
      return;
    }
    downloadBlob(new Blob([toSrt(cues)], { type: 'application/x-subrip' }), `${safeName(p.settings.name)}.srt`);
  },
  saveProjectFile(): void {
    const s = session();
    if (!s) return;
    const p = s.store.get();
    downloadBlob(new Blob([serializeProject(p)], { type: 'application/json' }), `${safeName(p.settings.name)}.tandem`);
  },
  async openProjectFile(): Promise<void> {
    const [file] = await pickFiles('.tandem,application/json', false);
    if (!file) return;
    const parsed = parseProjectFile(await file.text());
    if (!parsed) {
      toast('That is not a Tandem project file.', 'error');
      return;
    }
    editing((s) => {
      s.store.replaceAll(parsed);
      ui().clearSelection();
      toast('Project loaded. Media that is not on this device or the server will show as offline.', 'success');
    });
  },
  async captureStill(): Promise<void> {
    const s = session();
    if (!s) return;
    try {
      const p = s.store.get();
      const resolver = s.media.resolver((id) => !!s.store.get().assets[id]?.uploaded);
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
