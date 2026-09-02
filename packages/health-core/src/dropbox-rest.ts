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
import { ConflictError, fetchOrFail, jsonBody, StorageError, type ReadResult, type StorageAdapter, type WriteResult } from './adapter';

export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';

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
 * Download one app-folder-relative file. A missing file is not an error — it
 * is a user who has not saved yet — so it comes back as an empty read and the
 * caller's `migrate()` turns it into a fresh record.
 */
export async function dropboxRead(accessToken: string, fileName: string): Promise<ReadResult> {
  const res = await request(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: `/${fileName}` }),
    },
  });
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
      'Dropbox-API-Arg': JSON.stringify(arg),
    },
    body: JSON.stringify(body),
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
 * Documents (the uploaded PDFs) are deliberately unreachable: the hosted write
 * surface is append-only clinical values and nothing else. `DriveAdapter` in
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

  read(fileName: string): Promise<ReadResult> {
    return dropboxRead(this.accessToken, fileName);
  }

  write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    return dropboxWrite(this.accessToken, fileName, body, expectedVersion);
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The hosted server does not read uploaded documents.');
  }

  async writeDocument(): Promise<void> {
    throw new StorageError('The hosted server does not write uploaded documents.');
  }
}
