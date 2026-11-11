import {
  ArrowDownUp,
  AudioLines,
  ChevronsLeftRight,
  Eye,
  EyeOff,
  Film,
  Flag,
  Hand,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  MousePointer2,
  MoveHorizontal,
  Plus,
  Scissors,
  SquareSplitHorizontal,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  clamp,
  editPoints,
  formatTimecode,
  MARKER_COLORS,
  moveTrack,
  sequenceEnd,
  snapTo,
  trackLabel,
  tracksOf,
  type Marker,
  type Project,
  type Track,
} from '@tandem/core';
import { useComments, useLiveProject, usePeers, usePlayer, usePlayerState, useProject, useSession } from '../../session/hooks';
import { cmd, setTimelineWidth } from '../../state/commands';
import { commit } from '../../state/props';
import { clampPpf, MAX_PPF, MIN_PPF, useUI } from '../../state/ui';
import { IconButton, openContextMenu, Popover, Slider, TextField, tip, Button, cx, hideTip } from '../../ui/core';
import { Lanes } from './Lanes';
import { HEADER_W, layoutLanes, RULER_H, tickInterval, type Lane } from './layout';
import './timeline.css';

export function Timeline() {
  const session = useSession();
  const player = usePlayer();
  const live = useLiveProject((p) => p);
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const set = useUI((s) => s.set);
  const bodyRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const { lanes, height } = useMemo(() => layoutLanes(live), [live.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = sequenceEnd(live);
  const fitted = useRef(false);

  useLayoutEffect(() => {
    const el = areaRef.current!;
    const measure = () => {
      const w = Math.max(100, el.clientWidth);
      setWidth(w);
      setTimelineWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Open with the whole sequence in view.
  useEffect(() => {
    if (fitted.current || width <= 100) return;
    fitted.current = true;
    cmd.zoomFit();
  }, [width]);

  // Wheel: ctrl/⌘ zooms around the pointer, shift (or a sideways swipe) scrolls time.
  useEffect(() => {
    const el = mainRef.current!;
    const onWheel = (e: WheelEvent) => {
      const { scrollX: sx } = useUI.getState();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const r = areaRef.current!.getBoundingClientRect();
        // Pinch gestures arrive as small ctrl+wheel deltas; mouse wheels as large ones.
        const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 40 ? 0.02 : 0.004));
        cmd.zoom(factor, Math.max(0, e.clientX - r.left));
        return;
      }
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      const body = bodyRef.current!;
      const canScrollY = body.scrollHeight > body.clientHeight + 1;
      if (horizontal || !canScrollY) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        set({ scrollX: Math.max(0, sx + d) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [set]);

  // Keep the playhead on screen during playback by paging the view.
  useEffect(() => {
    if (!player) return;
    return player.onFrame((f) => {
      if (!player.getState().playing) return;
      const { ppf: z, scrollX: sx } = useUI.getState();
      const x = f * z - sx;
      if (x > width - 24 || x < 0) set({ scrollX: Math.max(0, f * z - 48) });
    });
  }, [player, width, set]);

  return (
    <div className="tl">
      <Toolbar />
      <div className="tl__main" ref={mainRef}>
        <div className="tl__corner" style={{ width: HEADER_W, height: RULER_H }}>
          <TrackAdder />
        </div>
        <div className="tl__area" ref={areaRef}>
          <Ruler width={width} project={live} />
        </div>
        <div className="tl__body" ref={bodyRef}>
          <div className="tl__headers" style={{ width: HEADER_W, height }}>
            {lanes.map((lane) => (
              <TrackHeader key={lane.track.id} lane={lane} project={live} />
            ))}
          </div>
          <div className="tl__lanes">
            <Lanes lanes={lanes} height={height} width={width} live={live} />
          </div>
        </div>
        <Playhead left={HEADER_W} width={width} />
        <RemotePlayheads left={HEADER_W} width={width} />
        {end === 0 && Object.keys(live.assets).length === 0 && (
          <div className="tl__hint">
            <Film />
            <b>Your timeline is empty</b>
            Import media, then drag it here — or press <kbd className="kbd">T</kbd> to start with a title.
          </div>
        )}
      </div>
      <Scrollbar width={width} end={end} ppf={ppf} scrollX={scrollX} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── toolbar ──

function Toolbar() {
  const tool = useUI((s) => s.tool);
  const snapping = useUI((s) => s.snapping);
  const ripple = useUI((s) => s.rippleMode);
  const linked = useUI((s) => s.linkedSelection);
  const ppf = useUI((s) => s.ppf);
  const hasSel = useUI((s) => s.selection.length > 0 || !!s.selectedTransition);
  const set = useUI((s) => s.set);
  const lo = Math.log(MIN_PPF);
  const hi = Math.log(MAX_PPF);
  return (
    <div className="tl__toolbar">
      <div className="tl__tools">
        <IconButton label="Selection tool" keys="v" tipPlace="top" active={tool === 'select'} onClick={() => set({ tool: 'select' })}>
          <MousePointer2 />
        </IconButton>
        <IconButton label="Blade tool" keys="b" tipPlace="top" active={tool === 'blade'} onClick={() => set({ tool: 'blade' })}>
          <Scissors />
        </IconButton>
        <IconButton label="Slip tool" keys="y" tipPlace="top" active={tool === 'slip'} onClick={() => set({ tool: 'slip' })}>
          <MoveHorizontal />
        </IconButton>
        <IconButton label="Hand tool" keys="h" tipPlace="top" active={tool === 'hand'} onClick={() => set({ tool: 'hand' })}>
          <Hand />
        </IconButton>
      </div>
      <div className="topbar__sep" />
      <IconButton label="Split at playhead" keys="mod+b" tipPlace="top" onClick={() => cmd.split()}>
        <SquareSplitHorizontal />
      </IconButton>
      <IconButton label="Delete" keys="delete" tipPlace="top" disabled={!hasSel} onClick={() => cmd.delete(false)}>
        <Trash2 />
      </IconButton>
      <IconButton label="Ripple delete" keys="shift+delete" tipPlace="top" disabled={!hasSel} onClick={() => cmd.delete(true)}>
        <ChevronsLeftRight />
      </IconButton>
      <div className="topbar__sep" />
      <IconButton label="Snapping" keys="n" tipPlace="top" active={snapping} onClick={() => set({ snapping: !snapping })}>
        <Magnet />
      </IconButton>
      <IconButton label="Ripple editing" keys="r" tipPlace="top" active={ripple} onClick={() => set({ rippleMode: !ripple })}>
        <ArrowDownUp style={{ transform: 'rotate(90deg)' }} />
      </IconButton>
      <IconButton label="Linked selection" keys="mod+shift+l" tipPlace="top" active={linked} onClick={() => set({ linkedSelection: !linked })}>
        <Link2 />
      </IconButton>
      <div className="topbar__sep" />
      <IconButton label="Add marker" keys="m" tipPlace="top" onClick={() => cmd.addMarker()}>
        <Flag />
      </IconButton>
      <IconButton label="Add text" keys="t" tipPlace="top" onClick={() => cmd.addText()}>
        <Type />
      </IconButton>
      <div style={{ flex: 1 }} />
      <IconButton label="Zoom out" keys="minus" tipPlace="top" onClick={() => cmd.zoom(1 / 1.4)}>
        <ZoomOut />
      </IconButton>
      <div style={{ width: 110, display: 'flex' }}>
        <Slider
          value={Math.log(ppf)}
          min={lo}
          max={hi}
          onChange={(v) => {
            const cur = useUI.getState().ppf;
            cmd.zoom(clampPpf(Math.exp(v)) / cur);
          }}
        />
      </div>
      <IconButton label="Zoom in" keys="equal" tipPlace="top" onClick={() => cmd.zoom(1.4)}>
        <ZoomIn />
      </IconButton>
      <IconButton label="Fit timeline" keys="shift+z" tipPlace="top" onClick={() => cmd.zoomFit()}>
        <Maximize2 />
      </IconButton>
    </div>
  );
}

function TrackAdder() {
  return (
    <div className="tl__adder">
      <button className="btn btn--ghost btn--sm" onClick={() => cmd.addTrack('video')} {...tip('Add video track')}>
        <Plus />
        <Film />
      </button>
      <button className="btn btn--ghost btn--sm" onClick={() => cmd.addTrack('audio')} {...tip('Add audio track')}>
        <Plus />
        <AudioLines />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── ruler ──

function Ruler({ width, project }: { width: number; project: Project }) {
  const session = useSession();
  const player = usePlayer();
  const range = usePlayerState().range;
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const comments = useComments();
  const [editing, setEditing] = useState<{ marker: Marker; rect: DOMRect } | null>(null);
  const scrub = useRef<{ kind: 'seek' } | { kind: 'marker'; id: string; moved: boolean } | { kind: 'range'; edge: 'in' | 'out' } | null>(null);
  const settings = project.settings;
  const fps = settings.fpsNum / settings.fpsDen;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(RULER_H * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, RULER_H);
    const { major, minor } = tickInterval(ppf, fps);
    const step = major / minor;
    const first = Math.floor(scrollX / ppf / major) * major;
    const last = (scrollX + width) / ppf;
    ctx.font = '500 10px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (let f = first; f <= last; f += major) {
      for (let k = 0; k < minor; k++) {
        const x = Math.round((f + k * step) * ppf - scrollX) + 0.5;
        if (x < -1 || x > width + 1) continue;
        ctx.strokeStyle = k === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
        ctx.beginPath();
        ctx.moveTo(x, k === 0 ? RULER_H - 11 : RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
      }
      const x = f * ppf - scrollX;
      if (x > -80 && x < width) {
        ctx.fillStyle = 'rgba(180,180,190,0.85)';
        ctx.fillText(formatTimecode(f, settings), x + 4, 5);
      }
    }
  }, [width, ppf, scrollX, fps, settings]);

  const frameAt = (clientX: number, snapEdits: boolean): number => {
    const r = canvasRef.current!.getBoundingClientRect();
    let f = Math.max(0, Math.round((clientX - r.left + useUI.getState().scrollX) / useUI.getState().ppf));
    if (snapEdits && useUI.getState().snapping) {
      const pts = [...editPoints(project), ...Object.values(project.markers).map((m) => m.frame)].sort((a, b) => a - b);
      const s = snapTo(f, pts, 6 / useUI.getState().ppf);
      if (s !== null) f = s;
    }
    return f;
  };

  const markers = Object.values(project.markers);
  return (
    <div
      className="ruler"
      style={{ height: RULER_H }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.target as HTMLElement;
        e.currentTarget.setPointerCapture(e.pointerId);
        const mk = el.closest<HTMLElement>('[data-marker]')?.dataset.marker;
        const edge = el.closest<HTMLElement>('[data-range]')?.dataset.range as 'in' | 'out' | undefined;
        if (mk) {
          scrub.current = { kind: 'marker', id: mk, moved: false };
          cmd.seek(project.markers[mk].frame, false);
        } else if (edge) scrub.current = { kind: 'range', edge };
        else {
          scrub.current = { kind: 'seek' };
          if (player?.getState().playing) player.pause();
          cmd.seek(frameAt(e.clientX, !e.shiftKey), false);
        }
      }}
      onPointerMove={(e) => {
        const s = scrub.current;
        if (!s) return;
        if (s.kind === 'seek') cmd.seek(frameAt(e.clientX, !e.shiftKey), false);
        else if (s.kind === 'marker' && session.canEdit) {
          const m = session.store.get().markers[s.id];
          const f = frameAt(e.clientX, false);
          if (m && m.frame !== f) {
            if (!s.moved) session.store.beginGesture();
            s.moved = true;
            commit([{ op: 'setMarker', marker: { ...m, frame: f } }], true);
          }
        } else if (s.kind === 'range' && range && player) {
          const f = frameAt(e.clientX, true);
          player.setRange(s.edge === 'in' ? { in: Math.min(f, range.out - 1), out: range.out } : { in: range.in, out: Math.max(f, range.in + 1) });
        }
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        scrub.current = null;
      }}
      onDoubleClick={(e) => {
        const mk = (e.target as HTMLElement).closest<HTMLElement>('[data-marker]');
        if (mk && session.canEdit) setEditing({ marker: project.markers[mk.dataset.marker!], rect: mk.getBoundingClientRect() });
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add marker here', keys: 'm', onSelect: () => cmd.addMarker() },
          { label: 'Mark in', keys: 'i', onSelect: () => cmd.markIn() },
          { label: 'Mark out', keys: 'o', onSelect: () => cmd.markOut() },
          { label: 'Clear in / out', keys: 'alt+x', onSelect: () => cmd.clearRange(), disabled: !range },
        ])
      }
    >
      <canvas ref={canvasRef} style={{ width, height: RULER_H }} />
      {range && (
        <div className="ruler__range" style={{ left: range.in * ppf - scrollX, width: Math.max(2, (range.out - range.in) * ppf) }}>
          <i data-range="in" />
          <i data-range="out" />
        </div>
      )}
      {markers.map((m) => (
        <div key={m.id} className="marker" data-marker={m.id} style={{ left: m.frame * ppf - scrollX, ['--c' as string]: m.color }} {...tip(m.note ? `${m.name} — ${m.note}` : m.name, undefined, 'top')}>
          <svg viewBox="0 0 10 12" width="10" height="12">
            <path d="M1 1h8v7L5 11 1 8z" fill="var(--c)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
          </svg>
        </div>
      ))}
      {comments
        .filter((c) => !c.resolved)
        .map((c) => (
          <button
            key={c.id}
            className="ruler__comment"
            style={{ left: c.frame * ppf - scrollX, background: c.authorColor }}
            {...tip(`${c.authorName}: ${c.text.slice(0, 80)}`, undefined, 'top')}
            onPointerDown={(e) => {
              hideTip();
              e.stopPropagation();
            }}
            onClick={() => {
              cmd.seek(c.frame, false);
              useUI.getState().set({ commentsOpen: true });
            }}
          />
        ))}
      {editing && <MarkerEditor marker={editing.marker} rect={editing.rect} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MarkerEditor({ marker, rect, onClose }: { marker: Marker; rect: DOMRect; onClose: () => void }) {
  const session = useSession();
  const m = useProject((p) => p.markers[marker.id]) ?? marker;
  const update = (patch: Partial<Marker>) => commit([{ op: 'setMarker', marker: { ...session.store.get().markers[marker.id], ...patch } }]);
  return (
    <Popover anchor={rect} onClose={onClose} style={{ width: 240, padding: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <TextField value={m.name} onChange={(name) => update({ name })} autoFocus ariaLabel="Marker name" onEnter={onClose} />
        <TextField value={m.note} onChange={(note) => update({ note })} multiline rows={2} placeholder="Note" ariaLabel="Marker note" />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {MARKER_COLORS.map((c) => (
            <button key={c} aria-label={`Colour ${c}`} onClick={() => update({ color: c })} style={{ width: 18, height: 18, borderRadius: '50%', background: c, boxShadow: m.color === c ? '0 0 0 2px var(--bg-4), 0 0 0 3.5px #fff' : 'none' }} />
          ))}
          <span style={{ flex: 1 }} />
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              commit([{ op: 'removeMarker', id: marker.id }]);
              onClose();
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Popover>
  );
}

// ──────────────────────────────────────────────────────────── playhead ──

function Playhead({ left, width }: { left: number; width: number }) {
  const player = usePlayer();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!player) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const { ppf, scrollX } = useUI.getState();
      const x = Math.floor(player.getFrame()) * ppf - scrollX;
      el.style.transform = `translate3d(${left + x}px, 0, 0)`;
      el.style.visibility = x < -1 || x > width + 1 ? 'hidden' : 'visible';
    };
    place();
    const offFrame = player.onFrame(place);
    const offUi = useUI.subscribe((s, p) => {
      if (s.ppf !== p.ppf || s.scrollX !== p.scrollX) place();
    });
    return () => {
      offFrame();
      offUi();
    };
  }, [player, left, width]);
  return (
    <div ref={ref} className="playhead">
      <svg viewBox="0 0 13 14" width="13" height="14">
        <path d="M1 1h11v7.500L6.500 13 1 8.500z" />
      </svg>
    </div>
  );
}

function RemotePlayheads({ left, width }: { left: number; width: number }) {
  const peers = usePeers();
  const ppf = useUI((s) => s.ppf);
  const scrollX = useUI((s) => s.scrollX);
  const following = useUI((s) => s.following);
  return (
    <>
      {peers.map((p) => {
        const x = p.playhead * ppf - scrollX;
        if (x < 0 || x > width) return null;
        return (
          <div key={p.clientId} className="playhead playhead--peer" data-following={following === p.clientId} style={{ transform: `translate3d(${left + x}px, 0, 0)`, ['--c' as string]: p.user.color }}>
            <span>{p.user.name}</span>
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────── headers ──

function TrackHeader({ lane, project }: { lane: Lane; project: Project }) {
  const session = useSession();
  const player = usePlayer();
  const t = lane.track;
  const [renaming, setRenaming] = useState<string | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<Track>) => commit([{ op: 'updateTrack', id: t.id, patch }]);
  const label = trackLabel(project, t);
  const resize = useRef<{ y: number; h: number } | null>(null);

  // Live level meter for audio tracks.
  useEffect(() => {
    if (t.kind !== 'audio' || !player) return;
    let raf = 0;
    let shown = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const level = player.levels().tracks[t.id] ?? 0;
      // Fast attack, slow release — the way meters are meant to move.
      shown = level > shown ? level : shown * 0.9;
      const db = shown > 0.0005 ? 20 * Math.log10(shown) : -60;
      if (meter.current) meter.current.style.transform = `scaleX(${clamp((db + 48) / 48, 0, 1)})`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player, t.id, t.kind]);

  const { video, audio } = tracksOf(project);
  const list = t.kind === 'video' ? video : audio;
  const idx = list.findIndex((x) => x.id === t.id);

  return (
    <div
      className="th"
      data-kind={t.kind}
      data-locked={t.locked}
      style={{ top: lane.top, height: lane.height }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Rename', onSelect: () => setRenaming(t.name || label) },
          { label: t.kind === 'video' ? 'Move up' : 'Move up', disabled: t.kind === 'video' ? idx >= list.length - 1 : idx <= 0, onSelect: () => commit(moveTrack(project, t.id, t.kind === 'video' ? 1 : -1)) },
          { label: 'Move down', disabled: t.kind === 'video' ? idx <= 0 : idx >= list.length - 1, onSelect: () => commit(moveTrack(project, t.id, t.kind === 'video' ? -1 : 1)) },
          'separator',
          { label: 'Add video track', onSelect: () => cmd.addTrack('video') },
          { label: 'Add audio track', onSelect: () => cmd.addTrack('audio') },
          'separator',
          { label: 'Delete track', danger: true, disabled: list.length <= 1, onSelect: () => cmd.removeTrack(t.id) },
        ])
      }
    >
      <div className="th__row">
        <span className="th__tag mono">{label}</span>
        {renaming !== null ? (
          <input
            className="th__rename"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              if (renaming !== (t.name || label)) update({ name: renaming.trim() === label ? '' : renaming.trim() });
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLElement).blur();
            }}
          />
        ) : (
          <span className="th__name" onDoubleClick={() => session.canEdit && setRenaming(t.name || label)}>
            {t.name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {t.kind === 'video' ? (
          <IconButton small label={t.hidden ? 'Show track' : 'Hide track'} active={t.hidden} onClick={() => update({ hidden: !t.hidden })}>
            {t.hidden ? <EyeOff /> : <Eye />}
          </IconButton>
        ) : (
          <>
            <IconButton small label={t.muted ? 'Unmute track' : 'Mute track'} active={t.muted} onClick={() => update({ muted: !t.muted })}>
              {t.muted ? <VolumeX /> : <Volume2 />}
            </IconButton>
            <button className={cx('th__solo', t.solo && 'th__solo--on')} onClick={() => update({ solo: !t.solo })} aria-pressed={t.solo} {...tip('Solo')}>
              S
            </button>
          </>
        )}
        <IconButton small label={t.locked ? 'Unlock track' : 'Lock track'} active={t.locked} onClick={() => update({ locked: !t.locked })}>
          {t.locked ? <Lock /> : <LockOpen />}
        </IconButton>
      </div>
      {t.kind === 'audio' && lane.height >= 40 && (
        <div className="th__meter">
          <div ref={meter} />
        </div>
      )}
      <div
        className="th__resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { y: e.clientY, h: t.height };
          session.store.beginGesture();
        }}
        onPointerMove={(e) => {
          if (!resize.current) return;
          const h = clamp(Math.round(resize.current.h + (e.clientY - resize.current.y)), 26, 220);
          commit([{ op: 'updateTrack', id: t.id, patch: { height: h } }], true);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          resize.current = null;
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────── scrollbar ──

function Scrollbar({ width, end, ppf, scrollX }: { width: number; end: number; ppf: number; scrollX: number }) {
  const set = useUI((s) => s.set);
  const drag = useRef<{ x: number; scroll: number } | null>(null);
  // Leave half a screen of empty time past the last clip to drop things into.
  const total = Math.max(end * ppf + width * 0.5, scrollX + width);
  const thumbW = Math.max(28, (width / total) * width);
  const thumbX = (scrollX / Math.max(1, total - width)) * (width - thumbW);
  if (total <= width + 1) return <div className="tl__scroll" />;
  return (
    <div className="tl__scroll">
      <div style={{ width: HEADER_W, flex: 'none' }} />
      <div
        className="tl__scrolltrack"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          const ratio = clamp((e.clientX - r.left - thumbW / 2) / (width - thumbW), 0, 1);
          set({ scrollX: ratio * (total - width) });
        }}
      >
        <div
          className="tl__scrollthumb"
          style={{ width: thumbW, transform: `translateX(${Number.isFinite(thumbX) ? thumbX : 0}px)` }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, scroll: scrollX };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x;
            set({ scrollX: clamp(drag.current.scroll + (dx / (width - thumbW)) * (total - width), 0, total - width) });
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            drag.current = null;
          }}
        />
      </div>
    </div>
  );
}
