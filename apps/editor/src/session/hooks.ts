import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Comment, Project } from '@tandem/core';
import type { Player, PlayerState } from '@tandem/engine';
import { useUI } from '../state/ui';
import type { MediaStatus } from './mediaStore';
import type { RemotePeer } from './presence';
import type { Session, SessionMeta } from './session';

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('No open project');
  return s;
}

/** Module-level handle on the open session for code that runs outside React (commands, shortcuts). */
let current: Session | null = null;
export const setCurrentSession = (s: Session | null): void => {
  current = s;
};
export const currentSession = (): Session | null => current;

export function useSessionMeta(): SessionMeta {
  const s = useSession();
  return useSyncExternalStore(s.subscribe, s.getMeta);
}

/** Select from the committed project. `select` should return a stable reference for unchanged data. */
export function useProject<T>(select: (p: Project) => T): T {
  const s = useSession();
  return useSyncExternalStore(s.store.subscribe, () => select(s.store.get()));
}

/** Like `useProject`, but sees the uncommitted drag preview when there is one. */
export function useLiveProject<T>(select: (p: Project) => T): T {
  const s = useSession();
  const preview = useUI((u) => u.preview);
  const committed = useSyncExternalStore(s.store.subscribe, () => s.store.get());
  return select(preview ?? committed);
}

export function useUndoState(): { canUndo: boolean; canRedo: boolean } {
  const s = useSession();
  useSyncExternalStore(s.store.subscribeUndo, () => s.store.undoVersion);
  return { canUndo: s.store.canUndo, canRedo: s.store.canRedo };
}

export function usePlayer(): Player | null {
  return useSessionMeta().player;
}

const IDLE_STATE: PlayerState = {
  playing: false,
  rate: 1,
  loop: false,
  range: null,
  quality: 'auto',
  muted: false,
  volume: 1,
  falseColor: false,
};

export function usePlayerState(): PlayerState {
  const player = usePlayer();
  const subscribe = useCallback((fn: () => void) => (player ? player.subscribe(fn) : () => {}), [player]);
  return useSyncExternalStore(subscribe, () => (player ? player.getState() : IDLE_STATE));
}

/**
 * The current frame as React state. Re-renders on every frame while playing, so use it only in
 * small leaf components (timecode readouts); everything else should use `player.onFrame`.
 */
export function useFrame(): number {
  const player = usePlayer();
  const [frame, setFrame] = useState(() => player?.getFrame() ?? 0);
  useEffect(() => {
    if (!player) return;
    setFrame(Math.floor(player.getFrame()));
    return player.onFrame((f) => setFrame(Math.floor(f)));
  }, [player]);
  return frame;
}

/** The current frame, updated only while paused or at most `hz` times a second while playing. */
export function useThrottledFrame(hz = 8): number {
  const player = usePlayer();
  const [frame, setFrame] = useState(() => Math.floor(player?.getFrame() ?? 0));
  const last = useRef(0);
  useEffect(() => {
    if (!player) return;
    setFrame(Math.floor(player.getFrame()));
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const off = player.onFrame((f) => {
      const now = performance.now();
      clearTimeout(trailing);
      if (!player.getState().playing || now - last.current > 1000 / hz) {
        last.current = now;
        setFrame(Math.floor(f));
      } else trailing = setTimeout(() => setFrame(Math.floor(player.getFrame())), 1000 / hz);
    });
    return () => {
      off();
      clearTimeout(trailing);
    };
  }, [player, hz]);
  return frame;
}

export type { RemotePeer } from './presence';

/** The other people in the project, as `readPresence` made sense of what they announce. */
export function usePeers(): RemotePeer[] {
  const s = useSession();
  return useSyncExternalStore(s.peers.subscribe, s.peers.get);
}

export function useComments(): Comment[] {
  const s = useSession();
  return useSyncExternalStore(s.review.subscribe, s.review.get);
}

export function useMediaStatus(assetId: string): MediaStatus {
  const s = useSession();
  useSyncExternalStore(s.media.subscribe, s.media.getVersion);
  return s.media.get(assetId);
}
