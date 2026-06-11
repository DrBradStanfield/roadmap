/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Short git SHA, injected by the vite configs' `define`. */
  readonly VITE_GIT_HASH?: string;
  /** "true" on the local-first builds (Pages + Shopify v2); undefined otherwise. */
  readonly VITE_LOCAL_FIRST?: string;
  /** "true" ONLY on the Shopify v2 (drstanfield.com) build — gates features
   *  that need Brad's server via the app proxy (guest report email). */
  readonly VITE_SHOPIFY_SURFACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
