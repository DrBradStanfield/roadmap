/**
 * Google Drive v3, as `fetch` calls and nothing else — plus the adapter the
 * hosted MCP server drives (US-32 Phase 2, design §7 "Drive").
 *
 * Two callers must agree byte for byte about WHICH file the record is: the
 * browser adapter (`widget-src/src/storage/drive.ts`) and this server. Drive
 * has no app folder, so "the record" is a name inside a folder we created, and
 * a server that discovered it differently would happily write a second record
 * beside the user's. So folder and file discovery live here, once, and both
 * adapters call it.
 *
 * SCOPE: `drive.file` only — the app sees the files it created and nothing else
 * of the user's Drive.
 *
 * CONCURRENCY — the whole reason this file has an adapter and `dropbox-rest.ts`
 * does not. Drive v3 removed `etag`, so there is no conditional write. Design
 * §7 specifies the substitute and `DriveAdapter.write` implements it:
 *   1. read with `fields=version`,
 *   2. re-fetch `version` immediately before the upload, and raise
 *      `ConflictError` if it moved,
 *   3. after writing, re-read and assert every row id survived — that step is
 *      `SyncManager.verifyAfterWrite`, which every backend already runs,
 *   4. bounded retry — `SyncManager.save`'s existing loop.
 *
 * Residual, disclosed: step 2 is a check, not a precondition. A writer that
 * lands between the check and the upload is caught only by step 3, so on Drive
 * concurrent writers are durable-by-retry rather than serialised. The browser
 * adapter (`widget-src/src/storage/drive.ts`) runs the same steps 1 and 2.
 */
import {
  ConflictError,
  fetchOrFail,
  ROADMAP_FILE_NAME,
  jsonBody,
  StorageError,
  type DocumentAccess,
  type ReadResult,
  type StorageAdapter,
  type StoredFile,
  type WriteResult,
} from './adapter';
import { readDriveRecord, writeDriveRecord } from './drive-record';
import { splitDocumentRef } from './document-path';

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

function auth(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** Drive's query language quotes with `'`; a name carrying one must escape it. */
function quoted(name: string): string {
  return name.replace(/'/g, "\\'");
}

/** The provider's user-facing name. One copy: the adapter's `label`, the
 *  non-ok message below, and every `request()` failure all read it from here. */
const PROVIDER = 'Google Drive';

/** `fetch` with this module's provider name already bound, so no call site can
 *  hand `fetchOrFail` the wrong one. Reach for this, never the bare global. */
const request = (url: string | URL, init?: RequestInit & { timeoutMs?: number }): Promise<Response> => fetchOrFail(PROVIDER, url, init);

async function fail(what: string, res: Response): Promise<never> {
  throw new StorageError(`${PROVIDER} ${what} failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
}

/** Find one file by name, optionally inside one parent. Undefined = not there.
 * Generic named documents retain unique discovery, including verify-after-write:
 * a cached id can otherwise confirm a private copy beside another device's.
 * Blob reads keep the existing duplicate/orphan semantics. Health records use
 * the paginated union owner in drive-record.ts instead. */
export async function driveFindFileId(
  accessToken: string,
  name: string,
  parentId?: string,
  signal?: AbortSignal,
  requireUnique = false,
): Promise<string | undefined> {
  const q = encodeURIComponent(
    `name='${quoted(name)}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const fields = requireUnique ? 'files(id),nextPageToken,incompleteSearch' : 'files(id)';
  const res = await request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=${fields}&pageSize=${requireUnique ? 2 : 1}`, {
    headers: auth(accessToken),
    signal,
  });
  if (!res.ok) await fail('lookup', res);
  const result = await jsonBody<{ files?: Array<{ id: string }>; nextPageToken?: string; incompleteSearch?: boolean }>(res);
  // Do not select a winner, merge unseen files or delete duplicates here. An
  // incomplete page cannot establish uniqueness either; refuse it safely.
  if (requireUnique && ((result.files?.length ?? 0) > 1 || result.nextPageToken || result.incompleteSearch)) {
    throw new StorageError(
      `${PROVIDER} could not identify a unique record file.`,
      'A save may already have landed. Keep your local copy. Check Drive for duplicate record files or an incomplete search before retrying; no files were removed.',
    );
  }
  return result.files?.[0]?.id;
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
  return (await driveFindFolders(accessToken, names, parentId, signal, 1))[0];
}

