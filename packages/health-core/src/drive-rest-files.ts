/**
 * Google Drive v3 file calls: the constants, the request helpers and the
 * per-file primitives (find, create, upload, download, version, liveness,
 * the version-checked update). Moved whole out of drive-rest.ts (file budget);
 * drive-rest.ts re-exports the public names, so callers import from there.
 */
import {
  ConflictError,
  fetchOrFail,
  jsonBody,
  StorageError,
  type StoredFile,
} from './adapter';
import { documentUploadMs, TRANSFER_DEADLINE_MS } from './transfer-deadline';

/** Exported for the browser adapter's two cosmetic PATCHes (rename, re-parent). */
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** Everything the app creates lives here (parity with Dropbox's app folder). */
export const DRIVE_FOLDER_NAME = 'Health Plan by Dr Brad';
/** Pre-rename folder name (the brand moved off "roadmap", 2026-06-10). */
export const DRIVE_LEGACY_FOLDER_NAME = 'Health Roadmap by Dr Brad';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** The only scope. `drive.file` is non-sensitive: brand verification, no CASA. */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function auth(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Drive's query language quotes with `'` and escapes with `\`, so a name
 *  must escape both, the backslash first. Otherwise a name ending in `\`
 *  swallows its closing quote and breaks the query. */
function quoted(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The provider's user-facing name. One copy: the adapter's `label`, the
 *  non-ok message below, and every `request()` failure all read it from here. */
export const PROVIDER = 'Google Drive';

/** `fetch` with this module's provider name already bound, so no call site can
 *  hand `fetchOrFail` the wrong one. Reach for this, never the bare global. */
export const request = (url: string | URL, init?: Parameters<typeof fetchOrFail>[2]): Promise<Response> => fetchOrFail(PROVIDER, url, init);

export async function fail(what: string, res: Response): Promise<never> {
  throw new StorageError(`${PROVIDER} ${what} failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
}

/** Find one file by name, optionally inside one parent. Undefined = not there.
 *  First match: named files (chat history, documents) keep it on purpose. The
 *  record has its own every-copy discovery below (US-10 AC4a). `oldestFirst`
 *  makes the match the oldest copy, so every device picks the same one. */
export async function driveFindFileId(
  accessToken: string,
  name: string,
  parentId?: string,
  signal?: AbortSignal,
  oldestFirst = false,
): Promise<string | undefined> {
  const q = encodeURIComponent(
    `name='${quoted(name)}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const order = oldestFirst ? '&orderBy=createdTime' : '';
  const res = await request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id)&pageSize=1${order}`, {
    headers: auth(accessToken),
    signal,
  });
  if (!res.ok) await fail('lookup', res);
  return (await jsonBody<{ files?: Array<{ id: string }> }>(res)).files?.[0]?.id;
}

/**
 * Find the app folder by any of the names it has ever had, so a user who
 * connected before the 2026-06 rename is not given a second folder.
 */
export async function driveFindFolder(
  accessToken: string,
  names: readonly string[] = [DRIVE_FOLDER_NAME, DRIVE_LEGACY_FOLDER_NAME],
  parentId?: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string } | undefined> {
  const anyName = names.map((name) => `name='${quoted(name)}'`).join(' or ');
  const q = encodeURIComponent(
    `(${anyName}) and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const res = await request(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=1`, {
    headers: auth(accessToken),
    signal,
  });
  if (!res.ok) await fail('folder lookup', res);
  return (await jsonBody<{ files?: Array<{ id: string; name: string }> }>(res)).files?.[0];
}

export async function driveCreateFolder(accessToken: string, name: string, parentId?: string, signal?: AbortSignal): Promise<string> {
  const res = await request(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { ...auth(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, ...(parentId ? { parents: [parentId] } : null) }),
    signal,
  });
  if (!res.ok) await fail('folder create', res);
  const id = (await jsonBody<{ id?: string }>(res)).id;
  if (!id) throw new StorageError(`${PROVIDER} folder create returned no id.`);
  return id;
}

