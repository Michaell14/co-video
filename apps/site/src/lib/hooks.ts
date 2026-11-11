import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** True while the element intersects the viewport (plus `rootMargin`). */
function useOnScreen<T extends Element>(ref: RefObject<T | null>, rootMargin = '0px'): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return onScreen;
}

/** Latches to true the first time the element comes near the viewport. */
export function useSeen<T extends Element>(ref: RefObject<T | null>, rootMargin = '300px'): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setSeen(true);
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** False while the tab is in the background. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * Should a continuous loop attached to this element be running?
 * Only when it is on screen and the tab is in the foreground.
 */
export function useLoopActive<T extends Element>(ref: RefObject<T | null>, rootMargin = '80px'): boolean {
  const onScreen = useOnScreen(ref, rootMargin);
  const visible = usePageVisible();
  return onScreen && visible;
}

/**
 * requestAnimationFrame loop that only runs while `active`. `time` is the accumulated *running*
 * time in seconds, so a loop resumes exactly where it paused instead of jumping ahead.
 */
export function useRafLoop(callback: (time: number, dt: number) => void, active: boolean): void {
  const cb = useRef(callback);
  const elapsed = useRef(0);
  useEffect(() => {
    cb.current = callback;
  });
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      elapsed.current += dt;
      cb.current(elapsed.current, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Observed content-box width of an element, in CSS pixels (0 until first measured). */
export function useWidth<T extends Element>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
