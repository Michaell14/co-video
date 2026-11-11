import type { CSSProperties } from 'react';
import './Avatar.css';

interface AvatarProps {
  name: string;
  color: string;
  /** Diameter: a number is CSS pixels (the mock editor is laid out in px), a string is any length. */
  size?: number | string;
}

/** Presence avatar: the collaborator's initial on their colour. Decorative; pair with visible text. */
export function Avatar({ name, color, size = 24 }: AvatarProps) {
  return (
    <span
      className="avatar"
      style={
        {
          '--avatar-color': color,
          '--avatar-size': typeof size === 'number' ? `${size}px` : size,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
