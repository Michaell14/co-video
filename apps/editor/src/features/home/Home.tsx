import {
  Clock,
  Copy,
  FileUp,
  Film,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  canEdit,
  describeFps,
  FRAME_RATE_PRESETS,
  formatClock,
  RESOLUTION_PRESETS,
  type ProjectSettings,
} from '@tandem/core';
import { Logo, navigate } from '../../App';
import { serverAvailable } from '../../session/api';
import { getUser, registry, setUser, type ProjectEntry } from '../../session/registry';
import { createProject, deleteLocalProject } from '../../session/projects';
import { confirm } from '../../ui/confirm';
import {
  Button,
  Dialog,
  MenuButton,
  NumberField,
  openContextMenu,
  Select,
  TextField,
  toast,
  type MenuEntry,
} from '../../ui/core';
import { duplicateProject, projectFromFile, renameProject } from './manage';
import './home.css';

const STARTERS: {
  label: string;
  hint: string;
  w: number;
  h: number;
  fps: [number, number];
  aspect: string;
}[] = [
  { label: 'Landscape', hint: '1920 × 1080 · 30 fps', w: 1920, h: 1080, fps: [30, 1], aspect: '16 / 9' },
  { label: 'Vertical', hint: '1080 × 1920 · 30 fps', w: 1080, h: 1920, fps: [30, 1], aspect: '9 / 16' },
  { label: '4K UHD', hint: '3840 × 2160 · 24 fps', w: 3840, h: 2160, fps: [24, 1], aspect: '16 / 9' },
  { label: 'Square', hint: '1080 × 1080 · 30 fps', w: 1080, h: 1080, fps: [30, 1], aspect: '1 / 1' },
];

function timeAgo(t: number): string {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

export function Home() {
  const projects = useSyncExternalStore(registry.subscribe, registry.snapshot);
  const sorted = useMemo(() => projects.slice().sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [custom, setCustom] = useState(false);
  const [join, setJoin] = useState(false);
  const [name, setName] = useState(() => getUser().name);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Tandem';
    void serverAvailable(true).then(setOnline);
    // Warm the editor bundle while the user decides what to open, so opening a project is instant.
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 600));
    idle(() => void import('../editor/Editor'));
  }, []);

  const create = async (settings: Partial<ProjectSettings>) => {
    if (creating) return;
    setCreating(true);
    try {
      const id = await createProject({ name: 'Untitled project', ...settings });
      navigate(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the project', 'error');
      setCreating(false);
    }
  };

  const openFile = async (file: File) => {
    if (creating) return;
    setCreating(true);
    try {
      const made = await projectFromFile(file);
      if (!made) {
        toast('That is not a Tandem project file.', 'error');
        setCreating(false);
        return;
      }
      navigate(made.id);
      const opened = `Opened “${made.project.settings.name}” as a new project.`;
      toast(
        Object.keys(made.project.assets).length
          ? `${opened} A project file does not carry media: relink each file from its menu in the media pool.`
          : opened,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not open the project file', 'error');
      setCreating(false);
    }
  };

  return (
    <div className="home">
      <header className="home__bar">
        <div className="home__brand">
          <Logo size={26} />
          <span>Tandem</span>
        </div>
        <div className="home__status" data-online={online === true}>
          {online === null ? <span className="spinner" /> : online ? <Wifi /> : <WifiOff />}
          {online === null
            ? 'Checking server'
            : online
              ? 'Collaboration server connected'
              : 'Working offline — projects stay on this device'}
        </div>
        <div className="home__me">
          <span>You are</span>
          <TextField
            value={name}
            onChange={setName}
            ariaLabel="Display name"
            onBlur={() => {
              const u = getUser();
              const next = name.trim() || u.name;
              setUser({ ...u, name: next });
              setName(next);
            }}
            style={{ width: 150 }}
          />
        </div>
      </header>

      <main className="home__main">
        <section className="home__hero">
          <h1>
            Start cutting<span className="home__dot">.</span>
          </h1>
          <p>
            Pick a canvas. Invite people when you are ready — everything syncs live, and exports render right
            here in your browser.
          </p>
        </section>

        <section className="home__starters" aria-label="New project">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              className="starter"
              disabled={creating}
              onClick={() => create({ width: s.w, height: s.h, fpsNum: s.fps[0], fpsDen: s.fps[1] })}
            >
              <div className="starter__frame">
                <div className="starter__shape" style={{ aspectRatio: s.aspect }}>
                  <Plus />
                </div>
              </div>
              <div className="starter__label">{s.label}</div>
              <div className="starter__hint mono">{s.hint}</div>
            </button>
          ))}
          <div className="home__side">
            <Button icon={<Film />} onClick={() => setCustom(true)} disabled={creating}>
              Custom project…
            </Button>
            <Button icon={<FileUp />} onClick={() => fileInput.current?.click()} disabled={creating}>
              Open project file…
            </Button>
            <Button icon={<Users />} onClick={() => setJoin(true)}>
              Join with a link…
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".tandem,application/json"
              aria-label="Project file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Choosing the same file again has to count as a choice.
                e.target.value = '';
                if (file) void openFile(file);
              }}
            />
          </div>
        </section>

        <section className="home__recent">
          <h2>Recent projects {sorted.length > 0 && <span className="badge">{sorted.length}</span>}</h2>
          {sorted.length === 0 ? (
            <div className="home__empty">
              <FolderOpen />
              <b>No projects yet</b>
              Create one above. Projects are saved automatically in this browser.
            </div>
          ) : (
            <div className="home__grid">
              {sorted.map((p, i) => (
                <ProjectCard key={p.id} project={p} index={i} />
              ))}
            </div>
          )}
        </section>
      </main>

      {custom && <CustomProjectDialog onClose={() => setCustom(false)} onCreate={create} busy={creating} />}
      {join && <JoinDialog onClose={() => setJoin(false)} />}
    </div>
  );
}

