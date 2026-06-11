/**
 * Build-surface flags — the ONE place their semantics are documented.
 * Injected by the vite configs' `define`; undefined (→ false) in the
 * production widget build. Full table: CLAUDE.md → "Local-first (v2) builds
 * & build flags".
 *
 * LOCAL_FIRST — true on BOTH local-first builds (Shopify v2 + GitHub Pages):
 * the user's plan lives client-side (their own cloud), so "logged in" is
 * storage UX only, chat sends the plan as context, and legacy login-sync
 * server calls are neutralized.
 *
 * SHOPIFY_SURFACE — true ONLY on the drstanfield.com (Shopify) v2 build,
 * never Pages: gates features that need Brad's server via the app proxy
 * (guest report email, server chat extras). The Pages build has no server.
 */
export const LOCAL_FIRST = import.meta.env.VITE_LOCAL_FIRST === 'true';
export const SHOPIFY_SURFACE = import.meta.env.VITE_SHOPIFY_SURFACE === 'true';
