import { StorageError } from '@roadmap/health-core';

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
