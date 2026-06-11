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
 * Drive files discovered by name (`health-roadmap.json`, `chat-history.json`, …).
 *
 * CONCURRENCY: Drive v3 has no conditional write (no ETag/sha/rev), so writes
 * are last-write-wins; the SyncManager's read-merge-write makes that safe. The
 * file `version` field is surfaced for change detection.
 */
import { splitDocumentRef } from '@roadmap/health-core';
import {
  ROADMAP_FILE_NAME,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';
import { claimRedirectCode, deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce';

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
/** Everything the app creates lives in this folder (parity with Dropbox's app folder). */
const FOLDER_NAME = 'Health Plan by Dr Brad';
/** Pre-rename folder name (brand moved off "roadmap", 2026-06-10) — found folders are renamed in place. */
const LEGACY_FOLDER_NAME = 'Health Roadmap by Dr Brad';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** Presence of this object IS the "connected" flag. */
interface Stored {
  /** Cached Drive id of the roadmap record file (legacy slot — predates named files). */
  fileId?: string;
  /** Cached Drive ids of other named record files (e.g. 'chat-history.json' → id). */
  fileIds?: Record<string, string>;
  /** Recorded once the app folder exists; also serves as the "migration
   *  attempted" marker — the root→folder move runs at most once. */
  folderId?: string;
  /** The folder's last-known display name — self-heals renames (brand changes)
   *  even when folderId is cached. */
  folderName?: string;
  /** Document subfolder ids (e.g. 'Lab results' → id), cached per device. */
  subfolders?: Record<string, string>;
}

interface DriveTokens {
  accessToken: string;
  /** Absent when the token came from the GIS popup fallback. */
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

function expiry(expiresIn?: number): number {
  return Date.now() + (expiresIn ?? 3600) * 1000;
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

export class GoogleDriveAdapter implements StorageAdapter {
  readonly id = 'google-drive' as const;
  readonly label = 'Google Drive';
  private stored: Stored | null;
  private tokens: DriveTokens | null;
  /** Signed ID token from the most recent server refresh (openid grants only) —
   *  consumed by getReminderProof; never persisted. */
  private lastIdToken: string | null = null;
  /** At-most-once-per-session guard for the cosmetic folder migration. */
  private folderCheckDone = false;

  constructor(private readonly config: GoogleDriveConfig) {
    this.stored = getJson<Stored>(CONFIG_KEY);
    this.tokens = getJson<DriveTokens>(TOKENS_KEY);
  }

  isConnected(): boolean {
    return this.stored !== null;
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
    const claimed = claimRedirectCode(PKCE_KEY); // null when the ?code isn't ours
    if (!claimed) return null;

    // No Content-Type header: a string body defaults to text/plain, keeping the
    // POST a CORS "simple request" (no preflight — remix-serve can't answer
    // OPTIONS). The endpoint parses JSON regardless of content type.
    const res = await fetch(config.exchangeUrl, {
      method: 'POST',
      body: JSON.stringify({
        grantType: 'code',
        code: claimed.code,
        codeVerifier: claimed.verifier,
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
      expiresAt: expiry(json.expiresIn),
    } satisfies DriveTokens);
    setJson(CONFIG_KEY, {} satisfies Stored);
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
    this.stored = this.stored ?? {};
    setJson(CONFIG_KEY, this.stored);
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
        // No Content-Type: keep it a CORS simple request (no preflight).
        body: JSON.stringify({ grantType: 'refresh', refreshToken: this.tokens.refreshToken }),
        // This runs at page load before first render — a black-holing server
        // must fail fast into the on-device + Reconnect fallback, not hang.
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return false; // network/server down/timeout → caller falls back to the popup path
    }
    if (res.status === 400 || res.status === 401) {
      this.clearTokens(); // refresh token revoked/expired — stop retrying
      return false;
    }
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken: string; expiresIn: number; idToken?: string };
    this.lastIdToken = json.idToken ?? null;
    this.saveTokens({
      accessToken: json.accessToken,
      refreshToken: this.tokens.refreshToken, // refresh grants don't re-issue it
      expiresAt: expiry(json.expiresIn),
    });
    return true;
  }

  async disconnect(): Promise<void> {
    this.stored = null;
    safeRemoveItem(CONFIG_KEY);
    this.clearTokens();
  }

  /**
   * Proof of the account's verified email for the reminders opt-in (§10).
   * PREFERRED: a signed ID token from a refresh grant — Google's signature
   * vouches for the email and no Drive-capable token ever leaves the browser.
   * FALLBACK (popup sessions, or pre-email-scope grants that return no ID
   * token): a fresh GIS popup token, which the server uses for ONE in-memory
   * userinfo read. Needs a user gesture — call from the opt-in click.
   */
  async getReminderProof(): Promise<{ idToken: string } | { accessToken: string }> {
    // Reuses the one token-refresh implementation (incl. its revoked-token
    // handling); the refresh grant returns a fresh signed ID token when the
    // original grant included openid.
    if (await this.tryServerRefresh()) {
      if (this.lastIdToken) return { idToken: this.lastIdToken };
    }
    const token = await this.acquireViaGis();
    this.saveTokens({ ...this.tokens, accessToken: token.accessToken, expiresAt: token.expiresAt });
    return { accessToken: token.accessToken };
  }

  // --- file ops -------------------------------------------------------------

  async read(fileName: string): Promise<ReadResult> {
    const fileId = this.cachedFileId(fileName) ?? (await this.findFileId(fileName));
    if (!fileId) return { body: null, version: null };
    this.rememberFileId(fileName, fileId);
    // Cosmetic, never blocks the read: adopt pre-folder files into the app folder.
    void this.ensureInFolderOnce(fileId);
    const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: await this.authHeaders() });
    if (res.status === 404) return { body: null, version: null };
    if (!res.ok) throw new StorageError(`Google Drive read failed (${res.status}): ${await res.text()}`);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch (error) {
      throw new StorageError('Google Drive read failed: file is not valid JSON (possible corruption).', error);
    }
    // version: null is honest — Drive has no conditional write, so write()
    // ignores expectedVersion (LWW; the SyncManager merges first). Fetching the
    // file's `version` field here cost an extra round trip per read (reads run
    // on every load and twice per save) for a value nothing consumed.
    return { body, version: null };
  }

  async write(fileName: string, body: object, _expectedVersion: string | null): Promise<WriteResult> {
    // Drive has no conditional write → last-write-wins (the SyncManager merges first).
    const json = JSON.stringify(body);
    const fileId = this.cachedFileId(fileName) ?? (await this.findFileId(fileName));
    if (fileId) {
      const res = await fetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
        method: 'PATCH',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body: json,
      });
      if (!res.ok) throw new StorageError(`Google Drive write failed (${res.status}): ${await res.text()}`);
      this.rememberFileId(fileName, fileId);
      return { version: String(((await res.json()) as { version?: string }).version ?? '') };
    }
    // First write — create the file (multipart: metadata + content).
    const res = await this.createMultipart(fileName, 'application/json', json);
    if (!res.ok) throw new StorageError(`Google Drive create failed (${res.status}): ${await res.text()}`);
    const created = (await res.json()) as { id?: string; version?: string };
    if (!created.id) throw new StorageError('Google Drive create returned no file id.');
    this.rememberFileId(fileName, created.id);
    return { version: String(created.version ?? '') };
  }

  async readDocument(ref: string): Promise<Blob> {
    const { folder, name } = splitDocumentRef(ref);
    const parentId = folder ? await this.ensureSubfolderId(folder) : await this.ensureFolderId();
    const id = await this.findFileId(name, parentId);
    if (!id) throw new StorageError(`Google Drive document not found: ${ref}`);
    const res = await fetch(`${DRIVE}/files/${id}?alt=media`, { headers: await this.authHeaders() });
    if (!res.ok) throw new StorageError(`Google Drive document read failed (${res.status}): ${ref}`);
    return res.blob();
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const { folder, name } = splitDocumentRef(ref);
    const parentId = folder ? await this.ensureSubfolderId(folder) : await this.ensureFolderId();
    const type = bytes.type || 'application/octet-stream';
    // Create directly — no pre-write existence lookup (it halved every upload's
    // round trips for a case that can't happen: refs are unique by construction,
    // collision-suffixed against the file's refs + content-hash deduped). The
    // one exception — retrying after an interrupted save left an orphan blob —
    // produces a same-named duplicate with identical bytes, which Drive allows
    // and readDocument resolves by name; accepted orphan semantics (§5.3).
    const res = await this.createMultipart(name, type, bytes, parentId);
    if (!res.ok) throw new StorageError(`Google Drive document create failed (${res.status}): ${ref}`);
  }

  // --- helpers --------------------------------------------------------------

  private saveTokens(tokens: DriveTokens): void {
    this.tokens = tokens;
    setJson(TOKENS_KEY, tokens);
  }

  private clearTokens(): void {
    this.tokens = null;
    safeRemoveItem(TOKENS_KEY);
  }

  /** The roadmap file uses the original `fileId` slot (back-compat with stored
   *  configs that predate named files); other names live in `fileIds`. */
  private cachedFileId(fileName: string): string | undefined {
    return fileName === ROADMAP_FILE_NAME ? this.stored?.fileId : this.stored?.fileIds?.[fileName];
  }

  private rememberFileId(fileName: string, fileId: string): void {
    if (this.cachedFileId(fileName) === fileId) return;
    this.stored =
      fileName === ROADMAP_FILE_NAME
        ? { ...(this.stored ?? {}), fileId }
        : { ...(this.stored ?? {}), fileIds: { ...(this.stored?.fileIds ?? {}), [fileName]: fileId } };
    setJson(CONFIG_KEY, this.stored);
  }

  /** Find-or-create the app folder; records its id (the "folder done" marker). */
  private async ensureFolderId(): Promise<string> {
    if (this.stored?.folderId) {
      void this.ensureFolderName(this.stored.folderId); // self-heal renames; never blocks
      return this.stored.folderId;
    }
    const q = encodeURIComponent(
      `(name='${FOLDER_NAME}' or name='${LEGACY_FOLDER_NAME}') and mimeType='${FOLDER_MIME}' and trashed=false`,
    );
    const found = await fetch(`${DRIVE}/files?q=${q}&fields=files(id,name)&pageSize=1`, {
      headers: await this.authHeaders(),
    });
    if (!found.ok) throw new StorageError(`Google Drive folder lookup failed (${found.status})`);
    const hit = ((await found.json()) as { files?: Array<{ id: string; name: string }> }).files?.[0];
    let id = hit?.id;
    if (id) void this.ensureFolderName(id, hit!.name);
    if (!id) {
      const created = await fetch(`${DRIVE}/files?fields=id`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
      });
      if (!created.ok) throw new StorageError(`Google Drive folder create failed (${created.status})`);
      id = ((await created.json()) as { id: string }).id;
      this.stored = { ...(this.stored ?? {}), folderName: FOLDER_NAME }; // fresh create = current name
    }
    this.stored = { ...(this.stored ?? {}), folderId: id };
    setJson(CONFIG_KEY, this.stored);
    return id;
  }

  /**
   * Self-heal the folder's display name after a brand rename — covers folders
   * whose id was cached before the rename (the find/create paths can't see
   * them). At most one PATCH per device per rename; cosmetic, never blocks.
   */
  private async ensureFolderName(folderId: string, knownName?: string): Promise<void> {
    if (this.stored?.folderName === FOLDER_NAME) return;
    try {
      if (knownName !== FOLDER_NAME) {
        await fetch(`${DRIVE}/files/${folderId}`, {
          method: 'PATCH',
          headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER_NAME }),
        });
      }
      this.stored = { ...(this.stored ?? {}), folderName: FOLDER_NAME };
      setJson(CONFIG_KEY, this.stored);
    } catch {
      /* cosmetic — retried next session */
    }
  }

  /**
   * Find-or-create a document subfolder (e.g. 'Lab results') inside the app
   * folder; the id is cached per device. The organised-archive folders —
   * Dropbox/GitHub/WebDAV get these natively from the ref path; Drive needs
   * real folder objects.
   */
  private async ensureSubfolderId(folderName: string): Promise<string> {
    const cached = this.stored?.subfolders?.[folderName];
    if (cached) return cached;
    const parentId = await this.ensureFolderId();
    const q = encodeURIComponent(
      `name='${folderName.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`,
    );
    const found = await fetch(`${DRIVE}/files?q=${q}&fields=files(id)&pageSize=1`, {
      headers: await this.authHeaders(),
    });
    if (!found.ok) throw new StorageError(`Google Drive subfolder lookup failed (${found.status})`);
    let id = ((await found.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id;
    if (!id) {
      const created = await fetch(`${DRIVE}/files?fields=id`, {
        method: 'POST',
        headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
      if (!created.ok) throw new StorageError(`Google Drive subfolder create failed (${created.status})`);
      id = ((await created.json()) as { id: string }).id;
    }
    this.stored = {
      ...(this.stored ?? {}),
      subfolders: { ...(this.stored?.subfolders ?? {}), [folderName]: id },
    };
    setJson(CONFIG_KEY, this.stored);
    return id;
  }

  /**
   * One-time migration: files created before the app folder existed (at the
   * Drive root) are moved into it. No-op once folderId is recorded; cosmetic,
   * so failures never block sync and retry at most once per session.
   */
  private async ensureInFolderOnce(fileId: string): Promise<void> {
    if (this.folderCheckDone || this.stored?.folderId) return;
    this.folderCheckDone = true;
    try {
      const folderId = await this.ensureFolderId();
      const meta = await fetch(`${DRIVE}/files/${fileId}?fields=parents`, { headers: await this.authHeaders() });
      if (!meta.ok) return;
      const parents = ((await meta.json()) as { parents?: string[] }).parents ?? [];
      if (parents.includes(folderId)) return;
      await fetch(`${DRIVE}/files/${fileId}?addParents=${folderId}&removeParents=${parents.join(',')}`, {
        method: 'PATCH',
        headers: await this.authHeaders(),
      });
    } catch {
      /* cosmetic — never block sync on the move */
    }
  }

  /** Create a new Drive file inside the app folder (metadata + content, one multipart POST). */
  private async createMultipart(
    name: string,
    contentType: string,
    content: Blob | string,
    parentId?: string,
  ): Promise<Response> {
    const metadata = { name, parents: [parentId ?? (await this.ensureFolderId())] };
    const boundary = 'rm_boundary_health_roadmap';
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ]);
    return fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { ...(await this.authHeaders()), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  private async findFileId(name: string, parentId?: string): Promise<string | undefined> {
    const safe = name.replace(/'/g, "\\'");
    const q = encodeURIComponent(
      `name='${safe}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
    );
    const res = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id)&pageSize=1`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw new StorageError(`Google Drive lookup failed (${res.status}): ${await res.text()}`);
    return ((await res.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  /** Valid cached token → server refresh → otherwise interaction is needed. */
  private async getToken(): Promise<string> {
    if (this.hasValidToken()) return this.tokens!.accessToken;
    if (await this.tryServerRefresh()) return this.tokens!.accessToken;
    throw new StorageError('Google Drive needs to be reconnected.');
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
              resolve({ accessToken: r.access_token, expiresAt: expiry(r.expires_in) });
            },
            error_callback: () => reject(new StorageError('Google Drive sign-in was cancelled or blocked.')),
          });
          client.requestAccessToken({ prompt: '' });
        }),
    );
  }
}
