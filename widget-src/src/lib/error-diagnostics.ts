/** Expected transport interruptions stay quiet without retaining raw messages. */
export const EXPECTED_NETWORK_ERRORS = [
  /Failed to fetch/,
  /Load failed/,
  /NetworkError when attempting to fetch resource/,
  /did not answer/,
  /The operation was aborted/,
];

type RecordFailure = 'Document file not stored' | 'Cloud sync failed' | 'Upload processing failed' | 'Upload save failed';

/** Fresh exception: no provider text, original cause or document reference. */
export function recordFailure(error: unknown, message: RecordFailure): Error {
  const interruption = error instanceof Error && EXPECTED_NETWORK_ERRORS.some(pattern => pattern.test(error.message));
  return new Error(interruption ? 'Network request did not answer' : message);
}
