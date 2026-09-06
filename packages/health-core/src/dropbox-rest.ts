/**
 * Dropbox's content API, as three `fetch` calls and nothing else.
 *
 * Two very different callers need byte-identical Dropbox semantics: the widget
 * adapter in the browser (`widget-src/src/storage/dropbox.ts`) and the hosted
 * MCP server in Node (`app/lib/mcp.server.ts`, US-32). The part that must not
 * drift between them is the conditional write — `strict_conflict` on a
 * rev-conditional update is what stops a stale writer silently re-creating a
 * record the user erased — so the request shapes live here, once, and both
 * adapters call them.
 *
 * Nothing here reads storage, the clock or the DOM: an access token comes in
 * as an argument. Refreshing that token is the caller's business, because the
 * browser refreshes with PKCE and the server refreshes as a confidential
 * client.
 */
import { ConflictError, fetchOrFail, jsonBody, StorageError, type ReadResult, type StorageAdapter, type StoredFile, type WriteResult } from './adapter';

export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const LIST_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const LIST_CONTINUE_URL = 'https://api.dropboxapi.com/2/files/list_folder/continue';
const DELETE_URL = 'https://api.dropboxapi.com/2/files/delete_v2';

/** The provider's user-facing name. One copy: the adapter's `label` and every
 *  message below read it from here. */
const PROVIDER = 'Dropbox';

/** `fetch` with this module's provider name already bound, so no call site can
 *  hand `fetchOrFail` the wrong one. Reach for this, never the bare global. */
const request = (url: string | URL, init?: RequestInit): Promise<Response> => fetchOrFail(PROVIDER, url, init);

