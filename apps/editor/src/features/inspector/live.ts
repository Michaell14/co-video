/**
 * Reading the project for a property panel. A panel shows a few clips out of thousands, and the
 * project changes with every tick of a drag anywhere in it: these hooks re-render their component
 * only when what it selected has changed.
 */
import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import type { Clip, ID, Project } from '@tandem/core';
import { usePlayer, useSession } from '../../session/hooks';
import { useUI } from '../../state/ui';

/** Tells `notify` of every change to the project as it is shown: commits, and the preview of a drag. */
function useLiveSubscription(): (notify: () => void) => () => void {
  const session = useSession();
  return useCallback(
    (notify: () => void) => {
      const offStore = session.store.subscribe(notify);
      const offPreview = useUI.subscribe((ui, before) => {
        if (ui.preview !== before.preview) notify();
      });
      return () => {
        offStore();
        offPreview();
      };
    },
    [session],
  );
}

/**
 * Select from the project as it is shown, the preview of a drag in progress included. `select`
 * has to return the same reference for unchanged data, as entities of the project themselves are.
 */
export function useLiveSelect<T>(select: (p: Project) => T): T {
  const session = useSession();
  return useSyncExternalStore(useLiveSubscription(), () =>
    select(useUI.getState().preview ?? session.store.get()),
  );
}

/** The clips with these ids that exist, as one array that stays the same while none of them changes. */
export function useLiveClips(ids: readonly ID[]): Clip[] {
  const last = useRef<Clip[]>([]);
  return useLiveSelect((p) => {
    const found: Clip[] = [];
    for (const id of ids) if (p.clips[id]) found.push(p.clips[id]);
    const same = found.length === last.current.length && found.every((c, i) => c === last.current[i]);
    if (!same) last.current = found;
    return last.current;
  });
}

/**
 * Re-render as the playhead moves, at most `hz` times a second while it plays, for as long as
 * `wanted`: only values that are animated change with the playhead.
 */
export function usePlayheadTick(wanted: boolean, hz = 10): void {
  const player = usePlayer();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!player || !wanted) return;
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const off = player.onFrame(() => {
      const now = performance.now();
      clearTimeout(trailing);
      if (!player.getState().playing || now - last > 1000 / hz) {
        last = now;
        tick();
      } else trailing = setTimeout(tick, 1000 / hz);
    });
    return () => {
      off();
      clearTimeout(trailing);
    };
  }, [player, wanted, hz]);
}
