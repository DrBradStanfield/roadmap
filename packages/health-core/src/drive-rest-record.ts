/**
 * The health record on Google Drive (US-10 AC4a): every copy discovered, read
 * and merged; saves to one fixed copy, version-checked, then verified. Moved
 * whole out of drive-rest.ts (file budget); drive-rest.ts re-exports
 * readDriveRecord and writeDriveRecord, so callers import from there.
 */
import {
  ConflictError,
  LostUpdateError,
  ROADMAP_FILE_NAME,
  jsonBody,
  StorageError,
  type ReadResult,
  type WriteResult,
} from './adapter';
import {
  auth,
  DRIVE_API,
  driveCreateFile,
  driveDownloadJson,
  driveFileVersion,
  driveUpdateIfVersion,
  fail,
  PROVIDER,
  request,
} from './drive-rest-files';
import { counterOf, MAX_COUNTER, RecordShapeError, SchemaTooNewError } from './migrate';
import { ROADMAP_DOC } from './roadmap-doc';
import { CURRENT_SCHEMA_VERSION, type RoadmapFile } from './roadmap-file';
import { verifyPersistedFile } from './sync-manager';
import { uncertainWrite } from './write-refusal';

// --- The health record (US-10 AC4a) -------------------------------------------
// Drive allows two files with one name, and two first saves can race to make
// them. Reads merge every copy in memory; saves go to one fixed copy (oldest
// `createdTime`, then id) and leave the others in place. Drive has no CAS:
// enumeration and version checks narrow races, they do not close them.

interface RecordCopy { id: string; createdTime?: string }
const recordContext = () => ({ deviceId: 'drive-record-discovery', now: new Date().toISOString() });
const LANDED_HINT = 'A save may already have landed. Keep your local copy and read the record again. No copies were removed.';
const ERASE_KEPT_COPY = 'One copy of health-roadmap.json in Google Drive could not be read (damaged, or from a newer version of the app), so the erase left it untouched. You can delete it in Google Drive.';
const DAMAGED_HINT = 'Your plan loaded from the other copies. Nothing was written. Saving resumes once that health-roadmap.json in Google Drive is repaired or renamed.';

/** A write that may have landed: keep the provider status, so a 401 still
 *  refreshes the token (iOS) and still reads as "reconnect" (the page), and
 *  mark it, so no status on it reads as a refusal (write-refusal.ts). */
const uncertain = (message: string, error: unknown): StorageError => uncertainWrite(new StorageError(message, LANDED_HINT, error, error instanceof StorageError ? error.status : undefined));

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

/** An unreadable copy's hold on saves, carried in the read's token (`of` is
 *  the plain token): `readable` is the readable copies' erase epoch, `seen`
 *  the highest epoch any copy showed, `target` the oldest readable copy. */
interface Hold { refuse: number | 'damaged'; readable: number; seen: number; target: string; of: string }

function holdOf(expected: string | null): (Hold & { error: Error }) | null {
  if (!expected?.startsWith('{')) return null;
  const hold = JSON.parse(expected) as Partial<Hold>;
  if (hold.refuse === undefined) return null;
  const error = typeof hold.refuse === 'number'
    ? new SchemaTooNewError(hold.refuse, CURRENT_SCHEMA_VERSION)
    : new StorageError(`A copy of the record in ${PROVIDER} could not be read, so saving is paused.`, DAMAGED_HINT);
  return { ...(hold as Hold), error };
}

/** A copy's erase epoch from its raw JSON, read as migrate reads a counter:
 *  what is known of a copy this app cannot migrate. */
function rawEraseEpoch(raw: unknown): number {
  return counterOf((raw as { meta?: { eraseEpoch?: unknown } } | null | undefined)?.meta?.eraseEpoch, 0);
}

/** One copy's JSON. Gone (404) is a conflict; empty, `null` or invalid JSON
 *  is a copy that is there and unreadable, never a missing one. */
async function downloadCopy(token: string, id: string, signal?: AbortSignal): Promise<unknown> {
  const res = await request(`${DRIVE_API}/files/${id}?alt=media`, { headers: auth(token), signal });
  if (res.status === 404) throw new ConflictError(`${PROVIDER} record disappeared during read`);
  if (!res.ok) await fail('read', res);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch { /* refused below */ }
  if (body === null) throw new StorageError(`${PROVIDER} read failed: a copy of the record is empty or not valid JSON.`, undefined, new SyntaxError('empty or invalid JSON'));
  return body;
}

