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
 *    serverless (acquireViaPopup, used by the Reconnect button).
 *
 * SCOPING: drive.file — the app sees ONLY files it created (including raw lab
 * documents later), never the rest of the user's Drive. The record lives as a
 * Drive files discovered by name (`health-roadmap.json`, `chat-history.json`, …).
 *
 * CONCURRENCY: Drive v3 has no conditional write (no ETag/sha/rev). This
 * adapter does what the hosted `DriveAdapter` does (mcp-architecture.md §7):
 * read `version` before the bytes, re-read it just before the upload, and
 * refuse with ConflictError if it moved so the SyncManager re-merges. The
 * check-to-upload gap of one PATCH round trip remains; verify-after-write
 * catches a writer who lands inside it.
 */
import { ConflictError, fetchOrFail, ROADMAP_FILE_NAME, StorageError, jsonBody, type ReadResult, type StorageAdapter, type WriteResult } from '@roadmap/health-core/adapter';
import { driveCreateFile, driveCreateFolder, driveDownloadDocument, driveDownloadJson, driveEnsureSubfolder, driveFileIsLive, driveFileVersion, driveFindFileId, driveFindFolder, driveUpdateIfVersion, driveUploadDocument, readDriveRecord, DRIVE_API, DRIVE_FOLDER_NAME, writeDriveRecord } from '@roadmap/health-core/drive-rest';
import { splitDocumentRef } from '@roadmap/health-core/document-path';
import { codeGrantReply, postRefreshGrant } from './drive-token-reply';
import { refreshOnce } from './token-flight';
import { isSignedOut, signInEnded } from './sign-in-state';
import { driveWatchLoop } from './drive-watch';
import { gis, gisReady, loadGis } from './drive-gis';
export { gisReady, preloadGis } from './drive-gis';
import { getSignIn, logOffId, setSignIn, setSignIns, safeRemoveItem, type LogOffId } from '../lib/storage';
import { claimRedirectCancel, claimRedirectCode, deriveCodeChallenge, generateCodeVerifier, generateState, pkceEntry } from './pkce';

export interface GoogleDriveConfig {
  clientId: string;
  scope: string;
  /** Must exactly match a redirect URI registered on the Google OAuth client. */
  redirectUri: string;
  /** Brad's stateless token-exchange endpoint (api.google-token.ts). */
  exchangeUrl: string;
}

export const CONFIG_KEY = 'health_roadmap_gdrive';
export const TOKENS_KEY = 'health_roadmap_gdrive_tokens';
const PKCE_KEY = 'health_roadmap_gdrive_pkce';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Folder names, file lookup and the upload requests are shared with the hosted
 *  MCP server (`packages/health-core/src/drive-rest.ts`): both must find the
 *  SAME file or the server writes a second record beside the user's. */
const FOLDER_NAME = DRIVE_FOLDER_NAME;

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
  /** The account's verified email, decoded from the ID token at connect /
   *  refresh — the reminders control prefills it. Never sent as proof: the
   *  signed ID token itself is (US-17 AC7). */
  accountEmail?: string;
}

/**
 * The verified email inside a Google ID token, or null. No signature check:
 * this runs in the user's own browser on a token Google just handed it, and
 * the only consumer is a prefill. The server verifies the token itself.
 */
export function decodeIdTokenEmail(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1] ?? '';
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: string; email_verified?: boolean };
    return claims.email_verified === true && claims.email ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
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

/** The one scope Drive access needs; `google-config.ts` builds the request from it. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Google names the approved scopes on both connect paths (the redirect URL,
 * the popup's token response), so a grant with the Drive box left unticked is
 * known BEFORE any token is kept (US-09 AC15). A response that omits the list
 * is trusted, as it was before the check.
 */
function grantsDrive(scope?: string): boolean {
  return typeof scope !== 'string' || scope.split(' ').includes(DRIVE_FILE_SCOPE);
}

/** A grant without `drive.file`, refused at connect (US-09 AC15). The message
 *  is what the user is told, so it names the box. */
export class DriveGrantRefusedError extends StorageError {
  constructor() {
    super(
      "Google didn't grant this app access to Google Drive, so nothing was connected. " +
        "Try again and tick the Google Drive box on Google's permission screen.",
    );
    this.name = 'DriveGrantRefusedError';
  }
}

