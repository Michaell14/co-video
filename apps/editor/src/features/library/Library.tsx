import {
  AudioLines,
  Blend,
  CircleAlert,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Film,
  FolderInput,
  Image as ImageIcon,
  Layers,
  MonitorPlay,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
  Type,
  Wand2,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  EFFECT_CATEGORIES,
  EFFECTS,
  formatBytes,
  formatClock,
  TRANSITION_CATEGORIES,
  TRANSITIONS,
  type Asset,
  type Edit,
  type ShapeKind,
  type TextProps,
} from '@tandem/core';
import { useMediaStatus, useProject, useSession, useSessionMeta } from '../../session/hooks';
import { cmd } from '../../state/commands';
import { commit } from '../../state/props';
import { useUI, type LibraryTab } from '../../state/ui';
import { Button, hideTip, IconButton, openContextMenu, tip } from '../../ui/core';
import { beginDrag } from '../../ui/dnd';
import { FxThumb } from './fxPreview';
import './library.css';

const TABS: { id: LibraryTab; label: string; icon: typeof Film }[] = [
  { id: 'media', label: 'Media', icon: Film },
  { id: 'text', label: 'Titles', icon: Type },
  { id: 'effects', label: 'Effects', icon: Sparkles },
  { id: 'transitions', label: 'Transitions', icon: Blend },
];

export function Library() {
  const tab = useUI((s) => s.libraryTab);
  const set = useUI((s) => s.set);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  }, [tab]);
  return (
    <>
      <div className="panel__head">
        <div className="tabs" role="tablist" ref={tabsRef}>
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => set({ libraryTab: t.id })}>
              <t.icon />
              {t.label}
            </button>
          ))}
          <div className="tabs__ink" style={{ width: ink.w, transform: `translateX(${ink.x}px)` }} />
        </div>
      </div>
      <div className="panel__body lib" key={tab}>
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
        <Button variant="primary" icon={<Plus />} onClick={() => void cmd.importMedia()} disabled={!session.canEdit} style={{ marginTop: 4 }}>
          Import media
        </Button>
        <span style={{ fontSize: 11, color: 'var(--fg-4)', marginTop: 4 }}>Video · audio · images · .cube LUTs · .srt captions</span>
        <button className="lib__sample" onClick={() => void cmd.loadSample()} disabled={!session.canEdit}>
          <Sparkles /> No footage handy? Load a sample project
        </button>
      </div>
    );
  }
  return (
    <div className="pool">
      <div className="lib__bar">
        <div className="field lib__search">
          <span className="field__prefix">
            <Search size={13} />
          </span>
          <input placeholder="Search media" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Search media" />
        </div>
        <IconButton label="Import media" keys="mod+i" onClick={() => void cmd.importMedia()} disabled={!session.canEdit}>
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
      <div className="pool__grid">
        {list.map((a) => (
          <AssetCard key={a.id} asset={a} />
        ))}
        {list.length === 0 && <div className="lib__none">Nothing matches “{query}”.</div>}
      </div>
    </div>
  );
}

