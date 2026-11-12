import { useEffect, useRef, useState } from 'react';
import { Splash, navigate } from '../../App';
import { SessionContext, setCurrentSession, useSession, useSessionMeta } from '../../session/hooks';
import { Session } from '../../session/session';
import { cmd } from '../../state/commands';
import { handleKey } from '../../state/shortcuts';
import { useUI } from '../../state/ui';
import { Button, cx } from '../../ui/core';
import { ColorPanel } from '../color/ColorPanel';
import { Scopes } from '../color/Scopes';
import { CommentsPanel } from '../collab/Comments';
import { ShareDialog, VersionsDialog, ProfileDialog } from '../collab/Dialogs';
import { ExportDialog } from '../export/ExportDialog';
import { Inspector } from '../inspector/Inspector';
import { ProjectSettingsDialog } from '../inspector/ProjectSettings';
import { Library } from '../library/Library';
import { Mixer } from '../audio/Mixer';
import { CommandPalette, ShortcutsDialog } from '../palette/Palette';
import { Timeline } from '../timeline/Timeline';
import { Viewer } from '../viewer/Viewer';
import {
  COMMENTS_WIDTH,
  fitPanels,
  GAP,
  resizePanel,
  windowSize,
  type Splitter,
  type Viewport,
} from './layout';
import { TopBar } from './TopBar';
import { DragLayer } from '../../ui/dnd';
import './editor.css';

export function Editor({ projectId, token }: { projectId: string; token: string | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the session asks to be opened afresh (it had to throw its local copy away).
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: Session | null = null;
    // Aborting closes the session, whether it is open by then or still opening.
    const closing = new AbortController();
    Session.open(projectId, token, closing.signal)
      .then((s) => {
        if (cancelled) return;
        opened = s;
        s.onReload = () => setReloads((n) => n + 1);
        setCurrentSession(s);
        setSession(s);
        // A small console / automation hook: `tandem.session.store.get()`, `tandem.cmd.split()`, …
        (window as unknown as { tandem?: unknown }).tandem = { session: s, ui: useUI, cmd };
        // Keep capability tokens out of the address bar (and so out of screenshots and history),
        // but not before the server has judged this one: until then the address is the only place
        // it is kept, and a reload or a restored tab has to find it there.
        const hideToken = (): void => history.replaceState(null, '', `#/p/${projectId}`);
        if (s.linkPending) s.onLinkJudged = hideToken;
        else if (token) hideToken();
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open the project');
      });
    return () => {
      cancelled = true;
      cmd.cancelVoiceover();
      useUI.getState().set({
        selection: [],
        selectedTransition: null,
        preview: null,
        dialog: null,
        following: null,
        sourceAsset: null,
        sourceCue: null,
        revealAsset: null,
      });
      if (opened) {
        setCurrentSession(null);
        setSession(null);
      }
      closing.abort();
    };
  }, [projectId, token, reloads]);

  if (error) {
    return (
      <div className="splash">
        <div style={{ fontWeight: 600 }}>{error}</div>
        <Button onClick={() => navigate(null)}>Back to projects</Button>
      </div>
    );
  }
  if (!session) return <Splash label="Opening project" />;
  return (
    <SessionContext.Provider value={session}>
      <Workspace />
    </SessionContext.Provider>
  );
}

