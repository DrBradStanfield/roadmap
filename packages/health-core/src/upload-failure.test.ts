/**
 * uploadFailure answers case for case as widget-src/src/lib/upload-api.ts `labImport` (US-12 AC9,
 * US-15 AC34): one row per branch of that function, read from it, and how upload-flow.ts then
 * treats each code (a file's reason, and whether Try again sends it again).
 */
import { describe, expect, it } from 'vitest';
import { RETRYABLE, transition, type UploadState } from './upload-flow';
import { uploadFailure, type UploadFailure } from './upload-failure';

// [upload-api.ts case, status (null: fetch threw), body (null: not JSON; undefined: JSON that would not parse), code]
const CASES: Array<[string, number | null, unknown, UploadFailure]> = [
  ['429 code busy (tooMany)', 429, { code: 'busy' }, 'busy'],
  ['429 code daily_limit', 429, { code: 'daily_limit' }, 'rate_limit'],
  ['429 unknown code', 429, { code: 'later' }, 'rate_limit'],
  ['429 no code', 429, {}, 'rate_limit'],
  ['429 body not JSON', 429, null, 'rate_limit'],
  ['429 JSON that would not parse (.catch to null)', 429, undefined, 'rate_limit'],
  ['422 errorCode refused (EXTRACTION_STOP_CODES)', 422, { errorCode: 'refused' }, 'refused'],
  ['422 errorCode too_long', 422, { errorCode: 'too_long' }, 'too_long'],
  ['422 unknown errorCode', 422, { errorCode: 'other' }, 'server_error'],
  ['422 no errorCode', 422, {}, 'server_error'],
  ['422 body not JSON (parseJsonResponse null)', 422, null, 'server_error'],
  ['422 JSON that would not parse (throws to the catch)', 422, undefined, 'network'],
  ['400 (!response.ok)', 400, { errorCode: 'refused' }, 'server_error'],
  ['413 (!response.ok)', 413, null, 'server_error'],
  ['500 (!response.ok)', 500, null, 'server_error'],
  ['503 (!response.ok)', 503, { code: 'busy' }, 'server_error'],
  ['200 success false', 200, { success: false, error: 'x' }, 'server_error'],
  ['200 success true but no data', 200, { success: true }, 'server_error'],
  ['200 body not JSON', 200, null, 'server_error'],
  ['200 JSON that would not parse (throws to the catch)', 200, undefined, 'network'],
  ['fetch threw', null, null, 'network'],
];

describe('uploadFailure: case for case with upload-api.ts labImport', () => {
  for (const [name, status, body, want] of CASES) {
    it(name, () => expect(uploadFailure(status, body)).toBe(want));
  }
});

describe('each code in upload-flow: a reason of its own, retried as today', () => {
  const sending: UploadState = {
    phase: 'open', platform: 'web', run: 1, started: 'T', firstRead: null,
    files: [{ id: 'x', name: 'x.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } }],
  };
  const WANT: Record<UploadFailure, [string, boolean]> = {
    busy: ['busy', true], network: ['network', true], server_error: ['server', true],
    rate_limit: ['dailyLimit', false], refused: ['declined', false], too_long: ['tooLong', false],
  };
  for (const [failure, [reason, retryable]] of Object.entries(WANT) as Array<[UploadFailure, [string, boolean]]>) {
    it(`${failure} -> ${reason}, ${retryable ? '' : 'not '}retryable`, () => {
      const { state } = transition(sending, { type: 'sendFailed', run: 1, id: 'x', failure });
      const status = 'files' in state ? state.files[0].status : null;
      expect(status).toEqual({ s: 'failed', reason, attempt: 1 });
      expect(status?.s === 'failed' && RETRYABLE[status.reason]).toBe(retryable);
      expect(transition(state, { type: 'retry', id: 'x' }).effects.some((f) => f.type === 'send')).toBe(retryable);
    });
  }
});
