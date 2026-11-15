import {
  Clock,
  CloudOff,
  Copy,
  FileUp,
  Film,
  FolderOpen,
  Link2Off,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
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
  Labelled,
  LabelText,
  MenuButton,
  NumberField,
  openContextMenu,
  Select,
  Switch,
  TextField,
  tip,
  toast,
  useBusy,
  type MenuEntry,
} from '../../ui/core';
import { COLOR_MODE_OPTIONS, describeResolution, describeSize } from '../../ui/labels';
import { handFocus, usingKeyboard } from '../../ui/layers';
import { askedToDelete, askToDeleteForEveryone, ownsProject } from './deletion';
import {
  afterDeletedFromServer,
  deleteFromServer,
  duplicateProject,
  projectFromFile,
  renameProject,
} from './manage';
import './home.css';

interface Starter {
  label: string;
  w: number;
  h: number;
  fps: [number, number];
  aspect: string;
}

const STARTERS: Starter[] = [
  { label: 'Landscape', w: 1920, h: 1080, fps: [30, 1], aspect: '16 / 9' },
  { label: 'Vertical', w: 1080, h: 1920, fps: [30, 1], aspect: '9 / 16' },
  { label: '4K UHD', w: 3840, h: 2160, fps: [24, 1], aspect: '16 / 9' },
  { label: 'Square', w: 1080, h: 1080, fps: [30, 1], aspect: '1 / 1' },
];

/** What a card with a refused link says when asked: what happened, and where the way back is. */
const REFUSED_LINK =
  'The server did not accept this project’s link. Open the project and choose Share, then Try again.';
/** What the card of a project says whose owner deleted it from the server: there is no way back. */
const DELETED_BY_OWNER =
  'Its owner deleted this project from the collaboration server. This copy stays on this device and is no longer shared.';

/**
 * Where the keyboard goes when a card leaves the list, worked out while the card is still there:
 * to the card that takes its place, to the last one, or to the first way of making a project.
 */
function afterCard(card: HTMLElement): () => HTMLElement | null {
  const grid = card.parentElement;
  const at = grid ? Array.from(grid.children).indexOf(card) : 0;
  return () => {
    const left = grid?.isConnected ? Array.from(grid.querySelectorAll<HTMLElement>('.pcard__open')) : [];
    return left[Math.min(at, left.length - 1)] ?? document.querySelector<HTMLElement>('.starter');
  };
}

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
  const listSaved = useSyncExternalStore(registry.subscribe, registry.saved);
  const sorted = useMemo(() => projects.slice().sort((a, b) => b.updatedAt - a.updatedAt), [projects]);
  const [online, setOnline] = useState<boolean | null>(null);
  // Which of the ways in is making a project, for as long as that takes: a starter by its label,
  // `custom` or `file`. That one is busy; the others are off until it is done.
  const [creating, setCreating] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [join, setJoin] = useState(false);
  const [name, setName] = useState(() => getUser().name);
  const fileInput = useRef<HTMLInputElement>(null);
  // What was chosen inside the editor on the way here has been asked by the project's card as it
  // appeared (see `ProjectCard`), or there is no such card: either way it is not asked later.
  useEffect(() => askToDeleteForEveryone(null), []);

  useEffect(() => {
    document.title = 'Tandem';
    void serverAvailable(true).then(setOnline);
    // Warm the editor bundle while the user decides what to open, so opening a project is instant.
    const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 600));
    idle(() => void import('../editor/Editor'));
  }, []);

  const create = async (by: string, settings: Partial<ProjectSettings>) => {
    if (creating) return;
    setCreating(by);
    try {
      const id = await createProject({ name: 'Untitled project', ...settings });
      navigate(id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the project', 'error');
      setCreating(null);
    }
  };

  const openFile = async (file: File) => {
    if (creating) return;
    setCreating('file');
    try {
      const made = await projectFromFile(file);
      if (!made) {
        toast('That is not a Tandem project file.', 'error');
        setCreating(null);
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
      setCreating(null);
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
            <StarterCard
              key={s.label}
              starter={s}
              busy={creating === s.label}
              disabled={creating !== null && creating !== s.label}
              onCreate={(settings) => void create(s.label, settings)}
            />
          ))}
          <div className="home__side">
            <Button icon={<Film />} onClick={() => setCustom(true)} disabled={creating !== null}>
              Custom project…
            </Button>
            <Button
              icon={<FileUp />}
              onClick={() => fileInput.current?.click()}
              busy={creating === 'file'}
              disabled={creating !== null && creating !== 'file'}
            >
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
          {!listSaved && (
            <p className="callout callout--warn home__notice" role="alert">
              <TriangleAlert />
              This browser has no room left to save the project list. Projects and links added in this tab are
              lost when it closes: delete a project you no longer need.
            </p>
          )}
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

      {custom && (
        <CustomProjectDialog
          onClose={() => setCustom(false)}
          onCreate={(settings) => void create('custom', settings)}
          busy={creating === 'custom'}
        />
      )}
      {join && <JoinDialog onClose={() => setJoin(false)} />}
    </div>
  );
}

