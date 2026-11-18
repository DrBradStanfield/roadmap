/**
 * labAnswer and labStreamAnswer as the upload sees them (US-52 AC7e, AC8c): a read only when the
 * route said success and its data is a read the engine can check; every other answer the shared
 * failure code, and what the machine then does with it. Synthetic values.
 */
import { describe, expect, it } from 'vitest';
import { labAnswer, labStreamAnswer } from './upload-answer';
import { RETRYABLE, transition, type UploadState } from './upload-flow';

const READ = { classification: 'lab_report', reportDate: '2026-11-01', values: [], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: 30, referenceHigh: null }], unrecognized: [], document: null };
const line = (status: number, body: unknown) => JSON.stringify({ status, body });
const two: UploadState = {
  phase: 'open', platform: 'phone', run: 1, started: 'T', firstRead: null, files: [
    { id: 'a', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } },
    { id: 'b', name: 'b.pdf', bytes: 1, hash: 'g', pages: null, status: { s: 'hashed' } },
  ],
};
/** The answer for file `a` through the machine: its file's status after it. */
const after = (answer: ReturnType<typeof labAnswer>) => {
  const { state } = transition(two, 'extraction' in answer
    ? { type: 'answered', run: 1, id: 'a', extraction: answer.extraction, legacy: false, now: 'T1' }
    : { type: 'sendFailed', run: 1, id: 'a', failure: answer.failure });
  return 'files' in state ? state.files.map((f) => f.status) : [];
};

describe('labStreamAnswer: the streaming route\'s last line (US-52 AC7e)', () => {
  it('200 with a read becomes the read, unknown fields kept', () => {
    expect(labStreamAnswer(line(200, { success: true, data: { ...READ, extra: 1 } }))).toEqual({ extraction: { ...READ, extra: 1 } });
  });
  it('a daily-limit 429 stops the run: the file and every unsent one fail on the limit, not retryable', () => {
    const answer = labStreamAnswer(line(429, { success: false, code: 'daily_limit' }));
    expect(answer).toEqual({ failure: 'rate_limit' });
    expect(after(answer).map((s) => s.s === 'failed' && s.reason)).toEqual(['dailyLimit', 'dailyLimit']);
    expect(RETRYABLE.dailyLimit).toBe(false);
  });
  it('a 422 decline is declined, not retryable', () => {
    const answer = labStreamAnswer(line(422, { success: false, errorCode: 'refused' }));
    expect(answer).toEqual({ failure: 'refused' });
    expect(after(answer)[0]).toEqual({ s: 'failed', reason: 'declined', attempt: 1 });
  });
  it('no last line, or one that is not {status, body}, is the network failure, retryable', () => {
    for (const l of [null, '', '{nope', '{"accepted":true}', '[]']) {
      expect(labStreamAnswer(l), String(l)).toEqual({ failure: 'network' });
    }
    expect(RETRYABLE.network).toBe(true);
  });
  it('a 200 whose data is not a read the engine can check is the server\'s error and never reaches a save', () => {
    const bad = { ...READ, additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: 'x' }] };
    expect(labStreamAnswer(line(200, { success: true, data: bad }))).toEqual({ failure: 'server_error' });
    expect(labStreamAnswer(line(200, { success: false, error: 'Extraction failed' }))).toEqual({ failure: 'server_error' });
  });
});

describe('labAnswer: a real HTTP answer before any stream (US-52 AC7e)', () => {
  it('the gate\'s 503 capacity refusal is retryable', () => {
    const answer = labAnswer(503, { success: false, reason: 'unavailable' });
    expect(answer).toEqual({ failure: 'server_error' });
    const [status] = after(answer);
    expect(status.s === 'failed' && RETRYABLE[status.reason]).toBe(true);
  });
});