/** Read every copy and merge them. A copy this app cannot read is left out
 *  of the merge and holds saves (`holdOf`), never the read itself. */
export async function readDriveRecord(token: string, known: Set<string>, signal?: AbortSignal): Promise<ReadResult> {
  const state = await recordSnapshot(token, known, signal);
  if (!state.token) return { body: null, version: null };
  if (state.copies.length === 1) {
    // A unique file keeps the adapter's raw-body/schema policy: an empty one
    // reads as no record, and the save writes over it.
    const body = await driveDownloadJson(token, state.copies[0].id, signal);
    signal?.throwIfAborted();
    return { body, version: state.token };
  }
  const context = recordContext();
  let merged: RoadmapFile | undefined;
  let refusal: unknown;
  let seen = 0;
  let target: string | undefined;
  for (const copy of state.copies) {
    signal?.throwIfAborted();
    let raw: unknown;
    let parsed: RoadmapFile;
    try {
      raw = await downloadCopy(token, copy.id, signal);
      signal?.throwIfAborted();
      parsed = ROADMAP_DOC.migrate(raw, context);
    } catch (error) {
      if (!unreadableCopy(error)) throw error;
      if (!(refusal instanceof SchemaTooNewError)) refusal = error; // "update the app" outranks "damaged"
      seen = Math.max(seen, rawEraseEpoch(raw));
      continue;
    }
    target ??= copy.id;
    merged = merged ? ROADMAP_DOC.merge(merged, parsed, context) : parsed;
  }
  if (!merged || !target) throw refusal;
  if (!refusal) return { body: merged, version: state.token };
  const readable = merged.meta.eraseEpoch ?? 0;
  const hold: Hold = {
    refuse: refusal instanceof SchemaTooNewError ? refusal.fileVersion : 'damaged',
    readable, seen: Math.max(seen, readable), target, of: state.token,
  };
  return { body: merged, version: JSON.stringify({ driveRecord: 1, ...hold }) };
}

/** Save to the winner, after checking every copy's version is still the one read. */
export async function writeDriveRecord(token: string, body: object, expected: string | null, folder: () => Promise<string>, known: Set<string>, signal?: AbortSignal): Promise<WriteResult & { fileId: string }> {
  const context = recordContext();
  // An unreadable copy holds saves, but never "Delete all my data": an erase
  // (an epoch past the readable copies') goes to the oldest READABLE copy, and
  // the unreadable one is never written. Its epoch goes past every epoch any
  // copy showed, so the cloud's erase never goes down.
  const hold = holdOf(expected);
  if (hold) {
    const epoch = ROADMAP_DOC.migrate(body, context).meta.eraseEpoch ?? 0;
    // No epoch goes past the counter cap, so an erase there cannot win: refuse.
    if (epoch <= hold.readable || hold.seen >= MAX_COUNTER) throw hold.error;
    if (epoch <= hold.seen) body = { ...body, meta: { ...(body as RoadmapFile).meta, eraseEpoch: hold.seen + 1 } };
  }
  const state = await recordSnapshot(token, known, signal);
  if (state.token !== (hold ? hold.of : expected)) throw new ConflictError(`${PROVIDER} record membership or contributing version changed`);
  const intended = ROADMAP_DOC.migrate(body, context);
  const json = JSON.stringify(body);
  const at = hold ? state.copies.findIndex((copy) => copy.id === hold.target) : 0;
  let id = state.copies[at]?.id;
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
      version = await driveUpdateIfVersion(token, id, json, state.versions[at], signal);
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
    verifyPersistedFile(ROADMAP_DOC, intended, ROADMAP_DOC.migrate(persisted, context), context);
  } catch (error) {
    if (error instanceof LostUpdateError) throw error;
    throw uncertain(`${PROVIDER} canonical record verification failed.`, error);
  }
  return { version, fileId: id, ...(hold ? { warning: ERASE_KEPT_COPY } : {}) };
}