/** A ready-made canvas. The whole card is the button that makes a project of it. */
function StarterCard({
  starter: s,
  busy,
  disabled,
  onCreate,
}: {
  starter: Starter;
  busy: boolean;
  disabled: boolean;
  onCreate: (settings: Partial<ProjectSettings>) => void;
}) {
  const press = useBusy(busy, () =>
    onCreate({ width: s.w, height: s.h, fpsNum: s.fps[0], fpsDen: s.fps[1] }),
  );
  return (
    <button className="starter" disabled={disabled} {...press}>
      <div className="starter__frame">
        <div className="starter__shape" style={{ aspectRatio: s.aspect }}>
          {busy ? <span className="spinner" /> : <Plus />}
        </div>
      </div>
      <div className="starter__label">{s.label}</div>
      <div className="starter__hint mono">
        {describeSize(s.w, s.h)} · {describeFps({ fpsNum: s.fps[0], fpsDen: s.fps[1] })} fps
      </div>
    </button>
  );
}

function ProjectCard({ project: p, index }: { project: ProjectEntry; index: number }) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  // Deleting this project for everyone was chosen inside the editor, which was left for this
  // screen: the card asks as it appears, and at no later time (the home screen sees to that).
  // Someone working from the keyboard is put on the card first, so that the question leaves them
  // there when it closes, as it does when it is asked from the card's menu.
  useLayoutEffect(() => {
    if (askedToDelete() !== p.id || !ownsProject(p)) return;
    if (usingKeyboard()) card.current?.querySelector<HTMLElement>('.pcard__open')?.focus();
    setDeleting(true);
  }, []);

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
    if (!sure) return;
    if (card.current) handFocus(card.current, afterCard(card.current));
    void deleteLocalProject(p.id);
  };

  const deletedFromServer = (keepCopy: boolean) => {
    // The dialog goes first, and at once: the keyboard is then back on the card, to be handed on
    // from there when the card goes too.
    flushSync(() => setDeleting(false));
    if (!keepCopy && card.current) handFocus(card.current, afterCard(card.current));
    void afterDeletedFromServer(p, keepCopy);
    toast(
      keepCopy
        ? `Deleted “${p.name}” from the server. The copy on this device is a local project now.`
        : `Deleted “${p.name}” for everyone.`,
      'success',
    );
  };

  // Only someone who may edit a shared project can rename it; the server would undo anyone else's.
  const mayRename = !p.token || !p.role || canEdit(p.role);
  // A project whose link the server turned down is a local one for now, and looks like one. The
  // card says what happened: the way back is inside the project, not here.
  const refused = !p.token && registry.linkAside(p.id) !== null;
  // So does one whose owner deleted it from the server, and for that one there is no way back.
  const unshared = !p.token && !refused && p.deletedByOwner === true;
  const notice = refused ? REFUSED_LINK : unshared ? DELETED_BY_OWNER : null;
  const whatNow = tip(notice);
  const noticeId = useId();
  const items: MenuEntry[] = [
    { label: 'Open', icon: <FolderOpen />, onSelect: () => navigate(p.id) },
    { label: 'Rename…', icon: <Pencil />, disabled: !mayRename, onSelect: () => setRenaming(true) },
    { label: 'Duplicate', icon: <Copy />, disabled: busy, onSelect: () => void duplicate() },
    'separator',
    { label: 'Delete from this device…', icon: <Trash2 />, danger: true, onSelect: () => void remove() },
    // Offered to whoever holds the owner's link. The server asks for it again when it is used.
    ownsProject(p) && {
      label: 'Delete for everyone…',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => setDeleting(true),
    },
  ];

  return (
    <div
      ref={card}
      className="pcard"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      aria-busy={busy}
      onContextMenu={(e) => {
        // The card's own menu and its rename dialog are drawn elsewhere on the page, yet their
        // events arrive here too: a right-click in those is not one on the card.
        if (e.currentTarget.contains(e.target as Node)) openContextMenu(e, items);
      }}
    >
      <button
        className="pcard__open"
        onClick={() => navigate(p.id)}
        aria-label={`Open ${p.name}`}
        aria-describedby={notice ? noticeId : undefined}
        // The pointer asks at the badge; the keyboard can only ask at the card.
        onFocusCapture={notice ? whatNow.onFocusCapture : undefined}
        onBlurCapture={notice ? whatNow.onBlurCapture : undefined}
      >
        <div className="pcard__thumb">
          {p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : <Film />}
          {p.token && (
            <span className="pcard__shared badge badge--accent">
              <Users size={10} /> Shared
            </span>
          )}
          {notice && (
            <span
              className={`${refused ? 'pcard__refused' : 'pcard__unshared'} badge badge--amber`}
              onPointerEnter={whatNow.onPointerEnter}
              onPointerLeave={whatNow.onPointerLeave}
            >
              {refused ? <Link2Off size={10} /> : <CloudOff size={10} />}
              {refused ? ' Link refused' : ' No longer shared'}
              <span className="sr-only" id={noticeId}>
                {notice}
              </span>
            </span>
          )}
          {p.duration > 0 && <span className="pcard__dur mono">{formatClock(p.duration)}</span>}
        </div>
        <div className="pcard__name">{p.name}</div>
        <div className="pcard__meta">
          <Clock size={11} /> {timeAgo(p.updatedAt)}
          <span className="mono">
            {describeSize(p.width, p.height)} · {describeFps({ fpsNum: p.fps, fpsDen: 1 })} fps
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
      {deleting && (
        <DeleteForEveryoneDialog
          project={p}
          onClose={() => setDeleting(false)}
          onDeleted={deletedFromServer}
        />
      )}
    </div>
  );
}

