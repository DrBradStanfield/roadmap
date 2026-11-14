/**
 * Dropbox storage adapter — the default backend for the grandma avatar
 * (implementation plan §4.1: cleanest of the four because Dropbox grants a
 * genuine long-lived client-side refresh token via PKCE).
 *
 * SCOPING (HARD requirement): this must be registered as a Dropbox **"App
 * folder"** app, NOT "Full Dropbox". That confines every path below to a
 * dedicated `/Apps/Health Plan by Dr Brad` folder — the app physically cannot read the
 * rest of the user's Dropbox. All paths here are therefore app-folder-relative.
 *
 * Required Dropbox app console settings:
 *   - Type: Scoped access → App folder
 *   - Permissions: files.content.read, files.content.write
 *   - OAuth 2 redirect URIs: every front-door origin (GitHub Pages, the Shopify
 *     test page, production) — e.g. https://drbradstanfield.github.io/roadmap/
 *   - PKCE: enabled (no client secret in the browser)
 *
 * Brad supplies the app key (client id) via DropboxConfig; there is no secret.
 */
import { dropboxDownload, dropboxListFolder, dropboxRead, dropboxUploadDocument, dropboxWrite, DROPBOX_TOKEN_URL } from '@roadmap/health-core/dropbox-rest';
import { fetchOrFail, ROADMAP_FILE_NAME, sleepUntilAborted, catchUpAfterFailure, StorageError, type ReadResult, type StorageAdapter, type WriteResult } from '@roadmap/health-core/adapter';
import { TRANSFER_DEADLINE_MS, timeoutDeadline } from '@roadmap/health-core/transfer-deadline';
import { getSignIn, logOffId, setSignIn, setSignIns, safeRemoveItem, type LogOffId } from '../lib/storage';
import { claimRedirectCancel, claimRedirectCode, deriveCodeChallenge, generateCodeVerifier, generateState, pkceEntry } from './pkce';
import { refreshOnce } from './token-flight';
import { isSignedOut, signInEnded } from './sign-in-state';

export const TOKEN_KEY = 'health_roadmap_dropbox_tokens';
/** Dropbox was chosen and signed in to, as Drive's config says it (US-09 AC48): an empty object, kept
 *  when a revoked sign-in forgets the tokens, so a reload shows the reconnect panel, not the guest pitch.
 *  A sign-in entry (AC45): removed by disconnect, log-off and the load sweep; an erase keeps it. */
export const CONFIG_KEY = 'health_roadmap_dropbox';
const PKCE_KEY = 'health_roadmap_dropbox_pkce';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = DROPBOX_TOKEN_URL;
const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_FOLDER_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
/** The long-poll lives on its own host BECAUSE it holds the connection open —
 *  Dropbox keeps those off the API host, and takes no Authorization header
 *  there (spec: `host = "notify"`, `auth = "noauth"`; the cursor is the
 *  credential). It is CORS-enabled, so the browser can call it directly. */
const LONGPOLL_URL = 'https://notify.dropboxapi.com/2/files/list_folder/longpoll';
const ACCOUNT_URL = 'https://api.dropboxapi.com/2/users/get_current_account';
/** Dropbox's own minimum, and its default. Seconds. */
const LONGPOLL_TIMEOUT_S = 30;
/** Dropbox holds a quiet long-poll its timeout plus up to 90 s of jitter
 *  (spec: `list_folder/longpoll`), so it is given up only after that and one
 *  ordinary call's 30 s more (US-34 AC1c). */
const LONGPOLL_DEADLINE_MS = (LONGPOLL_TIMEOUT_S + 90) * 1_000 + TRANSFER_DEADLINE_MS.call;
/** First retry after a failed poll, doubling to this ceiling. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface DropboxConfig {
  /** Dropbox app key (client id). No secret — PKCE only. */
  clientId: string;
  /** Must exactly match a redirect URI registered in the Dropbox app console. */
  redirectUri: string;
}

interface DropboxTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

function loadTokens(): DropboxTokens | null {
  return getSignIn<DropboxTokens>(TOKEN_KEY);
}

function saveTokens(tokens: DropboxTokens, gen: LogOffId): boolean {
  return setSignIn(TOKEN_KEY, tokens, gen);
}

