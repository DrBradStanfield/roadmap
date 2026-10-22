/** Record-only Drive IO. Reads merge in memory; saves retain every losing copy.
 * No Drive CAS exists: enumeration and version checks narrow, not close, races.
 */
import { ConflictError, LostUpdateError, StorageError, fetchOrFail, jsonBody, ROADMAP_FILE_NAME, type ReadResult, type WriteResult } from './adapter';
import { DRIVE_API, driveCreateFile, driveDownloadJson, driveFileVersion, driveUpdateIfVersion } from './drive-rest';
import { ROADMAP_DOC } from './roadmap-doc';
import { verifyPersistedFile } from './sync-manager';

interface Copy { id: string; createdTime?: string }
interface Snapshot { copies: Copy[]; versions: string[]; token: string | null }
const ctx = () => ({ deviceId: 'drive-record-discovery', now: new Date().toISOString() });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const landedHint = 'A save may already have landed. Keep your local copy and read the record again. No copies were removed.';

async function discover(token: string, signal?: AbortSignal): Promise<Copy[]> {
  const copies = new Map<string, Copy>();
  const seen = new Set<string>();
  let page: string | undefined;
  do {
    signal?.throwIfAborted();
    // Shared core also runs in native JS engines without URL/URLSearchParams.
    const query = `q=${encodeURIComponent(`name='${ROADMAP_FILE_NAME}' and trashed=false`)}`
      + '&spaces=drive&fields=files(id%2CcreatedTime)%2CnextPageToken%2CincompleteSearch&pageSize=1000'
      + (page ? `&pageToken=${encodeURIComponent(page)}` : '');
    const res = await fetchOrFail('Google Drive', `${DRIVE_API}/files?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!res.ok) throw new StorageError(`Google Drive record lookup failed (${res.status}).`, undefined, undefined, res.status);
    const result = await jsonBody<{ files?: Copy[]; nextPageToken?: string; incompleteSearch?: boolean }>(res);
    signal?.throwIfAborted();
    if (result.incompleteSearch || !Array.isArray(result.files)) throw new StorageError('Google Drive record enumeration is incomplete.');
    for (const copy of result.files) {
      if (!copy.id || typeof copy.id !== 'string' || (copy.createdTime !== undefined && (typeof copy.createdTime !== 'string' || !Number.isFinite(Date.parse(copy.createdTime))))) {
        throw new StorageError('Google Drive record metadata is invalid.');
      }
      const prior = copies.get(copy.id);
      if (prior && prior.createdTime !== copy.createdTime) throw new StorageError('Google Drive record metadata changed during enumeration.');
      copies.set(copy.id, copy);
    }
    if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !result.nextPageToken)) {
      throw new StorageError('Google Drive record continuation token is invalid.');
    }
    page = result.nextPageToken;
    if (page) {
      if (typeof page !== 'string' || seen.has(page)) throw new StorageError('Google Drive record enumeration repeated a page token.');
      seen.add(page);
    }
  } while (page);
  const all = [...copies.values()];
  // Legacy/missing creation metadata: use ID order for the entire set, never
  // silently drop a copy or mix incomparable metadata. Invalid dates refuse.
  const dated = all.every((copy) => copy.createdTime !== undefined);
  return all.sort((a, b) => (dated ? Date.parse(a.createdTime!) - Date.parse(b.createdTime!) : 0) || compare(a.id, b.id));
}

function opaque(copies: Copy[], versions: string[]): string | null {
  if (!copies.length) return null;
  if (copies.length === 1) return versions[0]; // preserve unique-file version contract
  return JSON.stringify({ driveRecord: 1, winner: copies[0].id, copies: copies.map((copy, i) => [copy.id, versions[i]]) });
}

async function snapshot(token: string, signal?: AbortSignal): Promise<Snapshot> {
  const copies = await discover(token, signal);
  const versions: string[] = [];
  for (const copy of copies) {
    const version = await driveFileVersion(token, copy.id, signal);
    if (version === null) throw new ConflictError('Google Drive record disappeared during discovery');
    versions.push(version);
  }
  return { copies, versions, token: opaque(copies, versions) };
}

export async function readDriveRecord(token: string, signal?: AbortSignal): Promise<ReadResult> {
  const state = await snapshot(token, signal);
  if (!state.copies.length) return { body: null, version: null };
  const context = ctx();
  let merged;
  let raw: unknown;
  for (const copy of state.copies) {
    signal?.throwIfAborted();
    const body = await driveDownloadJson(token, copy.id, signal);
    signal?.throwIfAborted();
    if (body === null) throw new ConflictError('Google Drive record disappeared or is empty during read');
    raw = body;
    // A unique file retains the adapter's raw-body/schema policy. On a union,
    // every copy must migrate before any caller can save over the winner.
    if (state.copies.length > 1) {
      const parsed = ROADMAP_DOC.migrate(body, context);
      merged = merged ? ROADMAP_DOC.merge(merged, parsed, context) : parsed;
    }
  }
  return { body: state.copies.length === 1 ? raw : merged, version: state.token };
}

export async function writeDriveRecord(token: string, body: object, expected: string | null, folder: () => Promise<string>, signal?: AbortSignal): Promise<WriteResult> {
  const state = await snapshot(token, signal);
  if (state.token !== expected) throw new ConflictError('Google Drive record membership or contributing version changed');
  const context = ctx();
  const intended = ROADMAP_DOC.migrate(body, context);
  const json = JSON.stringify(body);
  let id = state.copies[0]?.id;
  let version: string;
  if (!id) {
    const parent = await folder();
    signal?.throwIfAborted();
    try {
      const res = await driveCreateFile(token, ROADMAP_FILE_NAME, 'application/json', json, parent, signal);
      if (!res.ok) throw new StorageError(`Google Drive record create failed (${res.status}).`, landedHint, undefined, res.status);
      const created = await jsonBody<{ id?: string; version?: string }>(res);
      if (!created.id) throw new Error('Create returned no ID');
      id = created.id;
      version = JSON.stringify([id, String(created.version ?? '')]);
      const after = await snapshot(token, signal);
      if (after.copies.length !== 1 || after.copies[0].id !== id || after.token !== version) {
        throw new LostUpdateError('Google Drive create landed alongside another record or changed; reread and merge');
      }
    } catch (error) {
      if (error instanceof LostUpdateError) throw error;
      throw new StorageError('Google Drive create or post-create discovery failed.', landedHint, error);
    }
  } else {
    // All contributing versions were checked above, and the winner gets one
    // final immediate check before upload. There is still no atomic CAS.
    try {
      version = await driveUpdateIfVersion(token, id, json, state.versions[0], signal);
    } catch (error) {
      // A rejected precondition did not upload. Any other failure may be a
      // lost PATCH response; do not inherit a no-write/auth certainty claim.
      if (error instanceof ConflictError) throw error;
      throw new StorageError('Google Drive record update failed.', landedHint, error);
    }
  }
  try {
    signal?.throwIfAborted();
    const persisted = await driveDownloadJson(token, id, signal);
    signal?.throwIfAborted();
    if (persisted === null) throw new LostUpdateError('Google Drive canonical record missing after write');
    verifyPersistedFile(ROADMAP_DOC, intended, ROADMAP_DOC.migrate(persisted, context));
  } catch (error) {
    if (error instanceof LostUpdateError) throw error;
    throw new StorageError('Google Drive canonical record verification failed.', landedHint, error);
  }
  return { version };
}
