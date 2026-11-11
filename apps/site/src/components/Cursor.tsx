import type { CSSProperties, Ref } from 'react';
import './Cursor.css';

interface CursorProps {
  name: string;
  color: string;
  ref?: Ref<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
  /** Pressed state, for cursors driven by React rather than by a script. */
  down?: boolean;
}

/**
 * A collaborator's pointer with a name tag. The element's top-left corner is the pointer tip;
 * callers move it with `transform` and set `data-down` while the collaborator is pressing.
 */
export function Cursor({ name, color, ref, className, style, down }: CursorProps) {
  return (
    <div
      ref={ref}
      className={['collab-cursor', className].filter(Boolean).join(' ')}
      style={{ ...style, '--cursor-color': color } as CSSProperties}
      data-down={down}
      aria-hidden="true"
    >
      <svg className="collab-cursor__arrow" viewBox="0 0 18 20" fill="none">
        <path
          d="M2.2 1.6 15.6 9.3c.7.4.6 1.4-.2 1.6l-5.2 1.5-2.6 4.9c-.4.7-1.4.6-1.6-.2L1 2.5c-.2-.7.6-1.3 1.2-.9z"
          fill="var(--cursor-color)"
          stroke="rgba(7,7,8,0.65)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="collab-cursor__tag">{name}</span>
    </div>
  );
}
