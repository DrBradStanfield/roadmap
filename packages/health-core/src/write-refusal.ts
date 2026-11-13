/**
 * Did a failed record write land? (lead S57). An erase whose write fails and
 * whose device copy cannot be written either is put back only when the write
 * certainly did not land: one copy of the erase anywhere means a put-back
 * would accept edits the cloud's higher epoch then drops. So every failure on
 * the write path counts as "may have landed", except the definite refusals
 * named here. When unsure, a failure is NOT a refusal.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { ConflictError, LostUpdateError, StorageError } from './adapter';

/** Failures an adapter or SyncManager raised after a write it cannot rule out. */
const MAY_HAVE_LANDED = new WeakSet<object>();

/** Marks `error` as a failure after a write that may have landed, and returns it. */
export function uncertainWrite<E extends object>(error: E): E {
  MAY_HAVE_LANDED.add(error);
  return error;
}

/** True for a failure marked by `uncertainWrite`, and for a thrown value that is not an
 *  object: it cannot carry the mark, and an unknown failure is never a refusal. */
export function mayHaveLanded(error: unknown): boolean {
  return typeof error !== 'object' || error === null || MAY_HAVE_LANDED.has(error);
}

/**
 * HTTP answers to a record write that say the provider did not store it.
 * Every status here is the provider's answer to the upload itself; a status
 * kept on a failure after the upload (Google Drive's verify read) is marked
 * `uncertainWrite` by its adapter and never reaches this table.
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
 * Not here, so "may have landed":
 * - 408: a request timeout, which a proxy can send after it forwarded the body.
 * - 429: too many requests. No adapter here cites a provider promise that a
 *   rate-limited upload was never applied, so it is not called a refusal.
 * - 5xx (507 included): the server failed partway, or a gateway gave up waiting.
 * Google Drive: it offers no precondition; its adapter checks every copy's
 * version itself before the upload (a ConflictError) and marks every failure
 * after it sent the upload (drive-rest.ts `uncertain`), so only that check and
 * failures before the upload are refusals. The iPhone's token retry
 * (ios/engine/cloud-adapters.ts refreshOn401) never retries a marked failure.
 */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 412, 413, 422]);

/**
 * A failure on the write path that certainly stored nothing: a conflict the
 * provider refused (never a LostUpdateError, which wrote), a full store, a
 * device page that may no longer write (WritesStoppedError), or one of the
 * HTTP refusals above. Everything else may have landed: network errors,
 * timeouts, aborts, 5xx, and anything this function does not know.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  if (mayHaveLanded(error) || error instanceof LostUpdateError) return false;
  if (error instanceof ConflictError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'WritesStoppedError' || error.name === 'QuotaExceededError') return true;
  if (!(error instanceof StorageError)) return false;
  if (error.reason === 'storage-full' || (error.cause as { name?: unknown } | undefined)?.name === 'QuotaExceededError') return true;
  return error.status !== undefined && REFUSED_STATUSES.has(error.status);
}