/** A token reply holds a non-empty access token and a finite expiry, and at
 *  connect a refresh token; otherwise it is refused and nothing is kept
 *  (US-09 AC1a). Unchecked, it stored `undefined` or a NaN expiry. */
function tokenReply(json: unknown, needsRefresh: boolean): { access_token: string; refresh_token: string; expires_in: number } {
  const t = (json ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  const ok = (v: unknown) => typeof v === 'string' && v !== '';
  if (!ok(t.access_token) || !Number.isFinite(t.expires_in) || (needsRefresh && !ok(t.refresh_token))) {
    throw new StorageError('Dropbox sent an incomplete sign-in reply. Please reconnect.');
  }
  return t as { access_token: string; refresh_token: string; expires_in: number };
}

export class DropboxAdapter implements StorageAdapter {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox';
  private tokens: DropboxTokens | null;

  /** `gen`: the log-off id this sign-in began under, which its saves carry (US-09 AC45). */
  constructor(private readonly config: DropboxConfig, readonly gen: LogOffId = logOffId()) {
    this.tokens = loadTokens();
    // A sign-in from before the config key gets one now, under this adapter's log-off id (tokens under an older
    // id read as none), so a refresh that forgets the tokens still leaves the panel (US-09 AC48, Codex R3).
    if (this.tokens && getSignIn(CONFIG_KEY) === null) setSignIn(CONFIG_KEY, {}, this.gen);
  }

  isConnected(): boolean {
    return !!this.tokens?.refreshToken || getSignIn(CONFIG_KEY) !== null;
  }

  /**
   * Begin the PKCE redirect. This NAVIGATES AWAY, so the returned promise never
   * resolves in this page load — the flow completes on the return page via
   * `DropboxAdapter.completeRedirect()`.
   */
  async connect(): Promise<void> {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    const state = generateState();
    try {
      sessionStorage.setItem(PKCE_KEY, pkceEntry(verifier, state, this.gen));
    } catch {
      throw new StorageError('Cannot start Dropbox sign-in: session storage is blocked.');
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('token_access_type', 'offline'); // genuine refresh token
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
   * Call once on the redirect-return page load. If the URL carries an OAuth
   * `code`, exchanges it for tokens and returns a connected adapter; otherwise
   * returns null (not a return from Dropbox).
   */
  static async completeRedirect(config: DropboxConfig): Promise<DropboxAdapter | null> {
    const claimed = claimRedirectCode(PKCE_KEY); // null when the ?code isn't ours
    if (!claimed) return null;

    const body = new URLSearchParams({
      code: claimed.code,
      grant_type: 'authorization_code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code_verifier: claimed.verifier,
    });
    // Bounded (US-09 AC1a): the page waits on this before it draws anything,
    // so a network that never answers would leave the loading skeleton for good.
    const res = await fetchOrFail('Dropbox', TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      throw new StorageError(`Dropbox token exchange failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
    }
    // A body that is not JSON (a wifi sign-in page) is an incomplete reply too.
    const json = tokenReply(await res.json().catch(() => null), true);
    const saved = setSignIns({
      [TOKEN_KEY]: { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + json.expires_in * 1000 } satisfies DropboxTokens,
      [CONFIG_KEY]: {},
    }, claimed.gen);
    // Strip ?code/&state from the URL so a refresh doesn't re-trigger.
    window.history.replaceState({}, '', config.redirectUri);
    return saved ? new DropboxAdapter(config, claimed.gen) : null;
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
    safeRemoveItem(CONFIG_KEY); // first, so no other tab reads a forgotten sign-in (US-09 AC48)
    safeRemoveItem(TOKEN_KEY);
  }

  // --- file ops -------------------------------------------------------------

  read(fileName: string): Promise<ReadResult> {
    return this.readFile(fileName).catch(this.refused);
  }

  private async readFile(fileName: string): Promise<ReadResult> {
    const token = await this.accessToken();
    // A secondary file (chat-history.json before the first chat) is often
    // absent, and files/download answers absence with a 409 the browser logs
    // as a console error on every load. The root listing says so with a 200.
    // The record is never probed: hot path, and present after the first write.
    if (fileName !== ROADMAP_FILE_NAME && !(await dropboxListFolder(token, '')).some((e) => e.name === fileName)) {
      return { body: null, version: null };
    }
    return dropboxRead(token, fileName);
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    return dropboxWrite(await this.accessToken(), fileName, body, expectedVersion).catch(this.refused);
  }

  async readDocument(ref: string): Promise<Blob> {
    return new Blob([await dropboxDownload(await this.accessToken(), ref).catch(this.refused)]);
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    return dropboxUploadDocument(await this.accessToken(), ref, bytes).catch(this.refused);
  }

  // --- change signal (US-34) -------------------------------------------------

  /**
   * Tell the store when the app folder moved, within about a second, by
   * holding a long-poll open against it. The cursor covers the app folder
   * root, not one file: the record lives there, and a cursor per file would be
   * a second held connection to learn the same thing. Uploaded documents are
   * written at that same root, so a document write wakes the poll too; the
   * re-read it triggers announces nothing unless the record's own content
   * changed. `recursive: false` keeps the cursor to the root itself.
   */
  watch(_fileName: string, onChange: () => void, signal: AbortSignal): void {
    void this.watchLoop(onChange, signal);
  }

  private async watchLoop(onChange: () => void, signal: AbortSignal): Promise<void> {
    let cursor: string | null = null;
    let retryMs = 0;
    // A sign-in this page knows has ended stops it until a reload (US-09 AC48).
    while (!signal.aborted && !isSignedOut(this.id)) {
      try {
        // A cursor is dropped on every failure, so this re-establishes it: the
        // one Dropbox refused may be expired, and re-listing is cheap.
        if (!cursor) {
          cursor = await this.folderCursor(signal);
          catchUpAfterFailure(retryMs, signal, onChange);
        }
        const poll = await this.rpc(LONGPOLL_URL, { cursor, timeout: LONGPOLL_TIMEOUT_S }, signal, false, LONGPOLL_DEADLINE_MS);
        const result = (await poll.json()) as { changes?: boolean; backoff?: number };
        // Dropbox asking for room comes before anything else we do with it.
        if (result.backoff) await sleepUntilAborted(result.backoff * 1000, signal);
        if (result.changes) {
          // Advancing the cursor first is what keeps the next poll from
          // returning the same change forever.
          cursor = await this.continueCursor(cursor, signal);
          if (!signal.aborted) onChange();
        }
        retryMs = 0;
      } catch {
        // A dropped connection, an expired cursor, a 429: all the same answer
        // — wait longer each time, then start over with a fresh cursor. An
        // abort is not a failure; the loop condition catches it.
        cursor = null;
        retryMs = Math.min(retryMs ? retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
        await sleepUntilAborted(retryMs, signal);
      }
    }
  }

  /** A cursor for the app folder root as it stands now. */
  private async folderCursor(signal: AbortSignal): Promise<string> {
    const res = await this.rpc(LIST_FOLDER_URL, { path: '', recursive: false }, signal, true);
    return this.cursorOf(res);
  }

  private async continueCursor(cursor: string, signal: AbortSignal): Promise<string> {
    const res = await this.rpc(LIST_FOLDER_CONTINUE_URL, { cursor }, signal, true);
    return this.cursorOf(res);
  }

  private async cursorOf(res: Response): Promise<string> {
    const json = (await res.json()) as { cursor?: string };
    if (!json.cursor) throw new StorageError('Dropbox returned no cursor.');
    return json.cursor;
  }

  /** One JSON-in/JSON-out Dropbox call, under `fetchOrFail`'s 30 s call bound
   *  unless it passes its own: the long-poll's own timeout is 30 s, so it
   *  passes a longer one. */
  private async rpc(url: string, body: object | null, signal: AbortSignal, authed: boolean, timeoutMs?: number): Promise<Response> {
    const res = await fetchOrFail('Dropbox', url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authed ? { Authorization: `Bearer ${await this.accessToken()}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
      timeoutMs,
    });
    if (!res.ok) this.refused(new StorageError(`Dropbox call failed (${res.status}).`, undefined, undefined, res.status));
    return res;
  }

  // --- auth helpers ---------------------------------------------------------

  /**
   * The account's verified email, read HERE in the browser for the reminders
   * opt-in (US-17 AC7): only the address crosses to Brad's server, never the
   * access token that used to prove it. Throws on a transient failure (the
   * caller retries next visit) — a Dropbox account always has an email.
   */
  async accountEmail(): Promise<string> {
    // This deadline counts the token refresh too (US-09 AC13g); the call's own bound is the same number.
    const deadline = timeoutDeadline(TRANSFER_DEADLINE_MS.accountEmail);
    let account: { email?: string; email_verified?: boolean };
    try {
      account = (await (await this.rpc(ACCOUNT_URL, null, deadline.signal, true, TRANSFER_DEADLINE_MS.accountEmail)).json()) as typeof account;
    } finally {
      deadline.clear();
    }
    if (!account.email || account.email_verified !== true) throw new StorageError('Dropbox has not verified this account\'s email.');
    return account.email.toLowerCase();
  }

  /** Dropbox refused the access token (an API 401): it is not used again, so the next call refreshes
   *  and the refresh decides (US-09 AC48). Rethrows: the 401 still fails this call. */
  private readonly refused = (error: unknown): never => {
    if (error instanceof StorageError && error.status === 401 && this.tokens) this.tokens = { ...this.tokens, expiresAt: 0 };
    throw error;
  };

  private async accessToken(): Promise<string> {
    if (!this.tokens) throw new StorageError('Dropbox is not connected.', undefined, undefined, undefined, 'reconnect'); // a forgotten sign-in
    // Refresh a minute before expiry. A page signed out sends a cached token to the refresh too, which
    // refuses it: no adapter goes on using a sign-in this page knows has ended (US-09 AC48, Codex R2).
    if (Date.now() >= this.tokens.expiresAt - 60_000 || isSignedOut(this.id)) await this.refresh();
    return this.tokens.accessToken;
  }

  private async refresh(): Promise<void> {
    // No grant, or one this page knows is dead: only a new sign-in mends it, so nothing is posted (US-09 AC48).
    if (!this.tokens?.refreshToken || isSignedOut(this.id)) throw new StorageError('Dropbox session expired — please reconnect.', undefined, undefined, undefined, 'reconnect');
    const startedFrom = this.tokens.refreshToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: startedFrom,
      client_id: this.config.clientId,
    });
    // Bounded like Drive's refresh (US-09 AC13h): every read and save waits on it.
    // One flight per page and grant (US-09 AC47); each caller reads its own copy of the answer.
    const res = await refreshOnce('dropbox', startedFrom, () => fetchOrFail('Dropbox', TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: TRANSFER_DEADLINE_MS.tokenRefresh,
    })).then((shared) => shared.clone(), (error: unknown) => {
      this.dropIfGrantMoved(startedFrom);
      throw error;
    });
    if (!res.ok) {
      // A 400 or 401 refuses the sign-in: it ends here (US-09 AC48). Only invalid_grant, a revoked
      // token, forgets it, as Drive does (AC47, Brad B-2); the config stays, so a reload shows the panel.
      const refused = res.status === 400 || res.status === 401;
      const revoked = refused && ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error === 'invalid_grant';
      this.dropIfGrantMoved(startedFrom); // after the last await
      if (revoked) {
        this.tokens = null;
        safeRemoveItem(TOKEN_KEY);
      }
      if (refused) signInEnded(this.id, this.gen);
      throw new StorageError(`Dropbox token refresh failed (${res.status}) — please reconnect.`, undefined, undefined, res.status, refused ? 'reconnect' : undefined);
    }
    const reply: unknown = await res.json().catch(() => null);
    this.dropIfGrantMoved(startedFrom);
    const json = tokenReply(reply, false);
    this.tokens = {
      ...this.tokens,
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    saveTokens(this.tokens, this.gen);
  }

  /**
   * Disconnect and a sign-in elsewhere run on other adapters, so the stored
   * grant is the only shared truth. Read after a refresh's last await: if it is
   * no longer the grant the refresh started from, this adapter keeps nothing
   * and leaves storage alone. A replaced grant may be another account, so it
   * is never adopted (US-09 AC2f). A grant gone while the config stays is
   * another tab's invalid_grant: this page's sign-in ended too (US-09 AC48).
   */
  private dropIfGrantMoved(startedFrom: string): void {
    const stored = loadTokens();
    if (stored?.refreshToken === startedFrom) return;
    this.tokens = null;
    const ended = !stored && getSignIn(CONFIG_KEY) !== null;
    if (ended) signInEnded(this.id, this.gen);
    throw new StorageError('Dropbox was disconnected — please reconnect.', undefined, undefined, undefined, ended ? 'reconnect' : undefined);
  }
}
