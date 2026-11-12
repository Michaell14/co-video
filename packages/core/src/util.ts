export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * A colour from a shared document as `#rrggbb` or `#rrggbbaa` in lower case, or null when it is not
 * a hex colour (`#rgb` is written out in full). Colours end up in style attributes and canvas fill
 * styles, where any other string, a `url(…)` or a megabyte of text, would be acted on by the
 * browser of everyone who has the project open.
 */
export function hexColor(v: unknown): string | null {
  if (typeof v !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return null;
  const hex = v.toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

export const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20));

export const gainToDb = (gain: number): number => (gain <= 0.001 ? -60 : 20 * Math.log10(gain));

/** Memoise a function of one object argument by identity. */
export function memoByRef<K extends object, V>(fn: (k: K) => V): (k: K) => V {
  const cache = new WeakMap<K, V>();
  return (k: K) => {
    let v = cache.get(k);
    if (v === undefined) {
      v = fn(k);
      cache.set(k, v);
    }
    return v;
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
