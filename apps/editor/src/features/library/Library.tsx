import {
  AudioLines,
  Blend,
  CircleAlert,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Film,
  FolderInput,
  Gauge,
  HardDriveDownload,
  Image as ImageIcon,
  Layers,
  MonitorPlay,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Type,
  Wand2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EFFECT_CATEGORIES,
  EFFECTS,
  formatBytes,
  formatClock,
  TRANSITION_CATEGORIES,
  TRANSITIONS,
  type Asset,
  type Edit,
  type ID,
  type ShapeKind,
  type TextProps,
} from '@tandem/core';
import { useMediaStatus, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { commit } from '../../state/props';
import { useUI, type LibraryTab } from '../../state/ui';
import { Button, cx, hideTip, IconButton, openContextMenu, tip } from '../../ui/core';
import { beginDrag, useDrag, type DragPayload } from '../../ui/dnd';
import { usingKeyboard } from '../../ui/layers';
import { FxThumb } from './fxPreview';
import { tileToward } from './tiles';
import './library.css';

const TABS: { id: LibraryTab; label: string; icon: typeof Film }[] = [
  { id: 'media', label: 'Media', icon: Film },
  { id: 'text', label: 'Titles', icon: Type },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Transitions', icon: Blend },
];

/**
 * What makes a library tile both something to drag and a button. The pointer drags it to the
 * timeline or clicks it: `beginDrag` tells the two apart and takes a double-click as one click.
 * A click the keyboard makes has no press of the pointer before it and applies the tile directly.
 */
function tile(payload: DragPayload, label: string, apply: () => void) {
  return {
    'data-tile': true,
    onPointerDown: (e: React.PointerEvent) => {
      hideTip();
      beginDrag(e, payload, label, apply);
    },
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) apply();
    },
  };
}

const tilesIn = (grid: HTMLElement): HTMLElement[] =>
  Array.from(grid.querySelectorAll<HTMLElement>('[data-tile]'));

/**
 * A grid of library tiles (the elements marked `data-tile`). Tab stops at it once, on the tile that
 * was last in use, and the arrow keys, Home and End move between the tiles, so that the keyboard
 * does not have to walk through fifty effects to get past them. A button inside a tile is reached
 * with Tab from that tile.
 */
function TileGrid({ className, children }: { className: string; children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLElement | null>(null);
  // A tile that was clicked keeps the focus, and whoever clicked it goes on to step through frames
  // with the arrow keys: those stay the editor's until the tile is worked from the keyboard.
  const byPointer = useRef(false);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const keepOneStop = (): void => {
      const tiles = tilesIn(el);
      const current = tiles.find((t) => t === stop.current) ?? tiles[0];
      for (const t of tiles) {
        const tabIndex = t === current ? 0 : -1;
        t.tabIndex = tabIndex;
        for (const inner of t.querySelectorAll<HTMLElement>('button')) inner.tabIndex = tabIndex;
      }
    };
    keepOneStop();
    // Tiles come and go with the search and the filters, and their buttons with what they report.
    const observer = new MutationObserver(keepOneStop);
    observer.observe(el, { childList: true, subtree: true });
    const onFocus = (e: FocusEvent): void => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-tile]');
      if (!tile) return;
      byPointer.current = !usingKeyboard();
      if (tile === stop.current) return;
      stop.current = tile;
      keepOneStop();
    };
    // The keys that move between tiles are also the transport's, and the source monitor takes
    // them on the document for as long as it is open. Heard on the window, ahead of both, they
    // have one owner while a tile shows the focus ring.
    const onKey = (e: KeyboardEvent): void => {
      const from = e.target as HTMLElement;
      if (byPointer.current || !el.contains(from) || !from.matches('[data-tile]')) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const tiles = tilesIn(el);
      const to = tileToward(
        tiles.map((t) => t.getBoundingClientRect()),
        tiles.indexOf(from),
        e.key,
      );
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      tiles[to].focus();
    };
    el.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey, true);
    return () => {
      observer.disconnect();
      el.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return (
    <div
      className={className}
      ref={grid}
      onPointerDown={() => {
        byPointer.current = true;
      }}
      onClick={(e) => {
        // A click that no pointer made comes from Enter or Space.
        if (e.detail === 0) byPointer.current = false;
      }}
    >
      {children}
    </div>
  );
}

