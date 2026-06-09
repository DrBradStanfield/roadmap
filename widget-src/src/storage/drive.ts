/**
 * Google Drive storage adapter — the consumer cloud backend (impl plan §4.1,
 * decision record §14).
 *
 * AUTH (hybrid — Brad's call, 2026-06-10):
 *  - PRIMARY: authorization-code flow via a full-page redirect (same UX as
 *    Dropbox). The code/refresh exchange happens on Brad's STATELESS endpoint
 *    (api.google-token.ts) because Google only grants refresh tokens when the
 *    client secret is presented — and a secret can never ship in browser JS.
 *    The endpoint stores nothing; the refresh token lives HERE, in the user's
 *    browser (same posture as Dropbox's). Result: connect once, stay connected.
 *  - FALLBACK: if the endpoint is unreachable (server down / gone dark), a GIS
 *    popup on a user gesture mints a ~1 h access token and sync continues
 *    serverless (connectViaPopup, used by the Reconnect button).
 *
 * SCOPING: drive.file — the app sees ONLY files it created (including raw lab
 * documents later), never the rest of the user's Drive. The record lives as a
 * Drive file named `health-roadmap.json`, discovered by name.
 *
 * CONCURRENCY: Drive v3 has no conditional write (no ETag/sha/rev), so writes
 * are last-write-wins; the SyncManager's read-merge-write makes that safe. The
 * file `version` field is surfaced for change detection.
 */
