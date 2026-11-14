import {
  AudioLines,
  ChevronFirst,
  ChevronLast,
  CircleAlert,
  Eraser,
  FileWarning,
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  formatTimecode,
  hasKeyframes,
  parseTimecode,
  resolveFrame,
  sequenceEnd,
  type Asset,
  type Clip,
  type ClipLayer,
  type Project,
} from '@tandem/core';
import {
  fontEpoch,
  layerCorners,
  layoutLayer,
  measureClip,
  onFontsLoaded,
  type LayerBox,
  type Player,
} from '@tandem/engine';
import {
  useFrame,
  useLiveProject,
  usePeers,
  usePlayer,
  usePlayerState,
  useProject,
  useSession,
  useSessionMeta,
  useThrottledFrame,
} from '../../session/hooks';
import { cmd } from '../../state/commands';
import { eventKeys } from '../../state/keys';
import { mediaAvailable } from '../../state/media';
import { beginGesture, setClipValues } from '../../state/props';
import { isTyping, spaceOperates } from '../../state/shortcuts';
import { useUI, type SourceMarks } from '../../state/ui';
import { IconButton, MenuButton, Slider, tip, cx, Button, hideTip } from '../../ui/core';
import { beginDrag } from '../../ui/dnd';
import { handFocus, layerOpen } from '../../ui/layers';
import { useCanEdit } from '../timeline/access';
import { angleStep, pointInQuad, quadCovers, wrapDegrees } from './geometry';
import { missingPictureAt, pictureNotice, type MissingPicture, type PictureFault } from './mediaNotice';
import { selectedLayers } from './selectedLayers';
import {
  marksOfKnown,
  markedRange,
  rememberSource,
  resumeAt,
  UNMARKED,
  withIn,
  withOut,
} from './sourceMarks';
import { SourceTransport } from './sourceTransport';
import './viewer.css';

/** How far the rotation handle stands off the edge of the box, in CSS pixels. */
const ROTATE_STEM = 22;
/** Space kept free around the frame when it is fitted to the panel. */
const FIT_PAD_X = 20;
const FIT_PAD_Y = ROTATE_STEM + 12;
/** How far a press may travel, in CSS pixels, and still be a click where a click means something else. */
const CLICK_SLOP = 3;
/**
 * The widest viewer, in CSS pixels, whose transport bar has no room beside the mute button for the
 * volume slider: opened there it would reach the buttons in the middle of the bar.
 */
const VOLUME_ABOVE_W = 760;

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
  useSourceMarksOfProject();

  // The canvas belongs to the session's Player for as long as this panel is mounted.
  useEffect(() => {
    const canvas = canvasRef.current!;
    session.attachCanvas(canvas);
    return () => session.detachCanvas();
  }, [session]);

  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      // Above and below there has to be room for the rotation handle, which stands clear of the frame.
      const aw = Math.max(40, stage.clientWidth - FIT_PAD_X * 2);
      const ah = Math.max(40, stage.clientHeight - FIT_PAD_Y * 2);
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
                  <path
                    d="M33.333 0V100M66.667 0V100M0 33.333H100M0 66.667H100"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )}
              {showSafe && (
                <g>
                  <rect x="5" y="5" width="90" height="90" vectorEffect="non-scaling-stroke" />
                  <rect
                    x="10"
                    y="10"
                    width="80"
                    height="80"
                    vectorEffect="non-scaling-stroke"
                    strokeDasharray="4 3"
                  />
                  <path d="M48 50H52M50 47V53" vectorEffect="non-scaling-stroke" />
                </g>
              )}
            </svg>
          )}
          <MediaNotice />
          <Gizmo scale={size.scale} />
          <PeerCursors />
        </div>
        {showStats && <Stats />}
        {player && <ContextLost player={player} />}
        <FollowSync />
        {sourceAsset && <SourceMonitor key={sourceAsset} assetId={sourceAsset} />}
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

function boxFor(project: Project, layer: ClipLayer): LayerBox | null {
  const m = measureClip(layer.clip, project);
  if (!m) return null;
  return layoutLayer(layer, m.w, m.h, project.settings.width, project.settings.height, 1);
}

