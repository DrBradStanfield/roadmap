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
import { TRANSFER_DEADLINE_MS, timeoutDeadline } from './transfer-deadline';

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
 * `describeStorageFailure` mapping prints it as the second line. `status` is
 * the provider's HTTP status when there was one, so a surface can tell a
 * rejected token (401/403) from an unreachable folder without reading the
 * message text. `reason`, likewise, names a failure a caller acts on (#979):
 * a full store, a document that is not there, or a grant the provider revoked
 * (`reconnect`: only a new sign-in mends it, so a failed save is not retried, US-09 AC30),
 * a token refused (`auth`, a 401), access refused (`forbidden`, a 403 that is not a limit),
 * or a provider's rate or daily limit (`rate-limited`: it passes, so it is retried).
 * `writes-stopped`: a device write refused because this page may no longer write
 * health files here (a log-off, US-09 AC2c); it is expected, and not reported.
 *
 * `outcome` (root fix R6, US-10 AC16) is what the failure says about a write, set where
 * it is raised, so no reader decides from a status, a name or the words:
 * - refused: the provider answered and stored nothing;
 * - may-have-landed: a write went out, and nothing rules out that it was stored;
 * - no-answer: no usable answer to a call that sent no write.
 * Every raise names one (US-10 AC17): the argument is required, so a raise site
 * that forgets it does not compile. A provider's status picks it only through
 * `answerOutcome`, which the raise site calls on purpose. A 401 or 403 sets its
 * reason unless the raiser names its own.
 */
export type StorageFailureReason = 'storage-full' | 'not-found' | 'reconnect' | 'auth' | 'forbidden' | 'rate-limited' | 'writes-stopped';
export type StorageOutcome = 'refused' | 'may-have-landed' | 'no-answer';

/**
 * HTTP answers that say the provider did not store a write. Every status here
 * is the provider's answer to the upload itself, or to a call that sent no
 * write; a status kept on a failure after an upload (Google Drive's verify
 * read) is raised `may-have-landed` by its adapter.
 * - 400: the request was rejected as malformed before it was processed (all providers).
 * - 401, 403: the token or the grant was refused (Dropbox, Drive, GitHub, WebDAV).
 *   GitHub also answers 403 for a secondary rate limit, refused unprocessed.
 * - 404: the target (repository, folder, file id) is not there, so nothing was stored.
 * - 409: Dropbox answers 409 for every UploadError, the write not done
 *   (dropbox-rest.ts uploadRefusal); GitHub's sha conflict and WebDAV's missing
 *   parent collection are 409s too.
 * - 412: a failed precondition (WebDAV If-Match / If-None-Match).
 * - 413: the body was too large to accept.
 * - 422: GitHub's sha mismatch or "already exists" on create.
 * Not here, so an upload that met one may have landed:
 * - 408: a request timeout, which a proxy can send after it forwarded the body.
 * - 429: too many requests. No adapter here cites a provider promise that a
 *   rate-limited upload was never applied, so it is not called a refusal.
 * - 5xx (507 included): the server failed partway, or a gateway gave up waiting.
 * Google Drive has its own rules for its record's PATCH (drive-rest-record.ts).
 */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 412, 413, 422]);

/** The outcome of a provider's non-ok answer: a refusal by the table above; else
 *  may have landed for an upload, and no answer for a call that sent no write. */
export function answerOutcome(status: number, upload = false): StorageOutcome {
  return REFUSED_STATUSES.has(status) ? 'refused' : upload ? 'may-have-landed' : 'no-answer';
}

export class StorageError extends Error {
  readonly reason?: StorageFailureReason;
  /** Set where raised, a required argument: no raiser leaves it unset (US-10 AC17). */
  readonly outcome: StorageOutcome;
  /** SyncManager's rewrap after a write that landed with a warning: its hint
   *  says what landed first (US-31 AC8a), so it is shown as it is. */
  earlierLanded?: true;
  constructor(message: string, readonly hint: string | undefined, readonly cause: unknown, readonly status: number | undefined, reason: StorageFailureReason | undefined, outcome: StorageOutcome) {
    super(message);
    this.name = 'StorageError';
    this.reason = reason ?? (status === 401 ? 'auth' : status === 403 ? 'forbidden' : undefined);
    this.outcome = outcome;
  }
}

/** A failure's HTTP status as one tag from a closed list, never the body (US-09 AC6c): the
 *  status a StorageError carries, else `none`. */
export const HTTP_STATUS_TAGS = ['401', '403', '404', '409', '429', '4xx', '5xx', 'none'];
export function httpStatusTag(error: unknown): string {
  const status = error instanceof StorageError ? error.status : undefined;
  return status === undefined ? 'none'
    : HTTP_STATUS_TAGS.includes(String(status)) ? String(status)
    : status >= 400 && status < 500 ? '4xx'
    : status >= 500 && status < 600 ? '5xx'
    : 'none';
}