function ProjectCard({ project: p, index }: { project: ProjectEntry; index: number }) {
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    toast(`Duplicating “${p.name}”…`);
    try {
      await duplicateProject(p);
      toast(
        p.token
          ? `Duplicated “${p.name}”. Media that was never downloaded to this device shows as offline in the copy.`
          : `Duplicated “${p.name}”.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not duplicate the project', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const sure = await confirm({
      title: `Delete “${p.name}” from this device?`,
      message: p.token
        ? 'The project and the media stored for it on this device are deleted. The shared copy on the server stays, but this device forgets its link to it: you need a share link to open it again.'
        : 'The project and its media are deleted from this device. It exists nowhere else, so this cannot be undone.',
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (sure) void deleteLocalProject(p.id);
  };

  // Only someone who may edit a shared project can rename it; the server would undo anyone else's.
  const mayRename = !p.token || !p.role || canEdit(p.role);
  const items: MenuEntry[] = [
    { label: 'Open', icon: <FolderOpen />, onSelect: () => navigate(p.id) },
    { label: 'Rename…', icon: <Pencil />, disabled: !mayRename, onSelect: () => setRenaming(true) },
    { label: 'Duplicate', icon: <Copy />, disabled: busy, onSelect: () => void duplicate() },
    'separator',
    { label: 'Delete from this device…', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
  ];

  return (
    <div
      className="pcard"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      aria-busy={busy}
      onContextMenu={(e) => {
        // The card's own menu and its rename dialog are drawn elsewhere on the page, yet their
        // events arrive here too: a right-click in those is not one on the card.
        if (e.currentTarget.contains(e.target as Node)) openContextMenu(e, items);
      }}
    >
      <button className="pcard__open" onClick={() => navigate(p.id)} aria-label={`Open ${p.name}`}>
        <div className="pcard__thumb">
          {p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : <Film />}
          {p.token && (
            <span className="pcard__shared badge badge--accent">
              <Users size={10} /> Shared
            </span>
          )}
          {p.duration > 0 && <span className="pcard__dur mono">{formatClock(p.duration)}</span>}
        </div>
        <div className="pcard__name">{p.name}</div>
        <div className="pcard__meta">
          <Clock size={11} /> {timeAgo(p.updatedAt)}
          <span className="mono">
            {p.width}×{p.height} · {Number.isInteger(p.fps) ? p.fps : p.fps.toFixed(2)}
          </span>
        </div>
      </button>
      <MenuButton
        className="icon-btn icon-btn--sm pcard__menu"
        label={`Options for ${p.name}`}
        align="end"
        items={items}
      >
        <MoreHorizontal />
      </MenuButton>
      {renaming && <RenameDialog project={p} onClose={() => setRenaming(false)} />}
    </div>
  );
}

function RenameDialog({ project, onClose }: { project: ProjectEntry; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  // Typing replaces the old name; the arrow keys keep it to be corrected.
  useEffect(() => field.current?.querySelector('input')?.select(), []);

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await renameProject(project, name);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not rename the project', 'error');
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Rename project"
      narrow
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            Rename
          </Button>
        </>
      }
    >
      <div ref={field}>
        <TextField
          value={name}
          onChange={setName}
          autoFocus
          ariaLabel="Project name"
          onEnter={() => void save()}
          style={{ height: 32 }}
        />
      </div>
    </Dialog>
  );
}

function CustomProjectDialog({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (s: Partial<ProjectSettings>) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('Untitled project');
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState('30');
  const [color, setColor] = useState<ProjectSettings['colorMode']>('sdr');
  const preset = RESOLUTION_PRESETS.find((r) => r.width === width && r.height === height);
  const rate = FRAME_RATE_PRESETS.find((f) => f.label === fps) ?? FRAME_RATE_PRESETS[4];
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              onCreate({
                name: name.trim() || 'Untitled project',
                width: Math.round(width / 2) * 2,
                height: Math.round(height / 2) * 2,
                fpsNum: rate.fpsNum,
                fpsDen: rate.fpsDen,
                colorMode: color,
                toneMap: color === 'sdr' ? 'none' : 'bt2390',
              })
            }
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="form">
        <label className="form__row">
          <span>Name</span>
          <TextField value={name} onChange={setName} autoFocus />
        </label>
        <div className="form__row">
          <span>Resolution</span>
          <Select
            value={preset ? `${preset.width}x${preset.height}` : 'custom'}
            options={[
              ...RESOLUTION_PRESETS.map((r) => ({
                value: `${r.width}x${r.height}`,
                label: `${r.label} — ${r.width} × ${r.height}`,
                group: r.group,
              })),
              { value: 'custom', label: 'Custom', group: 'Other' },
            ]}
            onChange={(v) => {
              const r = RESOLUTION_PRESETS.find((x) => `${x.width}x${x.height}` === v);
              if (r) {
                setWidth(r.width);
                setHeight(r.height);
              }
            }}
          />
        </div>
        <div className="form__row">
          <span>Size</span>
          <div className="form__pair">
            <NumberField
              value={width}
              onChange={(v) => setWidth(Math.round(v))}
              min={16}
              max={8192}
              suffix="px"
              prefix="W"
            />
            <NumberField
              value={height}
              onChange={(v) => setHeight(Math.round(v))}
              min={16}
              max={8192}
              suffix="px"
              prefix="H"
            />
          </div>
        </div>
        <div className="form__row">
          <span>Frame rate</span>
          <Select
            value={fps}
            options={FRAME_RATE_PRESETS.map((f) => ({ value: f.label, label: `${describeFps(f)} fps` }))}
            onChange={setFps}
          />
        </div>
        <div className="form__row">
          <span>Colour</span>
          <Select
            value={color}
            options={[
              { value: 'sdr', label: 'SDR — Rec.709' },
              { value: 'hdr-pq', label: 'HDR — Rec.2100 PQ (HDR10)' },
              { value: 'hdr-hlg', label: 'HDR — Rec.2100 HLG' },
            ]}
            onChange={setColor}
          />
        </div>
        <p className="form__hint">
          Everything is resolution independent, so you can change any of this later without re-doing your
          edit.
        </p>
      </div>
    </Dialog>
  );
}

function JoinDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('');
  const go = () => {
    const m = /#\/p\/([A-Za-z0-9_-]+)(\?.*)?$/.exec(link.trim());
    if (!m) {
      toast('That does not look like a Tandem share link.', 'error');
      return;
    }
    location.hash = `#/p/${m[1]}${m[2] ?? ''}`;
  };
  return (
    <Dialog
      title="Join a project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={go} disabled={!link.trim()}>
            Join
          </Button>
        </>
      }
    >
      <div className="form">
        <p className="form__hint" style={{ marginTop: 0 }}>
          Paste the link someone shared with you. The link itself carries your access level — treat it like a
          key.
        </p>
        <TextField
          value={link}
          onChange={setLink}
          placeholder="https://…/app/#/p/…"
          autoFocus
          onEnter={go}
          ariaLabel="Share link"
          style={{ height: 32 }}
        />
      </div>
    </Dialog>
  );
}
