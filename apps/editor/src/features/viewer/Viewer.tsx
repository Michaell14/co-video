import {
  ChevronFirst,
  ChevronLast,
  Gauge,
  Grid3x3,
  Maximize,
  MonitorPlay,
  Pause,
  Play,
  Repeat,
  ScanEye,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
  X,
  Frame,
  CornerDownRight,
  ArrowDownToLine,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  animated,
  clamp,
  formatTimecode,
  parseTimecode,
  resolveFrame,
  sequenceEnd,
  type Clip,
  type ClipLayer,
  type Project,
} from '@tandem/core';
import { layerCorners, layoutLayer, measureClip, type LayerBox } from '@tandem/engine';
import { useFrame, useLiveProject, usePeers, usePlayer, usePlayerState, useProject, useSession, useThrottledFrame } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { beginGesture, setClipValues } from '../../state/props';
import { useUI } from '../../state/ui';
import { IconButton, MenuButton, Slider, tip, cx, Button } from '../../ui/core';
import './viewer.css';

export function Viewer() {
  const session = useSession();
  const player = usePlayer();
  const settings = useProject((p) => p.settings);
  const zoom = useUI((s) => s.viewerZoom);
  const showSafe = useUI((s) => s.showSafeAreas);
  const showGrid = useUI((s) => s.showGrid);
  const showStats = useUI((s) => s.showStats);
  const sourceAsset = useUI((s) => s.sourceAsset);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360, scale: 1 });

  // The canvas belongs to the session's Player for as long as this panel is mounted.
  useEffect(() => {
    const canvas = canvasRef.current!;
    session.attachCanvas(canvas);
    return () => session.detachCanvas();
  }, [session]);

  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const pad = 20;
      const aw = Math.max(40, stage.clientWidth - pad * 2);
      const ah = Math.max(40, stage.clientHeight - pad * 2);
      const scale = zoom === 'fit' ? Math.min(aw / settings.width, ah / settings.height) : zoom;
      setSize({ w: settings.width * scale, h: settings.height * scale, scale });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [settings.width, settings.height, zoom]);

  useEffect(() => {
    player?.setViewport(size.w, size.h, window.devicePixelRatio || 1);
  }, [player, size.w, size.h]);

  const onMove = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    session.setPresence({ cursor: x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { area: 'viewer', x, y } : null });
  };

  return (
    <div className="viewer">
      <div
        className={cx('viewer__stage', zoom !== 'fit' && 'viewer__stage--scroll')}
        ref={stageRef}
        onPointerMove={onMove}
        onPointerLeave={() => session.setPresence({ cursor: null })}
      >
        <div className="viewer__frame" style={{ width: size.w, height: size.h }}>
          <canvas ref={canvasRef} className="viewer__canvas" />
          {(showSafe || showGrid) && (
            <svg className="viewer__guides" viewBox="0 0 100 100" preserveAspectRatio="none">
              {showGrid && (
                <g>
                  <path d="M33.333 0V100M66.667 0V100M0 33.333H100M0 66.667H100" vectorEffect="non-scaling-stroke" />
                </g>
              )}
              {showSafe && (
                <g>
                  <rect x="5" y="5" width="90" height="90" vectorEffect="non-scaling-stroke" />
                  <rect x="10" y="10" width="80" height="80" vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />
                  <path d="M48 50H52M50 47V53" vectorEffect="non-scaling-stroke" />
                </g>
              )}
            </svg>
          )}
          <Gizmo scale={size.scale} />
          <PeerCursors />
        </div>
        {showStats && <Stats />}
        <FollowSync />
        {sourceAsset && <SourceMonitor assetId={sourceAsset} />}
      </div>
      <Transport />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── gizmo ──

interface Target {
  clip: Clip;
  layer: ClipLayer;
  box: LayerBox;
}

function findLayer(project: Project, frame: number, clipId: string): ClipLayer | null {
  for (const l of resolveFrame(project, frame).layers) {
    if (l.kind === 'clip') {
      if (l.layer.clip.id === clipId) return l.layer;
    } else {
      if (l.a?.clip.id === clipId) return l.a;
      if (l.b?.clip.id === clipId) return l.b;
    }
  }
  return null;
}

function boxFor(project: Project, layer: ClipLayer): LayerBox | null {
  const m = measureClip(layer.clip, project);
  if (!m) return null;
  return layoutLayer(layer, m.w, m.h, project.settings.width, project.settings.height, 1);
}

function pointInQuad(q: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

type DragMode = 'move' | 'rotate' | 'scale' | 'scale-x' | 'scale-y';

function Gizmo({ scale }: { scale: number }) {
  const session = useSession();
  const player = usePlayer();
  const playing = usePlayerState().playing;
  const project = useLiveProject((p) => p);
  const selection = useUI((s) => s.selection);
  const tool = useUI((s) => s.tool);
  const frame = useThrottledFrame(12);
  const svgRef = useRef<SVGSVGElement>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const drag = useRef<{
    mode: DragMode;
    id: string;
    startX: number;
    startY: number;
    x: number;
    y: number;
    sx: number;
    sy: number;
    rot: number;
    px: number;
    py: number;
    dist: number;
    angle: number;
    boxRot: number;
  } | null>(null);
  const { width: W, height: H } = project.settings;

  const target = useMemo<Target | null>(() => {
    for (const id of selection) {
      const clip = project.clips[id];
      if (!clip || clip.type === 'audio' || clip.type === 'adjustment') continue;
      if (project.tracks[clip.trackId]?.locked) continue;
      const layer = findLayer(project, frame, id);
      if (!layer) continue;
      const box = boxFor(project, layer);
      if (box) return { clip, layer, box };
    }
    return null;
  }, [project, selection, frame]);

  const toFrame = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const r = svgRef.current!.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    },
    [W, H],
  );

  const start = (e: React.PointerEvent, mode: DragMode) => {
    if (!target || !session.canEdit || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const [x, y] = toFrame(e);
    const { clip, layer, box } = target;
    beginGesture();
    drag.current = {
      mode,
      id: clip.id,
      startX: x,
      startY: y,
      x: layer.v.x,
      y: layer.v.y,
      sx: layer.v.scaleX,
      sy: layer.v.scaleY,
      rot: layer.v.rotation,
      px: box.px,
      py: box.py,
      dist: Math.hypot(x - box.px, y - box.py) || 1,
      angle: Math.atan2(y - box.py, x - box.px),
      boxRot: box.rotation,
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toFrame(e);
    if (d.mode === 'move') {
      let nx = d.x + (x - d.startX) / W;
      let ny = d.y + (y - d.startY) / H;
      // Magnetic centre lines.
      const tol = 6 / scale;
      const snapV = !e.altKey && Math.abs(nx * W) < tol;
      const snapH = !e.altKey && Math.abs(ny * H) < tol;
      if (snapV) nx = 0;
      if (snapH) ny = 0;
      if (e.shiftKey) {
        // Constrain to the dominant axis.
        if (Math.abs(x - d.startX) > Math.abs(y - d.startY)) ny = d.y;
        else nx = d.x;
      }
      setGuides({ v: snapV, h: snapH });
      setClipValues([d.id], { x: nx, y: ny });
    } else if (d.mode === 'rotate') {
      let deg = d.rot + ((Math.atan2(y - d.py, x - d.px) - d.angle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      setClipValues([d.id], { rotation: Math.round(deg * 10) / 10 });
    } else {
      const k = Math.max(0.01, Math.hypot(x - d.px, y - d.py) / d.dist);
      const r = (v: number) => Math.round(v * 1000) / 1000;
      if (d.mode === 'scale') setClipValues([d.id], e.shiftKey ? { scaleX: r(d.sx * k) } : { scaleX: r(d.sx * k), scaleY: r(d.sy * k) });
      else if (d.mode === 'scale-x') setClipValues([d.id], { scaleX: r(d.sx * k) });
      else setClipValues([d.id], { scaleY: r(d.sy * k) });
    }
  };

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
    setGuides({ v: false, h: false });
  };

  /** Click-to-select: the top-most visible layer under the pointer. */
  const pick = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== 'select') return;
    const [x, y] = toFrame(e);
    const f = Math.floor(player?.getFrame() ?? frame);
    const layers = resolveFrame(project, f).layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const candidates = l.kind === 'clip' ? [l.layer] : [l.b, l.a];
      for (const c of candidates) {
        if (!c || c.clip.type === 'adjustment' || project.tracks[c.clip.trackId]?.locked) continue;
        const box = boxFor(project, c);
        if (box && pointInQuad(layerCorners(box), x, y)) {
          if (e.shiftKey) useUI.getState().toggleSelect(c.clip.id);
          else useUI.getState().select([c.clip.id]);
          return;
        }
      }
    }
    useUI.getState().clearSelection();
  };

  const hs = 5 / scale;
  const sw = 1.25 / scale;
  let shape: React.ReactNode = null;
  if (target && !playing) {
    const q = layerCorners(target.box);
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const top = mid(q[0], q[1]);
    const right = mid(q[1], q[2]);
    const bottom = mid(q[2], q[3]);
    const left = mid(q[3], q[0]);
    // Rotation handle floats above the top edge, along the box's own "up" direction.
    const up = [Math.sin(target.box.rotation), -Math.cos(target.box.rotation)];
    const flip = target.box.sy < 0 ? -1 : 1;
    const rh: [number, number] = [top[0] + up[0] * (22 / scale) * flip, top[1] + up[1] * (22 / scale) * flip];
    const handle = (p: [number, number], mode: DragMode, cursor: string, key: string) => (
      <rect
        key={key}
        className="gizmo__handle"
        x={p[0] - hs}
        y={p[1] - hs}
        width={hs * 2}
        height={hs * 2}
        rx={hs * 0.3}
        strokeWidth={sw}
        style={{ cursor }}
        onPointerDown={(e) => start(e, mode)}
        onPointerMove={move}
        onPointerUp={end}
      />
    );
    shape = (
      <g>
        <polygon
          className="gizmo__body"
          points={q.map((p) => p.join(',')).join(' ')}
          strokeWidth={sw}
          onPointerDown={(e) => start(e, 'move')}
          onPointerMove={move}
          onPointerUp={end}
        />
        <line className="gizmo__stem" x1={top[0]} y1={top[1]} x2={rh[0]} y2={rh[1]} strokeWidth={sw} />
        <circle
          className="gizmo__rotate"
          cx={rh[0]}
          cy={rh[1]}
          r={hs * 1.1}
          strokeWidth={sw}
          onPointerDown={(e) => start(e, 'rotate')}
          onPointerMove={move}
          onPointerUp={end}
        />
        {handle(q[0], 'scale', 'nwse-resize', 'tl')}
        {handle(q[1], 'scale', 'nesw-resize', 'tr')}
        {handle(q[2], 'scale', 'nwse-resize', 'br')}
        {handle(q[3], 'scale', 'nesw-resize', 'bl')}
        {handle(left, 'scale-x', 'ew-resize', 'l')}
        {handle(right, 'scale-x', 'ew-resize', 'r')}
        {handle(top, 'scale-y', 'ns-resize', 't')}
        {handle(bottom, 'scale-y', 'ns-resize', 'b')}
      </g>
    );
  }

  return (
    <svg ref={svgRef} className="gizmo" viewBox={`0 0 ${W} ${H}`} onPointerDown={pick}>
      {guides.v && <line className="gizmo__guide" x1={W / 2} y1={0} x2={W / 2} y2={H} strokeWidth={sw} />}
      {guides.h && <line className="gizmo__guide" x1={0} y1={H / 2} x2={W} y2={H / 2} strokeWidth={sw} />}
      {shape}
    </svg>
  );
}