/** A document write the provider refused as busy (Dropbox: another write held the folder's lock, or too many
 *  requests): a later try may land (US-14 AC5). `retryAfterMs`: the wait the provider named, 0 for none. Its
 *  outcome is the upload's by the table: a 409 refused, a 429 may have landed (no provider promise says otherwise). */
export class BusyError extends StorageError {
  constructor(message: string, readonly retryAfterMs: number, status: number) {
    super(message, undefined, undefined, status, undefined, answerOutcome(status, true));
    this.name = 'BusyError';
  }
}

/** The wait the provider named (0 for none) when `error` is a busy refusal; else null. By name, not `instanceof`: the web's
 *  upload engine is its own bundle, with its own copy of this class. */
export function busyWait(error: unknown): number | null {
  const wait = error instanceof Error && error.name === 'BusyError' ? (error as Partial<BusyError>).retryAfterMs : undefined;
  return typeof wait === 'number' ? wait : null;
}

/**
 * The next move when a provider simply did not answer. One string: the adapter
 * raises it here, and `describeStorageFailure` prints the same words when it
 * meets an unrecognised failure. Two copies would drift, and the wording is
 * what the user is told to act on.
 */
export const UNREACHABLE_HINT = 'Try once more; if it keeps failing, check that the record is reachable.';
/** A write that went out and got no answer may still have landed (US-09 AC13d). */
export const LANDED_HINT = 'The change may have landed. Read the record again before trying it a second time.';
/** The hint for a call that got no answer: a write may have landed, a read did not. */
function unansweredHint(mayHaveWritten?: boolean): string {
  return mayHaveWritten ? LANDED_HINT : UNREACHABLE_HINT;
}

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
  init?: RequestInit & { timeoutMs?: number; mayHaveWritten?: boolean },
): Promise<Response> {
  // A provider that accepts the socket and then says nothing is not an error
  // any layer above can see: the hosted tool call, or the widget's save, waits
  // until the platform kills it. Bounded here, that silence arrives as the same
  // failure a dead network does. A caller's own signal still aborts the call.
  // Safari 14/15 has no `AbortSignal.timeout` and 16–17.3 no `AbortSignal.any`,
  // and the widget ships untranspiled to them: called unguarded, the bound
  // itself would be the outage, killing every read and save on those browsers.
  // Without `AbortSignal.timeout` the bound runs on the global timer (US-09
  // AC13g). Without `AbortSignal.any`, a caller's own signal is the only bound.
  const { timeoutMs, mayHaveWritten, signal: callerSignal, ...rest } = init ?? {};
  const timeout = timeoutDeadline(timeoutMs ?? TRANSFER_DEADLINE_MS.call);
  const signal = callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeout.signal])
    : callerSignal ?? timeout.signal;
  try {
    // The body is drained HERE, inside the try: a socket that dies mid-download
    // rejects the body read, not `fetch` (undici's `TypeError: terminated`), so
    // reading it at the call site would let the outage escape as an unknown
    // error again. Rebuilding with an explicit ResponseInit keeps status,
    // statusText and headers without asking a browser to coerce a Response
    // into a ResponseInit dictionary; a null-body status (204/304) must stay
    // bodiless.
    const res = await fetch(url, { ...rest, signal });
    const bytes = await res.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (error) {
    throw new StorageError(`${provider} did not answer`, unansweredHint(mayHaveWritten), error, undefined, undefined, mayHaveWritten ? 'may-have-landed' : 'no-answer');
  } finally {
    timeout.clear();
  }
}

/**
 * Waits on `work` until the caller's `signal` aborts, then fails as a call
 * with no answer, in `fetchOrFail`'s words. The work itself runs on under its
 * own request bounds: it is shared and cached (Drive's document-folder lookup),
 * so one caller's deadline must not cancel it for the others (US-09 AC53).
 */
export function untilAborted<T>(provider: string, work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new StorageError(`${provider} did not answer`, UNREACHABLE_HINT, signal.reason, undefined, undefined, 'no-answer'));
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
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
  /** What the user should hear about a write that landed (US-10 AC4a). */
  warning?: string;
}

/** The REST adapters' document opt-in. Without `documents: 'write'` they
 *  refuse document writes (and Drive document reads): the hosted MCP server
 *  constructs them bare and must stay that way. */
export interface DocumentAccess {
  documents?: 'write';
}