type DragMode = 'move' | 'rotate' | 'scale' | 'scale-x' | 'scale-y';

function Gizmo({ scale }: { scale: number }) {
  const session = useSession();
  const player = usePlayer();
  const playing = usePlayerState().playing;
  const project = useLiveProject((p) => p);
  const selection = useUI((s) => s.selection);
  const tool = useUI((s) => s.tool);
  const workspace = useUI((s) => s.workspace);
  const frame = useThrottledFrame(12);
  // A title is measured with the fonts that have arrived so far: measure again when one lands.
  const fonts = useSyncExternalStore(onFontsLoaded, fontEpoch);
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
    /** Rotation so far in degrees. Never wrapped: a drag past half a turn goes on counting. */
    rot: number;
    px: number;
    py: number;
    dist: number;
    /** Angle of the pointer around the pivot when it was last read, in radians. */
    angle: number;
    /** The layer to select instead if the press turns out to be a click: it never moves. */
    click: string | null;
  } | null>(null);
  const { width: W, height: H } = project.settings;

  const target = useMemo<Target | null>(() => {
    for (const layer of selectedLayers(project, frame, selection)) {
      const box = boxFor(project, layer);
      if (box) return { clip: layer.clip, layer, box };
    }
    return null;
  }, [project, selection, frame, fonts]);

  const toFrame = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const r = svgRef.current!.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    },
    [W, H],
  );

  /** The top-most visible layer under the pointer. */
  const layerAt = (e: { clientX: number; clientY: number }): Target | null => {
    const [x, y] = toFrame(e);
    const f = Math.floor(player?.getFrame() ?? frame);
    const layers = resolveFrame(project, f).layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const candidates = l.kind === 'clip' ? [l.layer] : [l.b, l.a];
      for (const c of candidates) {
        if (!c || c.clip.type === 'adjustment' || project.tracks[c.clip.trackId]?.locked) continue;
        const box = boxFor(project, c);
        if (box && pointInQuad(layerCorners(box), x, y)) return { clip: c.clip, layer: c, box };
      }
    }
    return null;
  };

  const start = (
    e: React.PointerEvent,
    mode: DragMode,
    on: Target | null = target,
    click: string | null = null,
  ) => {
    if (!on || !session.canEdit || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const [x, y] = toFrame(e);
    const { clip, layer, box } = on;
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
      click,
    };
  };

  /**
   * A press inside the selected layer's box. The box takes the press wherever it reaches, also
   * where another layer lies on top of it, so what is actually under the pointer is looked up
   * first. A layer on top that leaves some of the selected one free is the one being pressed: it
   * is selected and dragged in its place. One that covers all of the selected layer would leave
   * no spot to move that layer by, so there the drag stays with the selection and only a click
   * goes to the layer on top.
   */
  const pressBody = (e: React.PointerEvent) => {
    const hit = tool === 'select' && e.button === 0 ? layerAt(e) : null;
    if (!target || !hit || hit.clip.id === target.clip.id) return start(e, 'move');
    // With Shift the press only changes the selection, which `pick` does as it travels on.
    if (e.shiftKey) return;
    if (quadCovers(layerCorners(hit.box), layerCorners(target.box))) {
      return start(e, 'move', target, hit.clip.id);
    }
    useUI.getState().select([hit.clip.id]);
    start(e, 'move', hit);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toFrame(e);
    if (d.click) {
      if (Math.hypot(x - d.startX, y - d.startY) * scale < CLICK_SLOP) return;
      d.click = null;
    }
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
      const angle = Math.atan2(y - d.py, x - d.px);
      d.rot += (angleStep(d.angle, angle) * 180) / Math.PI;
      d.angle = angle;
      const turned = e.shiftKey ? Math.round(d.rot / 15) * 15 : d.rot;
      // Between keyframes the number of turns is part of the animation. A rotation that stands
      // still looks the same however it is counted, so it keeps to the range the inspector offers.
      const clip = project.clips[d.id];
      const deg = clip && hasKeyframes(clip, 'rotation') ? turned : wrapDegrees(turned);
      setClipValues([d.id], { rotation: Math.round(deg * 10) / 10 });
    } else {
      const k = Math.max(0.01, Math.hypot(x - d.px, y - d.py) / d.dist);
      const r = (v: number) => Math.round(v * 1000) / 1000;
      if (d.mode === 'scale')
        setClipValues(
          [d.id],
          e.shiftKey ? { scaleX: r(d.sx * k) } : { scaleX: r(d.sx * k), scaleY: r(d.sy * k) },
        );
      else if (d.mode === 'scale-x') setClipValues([d.id], { scaleX: r(d.sx * k) });
      else setClipValues([d.id], { scaleY: r(d.sy * k) });
    }
  };

  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
    setGuides({ v: false, h: false });
    if (d.click) useUI.getState().select([d.click]);
  };

  /** Click-to-select: the top-most visible layer under the pointer. */
  const pick = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== 'select') return;
    const hit = layerAt(e);
    if (!hit) useUI.getState().clearSelection();
    else if (e.shiftKey) useUI.getState().toggleSelect(hit.clip.id);
    else useUI.getState().select([hit.clip.id]);
  };

  /** Double-clicking a title goes to its text. */
  const editText = (e: React.MouseEvent) => {
    const hit = tool === 'select' ? layerAt(e) : null;
    if (hit?.clip.type === 'text') cmd.editText(hit.clip.id);
  };

  const hs = 5 / scale;
  const sw = 1.25 / scale;
  let shape: React.ReactNode = null;
  // The handles belong to laying a picture out. Where it is graded or mixed they would sit on
  // the very image being judged, so only the Edit workspace draws them.
  if (target && !playing && workspace === 'edit') {
    const q = layerCorners(target.box);
    const mid = (a: [number, number], b: [number, number]): [number, number] => [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
    ];
    const top = mid(q[0], q[1]);
    const right = mid(q[1], q[2]);
    const bottom = mid(q[2], q[3]);
    const left = mid(q[3], q[0]);
    // Rotation handle floats above the top edge, along the box's own "up" direction.
    const up = [Math.sin(target.box.rotation), -Math.cos(target.box.rotation)];
    const flip = target.box.sy < 0 ? -1 : 1;
    const stem = (ROTATE_STEM / scale) * flip;
    const rh: [number, number] = [top[0] + up[0] * stem, top[1] + up[1] * stem];
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
    const outline = q.map((p) => p.join(',')).join(' ');
    shape = (
      <g>
        <polygon className="gizmo__halo" points={outline} strokeWidth={sw * 3} />
        <line className="gizmo__halo" x1={top[0]} y1={top[1]} x2={rh[0]} y2={rh[1]} strokeWidth={sw * 3} />
        <polygon
          className="gizmo__body"
          points={outline}
          strokeWidth={sw}
          onPointerDown={pressBody}
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
    <svg
      ref={svgRef}
      className="gizmo"
      viewBox={`0 0 ${W} ${H}`}
      onPointerDown={pick}
      onDoubleClick={editText}
    >
      {guides.v && <line className="gizmo__guide" x1={W / 2} y1={0} x2={W / 2} y2={H} strokeWidth={sw} />}
      {guides.h && <line className="gizmo__guide" x1={0} y1={H / 2} x2={W} y2={H / 2} strokeWidth={sw} />}
      {shape}
    </svg>
  );
}

