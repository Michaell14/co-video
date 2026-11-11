import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import type { PointerEvent, ReactNode } from 'react';
import './Button.css';

interface ButtonProps {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  size?: 'md' | 'lg';
  /** Opens in a new tab with a safe `rel`. */
  external?: boolean;
  className?: string;
}

const SPRING = { stiffness: 260, damping: 18, mass: 0.6 };

/**
 * Link styled as a button. On fine pointers it is gently magnetic: the button leans toward the
 * cursor and its label leans a little further, then both spring back.
 */
export function Button({
  href,
  children,
  variant = 'primary',
  size = 'md',
  external,
  className,
}: ButtonProps) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, SPRING);
  const sy = useSpring(y, SPRING);
  const labelX = useTransform(sx, (v) => v * 0.35);
  const labelY = useTransform(sy, (v) => v * 0.35);

  const onPointerMove = (e: PointerEvent<HTMLAnchorElement>) => {
    if (reduced || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * 0.22);
    y.set((e.clientY - (r.top + r.height / 2)) * 0.3);
  };
  const reset = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.a
      href={href}
      className={['btn', `btn--${variant}`, `btn--${size}`, className].filter(Boolean).join(' ')}
      style={{ x: sx, y: sy }}
      whileTap={{ scale: 0.96 }}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
    >
      <motion.span className="btn__label" style={{ x: labelX, y: labelY }}>
        {children}
      </motion.span>
    </motion.a>
  );
}
