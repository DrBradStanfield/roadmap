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
  ROADMAP_FILE_NAME,
  jsonBody,
  StorageError,
  untilAborted,
  type DocumentAccess,
  type ReadResult,
  type StorageAdapter,
  type StoredFile,
  type WriteResult,
} from './adapter';
import { splitDocumentRef } from './document-path';
import {
  auth,
  DRIVE_API,
  DRIVE_FOLDER_MIME,
  DRIVE_FOLDER_NAME,
  driveCreateFile,
  driveCreateFolder,
  driveDelete,
  driveDownloadDocument,
  driveDownloadJson,
  driveEnsureSubfolder,
  driveFileIsLive,
  driveFileVersion,
  driveFindFileId,
  driveFindFolder,
  driveListByPrefix,
  driveUpdateIfVersion,
  driveUploadDocument,
  fail,
  PROVIDER,
  request,
} from './drive-rest-files';
import { readDriveRecord, writeDriveRecord } from './drive-rest-record';

// The file calls and the record live in drive-rest-files.ts and
// drive-rest-record.ts (file budget); every public name stays importable here.
export {
  DRIVE_API,
  DRIVE_FOLDER_MIME,
  DRIVE_FOLDER_NAME,
  DRIVE_LEGACY_FOLDER_NAME,
  driveCreateFile,
  driveCreateFolder,
  driveDownloadDocument,
  driveDownloadJson,
  driveEnsureSubfolder,
  driveFileIsLive,
  driveFileVersion,
  driveFindFileId,
  driveFindFolder,
  driveUpdateIfVersion,
  driveUploadDocument,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_TOKEN_URL,
} from './drive-rest-files';
export { readDriveRecord, writeDriveRecord } from './drive-rest-record';

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
    /** Named-file lookups pick the oldest copy (`orderBy=createdTime`). The
     *  iPhone passes false: its HTTP allow-list (EngineHTTP.swift) has no orderBy. */
    private readonly oldestFirst = true,
    /** The record's copies as last found or made (US-10 AC4a). The iPhone
     *  passes one set to every adapter it makes, so a token refresh keeps it. */
    private readonly recordIds = new Set<string>(),
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

  async readDocument(ref: string, signal?: AbortSignal): Promise<Blob> {
    const { name, parentId } = await this.docTarget(ref, 'read', signal);
    return driveDownloadDocument(this.accessToken, name, parentId, signal);
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    const { name, parentId } = await this.docTarget(ref, 'write');
    return driveUploadDocument(this.accessToken, name, bytes, parentId);
  }

  async list(folder: string, signal?: AbortSignal): Promise<StoredFile[]> {
    const files = await driveListByPrefix(this.accessToken, `${folder}/`, signal);
    // `remove` then pays one liveness GET, not a search (US-10 AC4b).
    for (const file of files) this.fileIds.set(file.name, file.ref);
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
    // Only while it still names a live file: Drive serves a trashed file by
    // id, and the iPhone app keeps one instance for a token's hour (SE-6).
    if (cached && await driveFileIsLive(this.accessToken, cached, fileName, signal)) return cached;
    this.fileIds.delete(fileName);
    // No parent filter, exactly as the browser adapter searches: `drive.file`
    // already limits the result set to this app's own files, and a record
    // created before the folder existed still lives at the Drive root.
    const found = await driveFindFileId(this.accessToken, fileName, undefined, signal, this.oldestFirst);
    if (found) this.fileIds.set(fileName, found);
    return found;
  }

  /** Where a document ref lives, once the opt-in allows it. Without the
   *  opt-in this is the hosted server's refusal, word for word. */
  private async docTarget(ref: string, verb: 'read' | 'write', signal?: AbortSignal): Promise<{ name: string; parentId: string }> {
    if (this.options.documents !== 'write') throw new StorageError(`The hosted server does not ${verb} uploaded documents.`);
    const { folder, name } = splitDocumentRef(ref);
    return { name, parentId: await untilAborted(PROVIDER, this.documentFolder(folder), signal) }; // ends the wait, not the shared lookup: lead A1-6b
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
   * The folder that holds the record: the browser persists its folder id and
   * moves the record into it, so originals filed here land beside the
   * website's, whatever the folder is called now (a renamed folder keeps its
   * id; Codex, 2026-10-23). A record with no such parent (none yet, one left at
   * the Drive root, a trashed parent, or a folder this app may not see) falls back
   * to the folder found by name. Any other failure throws, so the save retries
   * rather than filing into a fallback folder the website does not read (review R1).
   */
  private async recordFolder(): Promise<string> {
    const fileId = await this.findFile(ROADMAP_FILE_NAME);
    const parents = fileId ? (await this.metadata<{ parents?: string[] }>(fileId, 'parents'))?.parents ?? [] : [];
    for (const parent of parents) {
      const folder = await this.metadata<{ mimeType?: string; trashed?: boolean; parents?: string[] }>(parent, 'mimeType,trashed,parents');
      // The Drive root is a folder with no parent of its own: never file documents there.
      if (folder?.mimeType === DRIVE_FOLDER_MIME && !folder.trashed && (folder.parents?.length ?? 0) > 0) return parent;
    }
    return this.folderId();
  }

  /** One file's fields; null when Drive says it is not there (404: gone, or not this app's to see). */
  private async metadata<T>(id: string, fields: string): Promise<T | null> {
    const res = await request(`${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${fields}`, { headers: auth(this.accessToken) });
    if (res.status === 404) return null;
    if (!res.ok) await fail('folder lookup', res);
    return jsonBody<T>(res);
  }

  private async folderId(signal?: AbortSignal): Promise<string> {
    const found = await driveFindFolder(this.accessToken, undefined, undefined, signal);
    return found?.id ?? (await driveCreateFolder(this.accessToken, DRIVE_FOLDER_NAME, undefined, signal));
  }
}
