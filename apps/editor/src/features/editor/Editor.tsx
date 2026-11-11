import { useEffect, useRef, useState } from 'react';
import { Splash, navigate } from '../../App';
import { SessionContext, setCurrentSession, useSessionMeta } from '../../session/hooks';
import { Session } from '../../session/session';
import { cmd } from '../../state/commands';
import { handleKey } from '../../state/shortcuts';
import { useUI } from '../../state/ui';
import { Button } from '../../ui/core';
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
import { TopBar } from './TopBar';
import { DragLayer } from '../../ui/dnd';
import './editor.css';

export function Editor({ projectId, token }: { projectId: string; token: string | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: Session | null = null;
    Session.open(projectId, token)
      .then((s) => {
        if (cancelled) {
          s.destroy();
          return;
        }
        opened = s;
        setCurrentSession(s);
        setSession(s);
        // Keep capability tokens out of the address bar (and so out of screenshots and history).
        if (token) history.replaceState(null, '', `#/p/${projectId}`);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open the project');
      });
    return () => {
      cancelled = true;
      useUI.getState().set({ selection: [], selectedTransition: null, preview: null, dialog: null, following: null, sourceAsset: null });
      if (opened) {
        setCurrentSession(null);
        opened.destroy();
      }
    };
  }, [projectId, token]);

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
  const meta = useSessionMeta();
  const workspace = useUI((s) => s.workspace);
  const left = useUI((s) => s.leftWidth);
  const right = useUI((s) => s.rightWidth);
  const tlHeight = useUI((s) => s.timelineHeight);
  const dialog = useUI((s) => s.dialog);
  const comments = useUI((s) => s.commentsOpen);
  const set = useUI((s) => s.set);
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
          It is not stored on this device, and the link either expired or the collaboration server cannot be reached.
        </div>
        <Button onClick={() => navigate(null)}>Back to projects</Button>
      </div>
    );
  }

  const closeDialog = () => set({ dialog: null });
  const rightWide = workspace === 'color' ? Math.max(right, 400) : workspace === 'audio' ? Math.max(right, 360) : right;

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
        <div className="work__top" style={{ gridTemplateColumns: `${left}px minmax(0, 1fr) ${rightWide}px${comments ? ' 300px' : ''}` }}>
          <section className="panel" aria-label={workspace === 'color' ? 'Scopes' : 'Library'}>
            {workspace === 'color' ? <Scopes /> : <Library />}
          </section>
          <Resizer axis="x" onDrag={(d) => set({ leftWidth: clampW(useUI.getState().leftWidth + d, 220, 560) })} style={{ left: left }} />
          <section className="panel panel--viewer" aria-label="Viewer">
            <Viewer />
          </section>
          <Resizer axis="x" onDrag={(d) => set({ rightWidth: clampW(useUI.getState().rightWidth - d, 260, 560) })} style={{ right: rightWide + (comments ? 306 : 0) }} />
          <section className="panel" aria-label="Inspector">
            {workspace === 'color' ? <ColorPanel /> : workspace === 'audio' ? <Mixer /> : <Inspector />}
          </section>
          {comments && (
            <section className="panel panel--enter" aria-label="Comments">
              <CommentsPanel />
            </section>
          )}
        </div>
        <Resizer axis="y" onDrag={(d) => set({ timelineHeight: clampW(useUI.getState().timelineHeight - d, 160, Math.max(200, window.innerHeight - 280)) })} />
        <section className="panel panel--timeline" style={{ height: tlHeight }} aria-label="Timeline">
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

const clampW = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function Resizer({ axis, onDrag, style }: { axis: 'x' | 'y'; onDrag: (delta: number) => void; style?: React.CSSProperties }) {
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
        const d = cur - last.current;
        if (d !== 0) {
          last.current = cur;
          onDrag(d);
        }
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setActive(false);
      }}
    />
  );
}
