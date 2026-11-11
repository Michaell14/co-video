import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Home } from './features/home/Home';
import { ContextMenuLayer, ToastLayer, TooltipLayer } from './ui/core';

const Editor = lazy(() => import('./features/editor/Editor').then((m) => ({ default: m.Editor })));

export interface Route {
  projectId: string | null;
  token: string | null;
}

function parseHash(): Route {
  const m = /^#\/p\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(location.hash);
  if (!m) return { projectId: null, token: null };
  const params = new URLSearchParams(m[2] ?? '');
  return { projectId: m[1], token: params.get('t') };
}

export function navigate(projectId: string | null): void {
  location.hash = projectId ? `#/p/${projectId}` : '#/';
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Never let the browser navigate away to a dropped file, or pinch-zoom the whole UI.
    const stop = (e: DragEvent) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    window.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
      window.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <ErrorBoundary>
      {route.projectId ? (
        <Suspense fallback={<Splash label="Loading editor" />}>
          <Editor key={route.projectId} projectId={route.projectId} token={route.token} />
        </Suspense>
      ) : (
        <Home />
      )}
      <TooltipLayer />
      <ContextMenuLayer />
      <ToastLayer />
    </ErrorBoundary>
  );
}

/**
 * Last line of defence. Project data lives in IndexedDB and on the server, written continuously, so
 * a crash in the interface never costs work — reloading picks up exactly where things were.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error('[tandem] interface crashed', error);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="splash" role="alert">
        <Logo size={40} />
        <div style={{ fontWeight: 600, fontSize: 15 }}>Something went wrong</div>
        <div
          style={{ color: 'var(--fg-3)', maxWidth: 420, textAlign: 'center', lineHeight: 1.5, fontSize: 13 }}
        >
          Your project is safe — every edit is saved as you make it. Reloading will bring you right back.
        </div>
        <code
          style={{
            color: 'var(--fg-4)',
            fontSize: 11,
            maxWidth: 520,
            textAlign: 'center',
            userSelect: 'text',
          }}
        >
          {this.state.error.message.split('\n')[0]}
        </code>
        <button className="btn btn--primary btn--lg" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export function Splash({ label }: { label: string }) {
  return (
    <div className="splash">
      <Logo size={40} />
      <div className="splash__label">
        <span className="spinner" />
        {label}
      </div>
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <path
        d="M17 18.500c0-2.300 2.500-3.700 4.500-2.600l19 11c2 1.200 2 4 0 5.200l-19 11c-2 1.100-4.500-.3-4.500-2.600v-22z"
        fill="#8b7cff"
        fillOpacity=".9"
      />
      <path
        d="M27 21.500c0-2.300 2.500-3.700 4.500-2.600l19 11c2 1.200 2 4 0 5.200l-19 11c-2 1.100-4.500-.3-4.500-2.600v-22z"
        fill="#c6f84f"
      />
    </svg>
  );
}