function AssetCard({ asset }: { asset: Asset }) {
  const session = useSession();
  const meta = useSessionMeta();
  const status = useMediaStatus(asset.id);
  const usage = useProject((p) => p.clips);
  const used = useMemo(() => Object.values(usage).some((c) => c.assetId === asset.id || c.grade?.lutId === asset.id), [usage, asset.id]);
  const available = status.local || (asset.uploaded && meta.shared);
  const Icon = asset.kind === 'audio' ? AudioLines : asset.kind === 'image' ? ImageIcon : asset.kind === 'lut' ? Wand2 : Film;

  const remove = () => {
    const p = session.store.get();
    const edits: Edit[] = [];
    for (const c of Object.values(p.clips)) {
      if (c.assetId === asset.id) edits.push({ op: 'removeClip', id: c.id });
      else if (c.grade?.lutId === asset.id) edits.push({ op: 'updateClip', id: c.id, patch: { grade: { ...c.grade, lutId: null } } });
    }
    edits.push({ op: 'removeAsset', id: asset.id });
    commit(edits);
  };

  return (
    <div
      className="asset"
      data-kind={asset.kind}
      data-offline={!available}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        beginDrag(e, { kind: 'asset', assetId: asset.id }, asset.name);
      }}
      onDoubleClick={() => (asset.kind === 'lut' ? cmd.applyLut(asset.id) : useUI.getState().set({ sourceAsset: asset.id }))}
      onContextMenu={(e) =>
        openContextMenu(e, [
          asset.kind === 'lut'
            ? { label: 'Apply to selected clips', icon: <Wand2 />, onSelect: () => cmd.applyLut(asset.id) }
            : { label: 'Add to timeline', icon: <Plus />, onSelect: () => cmd.addAsset(asset) },
          asset.kind !== 'lut' ? { label: 'Open in source monitor', icon: <MonitorPlay />, onSelect: () => useUI.getState().set({ sourceAsset: asset.id }) } : null,
          asset.kind === 'video' && asset.hasAudio ? { label: 'Add video only', onSelect: () => cmd.addAsset(asset) } : null,
          'separator',
          { label: used ? 'Remove (and its clips)' : 'Remove from project', icon: <Trash2 />, danger: true, onSelect: remove },
        ])
      }
    >
      <div className="asset__thumb">
        {asset.thumb ? <img src={asset.thumb} alt="" draggable={false} /> : <Icon />}
        {asset.duration > 0 && <span className="asset__dur mono">{formatClock(asset.duration)}</span>}
        {asset.hdr && <span className="asset__hdr badge badge--amber">HDR</span>}
        <span className="asset__status">
          {status.error ? (
            <span {...tip(status.error)}>
              <CircleAlert style={{ color: 'var(--red)' }} />
            </span>
          ) : status.uploading !== null ? (
            <span {...tip(`Uploading ${Math.round(status.uploading * 100)}%`)}>
              <CloudUpload />
            </span>
          ) : status.downloading !== null ? (
            <span {...tip(`Downloading ${Math.round(status.downloading * 100)}%`)}>
              <CloudDownload />
            </span>
          ) : !available ? (
            <span {...tip('Media offline: not on this device or the server')}>
              <CloudOff style={{ color: 'var(--amber)' }} />
            </span>
          ) : null}
        </span>
        {(status.uploading !== null || status.downloading !== null) && (
          <div className="asset__progress">
            <i style={{ width: `${Math.round((status.uploading ?? status.downloading ?? 0) * 100)}%` }} />
          </div>
        )}
        {asset.kind !== 'lut' && (
          <button className="asset__add" onClick={() => cmd.addAsset(asset)} aria-label={`Add ${asset.name} to timeline`} {...tip('Add at playhead')}>
            <Plus />
          </button>
        )}
        {used && <span className="asset__used" {...tip('Used in the timeline')} />}
      </div>
      <div className="asset__name" title={asset.name}>
        {asset.name}
      </div>
      <div className="asset__meta mono">
        {asset.kind === 'video' || asset.kind === 'image' ? `${asset.width}×${asset.height}` : asset.kind === 'audio' ? `${(asset.audioSampleRate / 1000).toFixed(1)} kHz` : '3D LUT'}
        {asset.fps > 0 && ` · ${Number.isInteger(asset.fps) ? asset.fps : asset.fps.toFixed(2)}`}
        <span>{formatBytes(asset.size)}</span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── titles ──