/**
 * Asks the owner of a shared project before it is deleted from the server, says what goes and for
 * whom, and what came of asking the server. `onDeleted` is called once the server has said that
 * the project is gone, with whether this device is to keep its copy.
 */
function DeleteForEveryoneDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: ProjectEntry;
  onClose: () => void;
  onDeleted: (keepCopy: boolean) => void;
}) {
  const [keepCopy, setKeepCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const what = useId();

  const go = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await deleteFromServer(project, keepCopy);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The project could not be deleted.');
      setBusy(false);
      return;
    }
    onDeleted(keepCopy);
  };
  // Once the server has been asked, closing the dialog would not take the request back: it stays
  // until the answer is here, so that what the answer means for this device is done as well.
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog
      title={`Delete “${project.name}” for everyone?`}
      narrow
      describedBy={what}
      onClose={close}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void go()}>
            {busy ? 'Deleting…' : 'Delete for everyone'}
          </Button>
        </>
      }
    >
      <div className="form">
        <p className="dialog__message" id={what}>
          The project is deleted from the collaboration server: the edit, its comments, every saved version
          and every uploaded media file. Every link to it stops working, for you and for everyone you shared
          it with. This cannot be undone.
        </p>
        <p className="dialog__message">
          People who have it open keep what is already on their device, as a local project that is no longer
          shared.
        </p>
        <Labelled className="delete__keep">
          <LabelText>Keep a copy on this device</LabelText>
          <Switch checked={keepCopy} onChange={setKeepCopy} />
        </Labelled>
        <p className="form__hint delete__kept">
          {keepCopy
            ? 'The project stays in your list as a local project. Media that was never downloaded to this device is not in the copy.'
            : 'The project and the media stored for it on this device are deleted as well.'}
        </p>
        {problem && (
          <p className="form__error" role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
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
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()}>
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
            busy={busy}
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
        <Labelled className="form__row">
          <LabelText>Resolution</LabelText>
          <Select
            value={preset ? `${preset.width}x${preset.height}` : 'custom'}
            options={[
              ...RESOLUTION_PRESETS.map((r) => ({
                value: `${r.width}x${r.height}`,
                label: describeResolution(r),
                group: r.group,
              })),
              { value: 'custom', label: `Custom · ${describeSize(width, height)}`, group: 'Other' },
            ]}
            onChange={(v) => {
              const r = RESOLUTION_PRESETS.find((x) => `${x.width}x${x.height}` === v);
              if (r) {
                setWidth(r.width);
                setHeight(r.height);
              }
            }}
          />
        </Labelled>
        <Labelled className="form__row">
          <LabelText>Size</LabelText>
          <div className="form__pair">
            <NumberField
              value={width}
              onChange={(v) => setWidth(Math.round(v))}
              min={16}
              max={8192}
              prefix="W"
            />
            <NumberField
              value={height}
              onChange={(v) => setHeight(Math.round(v))}
              min={16}
              max={8192}
              prefix="H"
            />
          </div>
        </Labelled>
        <Labelled className="form__row">
          <LabelText>Frame rate</LabelText>
          <Select
            value={fps}
            options={FRAME_RATE_PRESETS.map((f) => ({ value: f.label, label: `${describeFps(f)} fps` }))}
            onChange={setFps}
          />
        </Labelled>
        <Labelled className="form__row">
          <LabelText>Colour</LabelText>
          <Select value={color} options={COLOR_MODE_OPTIONS} onChange={setColor} />
        </Labelled>
        <p className="form__hint">
          Everything is resolution independent, so you can change any of this later without redoing your edit.
        </p>
      </div>
    </Dialog>
  );
}

function JoinDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('');
  // Said at the field, where the person is looking, and until the link is changed.
  const [refused, setRefused] = useState(false);
  const problem = useId();
  const go = () => {
    const m = /#\/p\/([A-Za-z0-9_-]+)(\?.*)?$/.exec(link.trim());
    if (!m) {
      setRefused(true);
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
          onChange={(next) => {
            setLink(next);
            setRefused(false);
          }}
          placeholder="https://…/app/#/p/…"
          autoFocus
          onEnter={go}
          ariaLabel="Share link"
          style={{ height: 32 }}
          invalid={refused}
          describedBy={refused ? problem : undefined}
        />
        {refused && (
          <p className="form__error" id={problem} role="alert">
            That does not look like a Tandem share link.
          </p>
        )}
      </div>
    </Dialog>
  );
}
