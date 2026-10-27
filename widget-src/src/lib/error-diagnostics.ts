import { ConflictError, RecordShapeError, SchemaTooNewError, StorageError } from '@roadmap/health-core';

/** Expected transport interruptions stay quiet without retaining raw messages. */
export const EXPECTED_NETWORK_ERRORS = [
  /Failed to fetch/,
  /Load failed/,
  /NetworkError when attempting to fetch resource/,
  /did not answer/,
  /The operation was aborted/,
];

type RecordFailure =
  | 'Document file not stored'
  | 'Cloud sync failed'
  | 'Cloud connect failed'
  | 'Cloud record could not be loaded'
  | 'Upload processing failed'
  | 'Upload save failed';

/** Fresh exception: no provider text, original cause or document reference. */
export function recordFailure(error: unknown, message: RecordFailure): Error {
  const interruption = error instanceof Error && EXPECTED_NETWORK_ERRORS.some(pattern => pattern.test(error.message));
  return new Error(interruption ? 'Network request did not answer' : message);
}

const STORAGE_FAILURE_CLASSES = ['QuotaExceededError', 'SecurityError', 'TypeError', 'ReferenceError'];

/** The browser's own name for a refused device write, from a closed list —
 *  quota versus blocked storage (Sentry JAVASCRIPT-REMIX-6M). Read only from
 *  the adapter's wrapped cause: a bare TypeError elsewhere in the save path
 *  is a defect or a dead network, not a storage class. A name, never the
 *  message, so it survives the scrub value-free. */
export function storageFailureClass(error: unknown): string {
  const cause = error instanceof StorageError ? error.cause : undefined;
  const name = cause instanceof Error || cause instanceof DOMException ? cause.name : '';
  return STORAGE_FAILURE_CLASSES.includes(name) ? name : 'other';
}

export const CAUSE_CLASS_TAGS = ['SyntaxError', 'ConflictError', 'none', 'other'];

/** What a StorageError wrapped, from a closed list (US-09 AC28, Sentry
 *  JAVASCRIPT-REMIX-77): a corrupt read (SyntaxError) and a conflict read
 *  apart from the refusals `cause=other` pools. `none` when there is no
 *  StorageError cause. A class, never the message. */
export function storageCauseClass(error: unknown): string {
  const cause = error instanceof StorageError ? error.cause : undefined;
  return cause === undefined ? 'none'
    : cause instanceof ConflictError ? 'ConflictError'
    : cause instanceof SyntaxError ? 'SyntaxError'
    : 'other';
}

export const ERROR_CLASS_TAGS = ['StorageError', 'ConflictError', 'SchemaTooNewError', 'RecordShapeError', 'other'];
export const HTTP_STATUS_TAGS = ['401', '403', '404', '409', '429', '4xx', '5xx', 'none'];

/** What a fixed-message capture still needs to be read (US-09 AC6c): the
 *  error's class and the provider's HTTP status class, each from a closed
 *  list, so a refused token (401/403) reads apart from a rate limit (429) or
 *  an outage (5xx). Literal names, since a minified bundle renames classes.
 *  The status is the one a StorageError carries: the Drive and Dropbox
 *  adapters set it wherever they throw beside a response, the OAuth exchange
 *  and Dropbox's token refresh included. Drive's refresh-path errors ("retry
 *  later", "needs to be reconnected") read `none`: their status is not kept
 *  across the refresh, since overlapping refreshes would race. GitHub, WebDAV,
 *  a network failure and a check that made no request also read `none`.
 *  Never the message or the body. */
export function failureTags(error: unknown): { errorClass: string; httpStatus: string } {
  const errorClass = error instanceof StorageError ? 'StorageError'
    : error instanceof ConflictError ? 'ConflictError'
    : error instanceof SchemaTooNewError ? 'SchemaTooNewError'
    : error instanceof RecordShapeError ? 'RecordShapeError'
    : 'other';
  const status = error instanceof StorageError ? error.status : undefined;
  const httpStatus = status === undefined ? 'none'
    : HTTP_STATUS_TAGS.includes(String(status)) ? String(status)
    : status >= 400 && status < 500 ? '4xx'
    : status >= 500 && status < 600 ? '5xx'
    : 'none';
  return { errorClass, httpStatus };
}