const TEXT_PRESETS: { name: string; sample: string; style: React.CSSProperties; text: Partial<TextProps>; y?: number }[] = [
  { name: 'Title', sample: 'Title', style: { fontWeight: 800, fontSize: 22, letterSpacing: '-0.03em' }, text: { content: 'Your title', size: 0.12, weight: 800, letterSpacing: -0.02 } },
  { name: 'Subtitle', sample: 'Subtitle', style: { fontWeight: 500, fontSize: 15 }, text: { content: 'A line of supporting text', size: 0.055, weight: 500 }, y: 0.12 },
  {
    name: 'Lower third',
    sample: 'Name here',
    style: { fontWeight: 700, fontSize: 13, background: '#c6f84f', color: '#0c0f04', padding: '2px 8px', borderRadius: 4 },
    text: { content: 'Name Surname', size: 0.045, weight: 700, color: '#0c0f04', align: 'left', bg: { enabled: true, color: '#c6f84f', opacity: 1, padX: 0.5, padY: 0.25, radius: 0.18 } },
    y: 0.34,
  },
  {
    name: 'Caption',
    sample: 'Caption text',
    style: { fontWeight: 600, fontSize: 12, background: 'rgba(0,0,0,.7)', padding: '2px 8px', borderRadius: 4 },
    text: { content: 'Captions go here', size: 0.045, weight: 600, boxWidth: 0.8, bg: { enabled: true, color: '#000000', opacity: 0.65, padX: 0.4, padY: 0.2, radius: 0.2 } },
    y: 0.38,
  },
  {
    name: 'Outline',
    sample: 'OUTLINE',
    style: { fontFamily: 'Anton', fontSize: 22, color: 'transparent', WebkitTextStroke: '1px #fff', letterSpacing: '0.04em' },
    text: { content: 'OUTLINE', font: 'Anton', size: 0.16, weight: 400, color: '#00000000', stroke: { enabled: true, color: '#ffffff', width: 0.03 }, letterSpacing: 0.03 },
  },
  {
    name: 'Bold impact',
    sample: 'IMPACT',
    style: { fontFamily: 'Bebas Neue', fontSize: 26, letterSpacing: '0.05em' },
    text: { content: 'BIG NEWS', font: 'Bebas Neue', size: 0.2, weight: 400, letterSpacing: 0.04, shadow: { enabled: true, color: '#000000', blur: 0.2, x: 0, y: 0.06, opacity: 0.5 } },
  },
  {
    name: 'Gradient',
    sample: 'Gradient',
    style: { fontWeight: 800, fontSize: 20, background: 'linear-gradient(90deg,#c6f84f,#8b7cff)', WebkitBackgroundClip: 'text', color: 'transparent' },
    text: { content: 'Gradient', size: 0.13, weight: 800, gradient: { enabled: true, from: '#c6f84f', to: '#8b7cff', angle: 0 } },
  },
  { name: 'Elegant serif', sample: 'Elegant', style: { fontFamily: 'Playfair Display Variable', fontStyle: 'italic', fontSize: 21 }, text: { content: 'An elegant line', font: 'Playfair Display Variable', italic: true, size: 0.1, weight: 500 } },
  { name: 'Handwritten', sample: 'Handwritten', style: { fontFamily: 'Caveat Variable', fontSize: 23, fontWeight: 600 }, text: { content: 'by hand', font: 'Caveat Variable', size: 0.14, weight: 600 } },
  {
    name: 'Typewriter',
    sample: 'typing…',
    style: { fontFamily: 'JetBrains Mono Variable', fontSize: 14 },
    text: { content: 'Typing this out…', font: 'JetBrains Mono Variable', size: 0.06, weight: 500, animIn: { type: 'typewriter', duration: 45 } },
  },
];

const SHAPES: { kind: ShapeKind; label: string; path: string }[] = [
  { kind: 'rect', label: 'Rectangle', path: 'M4 6h16v12H4z' },
  { kind: 'ellipse', label: 'Ellipse', path: 'M12 5a8 7 0 1 0 0 14 8 7 0 0 0 0-14z' },
  { kind: 'triangle', label: 'Triangle', path: 'M12 4l9 16H3z' },
  { kind: 'star', label: 'Star', path: 'M12 3l2.6 5.800 6.400.600-4.800 4.300 1.400 6.300L12 16.800 6.400 20l1.400-6.300L3 9.400l6.400-.6z' },
  { kind: 'polygon', label: 'Polygon', path: 'M12 3l8.500 6.200-3.200 10H6.700L3.500 9.200z' },
  { kind: 'line', label: 'Line', path: 'M3 12h18' },
  { kind: 'arrow', label: 'Arrow', path: 'M3 12h17m-6-6 6 6-6 6' },
];

