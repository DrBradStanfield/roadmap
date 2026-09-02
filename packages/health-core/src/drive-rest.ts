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
 * concurrent writers are durable-by-retry rather than serialised, and the
 * BROWSER cannot detect being clobbered at all (it does not re-check versions).
 */
import {
  ConflictError,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';

/** Exported for the browser adapter's two cosmetic PATCHes (rename, re-parent). */
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE = DRIVE_API;
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

async function fail(what: string, res: Response): Promise<never> {
  throw new StorageError(`Google Drive ${what} failed (${res.status}): ${await res.text()}`);
}

/** Find one file by name, optionally inside one parent. Undefined = not there. */
export async function driveFindFileId(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<string | undefined> {
  const q = encodeURIComponent(
    `name='${quoted(name)}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const res = await fetch(`${DRIVE}/files?q=${q}&spaces=drive&fields=files(id)&pageSize=1`, {
    headers: auth(accessToken),
  });
  if (!res.ok) await fail('lookup', res);
  return ((await res.json()) as { files?: Array<{ id: string }> }).files?.[0]?.id;
}

/**
 * Find the app folder by any of the names it has ever had, so a user who
 * connected before the 2026-06 rename is not given a second folder.
 */
export async function driveFindFolder(
  accessToken: string,
  names: readonly string[] = [DRIVE_FOLDER_NAME, DRIVE_LEGACY_FOLDER_NAME],
  parentId?: string,
): Promise<{ id: string; name: string } | undefined> {
  const anyName = names.map((name) => `name='${quoted(name)}'`).join(' or ');
  const q = encodeURIComponent(
    `(${anyName}) and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`,
  );
  const res = await fetch(`${DRIVE}/files?q=${q}&fields=files(id,name)&pageSize=1`, {
    headers: auth(accessToken),
  });
  if (!res.ok) await fail('folder lookup', res);
  return ((await res.json()) as { files?: Array<{ id: string; name: string }> }).files?.[0];
}

export async function driveCreateFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const res = await fetch(`${DRIVE}/files?fields=id`, {
    method: 'POST',
    headers: { ...auth(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, ...(parentId ? { parents: [parentId] } : null) }),
  });
  if (!res.ok) await fail('folder create', res);
  return ((await res.json()) as { id: string }).id;
}

/** Create a file inside `parentId` — metadata and content in one multipart POST. */
export function driveCreateFile(
  accessToken: string,
  name: string,
  contentType: string,
  content: Blob | string,
  parentId: string,
): Promise<Response> {
  const metadata = { name, parents: [parentId] };
  const boundary = 'rm_boundary_health_roadmap';
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
    method: 'POST',
    headers: { ...auth(accessToken), 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

/** Overwrite a file's bytes. Unconditional — Drive offers no precondition. */
export async function driveUpdateFile(accessToken: string, fileId: string, json: string): Promise<string> {
  const res = await fetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { ...auth(accessToken), 'Content-Type': 'application/json' },
    body: json,
  });
  if (!res.ok) await fail('write', res);
  return String(((await res.json()) as { version?: string }).version ?? '');
}

/**
 * The file's change counter. Drive bumps it on every change, so it is the
 * closest thing to a rev — read-only, which is why it can only ever be
 * compared and never sent as a precondition.
 */
export async function driveFileVersion(accessToken: string, fileId: string): Promise<string | null> {
  const res = await fetch(`${DRIVE}/files/${fileId}?fields=version`, { headers: auth(accessToken) });
  if (res.status === 404) return null;
  if (!res.ok) await fail('version read', res);
  return ((await res.json()) as { version?: string }).version ?? null;
}

/** Download a file's bytes as JSON. Null = the file is gone. */
export async function driveDownloadJson(accessToken: string, fileId: string): Promise<unknown | null> {
  const res = await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: auth(accessToken) });
  if (res.status === 404) return null;
  if (!res.ok) await fail('read', res);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StorageError('Google Drive read failed: file is not valid JSON (possible corruption).', undefined, error);
  }
}

/**
 * One connection's Drive folder, for the life of one request. The access token
 * is minted from the sealed refresh token and dies with the call; the id caches
 * live on the instance, so they die with it too — there is no per-user
 * anything to cache in, by design (§1).
 *
 * Documents (the uploaded PDFs) are deliberately unreachable: the hosted write
 * surface is append-only clinical values and nothing else.
 */
export class DriveAdapter implements StorageAdapter {
  readonly id = 'google-drive' as const;
  readonly label = 'Google Drive';
  private readonly fileIds = new Map<string, string>();

  constructor(private readonly accessToken: string) {}

  async connect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async disconnect(): Promise<void> {}

  /** Step 1: read the bytes AND the version this write will be based on. */
  async read(fileName: string): Promise<ReadResult> {
    const fileId = await this.findFile(fileName);
    if (!fileId) return { body: null, version: null };
    const body = await driveDownloadJson(this.accessToken, fileId);
    if (body == null) return { body: null, version: null };
    return { body, version: await driveFileVersion(this.accessToken, fileId) };
  }

  /**
   * Steps 2 and 3 of design §7. Drive cannot be told "only if the version is
   * still X", so we ask it what the version is at the last possible moment and
   * refuse the write ourselves if it moved. That is a narrower window, not a
   * closed one: `SyncManager`'s verify-after-write is what actually catches a
   * writer who landed inside it, and its `ConflictError` sends this whole
   * method round again.
   */
  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    const json = JSON.stringify(body);
    const fileId = await this.findFile(fileName);

    if (!fileId) {
      // A first-ever create. If the caller thought there was a version, the
      // file it read has since been deleted or trashed — never silently
      // re-create it here: re-reading is what turns that into a decision.
      if (expectedVersion !== null) throw new ConflictError('Google Drive no longer holds that file');
      const parentId = await this.folderId();
      const res = await driveCreateFile(this.accessToken, fileName, 'application/json', json, parentId);
      if (!res.ok) await fail('create', res);
      const created = (await res.json()) as { id?: string; version?: string };
      if (!created.id) throw new StorageError('Google Drive create returned no file id.');
      this.fileIds.set(fileName, created.id);
      return { version: String(created.version ?? '') };
    }

    const current = await driveFileVersion(this.accessToken, fileId);
    if (current !== expectedVersion) {
      throw new ConflictError(
        `Google Drive changed since it was read (version ${expectedVersion ?? 'none'} → ${current ?? 'none'})`,
      );
    }
    return { version: await driveUpdateFile(this.accessToken, fileId, json) };
  }

  async readDocument(): Promise<Blob> {
    throw new StorageError('The hosted server does not read uploaded documents.');
  }

  async writeDocument(): Promise<void> {
    throw new StorageError('The hosted server does not write uploaded documents.');
  }

  private async findFile(fileName: string): Promise<string | undefined> {
    const cached = this.fileIds.get(fileName);
    if (cached) return cached;
    // No parent filter, exactly as the browser adapter searches: `drive.file`
    // already limits the result set to this app's own files, and a record
    // created before the folder existed still lives at the Drive root.
    const found = await driveFindFileId(this.accessToken, fileName);
    if (found) this.fileIds.set(fileName, found);
    return found;
  }

  private async folderId(): Promise<string> {
    const found = await driveFindFolder(this.accessToken);
    return found?.id ?? (await driveCreateFolder(this.accessToken, DRIVE_FOLDER_NAME));
  }
}