export class GoogleDriveAdapter implements StorageAdapter {
  readonly id = 'google-drive' as const;
  readonly label = 'Google Drive';
  private stored: Stored | null;
  private tokens: DriveTokens | null;
  /** Signed ID token from the most recent server refresh (openid grants only) —
   *  consumed by getReminderIdToken; never persisted. */
  private lastIdToken: string | null = null;
  /** At-most-once-per-session guard for the cosmetic folder migration. */
  private folderCheckDone = false;
  /** The record's copies as last found or made, winner first (US-10 AC4a). */
  private readonly recordIds = new Set<string>();

  constructor(private readonly config: GoogleDriveConfig, readonly gen: LogOffId = logOffId()) {
    this.stored = getSignIn<Stored>(CONFIG_KEY);
    this.tokens = getSignIn<DriveTokens>(TOKENS_KEY);
    // One-time normalization: fold the legacy single-file `fileId` slot into
    // the per-name map so every cache access is a uniform map read.
    if (this.stored?.fileId && !this.stored.fileIds?.[ROADMAP_FILE_NAME]) {
      this.stored = {
        ...this.stored,
        fileIds: { ...(this.stored.fileIds ?? {}), [ROADMAP_FILE_NAME]: this.stored.fileId },
      };
      setSignIn(CONFIG_KEY, this.stored, this.gen);
    }
    // The record id this browser saved last: a reload inside Drive's search
    // lag still finds the record, and never creates a second one (US-10 AC4a).
    const cached = this.cachedFileId(ROADMAP_FILE_NAME);
    if (cached) this.recordIds.add(cached);
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
      sessionStorage.setItem(PKCE_KEY, pkceEntry(verifier, state, this.gen));
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

  /** True once if the URL is OUR flow's Cancel/Back return (US-09 AC22). */
  static claimCancelledRedirect(): boolean {
    return claimRedirectCancel(PKCE_KEY);
  }

  /**
   * Call once on page load. If the URL carries an OAuth code from OUR flow
   * (matched via this adapter's own PKCE session entry), exchanges it on the
   * stateless endpoint and returns a connected adapter; otherwise null.
   */
  static async completeRedirect(config: GoogleDriveConfig): Promise<GoogleDriveAdapter | null> {
    const claimed = claimRedirectCode(PKCE_KEY); // null when the ?code isn't ours
    if (!claimed) return null;
    if (!grantsDrive(claimed.scope)) {
      window.history.replaceState({}, '', config.redirectUri);
      throw new DriveGrantRefusedError();
    }

    // No Content-Type header: a string body defaults to text/plain, keeping the
    // POST a CORS "simple request" (no preflight — remix-serve can't answer
    // OPTIONS). The endpoint parses JSON regardless of content type. Bounded
    // (US-09 AC37), as Dropbox's is: the page waits on this before it draws.
    const res = await fetchOrFail('Google Drive', config.exchangeUrl, {
      method: 'POST',
      body: JSON.stringify({
        grantType: 'code',
        code: claimed.code,
        codeVerifier: claimed.verifier,
        redirectUri: config.redirectUri,
      }),
      timeoutMs: 15_000, // past the server's 10 s for Google (issue #977)
    });
    const json = await codeGrantReply(res);
    const accountEmail = json.idToken ? decodeIdTokenEmail(json.idToken) : null;
    const saved = setSignIns({
      [TOKENS_KEY]: { accessToken: json.accessToken, refreshToken: json.refreshToken, expiresAt: expiry(json.expiresIn) } satisfies DriveTokens,
      [CONFIG_KEY]: { ...(accountEmail ? { accountEmail } : {}) } satisfies Stored,
    }, claimed.gen);
    // Strip ?code/&state so a refresh doesn't re-trigger.
    window.history.replaceState({}, '', config.redirectUri);
    return saved ? new GoogleDriveAdapter(config, claimed.gen) : null;
  }

  /**
   * Refresh the access token through the stateless endpoint. Returns true on
   * success; false if a popup re-grant is needed instead (endpoint unreachable,
   * or the refresh token was revoked — which also clears it).
   */
  async tryServerRefresh(): Promise<boolean> {
    return (await this.refresh()) === 'ok';
  }

  /**
   * The refresh with its failure mode kept: 'none' = there is no refresh token
   * to use (never had one, or it was revoked), or the endpoint refused it with
   * a 400/401 (kept unless Google said invalid_grant), which will not change on its
   * own; 'transient' = the endpoint was unreachable or errored, so the next
   * attempt may succeed. The reminders identity needs the difference — a
   * transient failure must not block auto-enrolment forever (review 2026-09-10).
   * A refusal, or an expired popup grant, ends this page's sign-in; a grant it
   * knows is dead is not posted again (US-09 AC48).
   */
  private async refresh(): Promise<'ok' | 'none' | 'transient'> {
    const startedFrom = this.tokens?.refreshToken;
    if (!startedFrom) {
      if (this.tokens && !this.hasValidToken()) signInEnded(this.id, this.gen);
      return 'none';
    }
    if (isSignedOut(this.id)) return 'none';
    // One flight per page and grant (US-09 AC47); each caller judges its answer below.
    const answer = await refreshOnce('google-drive', startedFrom, () => postRefreshGrant(this.config.exchangeUrl, startedFrom));
    if (!answer) return 'transient'; // network/server down/timeout → caller falls back to the popup path
    const { status, json } = answer;
    if (status === 400 || status === 401) {
      if (this.grantMoved(startedFrom)) return 'none';
      if (answer.error === 'invalid_grant') this.clearTokens(); // only Google's "revoked or expired" forgets the grant (US-09 AC47)
      signInEnded(this.id, this.gen);
      return 'none';
    }
    if (!json) return 'transient';
    if (this.grantMoved(startedFrom)) return 'none';
    this.lastIdToken = json.idToken ?? null;
    const accountEmail = this.lastIdToken ? decodeIdTokenEmail(this.lastIdToken) : null;
    if (accountEmail && this.stored && this.stored.accountEmail !== accountEmail) {
      this.stored = { ...this.stored, accountEmail };
      setSignIn(CONFIG_KEY, this.stored, this.gen);
    }
    this.saveTokens({
      accessToken: json.accessToken,
      refreshToken: startedFrom, // refresh grants don't re-issue it
      expiresAt: expiry(json.expiresIn),
    });
    return 'ok';
  }

  /**
   * Disconnect and a sign-in elsewhere run on other adapters, so the stored
   * grant is the only shared truth. Read after a refresh's last await: if it is
   * no longer the grant the refresh started from, this adapter keeps nothing
   * and leaves storage alone. A replaced grant may be another account, so it
   * is never adopted (US-09 AC2f). A grant gone while the account stays is
   * another tab's invalid_grant: this page's sign-in ended too (US-09 AC48).
   */
  private grantMoved(startedFrom: string): boolean {
    const stored = getSignIn<DriveTokens>(TOKENS_KEY);
    if (stored?.refreshToken === startedFrom) return false;
    this.tokens = null;
    if (!stored && getSignIn(CONFIG_KEY)) signInEnded(this.id, this.gen);
    return true;
  }

  async disconnect(): Promise<void> {
    this.stored = null;
    safeRemoveItem(CONFIG_KEY);
    this.clearTokens();
  }

  /**
   * A fresh signed ID token for the reminders opt-in (US-17 AC7) — the one
   * credential the server still accepts, because it grants nothing. Reuses the
   * one token-refresh implementation (incl. its revoked-token handling); the
   * refresh grant returns a fresh ID token when the original grant included
   * openid. Null when there is none: the popup path that used to send a Drive
   * ACCESS token as fallback is gone — the caller falls back to the address
   * (accountEmail) or asks for one. Never opens a popup. THROWS when the
   * refresh failed transiently: that is "try again next visit", not "no token
   * to give", and the caller must not remember it as the latter.
   */
  async getReminderIdToken(): Promise<string | null> {
    const outcome = await this.refresh();
    if (outcome === 'transient') throw new StorageError('Google token refresh unavailable — retry later.');
    return outcome === 'ok' ? this.lastIdToken : null;
  }

  /** The verified account email captured at connect/refresh, or null (pre-openid grants, popup sessions). */
  accountEmail(): string | null {
    return this.stored?.accountEmail ?? null;
  }

  // --- file ops -------------------------------------------------------------

  read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    return this.readFile(fileName, signal).catch(this.refused);
  }