/** Parse the `dropbox-api-result` response header (file metadata incl. rev). */
function parseApiResult(res: Response): Record<string, unknown> | null {
  const header = res.headers.get('dropbox-api-result');
  if (!header) return null;
  try {
    return JSON.parse(header) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The `Dropbox-API-Arg` header value for `arg`. HTTP headers carry ISO-8859-1
 * only, and `fetch` throws on anything else before a request leaves the
 * browser (Sentry 7715862604: an em dash in a letter's title). Dropbox's rule
 * for this header is JSON with every non-ASCII code point as `\uXXXX`, which
 * keeps the pretty file name intact. Every content-endpoint call, here and in
 * the widget adapter, builds the header through this — never `JSON.stringify`.
 */
export function dropboxApiArg(arg: object): string {
  return JSON.stringify(arg).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A Dropbox `path` argument: an `id:…` from a listing as is, else a folder-relative name. */
function pathArg(ref: string): string {
  return ref.startsWith('id:') ? ref : `/${ref}`;
}

/** One `files/download`. The two readers below parse its body their own way. */
function download(accessToken: string, ref: string, signal?: AbortSignal): Promise<Response> {
  return request(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': dropboxApiArg({ path: pathArg(ref) }),
    },
    signal,
  });
}

/**
 * Download one app-folder-relative file. A missing file is not an error — it
 * is a user who has not saved yet — so it comes back as an empty read and the
 * caller's `migrate()` turns it into a fresh record.
 */
export async function dropboxRead(accessToken: string, fileName: string, signal?: AbortSignal): Promise<ReadResult> {
  const res = await download(accessToken, fileName, signal);
  if (res.status === 409) return { body: null, version: null }; // path/not_found
  if (!res.ok) throw new StorageError(`${PROVIDER} read failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
  const meta = parseApiResult(res);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new StorageError(`${PROVIDER} read failed: file is not valid JSON (possible corruption).`, undefined, error);
  }
  return { body, version: (meta?.rev as string) ?? null };
}

/**
 * The bytes of one file: a document the widget views, or a lab file the
 * connector imports (US-35 AC2). `ref` is a folder-relative path or a listing
 * entry's `id:…` — the connector downloads by id, so a name an assistant
 * supplied only ever SELECTS from the listing and never forms a path.
 */
export async function dropboxDownload(accessToken: string, ref: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const res = await download(accessToken, ref, signal);
  if (!res.ok) throw new StorageError(`${PROVIDER} download failed (${res.status})`, undefined, undefined, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

/** One folder-relative entry of a listing, as the connector reads it. */
interface DropboxEntry {
  id: string;
  name: string;
  size: number;
  /** ISO 8601 `server_modified`. */
  modified: string;
}

/**
 * The FILES directly under one folder of the app folder (`''` for its root),
 * following `has_more`. Folders are dropped: the record's own document tree
 * is not something an import reads. A folder that does not exist lists as
 * empty, which is what an app folder with no `imports/` yet is.
 */
export async function dropboxListFolder(accessToken: string, folder: string, signal?: AbortSignal): Promise<DropboxEntry[]> {
  const entries: DropboxEntry[] = [];
  let url = LIST_URL;
  let body: object = { path: folder ? `/${folder}` : '', recursive: false, include_deleted: false };
  for (;;) {
    const res = await request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 409 && url === LIST_URL) return []; // path/not_found
    if (!res.ok) throw new StorageError(`${PROVIDER} list failed (${res.status})`, undefined, undefined, res.status);
    const page = await jsonBody<{ entries?: Array<Record<string, unknown>>; cursor?: string; has_more?: boolean }>(res);
    for (const entry of page.entries ?? []) {
      if (entry['.tag'] !== 'file' || typeof entry.id !== 'string' || typeof entry.name !== 'string') continue;
      entries.push({
        id: entry.id,
        name: entry.name,
        size: typeof entry.size === 'number' ? entry.size : 0,
        modified: typeof entry.server_modified === 'string' ? entry.server_modified : '',
      });
    }
    if (!page.has_more || !page.cursor) return entries;
    url = LIST_CONTINUE_URL;
    body = { cursor: page.cursor };
  }
}

/** Remove one folder-relative file. Already gone is not a failure. */
async function dropboxDelete(accessToken: string, fileName: string, signal?: AbortSignal): Promise<void> {
  const res = await request(DELETE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `/${fileName}` }),
    signal,
  });
  if (!res.ok && res.status !== 409) throw new StorageError(`${PROVIDER} delete failed (${res.status})`, undefined, undefined, res.status);
}

/**
 * Upload one app-folder-relative file under an optimistic-concurrency
 * precondition. `expectedVersion` null means first-ever create, which conflicts
 * if anything is already there.
 *
 * `strict_conflict` on the rev-conditional path is load-bearing: without it
 * Dropbox ACCEPTS an update whose rev does not match because the file was
 * DELETED, silently re-creating it — which resurrects a record the user erased
 * (US-11 `eraseEpoch`). With it the write raises, `SyncManager` re-reads, and
 * re-creating becomes an explicit decision made from the merged file.
 */
export async function dropboxWrite(
  accessToken: string,
  fileName: string,
  body: object,
  expectedVersion: string | null,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const arg = {
    path: `/${fileName}`,
    mode: expectedVersion == null ? { '.tag': 'add' } : { '.tag': 'update', update: expectedVersion },
    autorename: false,
    mute: true,
    strict_conflict: expectedVersion != null,
  };
  const res = await request(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': dropboxApiArg(arg),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 409) throw new ConflictError(`${PROVIDER} write conflict: ${await res.text()}`);
  if (!res.ok) throw new StorageError(`${PROVIDER} write failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
  const meta = await jsonBody<{ rev?: string }>(res);
  if (!meta.rev) throw new StorageError(`${PROVIDER} write returned no rev.`);
  return { version: meta.rev };
}

/**
 * One connection's app folder, for the life of one request — the hosted MCP
 * server's Dropbox backend. The access token is minted from the sealed refresh
 * token and dies with the call; nothing is cached between requests, because
 * there is no per-user anything to cache in (design §1).
 *
 * Documents are read (a lab file the user asked the connector to import,
 * US-35) and never written: the hosted write surface is clinical values, plus
 * the import's own pending payload, and nothing else. `DriveAdapter` in
 * `drive-rest.ts` is the same shape for Google.
 */
export class DropboxAdapter implements StorageAdapter {
  readonly id = 'dropbox' as const;
  readonly label = PROVIDER;

  constructor(private readonly accessToken: string) {}

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    return dropboxRead(this.accessToken, fileName, signal);
  }

  write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    return dropboxWrite(this.accessToken, fileName, body, expectedVersion, signal);
  }

  async readDocument(ref: string, signal?: AbortSignal): Promise<Blob> {
    return new Blob([await dropboxDownload(this.accessToken, ref, signal)]);
  }

  async writeDocument(): Promise<void> {
    throw new StorageError('The hosted server does not write uploaded documents.');
  }

  async list(folder: string, signal?: AbortSignal): Promise<StoredFile[]> {
    return (await dropboxListFolder(this.accessToken, folder, signal)).map((e) => ({
      name: folder ? `${folder}/${e.name}` : e.name, ref: e.id, size: e.size, modified: e.modified,
    }));
  }

  remove(fileName: string, signal?: AbortSignal): Promise<void> {
    return dropboxDelete(this.accessToken, fileName, signal);
  }
}