export function Library() {
  const tab = useUI((s) => s.libraryTab);
  const set = useUI((s) => s.set);
  const headRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  // In a panel too narrow for four labels, only the open tab keeps its own.
  const [compact, setCompact] = useState(false);
  // A tile on its way to the timeline passes over the others: they stay as they are meanwhile.
  const dragging = useDrag((d) => d.payload !== null);
  useLayoutEffect(() => {
    const head = headRef.current;
    const tabs = tabsRef.current;
    if (!head || !tabs) return;
    const fit = () => {
      // With every label showing, the row is as wide as it needs to be. A folded row is unfolded
      // for the measurement, within this one layout pass: what it needed when it folded may no
      // longer hold, since the labels are set in a font that can arrive after them.
      const folded = tabs.classList.contains('tabs--compact');
      if (folded) tabs.classList.remove('tabs--compact');
      const fullWidth = tabs.scrollWidth;
      if (folded) tabs.classList.add('tabs--compact');
      const style = getComputedStyle(head);
      const room = head.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setCompact(fullWidth > room);
      const el = tabs.querySelector<HTMLElement>('[aria-selected="true"]');
      if (el) {
        const next = { x: el.offsetLeft, w: el.offsetWidth };
        setInk((prev) => (prev.x === next.x && prev.w === next.w ? prev : next));
      }
    };
    fit();
    // The panel is resized by its splitter and by the window, and labels change width with the font.
    const observer = new ResizeObserver(fit);
    observer.observe(head);
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [tab]);
  return (
    <>
      <div className="panel__head" ref={headRef}>
        <div className={cx('tabs lib__tabs', compact && 'tabs--compact')} role="tablist" ref={tabsRef}>
          {TABS.map((t) => {
            // A tab folded down to its icon names itself on hover. The handlers that take the
            // name away stay on, so it cannot outlive the fold.
            const name = tip(t.label);
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                aria-label={t.label}
                className="tab"
                onClick={() => set({ libraryTab: t.id })}
                onPointerEnter={compact && tab !== t.id ? name.onPointerEnter : undefined}
                onPointerLeave={name.onPointerLeave}
                onPointerDown={name.onPointerDown}
              >
                <t.icon />
                <span className="tab__label">{t.label}</span>
              </button>
            );
          })}
          <div className="tabs__ink" style={{ width: ink.w, transform: `translateX(${ink.x}px)` }} />
        </div>
      </div>
      <div className="panel__body lib" key={tab} data-dragging={dragging || undefined}>
        {tab === 'media' && <MediaPool />}
        {tab === 'text' && <Titles />}
        {tab === 'effects' && <EffectsBrowser />}
        {tab === 'transitions' && <TransitionsBrowser />}
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────── media ──

function MediaPool() {
  const session = useSession();
  const assets = useProject((p) => p.assets);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | Asset['kind']>('all');
  const reveal = useUI((s) => s.revealAsset);
  const [revealed, setRevealed] = useState<{ id: ID } | null>(null);
  const pool = useRef<HTMLDivElement>(null);

  // Asked to show an asset: drop whatever narrows the list and hides it, then point at its card.
  useEffect(() => {
    if (!reveal) return;
    useUI.getState().set({ revealAsset: null });
    const asset = assets[reveal];
    if (!asset) return;
    if (filter !== 'all' && filter !== asset.kind) setFilter('all');
    if (!asset.name.toLowerCase().includes(query.trim().toLowerCase())) setQuery('');
    setRevealed({ id: asset.id });
  }, [reveal, assets, filter, query]);
  useEffect(() => {
    if (!revealed) return;
    pool.current
      ?.querySelector(`[data-asset="${CSS.escape(revealed.id)}"]`)
      ?.scrollIntoView({ block: 'center' });
    const done = setTimeout(() => setRevealed(null), REVEAL_MS);
    return () => clearTimeout(done);
  }, [revealed]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(assets)
      .filter((a) => (filter === 'all' || a.kind === filter) && (!q || a.name.toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  }, [assets, query, filter]);
  const total = Object.keys(assets).length;

  if (total === 0) {
    return (
      <div className="empty">
        <FolderInput />
        <b>No media yet</b>
        Drop files anywhere in the window, or
        <Button
          variant="primary"
          icon={<Plus />}
          onClick={() => void cmd.importMedia()}
          disabled={!session.canEdit}
          style={{ marginTop: 4 }}
        >
          Import media
        </Button>
        <span style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>
          Video · audio · images · .cube LUTs · .srt captions
        </span>
        <button className="lib__sample" onClick={() => void cmd.loadSample()} disabled={!session.canEdit}>
          <Sparkles /> No footage handy? Load a sample project
        </button>
      </div>
    );
  }
  return (
    <div className="pool" ref={pool}>
      <div className="lib__bar">
        <div className="field lib__search">
          <span className="field__prefix">
            <Search size={13} />
          </span>
          <input
            placeholder="Search media"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Search media"
          />
        </div>
        <IconButton
          label="Import media"
          keys="mod+i"
          onClick={() => void cmd.importMedia()}
          disabled={!session.canEdit}
        >
          <Plus />
        </IconButton>
      </div>
      <div className="chips">
        {(['all', 'video', 'audio', 'image', 'lut'] as const).map((k) => {
          const n = k === 'all' ? total : Object.values(assets).filter((a) => a.kind === k).length;
          if (k !== 'all' && n === 0) return null;
          return (
            <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {k === 'all' ? 'All' : k === 'lut' ? 'LUTs' : k[0].toUpperCase() + k.slice(1)}
              <span>{n}</span>
            </button>
          );
        })}
      </div>
      <TileGrid className="pool__grid">
        {list.map((a) => (
          <AssetCard key={a.id} asset={a} revealed={revealed?.id === a.id} />
        ))}
        {list.length === 0 && <div className="lib__none">Nothing matches “{query}”.</div>}
      </TileGrid>
    </div>
  );
}

/** How long a revealed card stays marked; the same as its animation in library.css. */
const REVEAL_MS = 1600;

function AssetCard({ asset, revealed }: { asset: Asset; revealed: boolean }) {
  const session = useSession();
  const meta = useSessionMeta();
  const status = useMediaStatus(asset.id);
  const usage = useProject((p) => p.clips);
  const used = useMemo(
    () => Object.values(usage).some((c) => c.assetId === asset.id || c.grade?.lutId === asset.id),
    [usage, asset.id],
  );
  const available = status.local || (asset.uploaded && meta.shared);
  // A file this device could not keep goes with the page, unless the server has it by then.
  const unkept = status.unsaved === 'failed' && !(asset.uploaded && meta.shared);
  const Icon =
    asset.kind === 'audio'
      ? AudioLines
      : asset.kind === 'image'
        ? ImageIcon
        : asset.kind === 'lut'
          ? Wand2
          : Film;

  const remove = () => {
    const p = session.store.get();
    const edits: Edit[] = [];
    for (const c of Object.values(p.clips)) {
      if (c.assetId === asset.id) edits.push({ op: 'removeClip', id: c.id });
      else if (c.grade?.lutId === asset.id)
        edits.push({ op: 'updateClip', id: c.id, patch: { grade: { ...c.grade, lutId: null } } });
    }
    edits.push({ op: 'removeAsset', id: asset.id });
    commit(edits);
  };

  /** What a double-click on the card does, and Enter while it has the keyboard. */
  const open = () => {
    if (asset.kind === 'lut') cmd.applyLut(asset.id);
    else useUI.getState().set({ sourceAsset: asset.id });
  };

  return (
    <div
      className="asset"
      role="group"
      aria-label={asset.name}
      data-tile
      data-asset={asset.id}
      data-kind={asset.kind}
      data-offline={!available}
      data-revealed={revealed || undefined}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        beginDrag(e, { kind: 'asset', assetId: asset.id }, asset.name);
      }}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('button')) open();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      }}
      onContextMenu={(e) =>
        openContextMenu(e, [
          asset.kind === 'lut'
            ? { label: 'Apply to selected clips', icon: <Wand2 />, onSelect: () => cmd.applyLut(asset.id) }
            : { label: 'Add to timeline', icon: <Plus />, onSelect: () => cmd.addAsset(asset) },
          asset.kind !== 'lut'
            ? {
                label: 'Open in source monitor',
                icon: <MonitorPlay />,
                onSelect: () => useUI.getState().set({ sourceAsset: asset.id }),
              }
            : null,
          asset.kind === 'video' && asset.hasVideo && asset.hasAudio
            ? {
                label: 'Add video only',
                icon: <Film />,
                onSelect: () => cmd.addAsset(asset, { only: 'video' }),
              }
            : null,
          asset.kind === 'video' && asset.hasVideo && asset.hasAudio
            ? {
                label: 'Add audio only',
                icon: <AudioLines />,
                onSelect: () => cmd.addAsset(asset, { only: 'audio' }),
              }
            : null,
          {
            label: available ? 'Replace media…' : 'Relink media…',
            icon: <RefreshCw />,
            onSelect: () => void cmd.replaceMedia(asset.id),
          },
          status.transferError
            ? {
                label: asset.uploaded ? 'Retry download' : 'Retry upload',
                icon: <RotateCw />,
                onSelect: () => session.retryTransfer(asset.id),
              }
            : null,
          status.proxying !== null
            ? { label: 'Cancel proxy', icon: <Gauge />, onSelect: () => session.media.cancelProxy(asset.id) }
            : status.proxy
              ? {
                  label: 'Delete proxy',
                  icon: <Gauge />,
                  onSelect: () => void session.media.removeProxy(asset.id),
                }
              : session.canProxy(asset)
                ? {
                    label: 'Create proxy',
                    icon: <Gauge />,
                    onSelect: () => void session.createProxy(asset.id),
                  }
                : null,
          'separator',
          {
            label: used ? 'Remove (and its clips)' : 'Remove from project',
            icon: <Trash2 />,
            danger: true,
            onSelect: remove,
          },
        ])
      }
    >
      <div className="asset__thumb">
        {asset.thumb ? <img src={asset.thumb} alt="" draggable={false} /> : <Icon />}
        {asset.duration > 0 && <span className="asset__dur mono">{formatClock(asset.duration)}</span>}
        <span className="asset__status">
          {status.transferError ? (
            <button
              className="asset__retry"
              aria-label={`${status.transferError}: ${asset.name}. Retry now`}
              onClick={() => session.retryTransfer(asset.id)}
              {...tip(`${status.transferError}. Click to retry now.`)}
            >
              <CircleAlert style={{ color: 'var(--red)' }} />
            </button>
          ) : status.uploading !== null ? (
            <span {...tip(`Uploading ${Math.round(status.uploading * 100)}%`)}>
              <CloudUpload />
            </span>
          ) : status.downloading !== null ? (
            <span {...tip(`Downloading ${Math.round(status.downloading * 100)}%`)}>
              <CloudDownload />
            </span>
          ) : status.proxying !== null ? (
            <span {...tip(`Making proxy ${Math.round(status.proxying * 100)}%`)}>
              <Gauge />
            </span>
          ) : status.proxyError ? (
            <span {...tip(status.proxyError)}>
              <CircleAlert style={{ color: 'var(--red)' }} />
            </span>
          ) : unkept ? (
            <span {...tip('Not saved on this device: it is gone after a reload')}>
              <CircleAlert style={{ color: 'var(--amber)' }} />
            </span>
          ) : status.unsaved === 'saving' ? (
            <span {...tip('Saving to this device…')}>
              <HardDriveDownload />
            </span>
          ) : !available ? (
            <span {...tip('Media offline: not on this device or the server')}>
              <CloudOff style={{ color: 'var(--amber)' }} />
            </span>
          ) : null}
        </span>
        {(asset.hdr || status.proxy) && (
          <span className="asset__badges">
            {asset.hdr && <span className="asset__hdr badge badge--amber">HDR</span>}
            {status.proxy && (
              <span
                className="asset__proxy badge"
                {...tip(
                  meta.proxies
                    ? 'Previewing from a proxy. Exports use the original.'
                    : 'A proxy exists but proxies are switched off.',
                )}
                data-off={!meta.proxies}
              >
                Proxy
              </span>
            )}
          </span>
        )}
        {(status.uploading !== null || status.downloading !== null || status.proxying !== null) && (
          <div className="asset__progress">
            <i
              style={{
                width: `${Math.round((status.uploading ?? status.downloading ?? status.proxying ?? 0) * 100)}%`,
              }}
            />
          </div>
        )}
        {asset.kind !== 'lut' && (
          <button
            className="asset__add"
            onClick={() => cmd.addAsset(asset)}
            aria-label={`Add ${asset.name} to timeline`}
            {...tip('Add at playhead')}
          >
            <Plus />
          </button>
        )}
        {used && <span className="asset__used" {...tip('Used in the timeline')} />}
      </div>
      <div className="asset__name" title={asset.name}>
        {asset.name}
      </div>
      <div className="asset__meta mono">
        {asset.kind === 'video' || asset.kind === 'image'
          ? `${asset.width}×${asset.height}`
          : asset.kind === 'audio'
            ? `${(asset.audioSampleRate / 1000).toFixed(1)} kHz`
            : '3D LUT'}
        {asset.fps > 0 && ` · ${Number.isInteger(asset.fps) ? asset.fps : asset.fps.toFixed(2)}`}
        <span>{formatBytes(asset.size)}</span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── titles ──