import type { RoadmapFile } from '@roadmap/health-core';
import {
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';
import { deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce';

export interface GoogleDriveConfig {
  clientId: string;
  scope: string;
  /** Must exactly match a redirect URI registered on the Google OAuth client. */
  redirectUri: string;
  /** Brad's stateless token-exchange endpoint (api.google-token.ts). */
  exchangeUrl: string;
}

const CONFIG_KEY = 'health_roadmap_gdrive';
const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
const PKCE_KEY = 'health_roadmap_gdrive_pkce';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FILE_NAME = 'health-roadmap.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

interface Stored {
  connected: true;
  fileId?: string;
}

interface DriveTokens {
  accessToken: string;
  /** Absent when the token came from the GIS popup fallback. */
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

/** Thrown when no token can be acquired without user interaction. */
export class DriveReauthNeeded extends StorageError {
  constructor(message = 'Google Drive needs to be reconnected.') {
    super(message);
    this.name = 'DriveReauthNeeded';
  }
}

// --- GIS (Google Identity Services) popup fallback ---------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
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
function gis(): Gis | undefined {
  return (window as unknown as { google?: Gis }).google;
}

/** Lazily inject + await the GIS script — loaded only when the fallback runs. */
function loadGis(): Promise<void> {
  if (gis()?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector('script[src*="gsi/client"]')) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
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

/** Drive file name for an uploaded document ref like 'documents/doc_1.pdf'. */
function docName(ref: string): string {
  return `roadmap-${ref.replace(/\//g, '-')}`;
}

export class GoogleDriveAdapter implements StorageAdapter {
  readonly id = 'google-drive' as const;
  readonly label = 'Google Drive';
  private stored: Stored | null;
  private tokens: DriveTokens | null;

  constructor(private readonly config: GoogleDriveConfig) {
    this.stored = getJson<Stored>(CONFIG_KEY);
    this.tokens = getJson<DriveTokens>(TOKENS_KEY);
  }

  isConnected(): boolean {
    return this.stored?.connected === true;
  }

  /** True if the cached access token is still usable as-is. */
  hasValidToken(): boolean {
    return !!this.tokens?.accessToken && Date.now() < this.tokens.expiresAt - 60_000;
  }

  /**
   * PRIMARY connect: full-page redirect to Google (PKCE). Never resolves in
   * this page load — the flow completes via `completeRedirect()` on return.
   * access_type=offline + prompt=consent ⇒ Google issues a refresh token.
   */
  async connect(): Promise<void> {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    const state = generateState();
    try {
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    } catch {
      throw new StorageError('Cannot start Google sign-in: session storage is blocked.');
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.config.scope);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    window.location.assign(url.toString());
    return new Promise<void>(() => {
      /* navigation in progress */
    });
  }

  /**
   * Call once on page load. If the URL carries an OAuth code from OUR flow
   * (matched via this adapter's own PKCE session entry), exchanges it on the
   * stateless endpoint and returns a connected adapter; otherwise null.
   */
  static async completeRedirect(config: GoogleDriveConfig): Promise<GoogleDriveAdapter | null> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code) return null;

    let stored: { verifier: string; state: string } | null = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null');
    } catch {
      stored = null;
    }
    if (!stored) return null; // not our flow (e.g. a Dropbox return)
    if (stored.state !== state) {
      throw new StorageError('Google sign-in failed: state mismatch (possible CSRF) — please retry.');
    }

    const res = await fetch(config.exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grantType: 'code',
        code,
        codeVerifier: stored.verifier,
        redirectUri: config.redirectUri,
      }),
    });
    if (!res.ok) {
      throw new StorageError(`Google Drive connect failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { accessToken: string; refreshToken?: string; expiresIn: number };
    setJson(TOKENS_KEY, {
      accessToken: json.accessToken,
      refreshToken: json.refreshToken,
      expiresAt: Date.now() + (json.expiresIn ?? 3600) * 1000,
    } satisfies DriveTokens);
    setJson(CONFIG_KEY, { connected: true } satisfies Stored);
    try {
      sessionStorage.removeItem(PKCE_KEY);
    } catch {
      /* ignore */
    }
    // Strip ?code/&state so a refresh doesn't re-trigger.
    window.history.replaceState({}, '', config.redirectUri);
    return new GoogleDriveAdapter(config);
  }

  /**
   * FALLBACK connect/reconnect: GIS popup (~1 h token, no refresh token).
   * Needs a user gesture; works even with the exchange endpoint down.
   */
  async connectViaPopup(): Promise<void> {
    const token = await this.acquireViaGis();
    this.saveTokens({ accessToken: token.accessToken, expiresAt: token.expiresAt });
    setJson(CONFIG_KEY, { ...(this.stored ?? {}), connected: true } as Stored);
    this.stored = getJson<Stored>(CONFIG_KEY);
  }

  /**
   * Refresh the access token through the stateless endpoint. Returns true on
   * success; false if a popup re-grant is needed instead (endpoint unreachable,
   * or the refresh token was revoked — which also clears it).
   */
  async tryServerRefresh(): Promise<boolean> {
    if (!this.tokens?.refreshToken) return false;
    let res: Response;
    try {
      res = await fetch(this.config.exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantType: 'refresh', refreshToken: this.tokens.refreshToken }),
      });
    } catch {
      return false; // network/server down → caller falls back to the popup path
    }
    if (res.status === 400 || res.status === 401) {
      // Refresh token revoked/expired — drop it so we stop retrying.
      this.saveTokens({ accessToken: '', expiresAt: 0 });
      return false;
    }
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string; expiresIn: number };
    this.saveTokens({
      accessToken: json.accessToken,
      refreshToken: this.tokens.refreshToken, // refresh grants don't re-issue it
      expiresAt: Date.now() + (json.expiresIn ?? 3600) * 1000,
    });
    return true;
  }

  async disconnect(): Promise<void> {
    this.stored = null;
    this.tokens = null;
    safeRemoveItem(CONFIG_KEY);
    safeRemoveItem(TOKENS_KEY);
    try {
      sessionStorage.removeItem('health_roadmap_gdrive_token'); // legacy cache
    } catch {
      /* ignore */
    }
  }

  // --- file ops -------------------------------------------------------------

  async read(): Promise<ReadResult> {
    const fileId = this.stored?.fileId ?? (await this.findFileId());
    if (!fileId) return { file: null, version: null };
    this.rememberFileId(fileId);
    const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: await this.authHeaders() });
    if (res.status === 404) return { file: null, version: null };
    if (!res.ok) throw new StorageError(`Google Drive read failed (${res.status}): ${await res.text()}`);
    const text = await res.text();
    let file: RoadmapFile | null;
    try {
      file = text ? (JSON.parse(text) as RoadmapFile) : null;
    } catch (error) {
      throw new StorageError('Google Drive read failed: file is not valid JSON (possible corruption).', error);
    }
    return { file, version: await this.fileVersion(fileId) };
  }

  async write(file: RoadmapFile, _expectedVersion: string | null): Promise<WriteResult> {
    // Drive has no conditional write → last-write-wins (the SyncManager merges first).
    const body = JSON.stringify(file);
    const fileId = this.stored?.fileId ?? (await this.findFileId());
    if (fileId) {
      const res = await fetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
        method: 'PATCH',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) throw new StorageError(`Google Drive write failed (${res.status}): ${await res.text()}`);
      this.rememberFileId(fileId);
      return { version: String(((await res.json()) as { version?: string }).version ?? '') };
    }
    // First write — create the file (multipart: metadata + content).
    const boundary = 'rm_boundary_health_roadmap';
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name: FILE_NAME })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { ...(await this.authHeaders()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!res.ok) throw new StorageError(`Google Drive create failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { id?: string; version?: string };
    if (!json.id) throw new StorageError('Google Drive create returned no file id.');
    this.rememberFileId(json.id);
    return { version: String(json.version ?? '') };
  }

  async readDocument(ref: string): Promise<Blob> {
    const id = await this.findFileId(docName(ref));
    if (!id) throw new StorageError(`Google Drive document not found: ${ref}`);
    const res = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: await this.authHeaders() });
    if (!res.ok) throw new StorageError(`Google Drive document read failed (${res.status}): ${ref}`);
    return res.blob();
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const name = docName(ref);
    const id = await this.findFileId(name);
    const type = bytes.type || 'application/octet-stream';
    if (id) {
      const res = await fetch(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { ...(await this.authHeaders()), 'Content-Type': type },
        body: bytes,
      });
      if (!res.ok) throw new StorageError(`Google Drive document write failed (${res.status}): ${ref}`);
      return;
    }
    const boundary = 'rm_boundary_doc';
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`;
    const multipart = new Blob([head, bytes, `\r\n--${boundary}--`]);
    const res = await fetch(`${UPLOAD}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { ...(await this.authHeaders()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    if (!res.ok) throw new StorageError(`Google Drive document create failed (${res.status}): ${ref}`);
  }

  // --- helpers --------------------------------------------------------------

  private saveTokens(tokens: DriveTokens): void {
    this.tokens = tokens;
    setJson(TOKENS_KEY, tokens);
  }

  private rememberFileId(fileId: string): void {
    if (this.stored?.fileId === fileId) return;
    this.stored = { connected: true, fileId };
    setJson(CONFIG_KEY, this.stored);
  }

  private async findFileId(name = FILE_NAME): Promise<string | undefined> {
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const res = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id)&pageSize=1`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw new StorageError(`Google Drive lookup failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id;
  }

  private async fileVersion(fileId: string): Promise<string | null> {
    const res = await fetch(`${DRIVE}/files/${fileId}?fields=version`, { headers: await this.authHeaders() });
    if (!res.ok) return null;
    return String(((await res.json()) as { version?: string }).version ?? '') || null;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  /** Valid cached token → server refresh → otherwise interaction is needed. */
  private async getToken(): Promise<string> {
    if (this.hasValidToken()) return this.tokens!.accessToken;
    if (await this.tryServerRefresh()) return this.tokens!.accessToken;
    throw new DriveReauthNeeded();
  }

  /** GIS popup token grant (requires a user gesture). */
  private acquireViaGis(): Promise<{ accessToken: string; expiresAt: number }> {
    return loadGis().then(
      () =>
        new Promise((resolve, reject) => {
          const client = gis()!.accounts.oauth2.initTokenClient({
            client_id: this.config.clientId,
            scope: this.config.scope,
            callback: (r) => {
              if (r.error || !r.access_token) {
                reject(new StorageError(`Google Drive authorization failed${r.error ? `: ${r.error}` : ''}.`));
                return;
              }
              resolve({
                accessToken: r.access_token,
                expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000,
              });
            },
            error_callback: () => reject(new StorageError('Google Drive sign-in was cancelled or blocked.')),
          });
          client.requestAccessToken({ prompt: '' });
        }),
    );
  }
}
