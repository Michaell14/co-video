const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** URL-safe random id. 12 chars ≈ 71 bits, plenty for per-project uniqueness. */
export function newId(size = 12): string {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Longer id used for projects (they double as capability-ish URLs). */
export const newProjectId = (): string => newId(20);
