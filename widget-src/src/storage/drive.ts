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
import {
  driveCreateFile,
  driveCreateFolder,
  driveDownloadJson,
  driveFindFileId,
  driveFindFolder,
  driveUpdateFile,
  splitDocumentRef,
  DRIVE_API,
  DRIVE_FOLDER_NAME,
  ROADMAP_FILE_NAME,
  sleepUntilAborted,
  StorageError,
  jsonBody,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';
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
/** Drive has no long-poll for a browser (its push channels need a public
 *  webhook), so the change signal is its changes feed, read on a short beat
 *  while the tab is visible. Three seconds is a page that keeps up without
 *  spending a request a second. */
const CHANGES_POLL_MS = 3_000;
/** First retry after a failed changes read, doubling to this ceiling. */
const RETRY_MIN_MS = 3_000;
const RETRY_MAX_MS = 60_000;
/** Folder names, file lookup and the upload requests are shared with the hosted
 *  MCP server (`packages/health-core/src/drive-rest.ts`): both must find the
 *  SAME file or the server writes a second record beside the user's. */
const FOLDER_NAME = DRIVE_FOLDER_NAME;

/** One page of Drive's changes feed — the fields the watch asks for. */
interface DriveChangesPage {
  newStartPageToken?: string;
  nextPageToken?: string;
  changes?: { fileId?: string }[];
}

/** Presence of this object IS the "connected" flag. */
interface Stored {
  /** LEGACY single-file slot (pre-named-files) — folded into `fileIds` at
   *  construction; kept only so old stored configs still parse. */
  fileId?: string;
  /** Cached Drive ids of the record files, keyed by file name. */
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
    // One-time normalization: fold the legacy single-file `fileId` slot into
    // the per-name map so every cache access is a uniform map read.
    if (this.stored?.fileId && !this.stored.fileIds?.[ROADMAP_FILE_NAME]) {
      this.stored = {
        ...this.stored,
        fileIds: { ...(this.stored.fileIds ?? {}), [ROADMAP_FILE_NAME]: this.stored.fileId },
      };
      setJson(CONFIG_KEY, this.stored);
    }
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
   *
   * `silent` (US-17 auto-enrolment) forbids that fallback and returns null
   * instead: auto-enrolment runs at page load, where a popup is both blocked
   * by the browser and unasked-for by the user. Null = retry next visit.
   */
  async getReminderProof(silent = false): Promise<{ idToken: string } | { accessToken: string } | null> {
    // Reuses the one token-refresh implementation (incl. its revoked-token
    // handling); the refresh grant returns a fresh signed ID token when the
    // original grant included openid.
    if (await this.tryServerRefresh()) {
      if (this.lastIdToken) return { idToken: this.lastIdToken };
    }
    if (silent) return null;
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
    // version: null is honest — the BROWSER write is last-write-wins (the
    // SyncManager merges first), so nothing here consumes a version and
    // fetching one would cost an extra round trip on every load and every
    // save. The hosted server does re-check it (design §7); the browser cannot
    // detect being clobbered on Drive, and the guides say so.
    return { body: await driveDownloadJson(await this.getToken(), fileId), version: null };
  }

  async write(fileName: string, body: object, _expectedVersion: string | null): Promise<WriteResult> {
    // Drive has no conditional write → last-write-wins (the SyncManager merges first).
    const json = JSON.stringify(body);
    const fileId = this.cachedFileId(fileName) ?? (await this.findFileId(fileName));
    if (fileId) {
      const version = await driveUpdateFile(await this.getToken(), fileId, json);
      this.rememberFileId(fileName, fileId);
      return { version };
    }
    // First write — create the file (multipart: metadata + content).
    const res = await this.createMultipart(fileName, 'application/json', json);
    if (!res.ok) throw new StorageError(`Google Drive create failed (${res.status}): ${await res.text()}`);
    const created = await jsonBody<{ id?: string; version?: string }>(res);
    if (!created.id) throw new StorageError('Google Drive create returned no file id.');
    this.rememberFileId(fileName, created.id);
    return { version: String(created.version ?? '') };
  }

  async readDocument(ref: string): Promise<Blob> {
    const { folder, name } = splitDocumentRef(ref);
    const parentId = folder ? await this.ensureSubfolderId(folder) : await this.ensureFolderId();
    const id = await this.findFileId(name, parentId);
    if (!id) throw new StorageError(`Google Drive document not found: ${ref}`);
    const res = await fetch(`${DRIVE_API}/files/${id}?alt=media`, { headers: await this.authHeaders() });
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

  // --- change signal (US-34) -------------------------------------------------

  /**
   * Tell the store when OUR file moved, by walking Drive's changes feed. The
   * `drive.file` scope keeps the feed to files this app created, so it is
   * small — but a second app-created file (chat history) must not re-read the
   * record, hence the file-id test. An unknown id means the record has not
   * been created yet, and then any change is worth a look.
   */
  watch(fileName: string, onChange: () => void, signal: AbortSignal): void {
    void this.watchLoop(fileName, onChange, signal);
  }

  private async watchLoop(fileName: string, onChange: () => void, signal: AbortSignal): Promise<void> {
    let retryMs = 0;
    // The outer loop owns the page token: a failure drops it, and the next
    // turn asks Drive for a fresh one.
    while (!signal.aborted) {
      try {
        let token = await this.startPageToken(signal);
        while (!signal.aborted) {
          const url = `${DRIVE_API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=100`
            + '&fields=newStartPageToken,nextPageToken,changes(fileId)';
          const page: DriveChangesPage = await jsonBody(await this.changesRequest(url, signal));
          const fileId = this.cachedFileId(fileName);
          if (page.changes?.some((c) => !fileId || c.fileId === fileId) && !signal.aborted) onChange();
          // `nextPageToken` means more pages of the SAME batch: take it and
          // read again on the next beat rather than looping the pages here,
          // because the answer is already "something changed".
          token = page.nextPageToken ?? page.newStartPageToken ?? token;
          retryMs = 0;
          await sleepUntilAborted(CHANGES_POLL_MS, signal);
        }
      } catch {
        // An expired token, a 401 the refresh could not fix, a dead network:
        // wait longer each time, then start over from a fresh page token.
        retryMs = Math.min(retryMs ? retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
        await sleepUntilAborted(retryMs, signal);
      }
    }
  }

  private async startPageToken(signal: AbortSignal): Promise<string> {
    const res = await this.changesRequest(`${DRIVE_API}/changes/startPageToken`, signal);
    const json = await jsonBody<{ startPageToken?: string }>(res);
    if (!json.startPageToken) throw new StorageError('Google Drive returned no start page token.');
    return json.startPageToken;
  }

  private async changesRequest(url: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(url, { headers: await this.authHeaders(), signal });
    if (!res.ok) throw new StorageError(`Google Drive watch failed (${res.status}).`);
    return res;
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

  private cachedFileId(fileName: string): string | undefined {
    return this.stored?.fileIds?.[fileName];
  }

  private rememberFileId(fileName: string, fileId: string): void {
    if (this.cachedFileId(fileName) === fileId) return;
    this.stored = {
      ...(this.stored ?? {}),
      fileIds: { ...(this.stored?.fileIds ?? {}), [fileName]: fileId },
    };
    setJson(CONFIG_KEY, this.stored);
  }

  /** Find-or-create the app folder; records its id (the "folder done" marker). */
  private async ensureFolderId(): Promise<string> {
    if (this.stored?.folderId) {
      void this.ensureFolderName(this.stored.folderId); // self-heal renames; never blocks
      return this.stored.folderId;
    }
    const hit = await driveFindFolder(await this.getToken());
    let id = hit?.id;
    if (id) void this.ensureFolderName(id, hit!.name);
    if (!id) {
      id = await driveCreateFolder(await this.getToken(), FOLDER_NAME);
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
        await fetch(`${DRIVE_API}/files/${folderId}`, {
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
    const id =
      (await driveFindFolder(await this.getToken(), [folderName], parentId))?.id ??
      (await driveCreateFolder(await this.getToken(), folderName, parentId));
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
      const meta = await fetch(`${DRIVE_API}/files/${fileId}?fields=parents`, { headers: await this.authHeaders() });
      if (!meta.ok) return;
      const parents = ((await meta.json()) as { parents?: string[] }).parents ?? [];
      if (parents.includes(folderId)) return;
      await fetch(`${DRIVE_API}/files/${fileId}?addParents=${folderId}&removeParents=${parents.join(',')}`, {
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
    return driveCreateFile(
      await this.getToken(),
      name,
      contentType,
      content,
      parentId ?? (await this.ensureFolderId()),
    );
  }

  private async findFileId(name: string, parentId?: string): Promise<string | undefined> {
    return driveFindFileId(await this.getToken(), name, parentId);
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
