import { AudioLines, Blend, Film, Gauge, Image as ImageIcon, Layers, Link2, Shapes, Sparkles, Square, Type } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  addAssetToTimeline,
  addGenerator,
  adjacentPrev,
  applyEdits,
  clamp,
  CLIP_TYPE_COLORS,
  clipEnd,
  clipsOnTrack,
  cutTransitionWindow,
  LABEL_COLORS,
  maxTransitionDuration,
  placeClips,
  pasteClips,
  rollEdit,
  slipClips,
  snapPoints,
  snapTo,
  splitClips,
  trackKindFor,
  trimClips,
  trimRange,
  withLinked,
  type Clip,
  type ClipType,
  type Edge,
  type Edit,
  type ID,
  type Project,
} from '@tandem/core';
import { usePeers, useProject, useSession } from '../../session/hooks';
import { cmd, effectiveSelection } from '../../state/commands';
import { commit } from '../../state/props';
import { useUI } from '../../state/ui';
import { openContextMenu, type MenuEntry } from '../../ui/core';
import { insideRect, onDrop, useDrag, type DragPayload } from '../../ui/dnd';
import { drawLane } from './laneCanvas';
import { laneAt, type Lane } from './layout';

const ICONS: Record<ClipType, typeof Film> = {
  video: Film,
  image: ImageIcon,
  audio: AudioLines,
  text: Type,
  shape: Shapes,
  solid: Square,
  adjustment: Layers,
};

type Drag =
  | { kind: 'move'; ids: ID[]; anchor: ID; f0: number; x0: number; y0: number; moved: boolean; reselect: boolean }
  | { kind: 'trim'; ids: ID[]; edge: Edge; f0: number; restore: number; roll: [ID, ID] | null; ripple: boolean }
  | { kind: 'slip'; ids: ID[]; x0: number; restore: number }
  | { kind: 'fade'; id: ID; side: 'in' | 'out'; f0: number; base: number }
  | { kind: 'trans'; id: ID; side: 'in' | 'out'; f0: number; base: number }
  | { kind: 'marquee'; x0: number; y0: number; keep: ID[]; moved: boolean; frame: number }
  | { kind: 'pan'; x0: number; scroll0: number };

interface Props {
  lanes: Lane[];
  height: number;
  width: number;
  live: Project;
}

