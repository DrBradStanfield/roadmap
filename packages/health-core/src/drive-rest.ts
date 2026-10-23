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
  LostUpdateError,
  ROADMAP_FILE_NAME,
  jsonBody,
  StorageError,
  type DocumentAccess,
  type ReadResult,
  type StorageAdapter,
  type StoredFile,
  type WriteResult,
} from './adapter';
import { splitDocumentRef } from './document-path';
import { RecordShapeError, SchemaTooNewError } from './migrate';
import { ROADMAP_DOC } from './roadmap-doc';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from './roadmap-file';
import { verifyPersistedFile } from './sync-manager';

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
 *  First match: named files (chat history, documents) keep it on purpose. The
 *  record has its own every-copy discovery below (US-10 AC4a). */
export async function driveFindFileId(
  accessToken: string,
  name: string,
  parentId?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const q = encodeURIComponent(
    `name='${quoted(name)}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const res = await request(`${DRIVE_API}/files?q=${q}&spaces=drive&fields=files(id)&pageSize=1`, {
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

// --- The health record (US-10 AC4a) -------------------------------------------
// Drive allows two files with one name, and two first saves can race to make
// them. Reads merge every copy in memory; saves go to one fixed copy (oldest
// `createdTime`, then id) and leave the others in place. Drive has no CAS:
// enumeration and version checks narrow races, they do not close them.

interface RecordCopy { id: string; createdTime?: string }
const recordContext = () => ({ deviceId: 'drive-record-discovery', now: new Date().toISOString() });
const LANDED_HINT = 'A save may already have landed. Keep your local copy and read the record again. No copies were removed.';
const DAMAGED_HINT = 'Your plan loaded from the other copies. Nothing was written. Saving resumes once that health-roadmap.json in Google Drive is repaired or renamed.';

/** A write that may have landed: keep the provider status, so a 401 still
 *  refreshes the token (iOS) and still reads as "reconnect" (the page). */
function uncertain(message: string, error: unknown): StorageError {
  return new StorageError(message, LANDED_HINT, error, error instanceof StorageError ? error.status : undefined);
}

/**
 * Every copy of the record, winner first. Search lags a create, so an id in
 * `known` (the copies this adapter last found or made) that search misses is
 * asked for by id; `known` leaves holding exactly the copies found.
 */
async function discoverRecord(token: string, known: Set<string>, signal?: AbortSignal): Promise<RecordCopy[]> {
  const copies = new Map<string, RecordCopy>();
  const seen = new Set<string>();
  let page: string | undefined;
  do {
    signal?.throwIfAborted();
    // Shared core also runs in native JS engines without URL/URLSearchParams.
    const query = `q=${encodeURIComponent(`name='${ROADMAP_FILE_NAME}' and trashed=false`)}`
      + '&spaces=drive&fields=files(id%2CcreatedTime)%2CnextPageToken%2CincompleteSearch&pageSize=1000'
      + (page ? `&pageToken=${encodeURIComponent(page)}` : '');
    const res = await request(`${DRIVE_API}/files?${query}`, { headers: auth(token), signal });
    if (!res.ok) throw new StorageError(`${PROVIDER} record lookup failed (${res.status}).`, undefined, undefined, res.status);
    const result = await jsonBody<{ files?: RecordCopy[]; nextPageToken?: string; incompleteSearch?: boolean }>(res);
    signal?.throwIfAborted();
    if (result.incompleteSearch || !Array.isArray(result.files)) throw new StorageError(`${PROVIDER} record enumeration is incomplete.`);
    for (const copy of result.files) {
      if (!copy.id || typeof copy.id !== 'string' || (copy.createdTime !== undefined && (typeof copy.createdTime !== 'string' || !Number.isFinite(Date.parse(copy.createdTime))))) {
        throw new StorageError(`${PROVIDER} record metadata is invalid.`);
      }
      const prior = copies.get(copy.id);
      if (prior && prior.createdTime !== copy.createdTime) throw new StorageError(`${PROVIDER} record metadata changed during enumeration.`);
      copies.set(copy.id, copy);
    }
    if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !result.nextPageToken)) {
      throw new StorageError(`${PROVIDER} record continuation token is invalid.`);
    }
    page = result.nextPageToken;
    if (page) {
      if (seen.has(page)) throw new StorageError(`${PROVIDER} record enumeration repeated a page token.`);
      seen.add(page);
    }
  } while (page);
  for (const id of known) {
    if (copies.has(id)) continue;
    const res = await request(`${DRIVE_API}/files/${id}?fields=id,name,createdTime,trashed`, { headers: auth(token), signal });
    if (res.status === 404) continue;
    if (!res.ok) await fail('record lookup', res);
    const meta = await jsonBody<RecordCopy & { name?: string; trashed?: boolean }>(res);
    if (meta.name === ROADMAP_FILE_NAME && !meta.trashed) copies.set(id, { id, createdTime: meta.createdTime });
  }
  // Legacy/missing creation metadata: use ID order for the entire set, never
  // silently drop a copy or mix incomparable metadata. Invalid dates refuse.
  const all = [...copies.values()];
  const dated = all.every((copy) => copy.createdTime !== undefined);
  all.sort((a, b) => (dated ? Date.parse(a.createdTime!) - Date.parse(b.createdTime!) : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  known.clear();
  for (const copy of all) known.add(copy.id);
  return all;
}

/** The copies and their versions, as one token. One copy keeps the plain
 *  per-file token; several bind every id and version, winner first. */
async function recordSnapshot(token: string, known: Set<string>, signal?: AbortSignal): Promise<{ copies: RecordCopy[]; versions: string[]; token: string | null }> {
  const copies = await discoverRecord(token, known, signal);
  const versions: string[] = [];
  for (const copy of copies) {
    const version = await driveFileVersion(token, copy.id, signal);
    if (version === null) throw new ConflictError(`${PROVIDER} record disappeared during discovery`);
    versions.push(version);
  }
  if (copies.length < 2) return { copies, versions, token: versions[0] ?? null };
  return { copies, versions, token: JSON.stringify({ driveRecord: 1, winner: copies[0].id, copies: copies.map((copy, i) => [copy.id, versions[i]]) }) };
}

/** A copy this app cannot parse or migrate. Its rows stay out of the merged
 *  read, so a save over the winner could hide them for good. */
function unreadableCopy(error: unknown): boolean {
  return error instanceof SchemaTooNewError || error instanceof RecordShapeError
    || (error instanceof StorageError && error.cause instanceof SyntaxError);
}

/** The read's token when a copy was unreadable: every save with it refuses. */
function refusingToken(token: string, error: unknown): string {
  return JSON.stringify({ driveRecord: 1, refuse: error instanceof SchemaTooNewError ? error.fileVersion : 'damaged', of: token });
}

function refusalOf(expected: string | null): Error | null {
  if (!expected?.startsWith('{')) return null;
  const { refuse } = JSON.parse(expected) as { refuse?: number | 'damaged' };
  if (refuse === undefined) return null;
  return typeof refuse === 'number'
    ? new SchemaTooNewError(refuse, CURRENT_SCHEMA_VERSION)
    : new StorageError(`A copy of the record in ${PROVIDER} could not be read, so saving is paused.`, DAMAGED_HINT);
}

/** Read every copy and merge them. A copy this app cannot read is left out
 *  of the merge and pauses saves (`refusalOf`), never the read itself. */
export async function readDriveRecord(token: string, known: Set<string>, signal?: AbortSignal): Promise<ReadResult> {
  const state = await recordSnapshot(token, known, signal);
  if (!state.token) return { body: null, version: null };
  if (state.copies.length === 1) {
    // A unique file keeps the adapter's raw-body/schema policy.
    const body = await driveDownloadJson(token, state.copies[0].id, signal);
    signal?.throwIfAborted();
    if (body === null) throw new ConflictError(`${PROVIDER} record disappeared or is empty during read`);
    return { body, version: state.token };
  }
  const context = recordContext();
  let merged: RoadmapFile | undefined;
  let refusal: unknown;
  for (const copy of state.copies) {
    signal?.throwIfAborted();
    let parsed: RoadmapFile;
    try {
      const body = await driveDownloadJson(token, copy.id, signal);
      signal?.throwIfAborted();
      if (body === null) throw new ConflictError(`${PROVIDER} record disappeared or is empty during read`);
      parsed = ROADMAP_DOC.migrate(body, context);
    } catch (error) {
      if (!unreadableCopy(error)) throw error;
      if (!(refusal instanceof SchemaTooNewError)) refusal = error; // "update the app" outranks "damaged"
      continue;
    }
    merged = merged ? ROADMAP_DOC.merge(merged, parsed, context) : parsed;
  }
  if (!merged) throw refusal;
  return { body: merged, version: refusal ? refusingToken(state.token, refusal) : state.token };
}

/** Save to the winner, after checking every copy's version is still the one read. */
export async function writeDriveRecord(token: string, body: object, expected: string | null, folder: () => Promise<string>, known: Set<string>, signal?: AbortSignal): Promise<WriteResult> {
  const refusal = refusalOf(expected);
  if (refusal) throw refusal;
  const state = await recordSnapshot(token, known, signal);
  if (state.token !== expected) throw new ConflictError(`${PROVIDER} record membership or contributing version changed`);
  const context = recordContext();
  const intended = ROADMAP_DOC.migrate(body, context);
  const json = JSON.stringify(body);
  let id = state.copies[0]?.id;
  let version: string;
  if (!id) {
    const parent = await folder();
    signal?.throwIfAborted();
    try {
      const res = await driveCreateFile(token, ROADMAP_FILE_NAME, 'application/json', json, parent, signal);
      if (!res.ok) throw new StorageError(`${PROVIDER} record create failed (${res.status}).`, LANDED_HINT, undefined, res.status);
      const created = await jsonBody<{ id?: string }>(res);
      if (!created.id) throw new Error('Create returned no ID');
      id = created.id;
      known.add(id);
      // Confirm by id, never by search: search lags a create, and a search
      // that missed this one would send the retry to make a second copy.
      const confirmed = await driveFileVersion(token, id, signal);
      if (confirmed === null) throw new LostUpdateError(`${PROVIDER} record vanished after its create`);
      version = confirmed;
      // Another device's create may have landed beside this one: reread and
      // merge both onto the winner. `known` keeps this copy in the retry's view.
      if ((await discoverRecord(token, known, signal)).length > 1) {
        throw new LostUpdateError(`${PROVIDER} create landed alongside another record; reread and merge`);
      }
    } catch (error) {
      if (error instanceof LostUpdateError) throw error;
      throw uncertain(`${PROVIDER} record create failed.`, error);
    }
  } else {
    // Every contributing version was checked above, and the winner gets one
    // final check before upload. There is still no atomic CAS.
    try {
      version = await driveUpdateIfVersion(token, id, json, state.versions[0], signal);
    } catch (error) {
      // A rejected precondition did not upload. Any other failure may be a
      // lost PATCH response: do not claim nothing was written.
      if (error instanceof ConflictError) throw error;
      throw uncertain(`${PROVIDER} record update failed.`, error);
    }
  }
  try {
    signal?.throwIfAborted();
    const persisted = await driveDownloadJson(token, id, signal);
    signal?.throwIfAborted();
    if (persisted === null) throw new LostUpdateError(`${PROVIDER} canonical record missing after write`);
    verifyPersistedFile(ROADMAP_DOC, intended, ROADMAP_DOC.migrate(persisted, context));
  } catch (error) {
    if (error instanceof LostUpdateError) throw error;
    throw uncertain(`${PROVIDER} canonical record verification failed.`, error);
  }
  return { version };
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
  /** The record's copies as last found or made (US-10 AC4a). */
  private readonly recordIds = new Set<string>();
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
    if (fileName === ROADMAP_FILE_NAME) return readDriveRecord(this.accessToken, this.recordIds, signal);
    const fileId = await this.findFile(fileName, signal);
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
    if (fileName === ROADMAP_FILE_NAME) return writeDriveRecord(this.accessToken, body, expectedVersion, () => this.folderId(signal), this.recordIds, signal);
    const json = JSON.stringify(body);
    const fileId = await this.findFile(fileName, signal);

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

  private async findFile(fileName: string, signal?: AbortSignal): Promise<string | undefined> {
    const cached = this.fileIds.get(fileName);
    if (cached) return cached;
    // No parent filter, exactly as the browser adapter searches: `drive.file`
    // already limits the result set to this app's own files, and a record
    // created before the folder existed still lives at the Drive root.
    const found = await driveFindFileId(this.accessToken, fileName, undefined, signal);
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