function Workspace() {
  const session = useSession();
  const meta = useSessionMeta();
  const workspace = useUI((s) => s.workspace);
  const left = useUI((s) => s.leftWidth);
  const right = useUI((s) => s.rightWidth);
  const tlHeight = useUI((s) => s.timelineHeight);
  const dialog = useUI((s) => s.dialog);
  const comments = useUI((s) => s.commentsOpen);
  const set = useUI((s) => s.set);
  const { viewport, resizing } = useViewport();
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (meta.denied) {
    return (
      <div className="splash">
        <div style={{ fontWeight: 600, fontSize: 15 }}>This project is not available</div>
        <div style={{ color: 'var(--fg-3)', maxWidth: 380, textAlign: 'center', lineHeight: 1.5 }}>
          It is not stored on this device, and the link either expired or the collaboration server cannot be
          reached.
        </div>
        {!meta.online && (
          <div style={{ color: 'var(--fg-3)', fontSize: 12 }}>Still trying to reach the server…</div>
        )}
        <Button onClick={() => navigate(null)}>Back to projects</Button>
      </div>
    );
  }

  if (meta.busy && !meta.synced && session.store.isEmpty()) {
    return (
      <div className="splash">
        <div style={{ fontWeight: 600, fontSize: 15 }}>Waiting for a place in this project</div>
        <div style={{ color: 'var(--fg-3)', maxWidth: 380, textAlign: 'center', lineHeight: 1.5 }}>
          Your link is fine, but the collaboration server is at capacity right now. This page joins by itself
          as soon as there is room.
        </div>
        <div className="splash__label">
          <span className="spinner" />
          Still trying
        </div>
        <Button onClick={() => navigate(null)}>Back to projects</Button>
      </div>
    );
  }

  const closeDialog = () => set({ dialog: null });
  const layout = fitPanels(
    { leftWidth: left, rightWidth: right, timelineHeight: tlHeight, commentsOpen: comments, workspace },
    viewport,
  );
  const commentsColumn = layout.comments === 'column';

  return (
    <div
      className="app"
      data-workspace={workspace}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDropping(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDropping(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void cmd.importFiles(files);
      }}
    >
      <TopBar />
      <div className="work">
        <div
          className="work__top"
          data-resizing={resizing || undefined}
          style={{
            gridTemplateColumns: `${layout.left}px minmax(0, 1fr) ${layout.right}px${commentsColumn ? ` ${COMMENTS_WIDTH}px` : ''}`,
          }}
        >
          {layout.comments !== 'left' && (
            <section className="panel" aria-label={workspace === 'color' ? 'Scopes' : 'Library'}>
              {workspace === 'color' ? <Scopes /> : <Library />}
            </section>
          )}
          <Resizer axis="x" onDrag={(d) => dragPanel('left', d)} style={{ left: layout.left }} />
          <section className="panel panel--viewer" aria-label="Viewer">
            <Viewer />
          </section>
          <Resizer
            axis="x"
            onDrag={(d) => -dragPanel('right', -d)}
            style={{ right: layout.right + (commentsColumn ? COMMENTS_WIDTH + GAP : 0) }}
          />
          {layout.comments !== 'right' && (
            <section className="panel" aria-label="Inspector">
              {workspace === 'color' ? <ColorPanel /> : workspace === 'audio' ? <Mixer /> : <Inspector />}
            </section>
          )}
          {/* One place among the children for every column the comments are drawn in, so that a
              half-written comment is still there when the window or the workspace moves them. */}
          {layout.comments && (
            <section
              className={cx('panel panel--enter', layout.comments === 'left' && 'panel--first')}
              aria-label="Comments"
            >
              <CommentsPanel />
            </section>
          )}
        </div>
        <Resizer axis="y" onDrag={(d) => -dragPanel('timeline', -d)} />
        <section className="panel panel--timeline" style={{ height: layout.timeline }} aria-label="Timeline">
          <Timeline />
        </section>
      </div>

      {dropping && (
        <div className="dropzone">
          <div className="dropzone__card">
            <div className="dropzone__title">Drop to import</div>
            <div>Video, audio, images, .cube LUTs and .srt captions</div>
          </div>
        </div>
      )}
      <DragLayer />
      {dialog === 'export' && <ExportDialog onClose={closeDialog} />}
      {dialog === 'share' && <ShareDialog onClose={closeDialog} />}
      {dialog === 'versions' && <VersionsDialog onClose={closeDialog} />}
      {dialog === 'profile' && <ProfileDialog onClose={closeDialog} />}
      {dialog === 'project' && <ProjectSettingsDialog onClose={closeDialog} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={closeDialog} />}
      {dialog === 'palette' && <CommandPalette onClose={closeDialog} />}
    </div>
  );
}

/** The window's size, and whether it is being resized at the moment. */
function useViewport(): { viewport: Viewport; resizing: boolean } {
  const [state, setState] = useState(() => ({ viewport: windowSize(), resizing: false }));
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      setState({ viewport: windowSize(), resizing: true });
      clearTimeout(settle);
      settle = setTimeout(() => setState((s) => ({ ...s, resizing: false })), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(settle);
    };
  }, []);
  return state;
}

/**
 * A splitter was dragged: keep the sizes that come of it, if it had anywhere to go. Returns how
 * much the panel grew, which is less than asked where it met its limit.
 */
function dragPanel(splitter: Splitter, grow: number): number {
  const ui = useUI.getState();
  const viewport = windowSize();
  const sizes = resizePanel(ui, viewport, splitter, grow);
  if (!sizes) return 0;
  ui.set(sizes);
  return fitPanels(useUI.getState(), viewport)[splitter] - fitPanels(ui, viewport)[splitter];
}

function Resizer({
  axis,
  onDrag,
  style,
}: {
  axis: 'x' | 'y';
  /** Moves the panel edge by up to `delta` pixels and returns how far it went. */
  onDrag: (delta: number) => number;
  style?: React.CSSProperties;
}) {
  const last = useRef(0);
  const [active, setActive] = useState(false);
  return (
    <div
      className={`resizer resizer--${axis}`}
      data-active={active}
      style={style}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = axis === 'x' ? e.clientX : e.clientY;
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (!active) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        // Only the distance the edge really went counts as covered. A pointer that has overshot a
        // limit then has to come all the way back to the splitter before it moves again.
        if (cur !== last.current) last.current += onDrag(cur - last.current);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
      }}
    />
  );
}
