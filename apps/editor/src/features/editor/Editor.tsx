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
        revealEffects: [],
        poolSelection: [],
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
        <div className="splash__title">{error}</div>
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
        <div className="splash__title">This project is not available</div>
        <p className="splash__text">
          {meta.unlisted ? (
            <>
              The collaboration server no longer accepts the link to it, and nothing of it is stored on this
              device.
              <br />
              It has been removed from your projects.
            </>
          ) : (
            'It is not stored on this device, and the link either expired or the collaboration server cannot be reached.'
          )}
        </p>
        {!meta.online && <div className="splash__label">Still trying to reach the server…</div>}
        <div className="splash__actions">
          {/* Every opening asks the server about the link again: a link that was refused for a
              while, or a server that was away, may answer differently now. */}
          {!meta.unlisted && (
            <Button variant="primary" onClick={() => session.onReload()}>
              Try again
            </Button>
          )}
          <Button onClick={() => navigate(null)}>Back to projects</Button>
        </div>
      </div>
    );
  }

  if (meta.busy && !meta.synced && session.store.isEmpty()) {
    return (
      <div className="splash">
        <div className="splash__title">Waiting for a place in this project</div>
        <p className="splash__text">
          Your link is fine, but the collaboration server is at capacity right now. This page joins by itself
          as soon as there is room.
        </p>
        <div className="splash__label">
          <span className="spinner" />
          Still trying
        </div>
        <Button onClick={() => navigate(null)}>Back to projects</Button>
      </div>
    );
  }

  // A shared project of which nothing is on this device yet is on its way from the server: on
  // first opening its link, and after a copy the server would not take has been thrown away. The
  // document it will arrive in is not the project. Shown as an editor it says that the timeline is
  // empty, and whatever was put into it would be merged into the project as that arrives.
  if (meta.shared && !meta.synced && session.store.isEmpty()) return <Splash label="Opening project" />;

  const closeDialog = () => set({ dialog: null });
  const layout = fitPanels(
    { leftWidth: left, rightWidth: right, timelineHeight: tlHeight, commentsOpen: comments, workspace },
    viewport,
  );
  const commentsColumn = layout.comments === 'column';
  // What each splitter sizes, by the name of the panel that stands there.
  const leftPanel = layout.comments === 'left' ? 'Comments' : workspace === 'color' ? 'Scopes' : 'Library';
  const rightPanel =
    layout.comments === 'right'
      ? 'Comments'
      : workspace === 'color'
        ? 'Colour'
        : workspace === 'audio'
          ? 'Mixer'
          : 'Inspector';

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
          <Resizer
            axis="x"
            label={`${leftPanel} width`}
            size={layout.left}
            limits={layout.limits.left}
            grows={1}
            onDrag={(d) => dragPanel('left', d)}
            style={{ left: layout.left }}
          />
          <section className="panel panel--viewer" aria-label="Viewer">
            <Viewer />
          </section>
          <Resizer
            axis="x"
            label={`${rightPanel} width`}
            size={layout.right}
            limits={layout.limits.right}
            grows={-1}
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
        <Resizer
          axis="y"
          label="Timeline height"
          size={layout.timeline}
          limits={layout.limits.timeline}
          grows={-1}
          onDrag={(d) => -dragPanel('timeline', -d)}
        />
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

/** How far one press of an arrow key moves a splitter, in pixels; ten times as far with Shift. */
const SPLITTER_STEP = 16;

function Resizer({
  axis,
  label,
  size,
  limits,
  grows,
  onDrag,
  style,
}: {
  axis: 'x' | 'y';
  label: string;
  /** The size of the panel the splitter sizes, and how small and large it can be in this window. */
  size: number;
  limits: { min: number; max: number };
  /** Whether the panel grows (1) or shrinks (-1) as the splitter moves right or down. */
  grows: 1 | -1;
  /** Moves the panel edge by up to `delta` pixels and returns how far it went. */
  onDrag: (delta: number) => number;
  style?: React.CSSProperties;
}) {
  const last = useRef(0);
  const [active, setActive] = useState(false);
  /**
   * The distance a key moves the splitter. The arrows along its axis move it a step, Page Up and
   * Page Down change the panel by a tenth of its range, Home and End make it as small and as
   * large as it goes: the keys of a slider, on the size of the panel.
   */
  const keyed = (key: string, shift: boolean): number | undefined => {
    const [back, on] = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const step = SPLITTER_STEP * (shift ? 10 : 1);
    const page = (limits.max - limits.min) / 10;
    const all = limits.max - limits.min;
    switch (key) {
      case back:
        return -step;
      case on:
        return step;
      case 'PageUp':
        return grows * page;
      case 'PageDown':
        return -grows * page;
      case 'Home':
        return -grows * all;
      case 'End':
        return grows * all;
      default:
        return undefined;
    }
  };
  return (
    <div
      className={`resizer resizer--${axis}`}
      data-active={active}
      style={style}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={Math.round(size)}
      aria-valuetext={`${Math.round(size)} pixels`}
      onMouseDown={(e) => {
        // A drag does not leave the keyboard on the splitter, where the arrow keys would go on
        // sizing the panel for someone who means them for the playhead. Focus goes where a press
        // on any other gap between panels would send it: nowhere.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const delta = keyed(e.key, e.shiftKey);
        if (delta === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        onDrag(delta);
      }}
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
