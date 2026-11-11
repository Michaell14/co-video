import { useRef } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import './GlowCard.css';

interface GlowCardProps {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'li' | 'article' | 'figure';
}

/** Card with a soft light and a lit border edge that follow the cursor. */
export function GlowCard({ children, className, as: Tag = 'div' }: GlowCardProps) {
  const frame = useRef(0);

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.currentTarget;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${clientX - r.left}px`);
      el.style.setProperty('--my', `${clientY - r.top}px`);
    });
  };

  return (
    <Tag className={['glow-card', className].filter(Boolean).join(' ')} onPointerMove={onPointerMove}>
      {children}
    </Tag>
  );
}