export function Lanes({ lanes, height, width, live }: Props) {
  const session = useSession();
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const selection = useUI((s) => s.selection);
  const selectedTransition = useUI((s) => s.selectedTransition);
  const tool = useUI((s) => s.tool);
  const snapLine = useUI((s) => s.snapLine);
  const peers = usePeers();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ clipId: ID; side: 'in' | 'out' | 'all' } | null>(null);
  const selectedSet = useMemo(() => new Set(selection), [selection]);

  const ui = () => useUI.getState();
  const store = () => session.store.get();
  const playhead = () => Math.floor(session.player?.getFrame() ?? 0);

  const toFrame = (clientX: number): number => {
    const r = ref.current!.getBoundingClientRect();
    return (clientX - r.left + ui().scrollX) / ui().ppf;
  };
  const toY = (clientY: number): number => clientY - ref.current!.getBoundingClientRect().top;

  /** Snap `edges` (already offset by the raw delta) to nearby cut points. Returns the correction. */
  const snap = (p: Project, moving: ReadonlySet<ID>, edges: number[], disabled: boolean): { adjust: number; line: number | null } => {
    if (!ui().snapping || disabled) return { adjust: 0, line: null };
    const pts = snapPoints(p, moving, [playhead()]);
    const threshold = 8 / ui().ppf;
    let best: { adjust: number; line: number } | null = null;
    for (const e of edges) {
      const s = snapTo(e, pts, threshold);
      if (s !== null && (!best || Math.abs(s - e) < Math.abs(best.adjust))) best = { adjust: s - e, line: s };
    }
    return best ?? { adjust: 0, line: null };
  };

  const setPreview = (edits: Edit[] | null, line: number | null = null) => {
    if (!edits) ui().set({ preview: null, snapLine: null });
    else ui().set({ preview: edits.length ? applyEdits(store(), edits) : null, snapLine: line });
  };

  // ─────────────────────────────────────────────────────── move planning ──
  const planMove = (d: Extract<Drag, { kind: 'move' }>, e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }) => {
    const p = store();
    const moving = new Set(d.ids);
    const clips = d.ids.map((id) => p.clips[id]).filter(Boolean);
    if (!clips.length) return { edits: [] as Edit[], line: null as number | null, placements: [] };
    let delta = Math.round(toFrame(e.clientX) - d.f0);
    const minStart = Math.min(...clips.map((c) => c.start));
    delta = Math.max(delta, -minStart);
    const edges = clips.flatMap((c) => [c.start + delta, clipEnd(c) + delta]);
    const s = snap(p, moving, edges, e.shiftKey);
    delta = Math.max(Math.round(delta + s.adjust), -minStart);

    // Vertical: move clips of the grabbed clip's kind by the same number of lanes.
    const anchor = p.clips[d.anchor];
    const kind = anchor ? trackKindFor(anchor.type) : 'video';
    const sameKind = lanes.filter((l) => l.track.kind === kind);
    const fromIdx = sameKind.findIndex((l) => l.track.id === anchor?.trackId);
    const over = laneAt(lanes, toY(e.clientY));
    let toIdx = over && over.track.kind === kind ? sameKind.indexOf(over) : fromIdx;
    if (!over) toIdx = toY(e.clientY) < (sameKind[0]?.top ?? 0) ? 0 : toIdx;
    let shift = toIdx - fromIdx;
    // Keep every moving clip of that kind on an existing, unlocked track.
    for (const c of clips) {
      if (trackKindFor(c.type) !== kind) continue;
      const i = sameKind.findIndex((l) => l.track.id === c.trackId);
      shift = clamp(shift, -i, sameKind.length - 1 - i);
    }
    const placements = clips.map((c) => {
      let trackId = c.trackId;
      if (trackKindFor(c.type) === kind && shift !== 0) {
        const i = sameKind.findIndex((l) => l.track.id === c.trackId);
        const target = sameKind[i + shift]?.track;
        if (target && !target.locked) trackId = target.id;
      }
      return { id: c.id, start: c.start + delta, trackId };
    });
    return { edits: placeClips(p, placements), line: s.line, placements };
  };

  // ─────────────────────────────────────────────────────────── pointer ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && tool === 'hand')) {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', x0: e.clientX, scroll0: ui().scrollX };
      return;
    }
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>('[data-clip]');
    const p = store();
    const clip = clipEl ? p.clips[clipEl.dataset.clip!] : null;
    const f = toFrame(e.clientX);
    const editable = session.canEdit;
    const locked = clip ? !!p.tracks[clip.trackId]?.locked : false;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (clip && !locked) {
      if (tool === 'blade') {
        if (!editable) return;
        let at = Math.round(f);
        const ph = playhead();
        if (ui().snapping && Math.abs(at - ph) * ui().ppf < 8) at = ph;
        const ids = ui().linkedSelection ? withLinked(p, [clip.id]) : [clip.id];
        commit(splitClips(p, ids, at).edits);
        return;
      }
      if (tool === 'slip') {
        if (!editable) return;
        const ids = ui().linkedSelection ? withLinked(p, [clip.id]) : [clip.id];
        ui().select(ids);
        session.store.beginGesture();
        drag.current = { kind: 'slip', ids, x0: e.clientX, restore: playhead() };
        return;
      }
      const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
      if (handle === 'trans-in' || handle === 'trans-out') {
        const side = handle === 'trans-in' ? 'in' : 'out';
        ui().set({ selectedTransition: { clipId: clip.id, side }, selection: [] });
        const t = side === 'in' ? clip.transIn : clip.transOut;
        if (editable && t && target.closest('[data-trans-edge]')) {
          session.store.beginGesture();
          drag.current = { kind: 'trans', id: clip.id, side, f0: f, base: t.duration };
        }
        return;
      }
      if ((handle === 'fade-in' || handle === 'fade-out') && editable) {
        session.store.beginGesture();
        drag.current = { kind: 'fade', id: clip.id, side: handle === 'fade-in' ? 'in' : 'out', f0: f, base: handle === 'fade-in' ? clip.fadeIn : clip.fadeOut };
        return;
      }
      if ((handle === 'start' || handle === 'end') && editable) {
        const ids = ui().linkedSelection ? withLinked(p, [clip.id]) : [clip.id];
        if (!selectedSet.has(clip.id)) ui().select(ids);
        // Ctrl/⌘ on a cut between two touching clips rolls the edit instead of trimming one side.
        let roll: [ID, ID] | null = null;
        if (e.metaKey || e.ctrlKey) {
          const list = clipsOnTrack(p, clip.trackId);
          const i = list.findIndex((c) => c.id === clip.id);
          if (handle === 'start' && i > 0 && clipEnd(list[i - 1]) === clip.start) roll = [list[i - 1].id, clip.id];
          if (handle === 'end' && i < list.length - 1 && list[i + 1].start === clipEnd(clip)) roll = [clip.id, list[i + 1].id];
        }
        drag.current = { kind: 'trim', ids, edge: handle, f0: f, restore: playhead(), roll, ripple: ui().rippleMode !== e.altKey };
        return;
      }
      // Body: select and maybe move.
      let reselect = false;
      const group = ui().linkedSelection ? withLinked(p, [clip.id]) : [clip.id];
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (selectedSet.has(clip.id)) ui().select(ui().selection.filter((id) => !group.includes(id)));
        else ui().select(group, true);
      } else if (!selectedSet.has(clip.id)) ui().select(group);
      else reselect = true;
      const ids = effectiveSelection(p, ui().selection).filter((id) => !p.tracks[p.clips[id].trackId]?.locked);
      if (ids.includes(clip.id) && editable) {
        drag.current = { kind: 'move', ids, anchor: clip.id, f0: f, x0: e.clientX, y0: e.clientY, moved: false, reselect };
      }
      return;
    }

    // Empty space: marquee, or click to move the playhead.
    drag.current = { kind: 'marquee', x0: f * ui().ppf, y0: toY(e.clientY), keep: e.shiftKey ? ui().selection : [], moved: false, frame: Math.round(f) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      const lane = laneAt(lanes, toY(e.clientY));
      session.setPresence({ cursor: { area: 'timeline', x: toFrame(e.clientX), y: lane?.track.id ?? '' } });
    }
    const d = drag.current;
    if (!d) return;
    const p = store();
    switch (d.kind) {
      case 'pan':
        ui().set({ scrollX: Math.max(0, d.scroll0 - (e.clientX - d.x0)) });
        break;
      case 'move': {
        if (!d.moved) {
          if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
          d.moved = true;
        }
        const plan = planMove(d, e);
        setPreview(plan.edits, plan.line);
        session.setPresence({
          dragging: plan.placements.map((m) => ({ id: m.id, start: m.start, duration: p.clips[m.id].duration, trackId: m.trackId })),
        });
        break;
      }
      case 'trim': {
        let delta = Math.round(toFrame(e.clientX) - d.f0);
        if (d.roll) {
          const cut = p.clips[d.roll[1]]?.start ?? 0;
          const s = snap(p, new Set(d.roll), [cut + delta], e.shiftKey);
          delta += s.adjust;
          setPreview(rollEdit(p, d.roll[0], d.roll[1], delta), s.line);
          const pv = ui().preview;
          if (pv?.clips[d.roll[1]]) session.player?.seek(pv.clips[d.roll[1]].start);
          break;
        }
        const first = p.clips[d.ids[0]];
        if (!first) break;
        const edgeFrame = d.edge === 'start' ? first.start : clipEnd(first);
        const range = trimRange(p, d.ids, d.edge, d.ripple);
        delta = clamp(delta, range.min, range.max);
        const s = snap(p, new Set(d.ids), [edgeFrame + delta], e.shiftKey || d.ripple);
        delta = clamp(Math.round(delta + s.adjust), range.min, range.max);
        const edits = trimClips(p, d.ids, d.edge, delta, d.ripple);
        setPreview(edits, s.line);
        // Show the frame being cut to, like a trim monitor.
        const pv = ui().preview ?? p;
        const c = pv.clips[d.ids[0]];
        if (c) session.player?.seek(d.edge === 'start' ? c.start : clipEnd(c) - 1);
        break;
      }
      case 'slip': {
        const delta = Math.round((d.x0 - e.clientX) / ui().ppf);
        setPreview(slipClips(p, d.ids, delta));
        const c = p.clips[d.ids[0]];
        if (c) session.player?.seek(c.start);
        break;
      }
      case 'fade': {
        const c = p.clips[d.id];
        if (!c) break;
        const df = Math.round(toFrame(e.clientX) - d.f0);
        const v = clamp(d.side === 'in' ? d.base + df : d.base - df, 0, c.duration);
        commit([{ op: 'updateClip', id: d.id, patch: d.side === 'in' ? { fadeIn: v } : { fadeOut: v } }], true);
        break;
      }
      case 'trans': {
        const c = p.clips[d.id];
        const t = c && (d.side === 'in' ? c.transIn : c.transOut);
        if (!c || !t) break;
        const df = Math.round(toFrame(e.clientX) - d.f0);
        const twoSided = d.side === 'in' && !!adjacentPrev(p, c);
        const raw = d.side === 'in' ? d.base + df * (twoSided ? 2 : 1) : d.base - df;
        const duration = clamp(raw, 1, maxTransitionDuration(p, c, d.side));
        commit([{ op: 'updateClip', id: d.id, patch: d.side === 'in' ? { transIn: { ...t, duration } } : { transOut: { ...t, duration } } }], true);
        break;
      }
      case 'marquee': {
        const x = toFrame(e.clientX) * ui().ppf;
        const y = toY(e.clientY);
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
        d.moved = true;
        const box = { x: Math.min(x, d.x0), y: Math.min(y, d.y0), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
        setMarquee(box);
        const hit: ID[] = [];
        for (const lane of lanes) {
          if (lane.top + lane.height < box.y || lane.top > box.y + box.h || lane.track.locked) continue;
          for (const c of clipsOnTrack(p, lane.track.id)) {
            if (c.start * ui().ppf < box.x + box.w && clipEnd(c) * ui().ppf > box.x) hit.push(c.id);
          }
        }
        ui().select(Array.from(new Set([...d.keep, ...(ui().linkedSelection ? withLinked(p, hit) : hit)])));
        break;
      }
    }
  };

  const finish = (e: React.PointerEvent | null, cancelled: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (e) (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const preview = ui().preview;
    const p = store();
    switch (d.kind) {
      case 'move':
        if (!d.moved) {
          // A click on an already-selected clip narrows the selection to it.
          if (d.reselect && !cancelled) ui().select(ui().linkedSelection ? withLinked(p, [d.anchor]) : [d.anchor]);
        } else if (!cancelled && e) {
          const plan = planMove(d, e);
          if (e.altKey) {
            // Alt-drop duplicates instead of moving.
            const copies = plan.placements.map((m) => ({ ...p.clips[m.id], start: m.start, trackId: m.trackId }));
            const r = pasteClips(p, copies, Math.min(...copies.map((c) => c.start)));
            commit(r.edits);
            ui().select(r.created);
          } else commit(plan.edits);
        }
        session.setPresence({ dragging: null });
        break;
      case 'trim':
        if (!cancelled && preview) {
          // Re-derive the edits from the previewed result so the commit matches what was shown.
          const edits: Edit[] = [];
          for (const [id, c] of Object.entries(preview.clips)) {
            const before = p.clips[id];
            if (!before) edits.push({ op: 'addClip', clip: c });
            else if (before !== c) edits.push({ op: 'updateClip', id, patch: c });
          }
          commit(edits);
        }
        session.player?.seek(d.restore);
        break;
      case 'slip':
        if (!cancelled && preview) {
          const edits: Edit[] = [];
          for (const id of d.ids) if (preview.clips[id]) edits.push({ op: 'updateClip', id, patch: { sourceIn: preview.clips[id].sourceIn } });
          commit(edits);
        }
        session.player?.seek(d.restore);
        break;
      case 'marquee':
        setMarquee(null);
        if (!d.moved && !cancelled) {
          if (!d.keep.length) ui().clearSelection();
          if (tool === 'select') cmd.seek(clamp(d.frame, 0, 1e9), false);
        }
        break;
      default:
        break;
    }
    setPreview(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        e.stopPropagation();
        finish(null, true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ─────────────────────────────────────────────── drops from the library ──
  const dropPlan = (payload: DragPayload, x: number, y: number): { edits: Edit[]; select?: ID[]; hint?: typeof dropHint; line?: number | null } | null => {
    const el = ref.current;
    if (!el || !insideRect(el.getBoundingClientRect(), x, y)) return null;
    const p = store();
    const lane = laneAt(lanes, toY(y));
    const clipEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-clip]');
    const over = clipEl ? p.clips[clipEl.dataset.clip!] : null;
    if (payload.kind === 'effect') {
      if (!over || over.type === 'audio') return { edits: [] };
      return { edits: [], hint: { clipId: over.id, side: 'all' } };
    }
    if (payload.kind === 'transition') {
      if (!over || over.type === 'audio') return { edits: [] };
      const mid = (over.start + over.duration / 2) * ui().ppf - ui().scrollX + el.getBoundingClientRect().left;
      return { edits: [], hint: { clipId: over.id, side: x < mid ? 'in' : 'out' } };
    }
    let frame = Math.max(0, Math.round(toFrame(x)));
    if (payload.kind === 'asset') {
      const asset = p.assets[payload.assetId];
      if (!asset || asset.kind === 'lut') {
        return over && over.type !== 'audio' ? { edits: [], hint: { clipId: over.id, side: 'all' } } : { edits: [] };
      }
      const len = asset.kind === 'image' ? Math.round(5 * (p.settings.fpsNum / p.settings.fpsDen)) : Math.round(asset.duration * (p.settings.fpsNum / p.settings.fpsDen));
      const s = snap(p, new Set(), [frame, frame + len], false);
      frame = Math.max(0, Math.round(frame + s.adjust));
      const visual = asset.kind !== 'audio';
      const r = addAssetToTimeline(p, asset, {
        frame,
        videoTrackId: visual && lane?.track.kind === 'video' && !lane.track.locked ? lane.track.id : undefined,
        audioTrackId: lane?.track.kind === 'audio' && !lane.track.locked ? lane.track.id : undefined,
      });
      return { edits: r.edits, select: r.created, line: s.line };
    }
    const s = snap(p, new Set(), [frame], false);
    frame = Math.max(0, Math.round(frame + s.adjust));
    const trackId = lane?.track.kind === 'video' && !lane.track.locked ? lane.track.id : undefined;
    const r =
      payload.kind === 'text'
        ? addGenerator(p, 'text', { frame, trackId, text: payload.text })
        : payload.kind === 'shape'
          ? addGenerator(p, 'shape', { frame, trackId, shape: payload.shape })
          : addGenerator(p, payload.type, { frame, trackId });
    return { edits: r.edits, select: r.created, line: s.line };
  };

  useEffect(() => {
    let wasInside = false;
    const unsub = useDrag.subscribe((s) => {
      if (!s.payload) {
        if (wasInside) {
          wasInside = false;
          setPreview(null);
          setDropHint(null);
        }
        return;
      }
      if (!session.canEdit) return;
      const plan = dropPlan(s.payload, s.x, s.y);
      if (!plan) {
        if (wasInside) {
          wasInside = false;
          setPreview(null);
          setDropHint(null);
        }
        return;
      }
      wasInside = true;
      setDropHint(plan.hint ?? null);
      setPreview(plan.edits.length ? plan.edits : null, plan.line ?? null);
    });
    const undrop = onDrop((payload, x, y) => {
      if (!session.canEdit) return false;
      const plan = dropPlan(payload, x, y);
      if (!plan) return false;
      setPreview(null);
      setDropHint(null);
      if (plan.hint) {
        if (payload.kind === 'effect') cmd.applyEffect(payload.type, [plan.hint.clipId]);
        else if (payload.kind === 'transition') cmd.applyTransition(payload.type, plan.hint.clipId, plan.hint.side === 'out' ? 'out' : 'in');
        else if (payload.kind === 'asset') {
          ui().select([plan.hint.clipId]);
          cmd.applyLut(payload.assetId);
        }
        return true;
      }
      if (plan.edits.length) {
        commit(plan.edits);
        if (plan.select) ui().select(plan.select);
      }
      return true;
    });
    return () => {
      unsub();
      undrop();
    };
    // The handlers read live state through refs / stores; re-subscribing on layout changes keeps `lanes` fresh.
  }, [lanes, session]);

  // ───────────────────────────────────────────────────────────── render ──
  const peerSel = useMemo(() => {
    const m = new Map<ID, { color: string; name: string }>();
    for (const peer of peers) for (const id of peer.selection ?? []) if (!m.has(id)) m.set(id, { color: peer.user.color, name: peer.user.name });
    return m;
  }, [peers]);

  const viewL = scrollX - 300;
  const viewR = scrollX + width + 300;
  const cursor = tool === 'blade' ? 'crosshair' : tool === 'hand' ? 'grab' : tool === 'slip' ? 'ew-resize' : undefined;

  return (
    <div
      ref={ref}
      className="lanes"
      data-tool={tool}
      style={{ height, cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onPointerLeave={() => session.setPresence({ cursor: null })}
      onContextMenu={(e) => {
        const clipEl = (e.target as HTMLElement).closest<HTMLElement>('[data-clip]');
        const id = clipEl?.dataset.clip;
        if (id && !selectedSet.has(id)) ui().select(ui().linkedSelection ? withLinked(store(), [id]) : [id]);
        openContextMenu(e, id ? clipMenu(store(), id) : laneMenu());
      }}
    >
      {lanes.map((lane) => {
        const clips = clipsOnTrack(live, lane.track.id);
        return (
          <div key={lane.track.id} className="lane" data-kind={lane.track.kind} data-locked={lane.track.locked} data-hidden={lane.track.hidden || lane.track.muted} style={{ top: lane.top, height: lane.height }}>
            <LaneCanvas project={live} clips={clips} width={width} height={lane.height} scrollX={scrollX} ppf={ppf} />
            <div className="lane__clips" style={{ transform: `translate3d(${-scrollX}px, 0, 0)` }}>
              {clips.map((c, i) => {
                const x = c.start * ppf;
                const w = c.duration * ppf;
                if (x + w < viewL || x > viewR) return null;
                const prev = i > 0 && clipEnd(clips[i - 1]) === c.start ? clips[i - 1] : null;
                const win = prev && c.transIn ? cutTransitionWindow(prev, c) : null;
                const peer = peerSel.get(c.id);
                return (
                  <ClipView
                    key={c.id}
                    clip={c}
                    ppf={ppf}
                    height={lane.height}
                    selected={selectedSet.has(c.id)}
                    transSel={selectedTransition?.clipId === c.id ? selectedTransition.side : null}
                    transBefore={win ? win.before : 0}
                    transLen={win ? win.duration : c.transIn ? Math.min(c.transIn.duration, c.duration) : 0}
                    peerColor={peer?.color ?? null}
                    peerName={peer?.name ?? null}
                    hint={dropHint?.clipId === c.id ? dropHint.side : null}
                    missing={!!c.assetId && !live.assets[c.assetId]}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Clips other people are dragging right now. */}
      {peers.flatMap((peer) =>
        (peer.dragging ?? []).map((g) => {
          const lane = lanes.find((l) => l.track.id === g.trackId);
          if (!lane) return null;
          return (
            <div
              key={`${peer.clientId}:${g.id}`}
              className="peer-ghost"
              style={{ left: g.start * ppf - scrollX, width: Math.max(2, g.duration * ppf), top: lane.top, height: lane.height, ['--c' as string]: peer.user.color }}
            >
              <span>{peer.user.name}</span>
            </div>
          );
        }),
      )}
      {peers.map((peer) => {
        if (!peer.cursor || peer.cursor.area !== 'timeline') return null;
        const lane = lanes.find((l) => l.track.id === peer.cursor!.y);
        if (!lane) return null;
        return (
          <div key={peer.clientId} className="peer-cursor peer-cursor--tl" style={{ left: peer.cursor.x * ppf - scrollX, top: lane.top + lane.height / 2, ['--c' as string]: peer.user.color }}>
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M2 1.5l11 5.2-4.700 1.400-1.700 4.700L2 1.500z" fill="var(--c)" stroke="#0b0b0d" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span>{peer.user.name}</span>
          </div>
        );
      })}

      {snapLine !== null && <div className="snapline" style={{ left: snapLine * ppf - scrollX }} />}
      {marquee && <div className="marquee" style={{ left: marquee.x - scrollX, top: marquee.y, width: marquee.w, height: marquee.h }} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── menus ──

function clipMenu(p: Project, id: ID): MenuEntry[] {
  const c = p.clips[id];
  if (!c) return [];
  const ui = useUI.getState();
  const timed = c.type === 'video' || c.type === 'audio';
  return [
    { label: 'Cut', keys: 'mod+x', onSelect: cmd.cut },
    { label: 'Copy', keys: 'mod+c', onSelect: cmd.copy },
    { label: 'Paste', keys: 'mod+v', onSelect: cmd.paste, disabled: !ui.clipboard.length },
    { label: 'Duplicate', keys: 'mod+d', onSelect: cmd.duplicate },
    'separator',
    { label: 'Split at playhead', keys: 'mod+b', onSelect: cmd.split },
    { label: 'Delete', keys: 'delete', onSelect: () => cmd.delete(false) },
    { label: 'Ripple delete', keys: 'shift+delete', onSelect: () => cmd.delete(true) },
    'separator',
    { label: c.enabled ? 'Disable' : 'Enable', keys: 'd', onSelect: cmd.toggleEnabled },
    c.linkId ? { label: 'Unlink', icon: <Link2 />, keys: 'mod+shift+g', onSelect: cmd.unlink } : { label: 'Link selected', icon: <Link2 />, keys: 'mod+g', onSelect: cmd.link, disabled: ui.selection.length < 2 },
    timed ? { label: c.reverse ? 'Play forwards' : 'Reverse', onSelect: () => cmd.setSpeed(c.speed, !c.reverse) } : null,
    timed ? { label: 'Speed: 50%', onSelect: () => cmd.setSpeed(0.5) } : null,
    timed ? { label: 'Speed: 100%', onSelect: () => cmd.setSpeed(1) } : null,
    timed ? { label: 'Speed: 200%', onSelect: () => cmd.setSpeed(2) } : null,
    'separator',
    { label: 'Copy attributes', keys: 'mod+alt+c', onSelect: cmd.copyAttributes },
    { label: 'Paste attributes', keys: 'mod+alt+v', onSelect: () => cmd.pasteAttributes('all'), disabled: !ui.attributes },
    'separator',
    { heading: 'Label' },
    ...LABEL_COLORS.slice(0, 6).map(
      (color): MenuEntry => ({
        label: color === CLIP_TYPE_COLORS[c.type] ? 'Default' : color,
        icon: <span style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }} />,
        checked: (c.label ?? CLIP_TYPE_COLORS[c.type]) === color,
        onSelect: () => cmd.updateSelected({ label: color === CLIP_TYPE_COLORS[c.type] ? null : color }),
      }),
    ),
  ];
}

function laneMenu(): MenuEntry[] {
  const ui = useUI.getState();
  return [
    { label: 'Paste', keys: 'mod+v', onSelect: cmd.paste, disabled: !ui.clipboard.length },
    { label: 'Close gap here', keys: 'shift+g', onSelect: cmd.closeGapAtPlayhead },
    'separator',
    { label: 'Add text', keys: 't', onSelect: () => cmd.addText() },
    { label: 'Add adjustment layer', onSelect: cmd.addAdjustment },
    'separator',
    { label: 'Add video track', onSelect: () => cmd.addTrack('video') },
    { label: 'Add audio track', onSelect: () => cmd.addTrack('audio') },
  ];
}

// ─────────────────────────────────────────────────────────────── canvas ──

function LaneCanvas({ project, clips, width, height, scrollX, ppf }: { project: Project; clips: readonly Clip[]; width: number; height: number; scrollX: number; ppf: number }) {
  const session = useSession();
  const ref = useRef<HTMLCanvasElement>(null);
  const [bump, setBump] = useState(0);
  const hasMedia = clips.some((c) => c.type === 'video' || c.type === 'image' || c.type === 'audio');

  useEffect(() => {
    const a = session.thumbs.film.subscribe(() => setBump((n) => n + 1));
    const b = session.thumbs.wave.subscribe(() => setBump((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [session]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) drawLane(ctx, project, clips, { scrollX, ppf, width, height, dpr }, session.thumbs);
  }, [project, clips, width, height, scrollX, ppf, bump, session]);

  if (!hasMedia) return null;
  return <canvas ref={ref} className="lane__canvas" style={{ width, height }} />;
}

// ───────────────────────────────────────────────────────────────── clip ──

interface ClipViewProps {
  clip: Clip;
  ppf: number;
  height: number;
  selected: boolean;
  transSel: 'in' | 'out' | null;
  /** Frames of the incoming transition that sit before this clip's start (two-sided cuts). */
  transBefore: number;
  transLen: number;
  peerColor: string | null;
  peerName: string | null;
  hint: 'in' | 'out' | 'all' | null;
  missing: boolean;
}

const ClipView = memo(function ClipView({ clip, ppf, height, selected, transSel, transBefore, transLen, peerColor, peerName, hint, missing }: ClipViewProps) {
  const w = Math.max(2, clip.duration * ppf - 1);
  const Icon = ICONS[clip.type];
  const color = clip.label ?? CLIP_TYPE_COLORS[clip.type];
  const roomy = w > 44;
  const fx = clip.effects.length > 0;
  const graded = !!clip.grade && clip.grade.enabled;
  const keyTimes = useMemo(() => {
    if (!selected) return [];
    const s = new Set<number>();
    for (const list of Object.values(clip.keyframes)) for (const k of list) if (k.t >= 0 && k.t <= clip.duration) s.add(k.t);
    return Array.from(s);
  }, [clip.keyframes, clip.duration, selected]);
  const label = clip.type === 'text' && clip.text ? clip.text.content.replace(/\s+/g, ' ') : clip.name || clip.type;

  return (
    <div
      className="clip"
      data-clip={clip.id}
      data-type={clip.type}
      data-selected={selected}
      data-disabled={!clip.enabled}
      data-hint={hint ?? undefined}
      data-missing={missing}
      data-compact={height < 40}
      style={{ left: clip.start * ppf, width: w, height, ['--c' as string]: color, ['--peer' as string]: peerColor ?? 'transparent' }}
    >
      {roomy && (
        <div className="clip__label">
          <Icon />
          <span className="clip__name">{label}</span>
          {clip.linkId && <Link2 className="clip__flag" />}
          {(clip.speed !== 1 || clip.reverse) && (
            <span className="clip__chip">
              <Gauge />
              {clip.reverse ? '−' : ''}
              {Math.round(clip.speed * 100)}%
            </span>
          )}
          {graded && <Blend className="clip__flag clip__flag--accent" />}
          {fx && (
            <span className="clip__chip clip__chip--fx">
              <Sparkles />
              {clip.effects.length}
            </span>
          )}
        </div>
      )}
      {clip.transIn && transLen > 0 && (
        <div className="clip__trans clip__trans--in" data-handle="trans-in" data-selected={transSel === 'in'} style={{ left: -transBefore * ppf, width: Math.max(6, transLen * ppf) }}>
          <i data-trans-edge />
        </div>
      )}
      {clip.transOut && (
        <div className="clip__trans clip__trans--out" data-handle="trans-out" data-selected={transSel === 'out'} style={{ width: Math.max(6, Math.min(clip.transOut.duration, clip.duration) * ppf) }}>
          <i data-trans-edge />
        </div>
      )}
      {clip.type === 'audio' && roomy && (
        <>
          <div className="clip__fade clip__fade--in" data-handle="fade-in" style={{ left: clip.fadeIn * ppf }} />
          <div className="clip__fade clip__fade--out" data-handle="fade-out" style={{ right: clip.fadeOut * ppf }} />
        </>
      )}
      {keyTimes.map((t) => (
        <i key={t} className="clip__kf" style={{ left: t * ppf }} />
      ))}
      <div className="clip__trim clip__trim--l" data-handle="start" />
      <div className="clip__trim clip__trim--r" data-handle="end" />
      {peerColor && <span className="clip__peer">{peerName}</span>}
    </div>
  );
});

export { useProject };
