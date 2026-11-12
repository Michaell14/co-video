import {
  Camera,
  Download,
  FileDown,
  FileUp,
  FolderInput,
  History,
  Keyboard,
  ListOrdered,
  LogOut,
  Menu,
  MessageSquare,
  Palette,
  Redo2,
  Replace,
  Scissors,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Subtitles,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { describeSettings, initials } from '@tandem/core';
import { Logo, navigate } from '../../App';
import {
  useComments,
  usePeers,
  useProject,
  useSession,
  useSessionMeta,
  useUndoState,
} from '../../session/hooks';
import { cmd } from '../../state/commands';
import { useUI } from '../../state/ui';
import { Button, IconButton, MenuButton, Segmented, tip } from '../../ui/core';

export function TopBar() {
  const session = useSession();
  const meta = useSessionMeta();
  const settings = useProject((p) => p.settings);
  const { canUndo, canRedo } = useUndoState();
  const workspace = useUI((s) => s.workspace);
  const commentsOpen = useUI((s) => s.commentsOpen);
  const set = useUI((s) => s.set);
  const comments = useComments();
  const open = comments.filter((c) => !c.resolved).length;
  const [name, setName] = useState(settings.name);
  // Escape leaves the name field by blurring it, and that blur must not store what was typed.
  const abandonName = useRef(false);

  useEffect(() => {
    setName(settings.name);
    document.title = `${settings.name} — Tandem`;
  }, [settings.name]);

  const status = !meta.shared ? 'local' : !session.canEdit ? 'readonly' : meta.status;
  // Edits reach the others at once, media only when its upload is through: say which it is.
  const media = useUploads();
  const uploads = status === 'connected' ? media : 'done';
  const statusLabel =
    status === 'local'
      ? 'Saved on this device'
      : status === 'readonly'
        ? meta.role === 'commenter'
          ? 'Comment-only access'
          : 'View-only access'
        : status === 'connected'
          ? uploads === 'stopped'
            ? 'Media not uploaded'
            : uploads === 'running'
              ? 'Uploading media…'
              : 'All changes synced'
          : status === 'connecting'
            ? 'Reconnecting…'
            : 'Offline — changes will sync';
  const statusTip =
    uploads === 'stopped'
      ? 'Your edits are synced, but some media has not reached the server. The media pool marks the files; click a mark to try again.'
      : uploads === 'running'
        ? 'Your edits are synced. Collaborators see the media as soon as its upload is through.'
        : statusLabel;

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button
          className="topbar__home"
          onClick={() => navigate(null)}
          {...tip('All projects')}
          aria-label="All projects"
        >
          <Logo size={22} />
        </button>
        <MenuButton
          className="icon-btn"
          label="Menu"
          items={[
            { heading: 'File' },
            {
              label: 'Import media…',
              icon: <FolderInput />,
              keys: 'mod+i',
              onSelect: () => void cmd.importMedia(),
            },
            {
              label: 'Export…',
              icon: <Download />,
              keys: 'mod+e',
              onSelect: () => set({ dialog: 'export' }),
            },
            {
              label: 'Export frame as PNG',
              icon: <Camera />,
              keys: 'mod+shift+e',
              onSelect: () => void cmd.captureStill(),
            },
            { label: 'Export captions (.srt)', icon: <Subtitles />, onSelect: () => cmd.exportSubtitles() },
            { label: 'Export edit list (.edl)', icon: <ListOrdered />, onSelect: () => cmd.exportEdl() },
            'separator',
            {
              label: 'Save project file',
              icon: <FileDown />,
              keys: 'mod+s',
              onSelect: () => cmd.saveProjectFile(),
            },
            {
              label: 'Open project file…',
              icon: <FileUp />,
              keys: 'mod+o',
              onSelect: () => void cmd.openProjectFile(),
            },
            {
              label: 'Replace with project file…',
              icon: <Replace />,
              disabled: !session.canEdit,
              onSelect: () => void cmd.replaceWithProjectFile(),
            },
            { label: 'Version history…', icon: <History />, onSelect: () => set({ dialog: 'versions' }) },
            'separator',
            { label: 'Project settings…', icon: <Settings2 />, onSelect: () => set({ dialog: 'project' }) },
            {
              label: 'Keyboard shortcuts',
              icon: <Keyboard />,
              keys: 'shift+slash',
              onSelect: () => set({ dialog: 'shortcuts' }),
            },
            {
              label: 'Command palette',
              icon: <Search />,
              keys: 'mod+k',
              onSelect: () => set({ dialog: 'palette' }),
            },
            'separator',
            { label: 'Back to projects', icon: <LogOut />, onSelect: () => navigate(null) },
          ]}
        >
          <Menu />
        </MenuButton>
        <input
          className="topbar__name"
          value={name}
          aria-label="Project name"
          spellCheck={false}
          readOnly={!session.canEdit}
          onMouseDown={(e) => {
            // The press that enters the field selects the whole name, as Tab does; presses after it
            // place the caret.
            if (document.activeElement === e.currentTarget) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.select();
          }}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!abandonName.current && next && next !== settings.name) cmd.renameProject(next);
            else setName(settings.name);
            abandonName.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') abandonName.current = true;
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
            e.stopPropagation();
          }}
        />
        <button
          className="topbar__meta mono"
          onClick={() => set({ dialog: 'project' })}
          {...tip('Project settings')}
        >
          {describeSettings(settings)}
          {settings.colorMode !== 'sdr' && (
            <span className="badge badge--amber" style={{ marginLeft: 6 }}>
              HDR
            </span>
          )}
        </button>
        <div className="topbar__sep" />
        <IconButton
          label="Undo"
          keys="mod+z"
          disabled={!canUndo || !session.canEdit}
          onClick={() => cmd.undo()}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label="Redo"
          keys="mod+shift+z"
          disabled={!canRedo || !session.canEdit}
          onClick={() => cmd.redo()}
        >
          <Redo2 />
        </IconButton>
      </div>

      <div className="topbar__center">
        <Segmented
          value={workspace}
          onChange={(v) => set({ workspace: v })}
          options={[
            { value: 'edit', label: 'Edit', icon: <Scissors />, tip: 'Edit workspace', keys: 'shift+1' },
            { value: 'color', label: 'Colour', icon: <Palette />, tip: 'Colour workspace', keys: 'shift+2' },
            {
              value: 'audio',
              label: 'Audio',
              icon: <SlidersHorizontal />,
              tip: 'Audio workspace',
              keys: 'shift+3',
            },
          ]}
        />
      </div>

      <div className="topbar__right">
        <div className="conn" data-status={status} data-uploads={uploads} {...tip(statusTip)}>
          <i />
          <span>{statusLabel}</span>
        </div>
        <Presence />
        <IconButton
          label="Comments"
          keys="shift+c"
          active={commentsOpen}
          onClick={() => set({ commentsOpen: !commentsOpen })}
        >
          <MessageSquare />
          {open > 0 && <span className="dot-count">{open > 9 ? '9+' : open}</span>}
        </IconButton>
        <Button icon={<Share2 />} onClick={() => set({ dialog: 'share' })}>
          Share
        </Button>
        <Button variant="primary" icon={<Download />} onClick={() => set({ dialog: 'export' })}>
          Export
        </Button>
      </div>
    </header>
  );
}