/** Find-or-create the folder `name` inside `parentId`: a document folder
 *  such as 'Lab results', for the browser adapter and the opted-in one. */
export async function driveEnsureSubfolder(accessToken: string, name: string, parentId: string): Promise<string> {
  return (await driveFindFolder(accessToken, [name], parentId))?.id ?? (await driveCreateFolder(accessToken, name, parentId));
}

/**
 * The app's own files whose name starts with `prefix` — the connector's
 * pending imports (US-35 AC7). Drive has no folders in a name, so
 * `imports/pending-x.json` is one flat name; `drive.file` already limits the
 * answer to files this app created.
 */
export async function driveListByPrefix(accessToken: string, prefix: string, signal?: AbortSignal): Promise<StoredFile[]> {
  const q = encodeURIComponent(`name contains '${quoted(prefix)}' and trashed = false`);
  const res = await request(`${DRIVE_API}/files?q=${q}&fields=files(id,name,size,modifiedTime)&pageSize=100`, { headers: auth(accessToken), signal });
  if (!res.ok) await fail('list', res);
  const files = (await jsonBody<{ files?: Array<{ id: string; name: string; size?: string; modifiedTime?: string }> }>(res)).files ?? [];
  return files.filter((f) => f.name.startsWith(prefix)).map((f) => ({ name: f.name, ref: f.id, size: Number(f.size ?? 0), modified: f.modifiedTime ?? '' }));
}

/** Delete one file by id. Already gone (404) is not a failure. */
export async function driveDelete(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const res = await request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: auth(accessToken), signal });
  if (!res.ok && res.status !== 404) await fail('delete', res);
}

/** Create a file inside `parentId` — metadata and content in one multipart POST. */
export function driveCreateFile(
  accessToken: string,
  name: string,
  contentType: string,
  content: Blob | string,
  parentId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const metadata = { name, parents: [parentId] };
  const boundary = 'rm_boundary_health_roadmap';
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return request(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
    method: 'POST',
    headers: { ...auth(accessToken), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    // A record file is a few KB and answers inside the default bound; an
    // uploaded document is up to 10 MB, which a slow phone uplink spends
    // minutes sending, so the bound scales with the bytes.
    timeoutMs: documentUploadMs(body.size),
    signal, mayHaveWritten: true, // a create with no answer may have landed (US-09 AC43)
  });
}

/**
 * Store one uploaded document inside `parentId`. Created directly, with no
 * pre-write existence lookup (it halved every upload's round trips for a case
 * that can't happen: refs are unique by construction, collision-suffixed
 * against the file's refs + content-hash deduped). The one exception —
 * retrying after an interrupted save left an orphan blob — produces a
 * same-named duplicate with identical bytes, which Drive allows and
 * `driveDownloadDocument` resolves by name; accepted orphan semantics (§5.3).
 */
export async function driveUploadDocument(accessToken: string, name: string, bytes: Blob, parentId: string): Promise<void> {
  const res = await driveCreateFile(accessToken, name, bytes.type || 'application/octet-stream', bytes, parentId);
  if (!res.ok) throw new StorageError(`${PROVIDER} document create failed (${res.status}).`, undefined, undefined, res.status);
}

/** The bytes of the document named `name` inside `parentId`, under the document deadline and
 *  the caller's own signal (US-09 AC53); not res.blob(), which the engine shim lacks (US-73 AC12). */
export async function driveDownloadDocument(accessToken: string, name: string, parentId: string, signal?: AbortSignal): Promise<Blob> {
  const id = await driveFindFileId(accessToken, name, parentId, signal);
  if (!id) throw new StorageError(`${PROVIDER} document not found.`, undefined, undefined, undefined, 'not-found');
  const res = await request(`${DRIVE_API}/files/${id}?alt=media`, { headers: auth(accessToken), signal, timeoutMs: TRANSFER_DEADLINE_MS.document });
  if (!res.ok) throw new StorageError(`${PROVIDER} document read failed (${res.status}).`, undefined, undefined, res.status);
  return new Blob([await res.arrayBuffer()], { type: res.headers.get('content-type') ?? '' });
}