/** One file as `list` names it. `ref` is what `readDocument` takes — a provider id where the provider has one, so a listed name never forms a path. */
export interface StoredFile {
  name: string;
  ref: string;
  size: number;
  /** ISO 8601, or '' when the provider does not say. */
  modified: string;
}

export interface StorageAdapter {
  readonly id: StorageBackendId;
  readonly label: string;

  /** Establish folder/repo-scoped access (OAuth/PKCE, pasted token, or local pick). */
  connect(): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;

  /**
   * Read the named record file. Returns {body:null, version:null} if it doesn't exist yet.
   *
   * `signal`, here and on the other methods below, is OPTIONAL and belongs to
   * a caller with a deadline of its own — the hosted import's 40 s tool call
   * (US-35 AC5). A REST adapter hands it to `fetch`, so the request is aborted
   * at the deadline, not abandoned; a local adapter need only refuse to start
   * once it is aborted. Absent, the adapter's own bound applies.
   */
  read(fileName: string, signal?: AbortSignal): Promise<ReadResult>;

  /**
   * Write the named record file with an optimistic-concurrency precondition.
   * @param expectedVersion the `version` from the read this write is based on,
   *   or null for a first-ever create. Throws ConflictError if the remote moved.
   */
  write(fileName: string, body: object, expectedVersion: string | null, signal?: AbortSignal): Promise<WriteResult>;

  /** Read an uploaded document blob (e.g. 'documents/doc_1.pdf'). */
  readDocument(ref: string, signal?: AbortSignal): Promise<Blob>;

  /**
   * Write an uploaded document blob. Per §5.3, callers write the blob FIRST,
   * then commit the `documents[]` reference via `write()` — so the JSON write is
   * the atomic commit point and orphan blobs are harmless.
   */
  writeDocument(ref: string, bytes: Blob): Promise<void>;

  /**
   * OPTIONAL: the files directly under one folder of the app's own space
   * (`''` for its root), and the removal of one. Only the connector's import
   * needs either (US-35): it lists the root for lab files and parks a pending
   * payload as `imports/pending-<id>.json` until the commit removes it. The
   * record's deletion is an `eraseEpoch` bump, a document's is a tombstone —
   * never this. `limit` stops a paged listing once that many entries are in
   * hand (US-37 AC1); a provider without pages may ignore it.
   */
  list?(folder: string, signal?: AbortSignal, limit?: number): Promise<StoredFile[]>;
  remove?(fileName: string, signal?: AbortSignal): Promise<void>;

  /**
   * OPTIONAL change signal (US-34): call `onChange` whenever the provider says
   * this file may have moved — a Dropbox long-poll returning, a Drive changes
   * page naming our id. It is a HINT, never data: the store answers it by
   * re-reading through the ordinary path, so a spurious call costs one read
   * and a missed one is caught by the next visibility/focus re-read.
   *
   * Returns nothing and never rejects — the loop owns its own errors and its
   * own backoff. `signal` is the only way it ends; an aborted signal must stop
   * every request. Backends with no push (GitHub and WebDAV have no cheap
   * watch) omit it and the store falls back to its slow poll. localStorage's
   * watch is the browser's `storage` event, which tells every other tab of
   * the origin that one tab wrote (US-34 AC6).
   */
  watch?(fileName: string, onChange: () => void, signal: AbortSignal): void;
}

/**
 * `setTimeout` that an abort cuts short, for the watch loops' backoff. It
 * resolves either way — a caller waits, then re-checks `signal.aborted` at the
 * top of its loop, so an abort mid-wait costs one tick and not a rejection to
 * catch.
 */
export function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * For a watch loop that has just taken a fresh cursor: a fresh cursor starts
 * at "now", so a change made while the provider could not be reached never
 * appears in it. After a failure (`retryMs` above zero), ask the store to
 * re-read once; a clean start and an abort owe nothing (US-34 AC1a).
 */
export function catchUpAfterFailure(retryMs: number, signal: AbortSignal, onChange: () => void): void {
  if (retryMs > 0 && !signal.aborted) onChange();
}

/**
 * A signal that aborts at `deadline` (epoch ms) — already aborted when the
 * deadline has passed, so a call that starts late never starts at all. The
 * reason is the same `TimeoutError` `AbortSignal.timeout` raises. Built on
 * the global timer, not `AbortSignal.timeout`, so a test's fake clock drives
 * it; unref'd, so it never holds a process open.
 */
export function deadlineSignal(deadline: number): AbortSignal {
  const controller = new AbortController();
  const reason = new DOMException('The deadline has passed', 'TimeoutError');
  const left = deadline - Date.now();
  if (left <= 0) controller.abort(reason);
  else (setTimeout(() => controller.abort(reason), left) as { unref?(): void }).unref?.();
  return controller.signal;
}
