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
import {
  dropboxRead,
  dropboxWrite,
  DROPBOX_TOKEN_URL,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';
import { claimRedirectCode, deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce';

const TOKEN_KEY = 'health_roadmap_dropbox_tokens';
const PKCE_KEY = 'health_roadmap_dropbox_pkce';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = DROPBOX_TOKEN_URL;
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';

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
  return getJson<DropboxTokens>(TOKEN_KEY);
}

function saveTokens(tokens: DropboxTokens): void {
  setJson(TOKEN_KEY, tokens);
}

export class DropboxAdapter implements StorageAdapter {
  readonly id = 'dropbox' as const;
  readonly label = 'Dropbox';
  private tokens: DropboxTokens | null;

  constructor(private readonly config: DropboxConfig) {
    this.tokens = loadTokens();
  }

  isConnected(): boolean {
    return !!this.tokens?.refreshToken;
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
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
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
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new StorageError(`Dropbox token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    saveTokens({
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    // Strip ?code/&state from the URL so a refresh doesn't re-trigger.
    window.history.replaceState({}, '', config.redirectUri);
    return new DropboxAdapter(config);
  }

  async disconnect(): Promise<void> {
    this.tokens = null;
    safeRemoveItem(TOKEN_KEY);
  }

  // --- file ops -------------------------------------------------------------

  async read(fileName: string): Promise<ReadResult> {
    return dropboxRead(await this.accessToken(), fileName);
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    return dropboxWrite(await this.accessToken(), fileName, body, expectedVersion);
  }

  async readDocument(ref: string): Promise<Blob> {
    const res = await fetch(DOWNLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `/${ref}` }),
      },
    });
    if (!res.ok) throw new StorageError(`Dropbox document read failed (${res.status}): ${ref}`);
    return res.blob();
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const arg = { path: `/${ref}`, mode: { '.tag': 'overwrite' }, autorename: false, mute: true };
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify(arg),
      },
      body: bytes,
    });
    if (!res.ok) throw new StorageError(`Dropbox document write failed (${res.status}): ${ref}`);
  }

  // --- auth helpers ---------------------------------------------------------

  /**
   * A current access token for the reminders opt-in (§10): the server uses it
   * for ONE in-memory get_current_account read of the verified email, then
   * discards it. Never stored server-side.
   */
  getReminderProofToken(): Promise<string> {
    return this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (!this.tokens) throw new StorageError('Dropbox is not connected.');
    // Refresh a minute before expiry.
    if (Date.now() >= this.tokens.expiresAt - 60_000) await this.refresh();
    return this.tokens.accessToken;
  }

  private async refresh(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new StorageError('Dropbox session expired — please reconnect.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.config.clientId,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new StorageError(`Dropbox token refresh failed (${res.status}) — please reconnect.`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens = {
      ...this.tokens,
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    saveTokens(this.tokens);
  }
}
