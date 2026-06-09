/**
 * Google Drive OAuth config for the standalone build. The client id is public
 * (it appears in the OAuth URL every user sees); the "Web application" client is
 * restricted by its registered JavaScript origins, not by a secret. No client
 * secret is used — the browser uses the Google Identity Services (GIS) token
 * model. Register the app's origins (e.g. https://drbradstanfield.github.io,
 * http://localhost:5173) in the Google Cloud console's OAuth client.
 */
export const GOOGLE_DRIVE_CLIENT_ID =
  '687809032623-dh4f91ravotu2cdactok13i2eirfadcs.apps.googleusercontent.com';

/**
 * drive.file scope: the app can ONLY see files it created itself — never the
 * rest of the user's Drive. This is the folder-scoped guarantee (impl plan §4.1).
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Brad's stateless token-exchange endpoint (decision record §14) — the only
 * party that can hold the Google client secret. It stores nothing; the refresh
 * token lives in the user's browser. If unreachable, the adapter falls back to
 * the GIS popup path, so this is a soft dependency.
 */
export const GOOGLE_EXCHANGE_URL = 'https://health-tool-app.fly.dev/api/google-token';

export function googleDriveConfig(): {
  clientId: string;
  scope: string;
  redirectUri: string;
  exchangeUrl: string;
} {
  return {
    clientId: GOOGLE_DRIVE_CLIENT_ID,
    scope: GOOGLE_DRIVE_SCOPE,
    // Same convention as Dropbox: this page, origin + path, no query/hash.
    redirectUri: location.origin + location.pathname,
    exchangeUrl: GOOGLE_EXCHANGE_URL,
  };
}