// ───────────────────────────────────────────────────────────── presence ──

function PeerCursors() {
  const peers = usePeers();
  return (
    <>
      {peers.map((p) =>
        p.cursor && p.cursor.area === 'viewer' && typeof p.cursor.y === 'number' ? (
          <div key={p.clientId} className="peer-cursor" style={{ left: `${p.cursor.x * 100}%`, top: `${p.cursor.y * 100}%`, ['--c' as string]: p.user.color }}>
            <svg viewBox="0 0 16 16" width="16" height="16">
              <path d="M2 1.5l11 5.2-4.700 1.400-1.700 4.700L2 1.500z" fill="var(--c)" stroke="#0b0b0d" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span>{p.user.name}</span>
          </div>
        ) : null,
      )}
    </>
  );
}

/** While following someone, keep our playhead where theirs is. */
function FollowSync() {
  const player = usePlayer();
  const peers = usePeers();
  const following = useUI((s) => s.following);
  const peer = following === null ? null : peers.find((p) => p.clientId === following);
  useEffect(() => {
    if (following !== null && !peer) useUI.getState().set({ following: null });
  }, [following, peer]);
  useEffect(() => {
    if (!peer || !player) return;
    if (Math.abs(player.getFrame() - peer.playhead) > 0.5) {
      if (player.getState().playing) player.pause();
      player.seek(peer.playhead);
    }
  }, [peer, peer?.playhead, player]);
  if (!peer) return null;
  return (
    <div className="following" style={{ ['--c' as string]: peer.user.color }}>
      Following {peer.user.name}
      <button onClick={() => useUI.getState().set({ following: null })} aria-label="Stop following">
        <X size={12} />
      </button>
    </div>
  );
}