// ────────────────────────────────────────────────────────── missing media ──

/** How often the picture under a running playhead is asked about, in times a second. */
const NOTICE_HZ = 8;

/**
 * One line over the picture that says why it is black, when it is black because the file of the
 * clip under the playhead is nowhere to be had or cannot be decoded here: the timeline marks such
 * clips, and without this the viewer would show nothing and say nothing. A file that is still on
 * its way counts as neither. The line is not in the way of the pointer, and it is drawn again
 * only when what it says changes: the playhead is listened to, not rendered with.
 */
function MediaNotice() {
  const session = useSession();
  const player = usePlayer();
  const { shared } = useSessionMeta();
  const [missing, setMissing] = useState<MissingPicture | null>(null);

  useEffect(() => {
    if (!player) return;
    const faultOf = (asset: Asset): PictureFault | null =>
      !mediaAvailable(asset, session.media.get(asset.id), shared)
        ? 'offline'
        : session.thumbs.fault(asset.id)?.picture
          ? 'undecodable'
          : null;
    const look = () => {
      const now = missingPictureAt(session.store.get(), Math.floor(player.getFrame()), faultOf);
      setMissing((before) => (before?.name === now?.name && before?.why === now?.why ? before : now));
    };
    let looked = 0;
    const onFrame = () => {
      const now = performance.now();
      if (player.getState().playing && now - looked < 1000 / NOTICE_HZ) return;
      looked = now;
      look();
    };
    look();
    // The frame a stop leaves the playhead on is looked at when the player says it has stopped.
    const offs = [
      player.onFrame(onFrame),
      player.subscribe(look),
      session.store.subscribe(look),
      session.media.subscribe(look),
      session.thumbs.subscribeFaults(look),
    ];
    return () => offs.forEach((off) => off());
  }, [session, player, shared]);

  if (!missing) return null;
  return (
    <div className="viewer__media" role="status">
      {missing.why === 'offline' ? <CircleAlert /> : <FileWarning />}
      <span>{pictureNotice(missing)}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── presence ──

function PeerCursors() {
  const peers = usePeers();
  return (
    <>
      {peers.map((p) =>
        p.cursor && p.cursor.area === 'viewer' && typeof p.cursor.y === 'number' ? (
          <div
            key={p.clientId}
            className="peer-cursor"
            style={{
              left: `${p.cursor.x * 100}%`,
              top: `${p.cursor.y * 100}%`,
              ['--c' as string]: p.user.color,
            }}
          >
            <svg viewBox="0 0 16 16" width="16" height="16">
              <path
                d="M2 1.5l11 5.2-4.700 1.400-1.700 4.700L2 1.500z"
                fill="var(--c)"
                stroke="#0b0b0d"
                strokeWidth="1"
                strokeLinejoin="round"
              />
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
      <div>
        {s.renderMs.toFixed(1)} ms · {s.passes} passes
      </div>
      <div>dropped {s.dropped}</div>
    </div>
  );
}

/** How long the graphics context may stay lost before the banner offers a way out. */
const CONTEXT_PATIENCE_MS = 10_000;

/**
 * Says so while the browser has taken the graphics context away. The canvas keeps its last frame
 * meanwhile, so without this the viewer would simply look frozen.
 */
function ContextLost({ player }: { player: Player }) {
  const lost = useSyncExternalStore(player.subscribe, () => player.contextLost);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!lost) return;
    const timer = setTimeout(() => setStuck(true), CONTEXT_PATIENCE_MS);
    return () => {
      clearTimeout(timer);
      setStuck(false);
    };
  }, [lost]);
  if (!lost) return null;
  return (
    <div className="viewer__lost" role="status">
      <span className="spinner" />
      {stuck
        ? 'The graphics context was lost and has not come back yet.'
        : 'The graphics context was lost. Waiting for the browser to restore it…'}
      {stuck && (
        <Button size="sm" onClick={() => location.reload()}>
          Reload
        </Button>
      )}
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
  const session = useSession();
  const meta = useSessionMeta();
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
  const bar = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);

  useLayoutEffect(() => {
    const el = bar.current!;
    const measure = () => setTight(el.offsetWidth <= VOLUME_ABOVE_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="transport" ref={bar}>
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
        <IconButton
          label="Loop playback"
          keys="mod+l"
          tipPlace="top"
          active={state.loop}
          onClick={() => cmd.toggleLoop()}
        >
          <Repeat />
        </IconButton>
      </div>
      <div className="transport__right">
        <div className="vol" data-place={tight ? 'above' : 'beside'}>
          {/* Above the button is where the slider opens in a narrow viewer: the tip goes below. */}
          <IconButton
            label={state.muted ? 'Unmute' : 'Mute'}
            tipPlace={tight ? 'bottom' : 'top'}
            onClick={() => player?.setMuted(!state.muted)}
          >
            {state.muted || state.volume === 0 ? <VolumeX /> : <Volume2 />}
          </IconButton>
          <div className="vol__slider">
            <Slider
              value={state.muted ? 0 : state.volume}
              min={0}
              max={1}
              onChange={(v) => {
                player?.setVolume(v);
                if (state.muted && v > 0) player?.setMuted(false);
              }}
              defaultValue={1}
              ariaLabel="Volume"
              valueText={(v) => `${Math.round(v * 100)}%`}
            />
          </div>
        </div>
        <MenuButton
          className="btn btn--ghost btn--sm"
          label="Preview quality"
          align="end"
          items={[
            { heading: 'Preview resolution' },
            {
              label: 'Auto (match viewer)',
              checked: state.quality === 'auto',
              onSelect: () => player?.setQuality('auto'),
            },
            { label: 'Full', checked: state.quality === 1, onSelect: () => player?.setQuality(1) },
            { label: 'Half', checked: state.quality === 0.5, onSelect: () => player?.setQuality(0.5) },
            { label: 'Quarter', checked: state.quality === 0.25, onSelect: () => player?.setQuality(0.25) },
            'separator',
            { heading: 'Proxy media' },
            {
              label: 'Preview from proxies',
              checked: meta.proxies,
              onSelect: () => session.setProxies(!meta.proxies),
            },
            { label: 'Create proxies for large media', onSelect: () => cmd.createProxies() },
          ]}
        >
          <Gauge />
          {state.quality === 'auto'
            ? 'Auto'
            : state.quality === 1
              ? 'Full'
              : state.quality === 0.5
                ? '1/2'
                : '1/4'}
        </MenuButton>
        <MenuButton
          className="btn btn--ghost btn--sm"
          label="Viewer zoom"
          align="end"
          items={[
            { label: 'Fit', checked: zoom === 'fit', onSelect: () => set({ viewerZoom: 'fit' }) },
            ...[0.25, 0.5, 1, 2, 4].map((z) => ({
              label: `${z * 100}%`,
              checked: zoom === z,
              onSelect: () => set({ viewerZoom: z }),
            })),
          ]}
        >
          {zoom === 'fit' ? 'Fit' : `${zoom * 100}%`}
        </MenuButton>
        <MenuButton
          className="icon-btn"
          label="View options"
          align="end"
          items={[
            {
              label: 'Safe areas',
              icon: <Frame />,
              checked: showSafe,
              onSelect: () => set({ showSafeAreas: !showSafe }),
            },
            {
              label: 'Rule of thirds',
              icon: <Grid3x3 />,
              checked: showGrid,
              onSelect: () => set({ showGrid: !showGrid }),
            },
            {
              label: 'Clipping warnings',
              icon: <ScanEye />,
              checked: state.falseColor,
              onSelect: () => player?.setFalseColor(!state.falseColor),
            },
            {
              label: 'Performance stats',
              icon: <Gauge />,
              checked: showStats,
              onSelect: () => set({ showStats: !showStats }),
            },
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

const closeSourceMonitor = () => useUI.getState().set({ sourceAsset: null, sourceCue: null });

/** The keys that move a slider: one that has the keyboard keeps them while the monitor is open. */
const SLIDER_KEYS = new Set([
  'arrowleft',
  'arrowright',
  'shift+arrowleft',
  'shift+arrowright',
  'home',
  'end',
]);

/** A position in a file as minutes, seconds and hundredths. */
function sourceClock(seconds: number): string {
  const hundredths = Math.round(seconds * 100);
  return `${Math.floor(hundredths / 6000)}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

/**
 * The monitor keeps marks and a position for every file it has shown. Those of a file that has
 * left the project go with it: nothing else would ever let go of them. And all of it belongs to
 * the project that is open: the next one starts with nothing kept.
 */
function useSourceMarksOfProject(): void {
  const session = useSession();
  const assets = useProject((p) => p.assets);
  useEffect(() => () => useUI.getState().set({ sourceMarks: {} }), [session]);
  useEffect(() => {
    const { sourceMarks, set } = useUI.getState();
    const kept = marksOfKnown(sourceMarks, assets);
    if (kept !== sourceMarks) set({ sourceMarks: kept });
  }, [assets]);
}

/** The source monitor for one asset. A different asset gets a monitor of its own (it is keyed). */
function SourceMonitor({ assetId }: { assetId: string }) {
  const session = useSession();
  const editable = useCanEdit();
  const player = usePlayer();
  const asset = useProject((p) => p.assets[assetId]);
  const fps = useProject((p) => p.settings.fpsNum / p.settings.fpsDen);
  const cue = useUI((s) => (s.sourceCue?.assetId === assetId ? s.sourceCue : null));
  const marks = useUI((s) => s.sourceMarks[assetId]) ?? UNMARKED;
  const [url, setUrl] = useState<string | null>(null);
  const [transport] = useState(() => new SourceTransport());
  const length = asset?.duration ?? 0;
  // Where the file goes on from, decided as the monitor opens. A match frame asks for a frame of
  // its own instead.
  const [resume] = useState(() => (cue ? null : resumeAt(marks, length)));
  // One function for the life of the monitor: React detaches and re-attaches a ref that changes.
  // The element is let go when the monitor closes or turns to another file, and where this file
  // had got to is kept for the next look at it. One that never loaded has no place to keep, and
  // one that has left the project is not coming back.
  const attach = useCallback(
    (el: HTMLMediaElement | null) => {
      const shown = transport.element;
      const loaded = !!shown && shown.readyState >= HTMLMediaElement.HAVE_METADATA;
      if (!el && loaded && session.store.get().assets[assetId]) {
        rememberSource(assetId, { at: transport.time });
      }
      transport.attach(el);
    },
    [transport, session, assetId],
  );

  // The asset can leave the project while it is on show, removed here or by someone else. There
  // is then nothing to show, and a monitor left open unseen would go on taking the transport keys.
  const gone = !asset;
  useEffect(() => {
    if (gone) closeSourceMonitor();
  }, [gone]);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
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

  useEffect(() => () => transport.dispose(), [transport]);

  // The programme is hidden behind the monitor: it must not go on playing there, unseen.
  useEffect(() => player?.pause(), [player]);

  // A file that is opened again plays on from where it was left.
  useEffect(() => {
    const el = transport.element;
    if (resume === null || !url || !el) return;
    const go = () => {
      el.currentTime = resume;
    };
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
    return () => el.removeEventListener('loadedmetadata', go);
  }, [resume, url, transport]);

  // Match frame: hold the source at the frame that was asked for instead of playing it. The
  // request is used up by that, so opening the same file from the pool later plays it as usual.
  useEffect(() => {
    if (!cue || !url) return;
    const el = transport.element;
    if (!el) return;
    const hold = () => {
      transport.seek(cue.time);
      useUI.getState().set({ sourceCue: null });
    };
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) hold();
    else el.addEventListener('loadedmetadata', hold, { once: true });
    return () => el.removeEventListener('loadedmetadata', hold);
  }, [cue, url, transport]);

  // A still has no stretch to mark.
  const timed = !!asset && asset.kind !== 'image';
  const range = markedRange(marks, length);
  const changeMarks = (change: (marks: SourceMarks) => Partial<SourceMarks>) => {
    if (timed) rememberSource(assetId, change(useUI.getState().sourceMarks[assetId] ?? UNMARKED));
  };
  const markIn = () => changeMarks((m) => withIn(m, transport.time, length));
  const markOut = () => changeMarks((m) => withOut(m, transport.time, length));
  const clearMarks = () => changeMarks(() => ({ in: 0, out: null }));

  // While the monitor is open the transport and marking keys are its own, and comma and period
  // put what is marked on the timeline; the programme keeps every other shortcut. Listening on
  // the document puts this after menus and drags in progress, which take Escape on the window,
  // and before the programme's shortcuts. Under a dialog or any other layer the keys belong to
  // that layer: Space there presses its focused button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || useUI.getState().dialog || layerOpen()) return;
      const keys = eventKeys(e);
      // A control the keyboard is working keeps what is its own, as it does over the programme:
      // Space presses a button that Tab has reached, and the arrow keys move a slider.
      if (keys === 'space' && spaceOperates(e.target)) return;
      if (SLIDER_KEYS.has(keys) && (e.target as Element | null)?.closest?.('[role=slider]')) return;
      const held = e.repeat && !keys.includes('arrow');
      switch (keys) {
        case 'space':
          if (!held) transport.toggle();
          break;
        case 'k':
          transport.pause();
          break;
        case 'l':
          if (!held) transport.shuttle(1);
          break;
        case 'j':
          if (!held) transport.shuttle(-1);
          break;
        case 'i':
          if (!held) markIn();
          break;
        case 'o':
          if (!held) markOut();
          break;
        case 'shift+i':
          transport.seek(range.sourceIn);
          break;
        case 'shift+o':
          transport.seek(range.sourceOut);
          break;
        case 'alt+x':
          clearMarks();
          break;
        case 'comma':
          if (!held) cmd.addFromSource(true);
          break;
        case 'period':
          if (!held) cmd.addFromSource(false);
          break;
        // With Shift the same two keys nudge the selected clips by ten frames. Those are behind the
        // monitor: they do not move unseen while the plain keys are the monitor's.
        case 'shift+comma':
        case 'shift+period':
          break;
        case 'arrowleft':
          transport.step(-1 / fps);
          break;
        case 'arrowright':
          transport.step(1 / fps);
          break;
        case 'shift+arrowleft':
          transport.step(-1);
          break;
        case 'shift+arrowright':
          transport.step(1);
          break;
        case 'home':
          transport.seek(0);
          break;
        case 'end':
          transport.seek(Infinity);
          break;
        case 'escape':
          closeSourceMonitor();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  if (!asset) return null;
  // The file is taken to the timeline by its name: the picture has the player's own controls on
  // it. What goes is what the buttons below would put there, the marked stretch of a timed file.
  const grip = editable ? tip(timed ? 'Drag what is marked to the timeline' : 'Drag to the timeline') : null;

  return (
    <div className="source">
      <div className="source__head">
        <span
          className="source__grip"
          data-live={editable || undefined}
          {...grip}
          onPointerDown={(e) => {
            if (!editable) return;
            hideTip();
            beginDrag(e, { kind: 'asset', assetId, ...(timed ? range : null) }, asset.name);
          }}
        >
          <MonitorPlay size={14} />
          <span className="source__name">{asset.name}</span>
        </span>
        <span className="badge">Source</span>
        <span style={{ flex: 1 }} />
        <IconButton label="Close source monitor" keys="escape" small onClick={closeSourceMonitor}>
          <X />
        </IconButton>
      </div>
      <div className="source__body">
        {!url ? (
          <span className="spinner" />
        ) : asset.kind === 'image' ? (
          <img src={url} alt={asset.name} draggable={false} />
        ) : asset.kind === 'audio' ? (
          <div className="source__sound">
            <AudioLines />
            <audio ref={attach} src={url} controls autoPlay={!cue} />
          </div>
        ) : (
          <video ref={attach} src={url} controls autoPlay={!cue} playsInline />
        )}
      </div>
      <div className="source__foot">
        {timed && (
          <div className="source__marks">
            <Button size="sm" onClick={markIn} {...tip('Mark in at the current frame', 'i')}>
              Mark in <span className="mono">{sourceClock(range.sourceIn)}</span>
            </Button>
            <Button size="sm" onClick={markOut} {...tip('Mark out at the current frame', 'o')}>
              Mark out <span className="mono">{sourceClock(range.sourceOut)}</span>
            </Button>
            {(range.sourceIn > 0 || range.sourceOut < length) && (
              <IconButton
                label="Clear in and out"
                keys="alt+x"
                small
                onClick={(e) => {
                  // The button goes with the marks it clears: the keyboard carries on at Mark in.
                  const group = e.currentTarget.parentElement;
                  handFocus(e.currentTarget, () => group?.querySelector<HTMLElement>('button'));
                  clearMarks();
                }}
              >
                <Eraser />
              </IconButton>
            )}
          </div>
        )}
        <div className="source__add">
          <Button
            size="sm"
            icon={<CornerDownRight />}
            disabled={!editable}
            onClick={() => cmd.addFromSource(true)}
            {...tip('Ripple-insert at the playhead', 'comma')}
          >
            Insert
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<ArrowDownToLine />}
            disabled={!editable}
            onClick={() => cmd.addFromSource(false)}
            {...tip('Add at the playhead, on a free track', 'period')}
          >
            Add to timeline
          </Button>
        </div>
      </div>
    </div>
  );
}
