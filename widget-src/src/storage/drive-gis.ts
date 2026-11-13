/**
 * Google Identity Services, loaded only when Drive's popup fallback runs
 * (US-09 AC30). Moved out of drive.ts unchanged (lead A3 step 2).
 */
import { StorageError } from '@roadmap/health-core/adapter';

// --- GIS (Google Identity Services) popup fallback ---------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  /** The scopes the user actually approved, space-delimited. */
  scope?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}
type Gis = {
  accounts: {
    oauth2: {
      initTokenClient: (cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: unknown) => void;
      }) => TokenClient;
    };
  };
};
export function gis(): Gis | undefined {
  return (window as unknown as { google?: Gis }).google;
}

/** True once the GIS script has loaded, so a popup can open inside the click. */
export function gisReady(): boolean {
  return !!gis()?.accounts?.oauth2;
}

/** Start loading GIS ahead of the click that needs it (US-09 AC30): a script
 *  that loads after the click can outlast its user activation, and the popup is
 *  then blocked. A failure here is retried by the click's own load. */
export function preloadGis(): void {
  loadGis().catch(() => undefined);
}

/** Lazily inject + await the GIS script — loaded only when the fallback runs. */
export function loadGis(): Promise<void> {
  if (gisReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector('script[src*="gsi/client"]')) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      // A script that failed (the network was down) is taken out, so the next
      // load asks again instead of waiting on it forever (US-09 AC30a).
      s.onerror = () => s.remove();
      document.head.appendChild(s);
    }
    const startedAt = Date.now();
    const iv = setInterval(() => {
      if (gis()?.accounts?.oauth2) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - startedAt > 10_000) {
        clearInterval(iv);
        reject(new StorageError('Google sign-in failed to load (check the network / origin allow-list).'));
      }
    }, 50);
  });
}
