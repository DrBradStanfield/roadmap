/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Short git SHA, injected by the vite configs' `define`. */
  readonly VITE_GIT_HASH?: string;
  /** "true" on the local-first builds (Pages + Shopify v2); undefined otherwise. */
  readonly VITE_LOCAL_FIRST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
