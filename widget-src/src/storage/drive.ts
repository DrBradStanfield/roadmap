/**
 * Google Drive storage adapter — the consumer cloud backend (impl plan §4.1).
 *
 * Auth: the Google Identity Services (GIS) TOKEN model — a popup that returns a
 * short-lived (~1h) access token and NO refresh token (browser-only; Safari/ITP
 * may force a re-consent on reload). This differs from Dropbox (genuine
 * client-side refresh) and from the pasted-credential backends. The GIS script is
 * loaded in standalone/index.html.
 *
 * SCOPING: drive.file — the app sees ONLY files it created itself, never the rest
 * of the user's Drive. The record lives as a Drive file named
 * `health-roadmap.json`; its fileId is discovered by name (drive.file makes only
 * the app's own files visible to the query).
 *
 * CONCURRENCY: Drive v3 has no clean conditional write (no ETag/sha/rev
 * equivalent), so writes are last-write-wins. The SyncManager's read-merge-write
 * makes that safe in practice (each write merges the latest read); the file
 * `version` field is surfaced as the version token for change detection.
 */
import type { RoadmapFile } from '@roadmap/health-core';
import {
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';

export interface GoogleDriveConfig {
  clientId: string;
  scope: string;
}

const CONFIG_KEY = 'health_roadmap_gdrive';
const TOKEN_KEY = 'health_roadmap_gdrive_token'; // sessionStorage: survives reloads, dies with the tab
const FILE_NAME = 'health-roadmap.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

interface Stored {
  connected: true;
  fileId?: string;
}

// --- GIS (Google Identity Services) token client typing + loader -------------

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

/** Wait for the GIS script (loaded async in index.html) to become ready. */
function loadGis(): Promise<void> {
  if (gis()?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Inject the GIS script lazily — only when a user actually connects Drive,
    // so Google's script never loads for non-Drive users (privacy + no dep cost).
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
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(private readonly config: GoogleDriveConfig) {
    this.stored = getJson<Stored>(CONFIG_KEY);
    // Google grants no refresh token, so cache the ~1h access token in
    // sessionStorage — otherwise every reload would need a popup, which the
    // browser blocks at page load (no user gesture).
    try {
      const cached = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null') as {
        token: string;
        expiry: number;
      } | null;
      if (cached) {
        this.token = cached.token;
        this.tokenExpiry = cached.expiry;
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  isConnected(): boolean {
    return this.stored?.connected === true;
  }

  /** True if the cached access token is still usable (no popup needed). */
  hasValidToken(): boolean {
    return !!this.token && Date.now() < this.tokenExpiry - 60_000;
  }

  /** Interactive connect: GIS consent popup + an access token, then persist. */
  async connect(): Promise<void> {
    await this.acquireToken(true);
    const fileId = await this.findFileId(); // discover an existing record; ok if none yet
    this.stored = { connected: true, fileId };
    setJson(CONFIG_KEY, this.stored);
  }

  async disconnect(): Promise<void> {
    this.stored = null;
    this.token = null;
    safeRemoveItem(CONFIG_KEY);
    try {
      sessionStorage.removeItem(TOKEN_KEY);
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

  /** Cached token, or a silent (no-popup) re-grant if expired. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token;
    return this.acquireToken(false);
  }

  /** Acquire an access token via GIS. interactive=true allows the consent popup. */
  private acquireToken(interactive: boolean): Promise<string> {
    return loadGis().then(
      () =>
        new Promise<string>((resolve, reject) => {
          const client = gis()!.accounts.oauth2.initTokenClient({
            client_id: this.config.clientId,
            scope: this.config.scope,
            callback: (r) => {
              if (r.error || !r.access_token) {
                reject(new StorageError(`Google Drive authorization failed${r.error ? `: ${r.error}` : ''}.`));
                return;
              }
              this.token = r.access_token;
              this.tokenExpiry = Date.now() + (r.expires_in ?? 3600) * 1000;
              try {
                sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: this.token, expiry: this.tokenExpiry }));
              } catch {
                /* session cache unavailable — popup will be needed after reload */
              }
              resolve(r.access_token);
            },
            error_callback: () => reject(new StorageError('Google Drive sign-in was cancelled or blocked.')),
          });
          client.requestAccessToken({ prompt: interactive ? '' : 'none' });
        }),
    );
  }
}
