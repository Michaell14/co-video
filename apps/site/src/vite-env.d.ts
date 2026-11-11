/** Site-specific env. `vite/client` (see tsconfig `types`) declares the base `ImportMetaEnv`. */
interface ImportMetaEnv {
  /** Where the editor app is served. Defaults to `/app/` (same origin). */
  readonly VITE_EDITOR_URL?: string;
}