const TEXT_PRESETS: {
  name: string;
  sample: string;
  style: React.CSSProperties;
  text: Partial<TextProps>;
  y?: number;
}[] = [
  {
    name: 'Title',
    sample: 'Title',
    style: { fontWeight: 800, fontSize: 22, letterSpacing: '-0.03em' },
    text: { content: 'Your title', size: 0.12, weight: 800, letterSpacing: -0.02 },
  },
  {
    name: 'Subtitle',
    sample: 'Subtitle',
    style: { fontWeight: 500, fontSize: 15 },
    text: { content: 'A line of supporting text', size: 0.055, weight: 500 },
    y: 0.12,
  },
  {
    name: 'Lower third',
    sample: 'Name here',
    style: {
      fontWeight: 700,
      fontSize: 13,
      background: '#c6f84f',
      color: '#0c0f04',
      padding: '2px 8px',
      borderRadius: 4,
    },
    text: {
      content: 'Name Surname',
      size: 0.045,
      weight: 700,
      color: '#0c0f04',
      align: 'left',
      bg: { enabled: true, color: '#c6f84f', opacity: 1, padX: 0.5, padY: 0.25, radius: 0.18 },
    },
    y: 0.34,
  },
  {
    name: 'Caption',
    sample: 'Caption text',
    style: {
      fontWeight: 600,
      fontSize: 12,
      background: 'rgba(0,0,0,.7)',
      padding: '2px 8px',
      borderRadius: 4,
    },
    text: {
      content: 'Captions go here',
      size: 0.045,
      weight: 600,
      boxWidth: 0.8,
      bg: { enabled: true, color: '#000000', opacity: 0.65, padX: 0.4, padY: 0.2, radius: 0.2 },
    },
    y: 0.38,
  },
  {
    name: 'Outline',
    sample: 'OUTLINE',
    style: {
      fontFamily: 'Anton',
      fontSize: 22,
      color: 'transparent',
      WebkitTextStroke: '1px #fff',
      letterSpacing: '0.04em',
    },
    text: {
      content: 'OUTLINE',
      font: 'Anton',
      size: 0.16,
      weight: 400,
      color: '#00000000',
      stroke: { enabled: true, color: '#ffffff', width: 0.03 },
      letterSpacing: 0.03,
    },
  },
  {
    name: 'Bold impact',
    sample: 'IMPACT',
    style: { fontFamily: 'Bebas Neue', fontSize: 26, letterSpacing: '0.05em' },
    text: {
      content: 'BIG NEWS',
      font: 'Bebas Neue',
      size: 0.2,
      weight: 400,
      letterSpacing: 0.04,
      shadow: { enabled: true, color: '#000000', blur: 0.2, x: 0, y: 0.06, opacity: 0.5 },
    },
  },
  {
    name: 'Gradient',
    sample: 'Gradient',
    style: {
      fontWeight: 800,
      fontSize: 20,
      background: 'linear-gradient(90deg,#c6f84f,#8b7cff)',
      WebkitBackgroundClip: 'text',
      color: 'transparent',
    },
    text: {
      content: 'Gradient',
      size: 0.13,
      weight: 800,
      gradient: { enabled: true, from: '#c6f84f', to: '#8b7cff', angle: 0 },
    },
  },
  {
    name: 'Elegant serif',
    sample: 'Elegant',
    style: { fontFamily: 'Playfair Display Variable', fontStyle: 'italic', fontSize: 21 },
    text: {
      content: 'An elegant line',
      font: 'Playfair Display Variable',
      italic: true,
      size: 0.1,
      weight: 500,
    },
  },
  {
    name: 'Handwritten',
    sample: 'Handwritten',
    style: { fontFamily: 'Caveat Variable', fontSize: 23, fontWeight: 600 },
    text: { content: 'by hand', font: 'Caveat Variable', size: 0.14, weight: 600 },
  },
  {
    name: 'Typewriter',
    sample: 'typing…',
    style: { fontFamily: 'JetBrains Mono Variable', fontSize: 14 },
    text: {
      content: 'Typing this out…',
      font: 'JetBrains Mono Variable',
      size: 0.06,
      weight: 500,
      animIn: { type: 'typewriter', duration: 45 },
    },
  },
];