  private async readFile(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    if (fileName === ROADMAP_FILE_NAME) {
      const result = await readDriveRecord(await this.getToken(), this.recordIds, signal);
      this.rememberRecord();
      return result;
    }
    // Search first, oldest copy first, so every device reads the same copy of
    // a duplicated file; the cached id only covers a search that lags a create,
    // and only while it still names a live file (SE-6).
    const fileId = (await this.findFileId(fileName)) ?? (await this.liveCachedFileId(fileName));
    if (!fileId) return { body: null, version: null };
    this.rememberFileId(fileName, fileId);
    // Version BEFORE bytes: a writer landing mid-download then conflicts at
    // write time instead of handing us their version on our stale bytes.
    const token = await this.getToken();
    const version = await driveFileVersion(token, fileId);
    return { body: await driveDownloadJson(token, fileId), version };
  }

  write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    return this.writeFile(fileName, body, expectedVersion, signal).catch(this.refused);
  }

  private async writeFile(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    if (fileName === ROADMAP_FILE_NAME) {
      const { fileId, ...result } = await writeDriveRecord(await this.getToken(), body, expectedVersion, () => this.ensureFolderId(), this.recordIds, signal);
      this.rememberRecord();
      // Cosmetic, never blocks the save, and never on a read (reads do not
      // mutate Drive): adopt the copy just written, never an unreadable one,
      // into the app folder.
      void this.ensureInFolderOnce(fileId);
      return result;
    }
    const json = JSON.stringify(body);
    const fileId = (await this.liveCachedFileId(fileName)) ?? (await this.findFileId(fileName));
    if (fileId) {
      const version = await driveUpdateIfVersion(await this.getToken(), fileId, json, expectedVersion);
      this.rememberFileId(fileName, fileId);
      // Cosmetic, never blocks the save, and never on a read: adopt a
      // pre-folder file into the app folder.
      void this.ensureInFolderOnce(fileId);
      return { version };
    }
    // The file that was read has since been deleted: re-reading turns that
    // into a decision, so never silently re-create it here.
    if (expectedVersion !== null) throw new ConflictError(`${this.label} no longer holds that file`);
    // First write — create the file (multipart: metadata + content).
    const res = await driveCreateFile(await this.getToken(), fileName, 'application/json', json, await this.liveFolderId());
    if (!res.ok) throw new StorageError(`Google Drive create failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
    const created = await jsonBody<{ id?: string; version?: string }>(res);
    if (!created.id) throw new StorageError('Google Drive create returned no file id.');
    this.rememberFileId(fileName, created.id);
    return { version: JSON.stringify([created.id, String(created.version ?? '')]) };
  }

  readDocument(ref: string): Promise<Blob> {
    const { folder, name } = splitDocumentRef(ref);
    return this.documentFolder(folder).then(async (parentId) => driveDownloadDocument(await this.getToken(), name, parentId)).catch(this.refused);
  }

  writeDocument(ref: string, bytes: Blob): Promise<void> {
    const { folder, name } = splitDocumentRef(ref);
    return this.documentFolder(folder).then(async (parentId) => driveUploadDocument(await this.getToken(), name, bytes, parentId)).catch(this.refused);
  }

  private documentFolder(folder: string | null): Promise<string> {
    return folder ? this.ensureSubfolderId(folder) : this.ensureFolderId();
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
    void driveWatchLoop({
      recordIds: this.recordIds,
      cachedFileId: (name) => this.cachedFileId(name),
      authHeaders: () => this.authHeaders(),
      refused: this.refused,
    }, fileName, onChange, signal);
  }

  // --- helpers --------------------------------------------------------------

  /** Drive refused the access token (an API 401, access revoked): it is not used again, so the next
   *  call refreshes and the refresh decides (US-09 AC48). Rethrows: the 401 still fails this call. */
  private readonly refused = (error: unknown): never => {
    if (error instanceof StorageError && error.status === 401 && this.tokens) this.tokens = { ...this.tokens, expiresAt: 0 };
    throw error;
  };

  private saveTokens(tokens: DriveTokens): boolean {
    this.tokens = tokens;
    return setSignIn(TOKENS_KEY, tokens, this.gen);
  }

  private clearTokens(): void {
    this.tokens = null;
    safeRemoveItem(TOKENS_KEY);
  }

  private cachedFileId(fileName: string): string | undefined {
    return this.stored?.fileIds?.[fileName];
  }

  /** The cached id of a secondary file, if it still names a live file. Drive
   *  serves a trashed file by id, and one deleted for good answers 404: either
   *  way the id is forgotten, so the next save searches and, finding nothing,
   *  creates the file again instead of writing into the trash or failing on
   *  every save (SE-6). */
  private async liveCachedFileId(fileName: string): Promise<string | undefined> {
    const cached = this.cachedFileId(fileName);
    if (!cached) return undefined;
    if (await driveFileIsLive(await this.getToken(), cached, fileName)) return cached;
    this.forgetFileId(fileName);
    return undefined;
  }

  private forgetFileId(fileName: string): void {
    const { [fileName]: _gone, ...rest } = this.stored?.fileIds ?? {};
    this.stored = { ...(this.stored ?? {}), fileIds: rest };
    setSignIn(CONFIG_KEY, this.stored, this.gen);
  }

  /** Cache the record's winner for the next page load. */
  private rememberRecord(): void {
    const [winner] = this.recordIds;
    if (winner) this.rememberFileId(ROADMAP_FILE_NAME, winner);
  }

  private rememberFileId(fileName: string, fileId: string): void {
    if (this.cachedFileId(fileName) === fileId) return;
    this.stored = {
      ...(this.stored ?? {}),
      fileIds: { ...(this.stored?.fileIds ?? {}), [fileName]: fileId },
    };
    setSignIn(CONFIG_KEY, this.stored, this.gen);
  }

  /** The app folder for a new secondary file, checked live first. A file made
   *  inside a trashed folder is itself trashed, so with a cached trashed
   *  folder every save would make another file the next check forgets (SE-6).
   *  A dead folder id is forgotten, with the subfolders under it and its
   *  rename marker, and the folder is found or made again. */
  private async liveFolderId(): Promise<string> {
    const id = await this.ensureFolderId();
    if (await driveFileIsLive(await this.getToken(), id)) return id;
    const { folderId: _gone, subfolders: _under, folderName: _named, ...rest } = this.stored ?? {};
    this.stored = rest;
    setSignIn(CONFIG_KEY, this.stored, this.gen);
    return this.ensureFolderId();
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
    setSignIn(CONFIG_KEY, this.stored, this.gen);
    return id;
  }

  /**
   * Self-heal the folder's display name after a brand rename — covers folders
   * whose id was cached before the rename (the find/create paths can't see
   * them). Marked done once Drive accepts one PATCH per device per rename;
   * cosmetic, never blocks.
   */
  private async ensureFolderName(folderId: string, knownName?: string): Promise<void> {
    if (this.stored?.folderName === FOLDER_NAME) return;
    try {
      if (knownName !== FOLDER_NAME) {
        const res = await fetch(`${DRIVE_API}/files/${folderId}`, {
          method: 'PATCH',
          headers: { ...(await this.authHeaders()), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER_NAME }),
        });
        if (this.stored?.folderId !== folderId || (!res.ok && res.status !== 404)) return; // replaced, or refused: retried; a gone folder is done (US-09 AC40)
      }
      this.stored = { ...(this.stored ?? {}), folderName: FOLDER_NAME };
      setSignIn(CONFIG_KEY, this.stored, this.gen);
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
    const id = await driveEnsureSubfolder(await this.getToken(), folderName, parentId);
    this.stored = {
      ...(this.stored ?? {}),
      subfolders: { ...(this.stored?.subfolders ?? {}), [folderName]: id },
    };
    setSignIn(CONFIG_KEY, this.stored, this.gen);
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

  private async findFileId(name: string): Promise<string | undefined> {
    return driveFindFileId(await this.getToken(), name, undefined, undefined, true);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  /** Valid cached token → server refresh → otherwise interaction is needed. */
  private async getToken(): Promise<string> {
    const refreshed = this.hasValidToken() ? 'ok' : await this.refresh(); // 'none': no grant to refresh with; 'transient' may pass
    if (refreshed === 'ok') return this.tokens!.accessToken;
    throw new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, refreshed === 'none' ? 'reconnect' : undefined); // US-09 AC30
  }

  /** FALLBACK reconnect: a GIS popup grant (~1 h token, no refresh token), which
   *  works even with the exchange endpoint down. It writes nothing: savePopupGrant
   *  (drive-popup-grant.ts) keeps it (US-09 AC45). Needs a user gesture: with GIS
   *  loaded, the popup opens synchronously inside the click; otherwise it waits for the load. */
  acquireViaPopup(): Promise<{ accessToken: string; expiresAt: number }> {
    return gisReady() ? this.requestGisToken() : loadGis().then(() => this.requestGisToken());
  }

  private requestGisToken(): Promise<{ accessToken: string; expiresAt: number }> {
    return new Promise((resolve, reject) => {
      const client = gis()!.accounts.oauth2.initTokenClient({
        client_id: this.config.clientId,
        scope: this.config.scope,
        callback: (r) => {
          if (r.error || !r.access_token) {
            reject(new StorageError(`Google Drive authorization failed${r.error ? `: ${r.error}` : ''}.`));
            return;
          }
          if (!grantsDrive(r.scope)) {
            reject(new DriveGrantRefusedError());
            return;
          }
          resolve({ accessToken: r.access_token, expiresAt: expiry(r.expires_in) });
        },
        error_callback: () => reject(new StorageError('Google Drive sign-in was cancelled or blocked.')),
      });
      client.requestAccessToken({ prompt: '' });
    });
  }
}
