/**
 * The cloud-storage adapter interface (implementation plan §4).
 *
 * Every backend — Dropbox, Google Drive, GitHub, self-host — sits behind this
 * one interface. The widget never talks to a backend directly; it talks to a
 * `SyncManager` (sync-manager.ts) which talks to one adapter.
 *
 * HARD requirement (§4.1): each adapter is folder/repo-scoped — it can only ever
 * touch the app's own `Health Roadmap` data, never the rest of the user's cloud.
 *
 * Adapters are SCHEMA-AGNOSTIC: JSON record files are addressed by name
 * (`health-roadmap.json`, `chat-history.json`, …) and bodies are opaque JSON.
 * Schema knowledge (migrate/merge/validate) lives in the SyncManager's
 * DocumentSpec, not here.
 */

/** The user's primary record file. Lives here (not with its DocumentSpec)
 *  because adapters need it for legacy-slot/key back-compat mapping. Other
 *  document names are schema facts and live in their DocumentSpec. */
export const ROADMAP_FILE_NAME = 'health-roadmap.json';

export type StorageBackendId =
  | 'google-drive'
  | 'dropbox'
  | 'github'
  | 'self-host'
  | 'file' // one local file on disk, edited by the CLI and the stdio MCP server
  | 'local' // no-sync, single-device tier (localStorage) — the "guest" tier
  | 'memory'; // test/demo only

/**
 * Thrown by `write()` when the remote file changed since the `expectedVersion`
 * we read — i.e. another device wrote in between. The SyncManager catches this,
 * re-reads, re-merges, and retries. NOT a fatal error.
 */
export class ConflictError extends Error {
  constructor(message = 'Remote file changed since last read') {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * A write that landed and then vanished: the re-read after it is missing rows
 * it had just written, so a concurrent writer overwrote them. It is a conflict
 * — the SyncManager re-reads, re-merges and writes again — but a NAMED one,
 * because unlike a refused write, something did happen. On a backend with a
 * real conditional write this cannot occur; on Google Drive, which has none,
 * it is design §7 step 3 doing the job step 2 cannot finish.
 */
export class LostUpdateError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'LostUpdateError';
  }
}

/**
 * Any other storage failure (network, auth, corruption, verify mismatch).
 * `hint` is the user's next move, when the thrower knows one — the shared
 * `describeStorageFailure` mapping prints it as the second line.
 */
export class StorageError extends Error {
  constructor(message: string, readonly hint?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * The next move when a provider simply did not answer. One string: the adapter
 * raises it here, and `describeStorageFailure` prints the same words when it
 * meets an unrecognised failure. Two copies would drift, and the wording is
 * what the user is told to act on.
 */
export const UNREACHABLE_HINT = 'Try once more; if it keeps failing, check that the record is reachable.';

/** How long a provider gets to answer, body included, before the call is
 *  abandoned as unreachable. Long enough for a slow phone on a slow network,
 *  short enough that a hosted tool call fails rather than hangs. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * `fetch`, with the network outage it can have owned by the adapter that made
 * the call. A dead network, a DNS miss or a severed socket rejects with a bare
 * `TypeError`, which is not a `StorageError` — so a surface above would have to
 * guess whether an unrecognised error was the provider's or a bug of ours, and
 * guessing wrong words our own bug as something the user could fix. Every REST
 * adapter goes through here (the disk adapter does the same in
 * `file-adapter.ts`). `provider` is its user-facing name: 'Dropbox'.
 */
export async function fetchOrFail(
  provider: string,
  url: string | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  // A provider that accepts the socket and then says nothing is not an error
  // any layer above can see: the hosted tool call, or the widget's save, waits
  // until the platform kills it. Bounded here, that silence arrives as the same
  // failure a dead network does. `AbortSignal.any` is Node 20+/modern-browser
  // only; without it a caller's own signal still wins, as it did before.
  const timeout = AbortSignal.timeout(init?.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = !init?.signal ? timeout
    : typeof AbortSignal.any === 'function' ? AbortSignal.any([init.signal, timeout])
    : init.signal;
  try {
    // The body is drained HERE, inside the try: a socket that dies mid-download
    // rejects the body read, not `fetch` (undici's `TypeError: terminated`), so
    // reading it at the call site would let the outage escape as an unknown
    // error again. Rebuilding with an explicit ResponseInit keeps status,
    // statusText and headers without asking a browser to coerce a Response
    // into a ResponseInit dictionary; a null-body status (204/304) must stay
    // bodiless.
    const res = await fetch(url, { ...init, signal });
    const bytes = await res.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (error) {
    throw new StorageError(`${provider} did not answer`, UNREACHABLE_HINT, error);
  }
}

/**
 * A 2xx whose body is not JSON is a broken answer, not a crash: an empty object
 * drops each caller into its own "returned no id/version/rev" path. It lives
 * beside `fetchOrFail` because it answers the next question that helper raises
 * — the response arrived, now what — and every REST adapter asks it.
 */
export async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

/**
 * Result of reading a record file. `body` is the JSON-parsed object WITHOUT
 * normalisation — the SyncManager runs it through the document's `migrate()`
 * to fill defaults + gate the schema version. `version` is the backend's
 * change token for THAT file (Dropbox `rev`, GitHub `sha`, WebDAV ETag,
 * localStorage counter) — opaque to everything above the adapter.
 */
export interface ReadResult {
  body: unknown;
  version: string | null;
}

export interface WriteResult {
  version: string;
}

export interface StorageAdapter {
  readonly id: StorageBackendId;
  readonly label: string;

  /** Establish folder/repo-scoped access (OAuth/PKCE, pasted token, or local pick). */
  connect(): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;

  /** Read the named record file. Returns {body:null, version:null} if it doesn't exist yet. */
  read(fileName: string): Promise<ReadResult>;

  /**
   * Write the named record file with an optimistic-concurrency precondition.
   * @param expectedVersion the `version` from the read this write is based on,
   *   or null for a first-ever create. Throws ConflictError if the remote moved.
   */
  write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult>;

  /** Read an uploaded document blob (e.g. 'documents/doc_1.pdf'). */
  readDocument(ref: string): Promise<Blob>;

  /**
   * Write an uploaded document blob. Per §5.3, callers write the blob FIRST,
   * then commit the `documents[]` reference via `write()` — so the JSON write is
   * the atomic commit point and orphan blobs are harmless.
   */
  writeDocument(ref: string, bytes: Blob): Promise<void>;

  /**
   * OPTIONAL synchronous last-ditch write, used only on tab-close /
   * visibilitychange where an async chain may not finish (esp. mobile). Only
   * backends whose write is genuinely synchronous (localStorage) implement it;
   * cloud backends omit it (network can't be sync) and fall back to a
   * best-effort async flush. No version check — it's the emergency
   * last-write-on-this-device path.
   */
  writeSync?(fileName: string, body: object): void;
}