const SHAPES: { kind: ShapeKind; label: string; path: string }[] = [
  { kind: 'rect', label: 'Rectangle', path: 'M4 6h16v12H4z' },
  { kind: 'ellipse', label: 'Ellipse', path: 'M12 5a8 7 0 1 0 0 14 8 7 0 0 0 0-14z' },
  { kind: 'triangle', label: 'Triangle', path: 'M12 4l9 16H3z' },
  {
    kind: 'star',
    label: 'Star',
    path: 'M12 3l2.6 5.800 6.400.600-4.800 4.300 1.400 6.300L12 16.800 6.400 20l1.400-6.300L3 9.400l6.400-.6z',
  },
  { kind: 'polygon', label: 'Polygon', path: 'M12 3l8.500 6.200-3.200 10H6.700L3.500 9.200z' },
  { kind: 'line', label: 'Line', path: 'M3 12h18' },
  { kind: 'arrow', label: 'Arrow', path: 'M3 12h17m-6-6 6 6-6 6' },
];

function Titles() {
  return (
    <div className="lib__scroll">
      <div className="lib__heading">Text</div>
      <TileGrid className="presets">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="preset"
            aria-label={p.name}
            {...tip(`${p.name} — click to add, or drag to the timeline`)}
            {...tile({ kind: 'text', text: p.text }, p.name, () =>
              cmd.addTitle(p.text, p.y ? { y: p.y } : {}),
            )}
          >
            <span style={p.style}>{p.sample}</span>
          </button>
        ))}
      </TileGrid>
      <div className="lib__heading">Shapes</div>
      <TileGrid className="shapes">
        {SHAPES.map((s) => {
          const shape = {
            kind: s.kind,
            ...(s.kind === 'line' || s.kind === 'arrow'
              ? { w: 0.4, h: 0.08, strokeWidth: 0.008, stroke: '#ffffff' }
              : s.kind === 'rect'
                ? { w: 0.4, h: 0.3 }
                : { w: 0.25, h: 0.444 }),
          };
          return (
            <button
              key={s.kind}
              className="shape"
              aria-label={s.label}
              {...tip(s.label)}
              {...tile({ kind: 'shape', shape }, s.label, () => cmd.addShape(shape))}
            >
              <svg
                viewBox="0 0 24 24"
                fill={s.kind === 'line' || s.kind === 'arrow' ? 'none' : 'currentColor'}
                stroke="currentColor"
                strokeWidth={s.kind === 'line' || s.kind === 'arrow' ? 2 : 0}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={s.path} />
              </svg>
            </button>
          );
        })}
      </TileGrid>
      <div className="lib__heading">Generators</div>
      <TileGrid className="gens">
        <button
          className="gen"
          {...tile({ kind: 'generator', type: 'solid' }, 'Solid colour', () => cmd.addSolid())}
        >
          <Square />
          <div>
            <b>Solid colour</b>
            <span>A flat or gradient background</span>
          </div>
        </button>
        <button
          className="gen"
          {...tile({ kind: 'generator', type: 'adjustment' }, 'Adjustment layer', () => cmd.addAdjustment())}
        >
          <Layers />
          <div>
            <b>Adjustment layer</b>
            <span>Grade or add effects to everything below</span>
          </div>
        </button>
      </TileGrid>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── effects ──

