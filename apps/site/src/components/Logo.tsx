import './Logo.css';

interface LogoMarkProps {
  size?: number | string;
  className?: string;
}

/** The Tandem mark: two overlapping play triangles, violet behind and lime in front. */
export function LogoMark({ size = '1.75rem', className }: LogoMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="#0c0c0e" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" stroke="rgba(255,255,255,0.1)" />
      <path
        d="M17 18.5c0-2.3 2.5-3.7 4.5-2.6l19 11c2 1.2 2 4 0 5.2l-19 11c-2 1.1-4.5-.3-4.5-2.6v-22z"
        fill="#8b7cff"
        fillOpacity="0.9"
      />
      <path
        d="M27 21.5c0-2.3 2.5-3.7 4.5-2.6l19 11c2 1.2 2 4 0 5.2l-19 11c-2 1.1-4.5-.3-4.5-2.6v-22z"
        fill="#c6f84f"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo__word">Tandem</span>
    </span>
  );
}