/** Overwrite a file's bytes. Unconditional — Drive offers no precondition. */
async function driveUpdateFile(accessToken: string, fileId: string, json: string, signal?: AbortSignal): Promise<string> {
  const res = await request(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { ...auth(accessToken), 'Content-Type': 'application/json' },
    body: json,
    signal, mayHaveWritten: true,
  });
  if (!res.ok) await fail('write', res);
  return JSON.stringify([fileId, String((await jsonBody<{ version?: string }>(res)).version ?? '')]);
}

/**
 * The file's change counter. Drive bumps it on every change, so it is the
 * closest thing to a rev — read-only, which is why it can only ever be
 * compared and never sent as a precondition. Return an opaque token binding
 * that counter to this file ID: another read cannot rebind an older token.
 */
export async function driveFileVersion(accessToken: string, fileId: string, signal?: AbortSignal): Promise<string | null> {
  const res = await request(`${DRIVE_API}/files/${fileId}?fields=version`, { headers: auth(accessToken), signal });
  if (res.status === 404) return null;
  if (!res.ok) await fail('version read', res);
  const version = (await jsonBody<{ version?: string }>(res)).version;
  return version == null ? null : JSON.stringify([fileId, version]);
}

/**
 * Whether a file id from a cache still names a live file: Drive serves a
 * trashed file by id (read, version, PATCH) though a `trashed=false` search
 * leaves it out, and a file deleted for good answers 404. A search result
 * needs no check; a cached id does, or writes land in the trash and, once it
 * is emptied, fail on every save. With `name`, a file renamed away from it is
 * not live either: other devices search by name and would not find it, as the
 * record's known-id check rules (readDriveRecord). Any other failure throws and
 * changes nothing, so a passing error never makes a caller forget an id.
 */
export async function driveFileIsLive(accessToken: string, fileId: string, name?: string, signal?: AbortSignal): Promise<boolean> {
  const res = await request(`${DRIVE_API}/files/${fileId}?fields=id,name,trashed`, { headers: auth(accessToken), signal });
  if (res.status === 404) return false;
  if (!res.ok) await fail('lookup', res);
  const meta = await jsonBody<{ name?: string; trashed?: boolean }>(res);
  return meta.trashed !== true && (name === undefined || meta.name === name);
}

/**
 * Drive's substitute for a conditional write (design §7 step 2), shared by the
 * hosted and the browser adapter. Drive cannot be told "only if the version is
 * still X", so ask it what the version is at the last possible moment and
 * refuse the upload ourselves if it moved. That is a narrower window, not a
 * closed one: `SyncManager`'s verify-after-write is what catches a writer who
 * lands between this check and the upload.
 */
export async function driveUpdateIfVersion(
  accessToken: string,
  fileId: string,
  json: string,
  expectedVersion: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const current = await driveFileVersion(accessToken, fileId, signal);
  if (current !== expectedVersion) {
    throw new ConflictError(
      `${PROVIDER} file identity or version changed since it was read`,
    );
  }
  return driveUpdateFile(accessToken, fileId, json, signal);
}

/** Download a file's bytes as JSON. Null = the file is gone. */
export async function driveDownloadJson(accessToken: string, fileId: string, signal?: AbortSignal): Promise<unknown | null> {
  const res = await request(`${DRIVE_API}/files/${fileId}?alt=media`, { headers: auth(accessToken), signal });
  if (res.status === 404) return null;
  if (!res.ok) await fail('read', res);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StorageError(`${PROVIDER} read failed: file is not valid JSON (possible corruption).`, undefined, error);
  }
}