/**
 * Whether media of this project is still on its way to the server: `stopped` when an upload has
 * failed and is waiting to be tried again.
 */
function useUploads(): 'done' | 'running' | 'stopped' {
  const session = useSession();
  const assets = useProject((p) => p.assets);
  return useSyncExternalStore(session.media.subscribe, () => {
    let state: 'done' | 'running' = 'done';
    for (const asset of Object.values(assets)) {
      const held = session.media.get(asset.id);
      if (asset.uploaded || !held.local) continue;
      if (held.transferError) return 'stopped';
      state = 'running';
    }
    return state;
  });
}

function Presence() {
  const session = useSession();
  const meta = useSessionMeta();
  const peers = usePeers();
  const following = useUI((s) => s.following);
  const set = useUI((s) => s.set);
  // One avatar per person even if they have several tabs open.
  const seen = new Set<string>();
  const unique = peers.filter((p) => (seen.has(p.user.id) ? false : (seen.add(p.user.id), true)));
  return (
    <div className="avatars" aria-label="People in this project">
      {unique.slice(0, 6).map((p) => (
        <button
          key={p.clientId}
          className="avatar"
          style={{ background: p.user.color }}
          data-following={following === p.clientId}
          data-playing={p.playing}
          onClick={() => {
            const next = following === p.clientId ? null : p.clientId;
            set({ following: next });
            if (next !== null) session.player?.seek(p.playhead);
          }}
          {...tip(
            following === p.clientId
              ? `Following ${p.user.name} — click to stop`
              : `${p.user.name} · click to follow`,
          )}
        >
          {initials(p.user.name)}
        </button>
      ))}
      {unique.length > 6 && (
        <span className="avatar" style={{ background: 'var(--bg-6)', color: 'var(--fg-1)' }}>
          +{unique.length - 6}
        </span>
      )}
      <button
        className="avatar avatar--me"
        style={{ background: meta.user.color }}
        onClick={() => set({ dialog: 'profile' })}
        {...tip(`${meta.user.name} (you)`)}
      >
        {initials(meta.user.name)}
      </button>
    </div>
  );
}
