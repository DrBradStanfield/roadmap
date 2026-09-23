/**
 * US-09 AC15 (Sentry JAVASCRIPT-REMIX-6G, 2026-09-20): a Google grant issued
 * without the Drive box ticked is refused AT CONNECT — before any token is
 * kept — instead of becoming a "connected" record every load answers 403.
 * Google names the approved scopes on both paths: the redirect URL's `scope`
 * and the popup token response's `scope`, so neither check makes a request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveAdapter, DriveGrantRefusedError, DRIVE_FILE_SCOPE } from './drive';

const CONFIG = {
  clientId: 'test-client-id',
  scope: `openid email ${DRIVE_FILE_SCOPE}`,
  redirectUri: 'https://example.com/',
  exchangeUrl: 'https://health-tool-app.fly.dev/api/google-token',
};
const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
const CONFIG_KEY = 'health_roadmap_gdrive';
const PKCE_KEY = 'health_roadmap_gdrive_pkce';
/** What Google appends when the Drive box is left unticked. */
const SCOPELESS = 'openid https://www.googleapis.com/auth/userinfo.email';

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

const exchange = vi.fn(async () =>
  new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }), { status: 200 }),
);
const replaceState = vi.fn();
/** requestAccessToken hands the captured GIS config this token response. */
let popupResponse: Record<string, unknown> = {};
const initTokenClient = vi.fn((cfg: { callback: (r: unknown) => void }) => ({
  requestAccessToken: () => cfg.callback(popupResponse),
}));

/** The page as Google returns it: our PKCE entry in place, `?code` in the URL. */
function returnedFromGoogle(query: string): void {
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier: 'v', state: 's' }));
  vi.stubGlobal('window', {
    location: { search: query },
    history: { replaceState },
    google: { accounts: { oauth2: { initTokenClient } } },
  });
}

describe('GoogleDriveAdapter — a grant without drive.file is refused at connect (US-09 AC15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', makeStorage());
    vi.stubGlobal('sessionStorage', makeStorage());
    vi.stubGlobal('fetch', exchange);
    returnedFromGoogle('');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirect return without drive.file: refused before the exchange, nothing kept, ?code stripped', async () => {
    returnedFromGoogle(`?code=c&state=s&scope=${encodeURIComponent(SCOPELESS)}`);

    await expect(GoogleDriveAdapter.completeRedirect(CONFIG)).rejects.toThrow(DriveGrantRefusedError);
    expect(exchange).not.toHaveBeenCalled(); // no token is minted for a grant that buys nothing
    expect(localStorage.getItem(TOKENS_KEY)).toBeNull();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
    expect(new GoogleDriveAdapter(CONFIG).isConnected()).toBe(false);
    expect(replaceState).toHaveBeenCalledTimes(1); // a refresh must not re-run the flow
  });

  it('redirect return with drive.file: connected, tokens kept', async () => {
    returnedFromGoogle(`?code=c&state=s&scope=${encodeURIComponent(`email openid ${DRIVE_FILE_SCOPE}`)}`);

    const adapter = await GoogleDriveAdapter.completeRedirect(CONFIG);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(adapter!.isConnected()).toBe(true);
    expect(adapter!.hasValidToken()).toBe(true);
  });

  it('redirect return that names no scopes is trusted, as before the check (stated residual)', async () => {
    returnedFromGoogle('?code=c&state=s');

    const adapter = await GoogleDriveAdapter.completeRedirect(CONFIG);
    expect(adapter!.isConnected()).toBe(true);
  });

  it('popup: a token response whose scope lacks drive.file is refused, nothing saved', async () => {
    popupResponse = { access_token: 't', expires_in: 3600, scope: SCOPELESS };

    await expect(new GoogleDriveAdapter(CONFIG).connectViaPopup()).rejects.toThrow(DriveGrantRefusedError);
    expect(localStorage.getItem(TOKENS_KEY)).toBeNull();
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('popup: a token response carrying drive.file connects', async () => {
    popupResponse = { access_token: 't', expires_in: 3600, scope: CONFIG.scope };

    const adapter = new GoogleDriveAdapter(CONFIG);
    await adapter.connectViaPopup();
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.hasValidToken()).toBe(true);
  });

  it('the refusal names the box the user has to tick', () => {
    expect(new DriveGrantRefusedError().message).toMatch(/tick the Google Drive box/);
  });
});
