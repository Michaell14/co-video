import { motion } from 'motion/react';
import type { ReactNode } from 'react';

interface RevealProps {
  children: ReactNode;
  /** Seconds to wait after entering the viewport; use for staggering siblings. */
  delay?: number;
  /** Starting vertical offset in pixels. */
  y?: number;
  className?: string;
  as?: 'div' | 'li' | 'p' | 'span';
}

const EASE = [0.16, 1, 0.3, 1] as const;

/** Fade-and-rise on first scroll into view. Reduced-motion users get the fade only (MotionConfig). */
export function Reveal({ children, delay = 0, y = 28, className, as = 'div' }: RevealProps) {
  const Tag = motion[as];
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </Tag>
  );
}