/** Every folder by any of `names` (inside `parentId`), up to `pageSize`. */
async function driveFindFolders(
  accessToken: string,
  names: readonly string[],
  parentId: string | undefined,
  signal: AbortSignal | undefined,
  pageSize: number,
): Promise<Array<{ id: string; name: string }>> {
  const anyName = names.map((name) => `name='${quoted(name)}'`).join(' or ');
  const q = encodeURIComponent(
    `(${anyName}) and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const res = await request(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&pageSize=${pageSize}`, {
    headers: auth(accessToken),
    signal,
  });
  if (!res.ok) await fail('folder lookup', res);
  return (await jsonBody<{ files?: Array<{ id: string; name: string }> }>(res)).files ?? [];
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
async function driveListByPrefix(accessToken: string, prefix: string, signal?: AbortSignal): Promise<StoredFile[]> {
  const q = encodeURIComponent(`name contains '${quoted(prefix)}' and trashed = false`);
  const res = await request(`${DRIVE_API}/files?q=${q}&fields=files(id,name,size,modifiedTime)&pageSize=100`, { headers: auth(accessToken), signal });
  if (!res.ok) await fail('list', res);
  const files = (await jsonBody<{ files?: Array<{ id: string; name: string; size?: string; modifiedTime?: string }> }>(res)).files ?? [];
  return files.filter((f) => f.name.startsWith(prefix)).map((f) => ({ name: f.name, ref: f.id, size: Number(f.size ?? 0), modified: f.modifiedTime ?? '' }));
}

/** Delete one file by id. Already gone (404) is not a failure. */
async function driveDelete(accessToken: string, fileId: string, signal?: AbortSignal): Promise<void> {
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
    // minutes sending. Scale the bound with the bytes so the upload is judged
    // on the provider's silence, not on the user's connection.
    timeoutMs: Math.min(300_000, 30_000 + Math.round(body.size / 10_000) * 1_000),
    signal,
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

/** The bytes of the document named `name` inside `parentId`. Bare `fetch` for
 *  the download, as the browser always has: a large original must not be cut
 *  at `fetchOrFail`'s 30-second bound. */
export async function driveDownloadDocument(accessToken: string, name: string, parentId: string): Promise<Blob> {
  const id = await driveFindFileId(accessToken, name, parentId);
  if (!id) throw new StorageError(`${PROVIDER} document not found.`);
  const res = await fetch(`${DRIVE_API}/files/${id}?alt=media`, { headers: auth(accessToken) });
  if (!res.ok) throw new StorageError(`${PROVIDER} document read failed (${res.status}).`, undefined, undefined, res.status);
  return res.blob();
}

/** Overwrite a file's bytes. Unconditional — Drive offers no precondition. */
async function driveUpdateFile(accessToken: string, fileId: string, json: string, signal?: AbortSignal): Promise<string> {
  const res = await request(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { ...auth(accessToken), 'Content-Type': 'application/json' },
    body: json,
    signal,
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

/**
 * One connection's Drive folder, for the life of one request. The access token
 * is minted from the sealed refresh token and dies with the call; the id caches
 * live on the instance, so they die with it too — there is no per-user
 * anything to cache in, by design (§1).
 *
 * Documents (the uploaded PDFs) are deliberately unreachable: the hosted write
 * surface is append-only clinical values and nothing else. Only a caller that
 * passes `{ documents: 'write' }` (the iPhone app's own save) can read or
 * write one; the hosted server never does.
 */
export class DriveAdapter implements StorageAdapter {
  readonly id = 'google-drive' as const;
  readonly label = PROVIDER;
  private readonly fileIds = new Map<string, string>();
  /** Document folder ids by ref folder ('' = the app folder), opted-in only.
   *  The promise is cached, so concurrent first writes share one find-or-create. */
  private readonly documentFolders = new Map<string, Promise<string>>();

  constructor(
    private readonly accessToken: string,
    private readonly options: DocumentAccess = {},
  ) {}

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /**
   * Step 1: read the version FIRST, then the bytes it belongs to.
   *
   * The order is the whole point. A writer landing DURING the download would,
   * with the version read afterwards, hand back their new version number
   * attached to our old bytes — and the pre-upload check in `write` would then
   * find nothing moved, pass, and drop their row with `attempts: 0` and no
   * error anywhere. Reading the version first makes the pair pessimistic
   * instead: worst case the version is stale, the check conflicts, and the
   * save retries. A wasted round trip beats a silent lost update.
   */
  async read(fileName: string, signal?: AbortSignal): Promise<ReadResult> {
    if (fileName === ROADMAP_FILE_NAME) return readDriveRecord(this.accessToken, signal);
    const fileId = await this.findFile(fileName, signal, true);
    if (!fileId) return { body: null, version: null };
    const version = await driveFileVersion(this.accessToken, fileId, signal);
    if (version == null) return { body: null, version: null }; // deleted between the two calls
    const body = await driveDownloadJson(this.accessToken, fileId, signal);
    if (body == null) return { body: null, version: null };
    return { body, version };
  }

  /** Step 2 of design §7 (`driveUpdateIfVersion`); its `ConflictError` sends
   *  `SyncManager.save` round again. */
  async write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult> {
    if (fileName === ROADMAP_FILE_NAME) return writeDriveRecord(this.accessToken, body, expectedVersion, () => this.folderId(signal), signal);
    const json = JSON.stringify(body);
    const fileId = await this.findFile(fileName, signal, true);

    if (!fileId) {
      // A first-ever create. If the caller thought there was a version, the
      // file it read has since been deleted or trashed — never silently
      // re-create it here: re-reading is what turns that into a decision.
      if (expectedVersion !== null) throw new ConflictError(`${PROVIDER} no longer holds that file`);
      const parentId = await this.folderId(signal);
      const res = await driveCreateFile(this.accessToken, fileName, 'application/json', json, parentId, signal);
      if (!res.ok) await fail('create', res);
      const created = await jsonBody<{ id?: string; version?: string }>(res);
      if (!created.id) throw new StorageError(`${PROVIDER} create returned no file id.`);
      this.fileIds.set(fileName, created.id);
      return { version: JSON.stringify([created.id, String(created.version ?? '')]) };
    }

    return { version: await driveUpdateIfVersion(this.accessToken, fileId, json, expectedVersion, signal) };
  }

  async readDocument(ref: string): Promise<Blob> {
    const { name, parentId } = await this.docTarget(ref, 'read');
    return driveDownloadDocument(this.accessToken, name, parentId);
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const { name, parentId } = await this.docTarget(ref, 'write');
    return driveUploadDocument(this.accessToken, name, bytes, parentId);
  }

  async list(folder: string, signal?: AbortSignal): Promise<StoredFile[]> {
    const files = await driveListByPrefix(this.accessToken, `${folder}/`, signal);
    for (const file of files) this.fileIds.set(file.name, file.ref); // so `remove` needs no second search
    return files;
  }

  async remove(fileName: string, signal?: AbortSignal): Promise<void> {
    const fileId = await this.findFile(fileName, signal);
    if (!fileId) return;
    await driveDelete(this.accessToken, fileId, signal);
    this.fileIds.delete(fileName);
  }

  private async findFile(fileName: string, signal?: AbortSignal, requireUnique = false): Promise<string | undefined> {
    const cached = this.fileIds.get(fileName);
    if (cached && !requireUnique) return cached;
    // No parent filter, exactly as the browser adapter searches: `drive.file`
    // already limits the result set to this app's own files, and a record
    // created before the folder existed still lives at the Drive root.
    const found = await driveFindFileId(this.accessToken, fileName, undefined, signal, requireUnique);
    if (found) this.fileIds.set(fileName, found);
    return found;
  }

  /** Where a document ref lives, once the opt-in allows it. Without the
   *  opt-in this is the hosted server's refusal, word for word. */
  private async docTarget(ref: string, verb: 'read' | 'write'): Promise<{ name: string; parentId: string }> {
    if (this.options.documents !== 'write') throw new StorageError(`The hosted server does not ${verb} uploaded documents.`);
    const { folder, name } = splitDocumentRef(ref);
    return { name, parentId: await this.documentFolder(folder) };
  }

  /** Find-or-create a document's folder ('Lab results') inside the app
   *  folder, as the browser adapter does; Drive needs real folder objects. A
   *  failed lookup is dropped from the cache, so the next call retries. */
  private documentFolder(folder: string | null): Promise<string> {
    const key = folder ?? '';
    let pending = this.documentFolders.get(key);
    if (!pending) {
      pending = folder
        ? this.documentFolder(null).then((root) => driveEnsureSubfolder(this.accessToken, folder, root))
        : this.recordFolder();
      this.documentFolders.set(key, pending);
      const settled = pending;
      settled.catch(() => {
        if (this.documentFolders.get(key) === settled) this.documentFolders.delete(key);
      });
    }
    return pending;
  }

  /**
   * The app folder that holds the record: the browser persists its folder id
   * and moves the record into it, so originals filed here land beside the
   * website's. A record with no such parent (none yet, or one left at the
   * Drive root) falls back to the folder found by name.
   */
  private async recordFolder(): Promise<string> {
    const fileId = await this.findFile(ROADMAP_FILE_NAME);
    const res = fileId ? await request(`${DRIVE_API}/files/${fileId}?fields=parents`, { headers: auth(this.accessToken) }) : null;
    const parents = res?.ok ? (await jsonBody<{ parents?: string[] }>(res)).parents ?? [] : [];
    // The app folders by name, the same lookup the record's own folder takes.
    const folders = await driveFindFolders(this.accessToken, [DRIVE_FOLDER_NAME, DRIVE_LEGACY_FOLDER_NAME], undefined, undefined, 10);
    const found = folders.find((f) => parents.includes(f.id)) ?? folders[0];
    return found?.id ?? (await driveCreateFolder(this.accessToken, DRIVE_FOLDER_NAME));
  }

  private async folderId(signal?: AbortSignal): Promise<string> {
    const found = await driveFindFolder(this.accessToken, undefined, undefined, signal);
    return found?.id ?? (await driveCreateFolder(this.accessToken, DRIVE_FOLDER_NAME, undefined, signal));
  }
}
