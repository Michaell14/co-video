import { animate, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

interface CountUpProps {
  to: number;
  /** Starting value; counts down when larger than `to`. */
  from?: number;
  duration?: number;
}

/** Animates a whole number into place the first time it scrolls into view. */
export function CountUp({ to, from = 0, duration = 1.6 }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduced) return;
    const controls = animate(from, to, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [inView, reduced, from, to, duration]);

  // The final value is in the markup from the start, so it is correct without JS-driven motion
  // and for assistive tech; the animation only overwrites the text while it runs.
  return <span ref={ref}>{to}</span>;
}