function Titles() {
  return (
    <div className="lib__scroll">
      <div className="lib__heading">Text</div>
      <div className="presets">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="preset"
            {...tip(`${p.name} — click to add, or drag to the timeline`)}
            onPointerDown={(e) => {
              hideTip();
              beginDrag(e, { kind: 'text', text: p.text }, p.name, () => cmd.addText(p.text, p.y ? { y: p.y } : {}));
            }}
          >
            <span style={p.style}>{p.sample}</span>
          </button>
        ))}
      </div>
      <div className="lib__heading">Shapes</div>
      <div className="shapes">
        {SHAPES.map((s) => (
          <button
            key={s.kind}
            className="shape"
            aria-label={s.label}
            {...tip(s.label)}
            onPointerDown={(e) => {
              hideTip();
              const shape = { kind: s.kind, ...(s.kind === 'line' || s.kind === 'arrow' ? { w: 0.4, h: 0.08, strokeWidth: 0.008, stroke: '#ffffff' } : s.kind === 'rect' ? { w: 0.4, h: 0.3 } : { w: 0.25, h: 0.444 }) };
              beginDrag(e, { kind: 'shape', shape }, s.label, () => cmd.addShape(shape));
            }}
          >
            <svg viewBox="0 0 24 24" fill={s.kind === 'line' || s.kind === 'arrow' ? 'none' : 'currentColor'} stroke="currentColor" strokeWidth={s.kind === 'line' || s.kind === 'arrow' ? 2 : 0} strokeLinecap="round" strokeLinejoin="round">
              <path d={s.path} />
            </svg>
          </button>
        ))}
      </div>
      <div className="lib__heading">Generators</div>
      <div className="gens">
        <button className="gen" onPointerDown={(e) => beginDrag(e, { kind: 'generator', type: 'solid' }, 'Solid colour', () => cmd.addSolid())}>
          <Square />
          <div>
            <b>Solid colour</b>
            <span>A flat or gradient background</span>
          </div>
        </button>
        <button className="gen" onPointerDown={(e) => beginDrag(e, { kind: 'generator', type: 'adjustment' }, 'Adjustment layer', () => cmd.addAdjustment())}>
          <Layers />
          <div>
            <b>Adjustment layer</b>
            <span>Grade or add effects to everything below</span>
          </div>
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── effects ──

function useSearch<T extends { name: string; description: string }>(items: T[], query: string): T[] {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : items;
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
          <input placeholder={`Search ${EFFECTS.length} effects`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Search effects" />
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
      <div className="fx-grid">
        {list.map((e) => (
          <button
            key={e.id}
            className="fx"
            {...tip(e.description)}
            onPointerDown={(ev) => {
              hideTip();
              beginDrag(ev, { kind: 'effect', type: e.id }, e.name, () => cmd.applyEffect(e.id));
            }}
          >
            <FxThumb kind="effect" id={e.id} />
            <span>{e.name}</span>
          </button>
        ))}
        {list.length === 0 && <div className="lib__none">No effects match.</div>}
      </div>
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
          <input placeholder={`Search ${TRANSITIONS.length} transitions`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Search transitions" />
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
      <div className="fx-grid">
        {list.map((t) => (
          <button
            key={t.id}
            className="fx"
            {...tip(`${t.description} Drag onto a cut.`)}
            onPointerDown={(ev) => {
              hideTip();
              beginDrag(ev, { kind: 'transition', type: t.id }, t.name, () => cmd.applyTransition(t.id));
            }}
          >
            <FxThumb kind="transition" id={t.id} />
            <span>{t.name}</span>
          </button>
        ))}
        {list.length === 0 && <div className="lib__none">No transitions match.</div>}
      </div>
    </div>
  );
}


