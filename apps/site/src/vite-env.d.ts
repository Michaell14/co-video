/** Site-specific env. `vite/client` (see tsconfig `types`) declares the base `ImportMetaEnv`. */
interface ImportMetaEnv {
  /** Where the editor app is served, when that is not where src/lib/links.ts expects it. */
  readonly VITE_EDITOR_URL?: string;
}
