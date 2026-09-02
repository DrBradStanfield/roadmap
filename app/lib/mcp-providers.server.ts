/**
 * Dropbox and Google Drive as confidential OAuth clients: the table of what
 * each one needs, and the two legs we walk (US-32, design §1).
 *
 * NOTHING HERE MAY LOG A URL.
 */
import { GOOGLE_AUTHORIZE_URL, GOOGLE_DRIVE_SCOPE, GOOGLE_TOKEN_URL } from '../../packages/health-core/src/drive-rest';
import { DROPBOX_TOKEN_URL } from '../../packages/health-core/src/dropbox-rest';
import { callbackUrl } from './mcp-config.server';

/**
 * The two clouds a hosted connection can hold a record in. The provider is
 * SEALED into every blob (state, code, access, refresh) rather than passed
 * around: `/mcp` receives a bearer token and nothing else, so the token itself
 * has to say which cloud to open. Tampering with it breaks the GCM tag, so a
 * Dropbox connection can never be steered into building a Drive adapter.
 */
export type McpProvider = 'dropbox' | 'google';

export function isProvider(value: unknown): value is McpProvider {
  return value === 'dropbox' || value === 'google';
}

interface ProviderSpec {
  /** What the user sees. */
  label: string;
  /** Where the user revokes us — the real kill switch (design §1). */
  revokeUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  idVar: string;
  secretVar: string;
  /** Whatever that provider needs to issue a refresh token at all. */
  offlineParams: Record<string, string>;
}

/**
 * Reuse the app's EXISTING OAuth clients, which §1 makes mandatory: Dropbox's
 * app-folder scoping and Google's `drive.file` visibility are both tied to the
 * app identity, so a second identity would open an empty folder.
 *
 * Google, `prompt=consent`, and the 100-refresh-token cap. The cap is per
 * account per client id and it is SHARED with the widget, so every token we
 * mint is one the user's own browser connection could later be evicted for.
 * "Only when needed" reduces to "always" here and it is worth saying why:
 * Google issues a refresh token on the FIRST authorization only, and returns
 * none on a re-authorization without `prompt=consent`. A stateless server has
 * nowhere to keep a token, so a connection with no refresh token cannot be
 * made at all — omitting the prompt would simply fail for every user who has
 * ever connected the widget, and then need a second trip through Google with
 * the prompt anyway. So we ask once, and we never mint a SPARE: one token per
 * connection, minted only inside a flow the user just consented to.
 *
 * `include_granted_scopes` is deliberately absent. It would widen the token to
 * scopes granted elsewhere, and `drive.file` alone is the whole point.
 */
const PROVIDERS: Record<McpProvider, ProviderSpec> = {
  dropbox: {
    label: 'Dropbox',
    revokeUrl: 'dropbox.com/account/connected_apps',
    authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: DROPBOX_TOKEN_URL,
    scope: 'files.content.read files.content.write files.metadata.read',
    idVar: 'DROPBOX_APP_KEY',
    secretVar: 'DROPBOX_APP_SECRET',
    offlineParams: { token_access_type: 'offline' },
  },
  google: {
    label: 'Google Drive',
    revokeUrl: 'myaccount.google.com/connections',
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scope: GOOGLE_DRIVE_SCOPE,
    idVar: 'GOOGLE_DRIVE_CLIENT_ID',
    secretVar: 'GOOGLE_DRIVE_SECRET',
    offlineParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export function providerLabel(provider: McpProvider): string {
  return PROVIDERS[provider].label;
}

export function providerRevokeUrl(provider: McpProvider): string {
  return PROVIDERS[provider].revokeUrl;
}

/**
 * A provider with no credentials is not offered. That is the whole feature
 * gate for Google: this code ships with the console work undone, the consent
 * screen shows Dropbox alone, and Brad turns Drive on by setting two Fly
 * secrets rather than by deploying again.
 */
export function providerConfigured(provider: McpProvider): boolean {
  const spec = PROVIDERS[provider];
  return Boolean(process.env[spec.idVar] && process.env[spec.secretVar]);
}

export function availableProviders(): McpProvider[] {
  return (Object.keys(PROVIDERS) as McpProvider[]).filter(providerConfigured);
}

export function providerAuthorizeUrl(provider: McpProvider, state: string): string {
  const spec = PROVIDERS[provider];
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set('client_id', process.env[spec.idVar] ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('scope', spec.scope);
  for (const [key, value] of Object.entries(spec.offlineParams)) url.searchParams.set(key, value);
  url.searchParams.set('state', state);
  return url.toString();
}

async function providerToken(provider: McpProvider, body: URLSearchParams): Promise<Record<string, unknown> | null> {
  const spec = PROVIDERS[provider];
  body.set('client_id', process.env[spec.idVar] ?? '');
  body.set('client_secret', process.env[spec.secretVar] ?? '');
  // A refused connection or the 8-second abort throws, and an uncaught throw
  // here is a 500 at `/mcp` and a callback that never clears its state cookie.
  // Every caller already reads null as "the provider would not answer".
  let res: Response;
  try {
    res = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Exchange the provider's authorization code for the refresh token we seal. */
export async function providerExchange(provider: McpProvider, code: string): Promise<string | null> {
  const json = await providerToken(
    provider,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl() }),
  );
  const refresh = json?.refresh_token;
  return typeof refresh === 'string' && refresh.length > 0 ? refresh : null;
}

/**
 * A short-lived provider access token for ONE tool call. Neither Dropbox nor
 * Google rotates refresh tokens on refresh (verified 2026-09-01) — the whole
 * design rests on that, because we hold no row we could update if they did.
 */
export async function providerAccessToken(provider: McpProvider, refreshToken: string): Promise<string | null> {
  const json = await providerToken(provider, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  const access = json?.access_token;
  return typeof access === 'string' && access.length > 0 ? access : null;
}