function Stats() {
  const player = usePlayer();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(t);
  }, []);
  if (!player) return null;
  const s = player.stats;
  return (
    <div className="viewer__stats mono">
      <div>
        {s.renderWidth}×{s.renderHeight}
      </div>
      <div>{player.getState().playing ? `${s.fps} fps` : 'paused'}</div>
      <div>{s.renderMs.toFixed(1)} ms · {s.passes} passes</div>
      <div>dropped {s.dropped}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── transport ──

function Timecode() {
  const player = usePlayer();
  const settings = useProject((p) => p.settings);
  const frame = useFrame();
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <input
      className="tc mono"
      aria-label="Current timecode"
      value={edit ?? formatTimecode(frame, settings)}
      spellCheck={false}
      onFocus={(e) => {
        setEdit(formatTimecode(frame, settings));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setEdit(e.target.value)}
      onBlur={() => setEdit(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const parsed = parseTimecode(edit ?? '', settings);
          if (parsed && player) cmd.seek(parsed.relative ? frame + parsed.frame : parsed.frame);
          (e.target as HTMLElement).blur();
        } else if (e.key === 'Escape') (e.target as HTMLElement).blur();
      }}
      {...tip('Click to type a timecode. +30 / −30 moves relative.')}
    />
  );
}

function Transport() {
  const player = usePlayer();
  const state = usePlayerState();
  const settings = useProject((p) => p.settings);
  const end = useProject((p) => sequenceEnd(p));
  const zoom = useUI((s) => s.viewerZoom);
  const showSafe = useUI((s) => s.showSafeAreas);
  const showGrid = useUI((s) => s.showGrid);
  const showStats = useUI((s) => s.showStats);
  const set = useUI((s) => s.set);
  const rate = state.playing && state.rate !== 1 ? `${state.rate}×` : null;

  return (
    <div className="transport">
      <div className="transport__left">
        <Timecode />
        <span className="transport__dur mono">/ {formatTimecode(end, settings)}</span>
        {rate && <span className="badge badge--accent mono">{rate}</span>}
      </div>
      <div className="transport__center">
        <IconButton label="Go to start" keys="home" tipPlace="top" onClick={() => cmd.goStart()}>
          <ChevronFirst />
        </IconButton>
        <IconButton label="Previous edit" keys="arrowup" tipPlace="top" onClick={() => cmd.prevEdit()}>
          <SkipBack />
        </IconButton>
        <button
          className="play"
          data-playing={state.playing}
          onClick={() => cmd.togglePlay()}
          aria-label={state.playing ? 'Pause' : 'Play'}
          {...tip(state.playing ? 'Pause' : 'Play', 'space', 'top')}
        >
          {state.playing ? <Pause /> : <Play />}
        </button>
        <IconButton label="Next edit" keys="arrowdown" tipPlace="top" onClick={() => cmd.nextEdit()}>
          <SkipForward />
        </IconButton>
        <IconButton label="Go to end" keys="end" tipPlace="top" onClick={() => cmd.goEnd()}>
          <ChevronLast />
        </IconButton>
        <IconButton label="Loop playback" keys="mod+l" tipPlace="top" active={state.loop} onClick={() => cmd.toggleLoop()}>
          <Repeat />
        </IconButton>
      </div>
      <div className="transport__right">
        <div className="vol">
          <IconButton label={state.muted ? 'Unmute' : 'Mute'} tipPlace="top" onClick={() => player?.setMuted(!state.muted)}>
            {state.muted || state.volume === 0 ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <div className="vol__slider">
            <Slider value={state.muted ? 0 : state.volume} min={0} max={1} onChange={(v) => { player?.setVolume(v); if (state.muted && v > 0) player?.setMuted(false); }} defaultValue={1} />
          </div>
        </div>
        <MenuButton
          className="btn btn--ghost btn--sm"
          label="Preview quality"
          align="end"
          items={[
            { heading: 'Preview resolution' },
            { label: 'Auto (match viewer)', checked: state.quality === 'auto', onSelect: () => player?.setQuality('auto') },
            { label: 'Full', checked: state.quality === 1, onSelect: () => player?.setQuality(1) },
            { label: 'Half', checked: state.quality === 0.5, onSelect: () => player?.setQuality(0.5) },
            { label: 'Quarter', checked: state.quality === 0.25, onSelect: () => player?.setQuality(0.25) },
          ]}
        >
          <Gauge />
          {state.quality === 'auto' ? 'Auto' : state.quality === 1 ? 'Full' : state.quality === 0.5 ? '1/2' : '1/4'}
        </MenuButton>
        <MenuButton
          className="btn btn--ghost btn--sm"
          label="Viewer zoom"
          align="end"
          items={[
            { label: 'Fit', checked: zoom === 'fit', onSelect: () => set({ viewerZoom: 'fit' }) },
            ...[0.25, 0.5, 1, 2, 4].map((z) => ({ label: `${z * 100}%`, checked: zoom === z, onSelect: () => set({ viewerZoom: z }) })),
          ]}
        >
          {zoom === 'fit' ? 'Fit' : `${zoom * 100}%`}
        </MenuButton>
        <MenuButton
          className="icon-btn"
          label="View options"
          align="end"
          items={[
            { label: 'Safe areas', icon: <Frame />, checked: showSafe, onSelect: () => set({ showSafeAreas: !showSafe }) },
            { label: 'Rule of thirds', icon: <Grid3x3 />, checked: showGrid, onSelect: () => set({ showGrid: !showGrid }) },
            { label: 'Clipping warnings', icon: <ScanEye />, checked: state.falseColor, onSelect: () => player?.setFalseColor(!state.falseColor) },
            { label: 'Performance stats', icon: <Gauge />, checked: showStats, onSelect: () => set({ showStats: !showStats }) },
          ]}
        >
          <ScanEye />
        </MenuButton>
        <IconButton
          label="Full screen"
          tipPlace="top"
          onClick={() => {
            const el = document.querySelector('.viewer__stage');
            if (document.fullscreenElement) void document.exitFullscreen();
            else void el?.requestFullscreen?.();
          }}
        >
          <Maximize />
        </IconButton>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────── source monitor ──

function SourceMonitor({ assetId }: { assetId: string }) {
  const session = useSession();
  const asset = useProject((p) => p.assets[assetId]);
  const [url, setUrl] = useState<string | null>(null);
  const [marks, setMarks] = useState<{ in: number; out: number | null }>({ in: 0, out: null });
  const media = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const close = () => useUI.getState().set({ sourceAsset: null });

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setUrl(null);
    setMarks({ in: 0, out: null });
    void session.media
      .resolver((id) => !!session.store.get().assets[id]?.uploaded)(assetId)
      .then((loc) => {
        if (cancelled || !loc) return;
        if (loc.blob) {
          revoke = URL.createObjectURL(loc.blob);
          setUrl(revoke);
        } else if (loc.url) setUrl(loc.url);
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [assetId, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!asset) return null;
  const time = () => media.current?.currentTime ?? 0;
  const add = (insert: boolean) => {
    const out = marks.out ?? asset.duration;
    cmd.addAsset(asset, { sourceIn: marks.in, sourceOut: out > marks.in ? out : asset.duration, insert });
    close();
  };
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

  return (
    <div className="source">
      <div className="source__head">
        <MonitorPlay size={14} />
        <span className="source__name">{asset.name}</span>
        <span className="badge">Source</span>
        <span style={{ flex: 1 }} />
        <IconButton label="Close source monitor" keys="escape" small onClick={close}>
          <X />
        </IconButton>
      </div>
      <div className="source__body">
        {!url ? (
          <span className="spinner" />
        ) : asset.kind === 'image' ? (
          <img src={url} alt={asset.name} draggable={false} />
        ) : asset.kind === 'audio' ? (
          <audio ref={(el) => void (media.current = el)} src={url} controls autoPlay />
        ) : (
          <video ref={(el) => void (media.current = el)} src={url} controls autoPlay playsInline />
        )}
      </div>
      <div className="source__foot">
        {asset.kind !== 'image' && (
          <>
            <Button size="sm" onClick={() => setMarks((m) => ({ ...m, in: clamp(time(), 0, asset.duration) }))}>
              Mark in <span className="mono">{fmt(marks.in)}</span>
            </Button>
            <Button size="sm" onClick={() => setMarks((m) => ({ ...m, out: clamp(time(), 0, asset.duration) }))}>
              Mark out <span className="mono">{fmt(marks.out ?? asset.duration)}</span>
            </Button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <Button size="sm" icon={<CornerDownRight />} onClick={() => add(true)} {...tip('Ripple-insert at the playhead')}>
          Insert
        </Button>
        <Button size="sm" variant="primary" icon={<ArrowDownToLine />} onClick={() => add(false)}>
          Add to timeline
        </Button>
      </div>
    </div>
  );
}


