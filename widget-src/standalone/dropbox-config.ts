/**
 * Dropbox app config for the standalone (GitHub Pages / self-host) build.
 * The app key is a PKCE client id — public by design (it appears in the OAuth
 * URL every user sees), so it is safe in this public repo.
 *
 * redirectUri must exactly match a URI registered in the Dropbox app console;
 * we derive it from the current page so it works on GitHub Pages, a custom
 * domain, or a self-host origin without per-deploy config (each origin's
 * `/roadmap/` is registered once).
 */
export const DROPBOX_APP_KEY = 'xf96vqvjotm5xhx';

export function dropboxConfig(): { clientId: string; redirectUri: string } {
  return { clientId: DROPBOX_APP_KEY, redirectUri: location.origin + location.pathname };
}