function useSearch<T extends { name: string; description: string }>(items: T[], query: string): T[] {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? items.filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      : items;
  }, [items, query]);
}

function EffectsBrowser() {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('all');
  const found = useSearch(EFFECTS, query);
  const list = cat === 'all' ? found : found.filter((e) => e.category === cat);
  return (
    <div className="pool">
      <div className="lib__bar">
        <div className="field lib__search">
          <span className="field__prefix">
            <Search size={13} />
          </span>
          <input
            placeholder={`Search ${EFFECTS.length} effects`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Search effects"
          />
        </div>
      </div>
      <div className="chips">
        <button className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
          All
        </button>
        {EFFECT_CATEGORIES.map((c) => (
          <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <TileGrid className="fx-grid">
        {list.map((e) => (
          <button
            key={e.id}
            className="fx"
            {...tip(e.description)}
            {...tile({ kind: 'effect', type: e.id }, e.name, () => cmd.applyEffect(e.id))}
          >
            <FxThumb kind="effect" id={e.id} />
            <span>{e.name}</span>
          </button>
        ))}
        {list.length === 0 && <div className="lib__none">No effects match.</div>}
      </TileGrid>
    </div>
  );
}

function TransitionsBrowser() {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('all');
  const found = useSearch(TRANSITIONS, query);
  const list = cat === 'all' ? found : found.filter((e) => e.category === cat);
  return (
    <div className="pool">
      <div className="lib__bar">
        <div className="field lib__search">
          <span className="field__prefix">
            <Search size={13} />
          </span>
          <input
            placeholder={`Search ${TRANSITIONS.length} transitions`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Search transitions"
          />
        </div>
      </div>
      <div className="chips">
        <button className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>
          All
        </button>
        {TRANSITION_CATEGORIES.map((c) => (
          <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <TileGrid className="fx-grid">
        {list.map((t) => (
          <button
            key={t.id}
            className="fx"
            {...tip(`${t.description} Drag onto a cut.`)}
            {...tile({ kind: 'transition', type: t.id }, t.name, () => cmd.applyTransition(t.id))}
          >
            <FxThumb kind="transition" id={t.id} />
            <span>{t.name}</span>
          </button>
        ))}
        {list.length === 0 && <div className="lib__none">No transitions match.</div>}
      </TileGrid>
    </div>
  );
}
