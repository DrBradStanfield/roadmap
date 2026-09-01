/**
 * Self-host (WebDAV) storage adapter — the privacy-maximalist / own-server
 * backend (implementation plan §4.1). The user points it at any WebDAV directory
 * they control (Nextcloud, ownCloud, Apache mod_dav, …) with Basic-auth
 * credentials. Folder-scoped by construction: every path is relative to the one
 * directory URL the user supplies.
 *
 * Optimistic concurrency uses the WebDAV ETag (mirrors Dropbox `rev` / GitHub
 * `sha`): read returns the ETag, write is conditional (`If-Match` on update),
 * 412 → ConflictError → the SyncManager re-reads, re-merges, retries.
 *
 * SELF-HOST REQUIREMENTS (the user configures these on their server):
 *   - CORS: allow the app origin for GET/PUT/PROPFIND/MKCOL, and expose the
 *     `ETag` response header (Access-Control-Expose-Headers: ETag).
 *   - A server that returns ETags (Nextcloud/ownCloud/mod_dav do). Without them
 *     writes degrade to last-write-wins — see the implementation build log.
 * iOS note: WebDAV is the only self-host path on iOS (no File System Access API).
 */
import {
  ConflictError,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';
import { bytesToBase64 } from '../lib/base64';

const CONFIG_KEY = 'health_roadmap_selfhost';

export interface WebDavConfig {
  /** Base WebDAV directory URL the app confines itself to (trailing slash optional). */
  url: string;
  username: string;
  password: string;
}

function loadConfig(): WebDavConfig | null {
  return getJson<WebDavConfig>(CONFIG_KEY);
}

/** UTF-8-safe Basic credential (handles non-ASCII passwords). */
function basicAuth(username: string, password: string): string {
  return `Basic ${bytesToBase64(new TextEncoder().encode(`${username}:${password}`))}`;
}

export class WebDavAdapter implements StorageAdapter {
  readonly id = 'self-host' as const;
  readonly label = 'Self-host (WebDAV)';
  private config: WebDavConfig | null;

  /** First connect: pass the config. Reconnect: omit, loads from storage. */
  constructor(config?: WebDavConfig) {
    this.config = config ?? loadConfig();
  }

  isConnected(): boolean {
    return !!(this.config?.url && this.config.username);
  }

  /** Validate reachability + credentials with a PROPFIND, then persist. */
  async connect(): Promise<void> {
    if (!this.config?.url || !this.config.username) {
      throw new StorageError('Self-host needs a URL, username, and password.');
    }
    const res = await fetch(this.urlFor(''), {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), Depth: '0' },
    });
    if (res.status === 401) throw new StorageError('Self-host rejected the credentials.');
    // 207 Multi-Status is the WebDAV success for PROPFIND.
    if (!res.ok && res.status !== 207) {
      throw new StorageError(`Self-host connect failed (${res.status}). Check the URL and the server's CORS settings.`);
    }
    setJson(CONFIG_KEY, this.config);
  }

  async disconnect(): Promise<void> {
    this.config = null;
    safeRemoveItem(CONFIG_KEY);
  }

  // --- file ops -------------------------------------------------------------

  async read(fileName: string): Promise<ReadResult> {
    const res = await fetch(this.urlFor(fileName), { headers: this.authHeaders() });
    if (res.status === 404) return { body: null, version: null };
    if (!res.ok) throw new StorageError(`Self-host read failed (${res.status}): ${await res.text()}`);
    const etag = res.headers.get('etag');
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text)) : null;
    } catch (error) {
      throw new StorageError('Self-host read failed: file is not valid JSON (possible corruption).', undefined, error);
    }
    return { body, version: etag };
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    const headers: Record<string, string> = { ...this.authHeaders(), 'Content-Type': 'application/json' };
    // Conditional update when we have an ETag; otherwise an unconditional PUT
    // (genuine first create, or a server that doesn't return ETags → LWW).
    if (expectedVersion) headers['If-Match'] = expectedVersion;
    const res = await fetch(this.urlFor(fileName), { method: 'PUT', headers, body: JSON.stringify(body) });
    if (res.status === 412) {
      throw new ConflictError('Self-host write conflict: the file changed since last read.');
    }
    if (!res.ok) throw new StorageError(`Self-host write failed (${res.status}): ${await res.text()}`);
    // Prefer the ETag from the PUT response; fall back to a HEAD if the server
    // didn't include it. '' = the server exposes no ETag → next write is LWW.
    let etag = res.headers.get('etag');
    if (!etag) {
      try {
        const head = await fetch(this.urlFor(fileName), { method: 'HEAD', headers: this.authHeaders() });
        etag = head.headers.get('etag');
      } catch {
        /* HEAD unsupported/blocked — degrade to LWW */
      }
    }
    return { version: etag ?? '' };
  }

  async readDocument(ref: string): Promise<Blob> {
    const res = await fetch(this.urlFor(ref), { headers: this.authHeaders() });
    if (!res.ok) throw new StorageError(`Self-host document read failed (${res.status}): ${ref}`);
    return res.blob();
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const put = (): Promise<Response> =>
      fetch(this.urlFor(ref), { method: 'PUT', headers: this.authHeaders(), body: bytes });
    let res = await put();
    if (res.status === 409) {
      // Parent collection missing — create it, then retry once.
      await this.ensureCollection(ref);
      res = await put();
    }
    if (!res.ok) throw new StorageError(`Self-host document write failed (${res.status}): ${ref}`);
  }

  // --- helpers --------------------------------------------------------------

  /** MKCOL the parent collection of `ref` (e.g. 'documents/'). Ignores "exists". */
  private async ensureCollection(ref: string): Promise<void> {
    const slash = ref.lastIndexOf('/');
    if (slash < 0) return;
    await fetch(this.urlFor(ref.slice(0, slash + 1)), { method: 'MKCOL', headers: this.authHeaders() });
  }

  private urlFor(path: string): string {
    if (!this.config) throw new StorageError('Self-host is not connected.');
    return this.config.url.replace(/\/?$/, '/') + path;
  }

  private authHeaders(): Record<string, string> {
    if (!this.config) throw new StorageError('Self-host is not connected.');
    return { Authorization: basicAuth(this.config.username, this.config.password) };
  }
}
