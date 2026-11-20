/**
 * US-52 AC7e: the app gate's refusals and the phone's own App Attest failures, through the shared
 * failure model. Words: the gate's own `error` text as today's iPhone shows it; the iPhone's lines
 * moved byte for byte from Swift; never new sentences.
 */
import { describe, expect, it } from 'vitest';
import { appGateFailure, GATE_WORDS_MAX, type FailDetail, type UploadFailure } from './upload-failure';
import { RETRYABLE, transition, type UploadState } from './upload-flow';
import { UPLOAD_EVENT, UPLOAD_STATE } from './upload-schema';
import { failLine, FAIL_TEXT, PHONE_FAIL_TEXT } from './upload-text';

const JSON_TYPE = 'application/json; charset=utf-8';
const gate = (error: string, reason: string) => JSON.stringify({ success: false, error, reason });

describe('appGateFailure: what each gate refusal means on the phone', () => {
  const cases: Array<[string, number | null, string | null, string | null, UploadFailure, string | null]> = [
    ['a final 401', 401, gate('This request was not signed by the app.', 'bad_signature'), JSON_TYPE, 'app_refused', 'This request was not signed by the app.'],
    ['a 413', 413, gate('Request too large', 'too_large'), JSON_TYPE, 'too_large', 'Request too large'],
    ['an unknown 4xx', 400, JSON.stringify({ success: false, error: 'Invalid request' }), JSON_TYPE, 'app_refused', 'Invalid request'],
    ['the daily limit stays the daily limit', 429, gate('Daily limit reached. Please try again tomorrow.', 'limit'), JSON_TYPE, 'rate_limit', 'Daily limit reached. Please try again tomorrow.'],
    ['a 503 is a server failure Try again mends', 503, gate('This is not available right now. Please try again later.', 'unavailable'), JSON_TYPE, 'server_error', 'This is not available right now. Please try again later.'],
    ['a 422 keeps no words of its own', 422, JSON.stringify({ errorCode: 'refused', error: 'x' }), JSON_TYPE, 'refused', null],
    ['no answer', null, null, null, 'network', null],
    ['a body not JSON: no words', 401, 'This request was not signed by the app.', 'text/plain', 'app_refused', null],
    ['blank words: none', 413, gate('   ', 'too_large'), JSON_TYPE, 'too_large', null],
    ['words that are not text: none', 401, JSON.stringify({ error: { html: '<b>' } }), JSON_TYPE, 'app_refused', null],
  ];
  for (const [name, status, text, type, failure, message] of cases) {
    it(name, () => expect(appGateFailure(status, text, type)).toEqual(message === null ? { failure } : { failure, detail: { message } }));
  }

  it('the words are trimmed and cut at 200 characters, never read', () => {
    const long = ` ${'<script>'.repeat(40)} `;
    const read = appGateFailure(401, gate(long, 'x'), JSON_TYPE);
    expect(read.detail).toEqual({ message: long.trim().slice(0, GATE_WORDS_MAX) });
  });
});

describe('the failure on the file: its words travel with it, and only with its own reason', () => {
  const open = (platform: 'web' | 'phone', ids = ['x']): UploadState => ({
    phase: 'open', platform, run: 1, started: 'T', firstRead: null,
    files: ids.map((id) => ({ id, name: `${id}.pdf`, bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending' as const, attempt: 1 } })),
  });
  const failedOf = (state: UploadState, id = 'x') => ('files' in state ? state.files.find((f) => f.id === id)?.status : undefined);

  it('a 401 with its words: kept, not retryable, and the state round-trips its schema', () => {
    const detail: FailDetail = { message: 'This request was not signed by the app.' };
    const { state } = transition(open('phone'), { type: 'sendFailed', run: 1, id: 'x', failure: 'app_refused', detail });
    expect(failedOf(state)).toEqual({ s: 'failed', reason: 'appRefused', attempt: 1, detail });
    expect(RETRYABLE.appRefused).toBe(false);
    expect(UPLOAD_STATE.parse(state)).toEqual(state);
  });

  it('the daily limit still stops the run; the words stay with the file that met it', () => {
    const detail: FailDetail = { message: 'Daily limit reached. Please try again tomorrow.' };
    const { state } = transition(open('phone', ['x', 'y']), { type: 'sendFailed', run: 1, id: 'x', failure: 'rate_limit', detail });
    expect(failedOf(state)).toEqual({ s: 'failed', reason: 'dailyLimit', attempt: 1, detail });
    // y was in flight: its own end comes later; a server failure then is the limit, with no words of another reason.
    const after = transition(state, { type: 'sendFailed', run: 1, id: 'y', failure: 'server_error', detail: { message: 'This is not available right now. Please try again later.' } }).state;
    expect(failedOf(after, 'y')).toEqual({ s: 'failed', reason: 'dailyLimit', attempt: 1 });
  });

  it('Try again drops the words with the failure', () => {
    const failed = transition(open('phone'), { type: 'sendFailed', run: 1, id: 'x', failure: 'attest_failed', detail: { stage: 'assert', code: '3' } }).state;
    const again = transition(failed, { type: 'retry', id: 'x' }).state;
    expect(failedOf(again)?.s).toBe('sending');
  });

  it('the schema bounds the App Attest step and code, and the words', () => {
    const event = (detail: unknown) => ({ type: 'sendFailed', run: 1, id: 'x', failure: 'attest_failed', detail });
    expect(UPLOAD_EVENT.safeParse(event({ stage: 'assert', code: '3' })).success).toBe(true);
    expect(UPLOAD_EVENT.safeParse(event({ stage: 'assert', code: 'com.apple.devicecheck.error 3' })).success).toBe(false);
    expect(UPLOAD_EVENT.safeParse(event({ stage: 'a'.repeat(25), code: '3' })).success).toBe(false);
    expect(UPLOAD_EVENT.safeParse(event({ message: 'x'.repeat(GATE_WORDS_MAX + 1) })).success).toBe(false);
    expect(UPLOAD_EVENT.safeParse(event({ message: 'x', stage: 'a', code: 'b' })).success).toBe(false);
  });
});

describe('failLine: each failed file\'s words', () => {
  it('the gate\'s own words first, on either client', () => {
    expect(failLine({ reason: 'appRefused', detail: { message: 'Request too large' } }, 'phone')).toBe('Request too large');
  });
  it('the App Attest step and code, after today\'s iPhone line', () => {
    expect(failLine({ reason: 'attestFailed', detail: { stage: 'assert', code: '3' } }, 'phone'))
      .toBe('This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest assert 3)');
  });
  it('the iPhone\'s lines where they differ; the web\'s unchanged', () => {
    expect(failLine({ reason: 'cannotAttest' }, 'phone')).toBe('Chat and lab upload need a device that can prove the app is genuine (Apple App Attest). This device cannot.');
    expect(failLine({ reason: 'declined' }, 'phone')).toBe('The AI could not read this file.');
    expect(failLine({ reason: 'tooLong' }, 'phone')).toBe(PHONE_FAIL_TEXT.declined);
    expect(failLine({ reason: 'appRefused' }, 'phone')).toBe('The server could not answer just now. Please try again later.');
    expect(failLine({ reason: 'server' }, 'phone')).toBe(PHONE_FAIL_TEXT.noAnswer);
    expect(failLine({ reason: 'declined' }, 'web')).toBe(FAIL_TEXT.declined);
    expect(failLine({ reason: 'server' }, 'web')).toBe(FAIL_TEXT.server);
  });
});
