/**
 * The website's lab read: one file per POST through the app proxy (US-12). The batch path and its
 * poll are gone (owner ruling Q2, US-12 AC26): a body that asks for one is an invalid request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const extractOrClassify = vi.fn();

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractOrClassify: (...a: unknown[]) => extractOrClassify(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import * as Sentry from '@sentry/react-router';
import { ExtractionStopError } from '../lib/anthropic.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { machineFiles } from '../lib/rate-limiter';
import { action, loader } from './api.lab-import-v2';
import { streamingPost } from '../lib/capped-body.test-helpers';

const PAGES = [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }];
const URL = 'https://health-tool-app.fly.dev/api/lab-import-v2';

let ipCounter = 0;
/** One file's read; a fresh IP unless given: the per-IP daily quota is module-global. */
const single = (extra: Record<string, unknown> = {}, ip = `10.1.0.${++ipCounter}`) => new Request(URL, {
  method: 'POST', headers: { 'fly-client-ip': ip }, body: JSON.stringify({ pages: PAGES, ...extra }),
});
const remaining = async (ip: string) => (await (await loader({ request: new Request(URL, { headers: { 'fly-client-ip': ip } }) } as never)).json()).remaining;
/** Spends `n` of the IP's files, one read each. */
async function spend(ip: string, n: number) {
  for (let i = 0; i < n; i++) {
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    expect((await action({ request: single({}, ip) } as never)).status).toBe(200);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// US-12 AC26 (owner ruling Q2): every upload reads file by file; the batch and its poll are gone.
describe('US-12 AC26: no batch, no poll', () => {
  it('a batch body is an invalid request, read by nothing and charged nothing', async () => {
    const ip = '10.3.0.1';
    const res = await action({ request: new Request(URL, { method: 'POST', headers: { 'fly-client-ip': ip }, body: JSON.stringify({ batch: true, files: [{ pages: PAGES }] }) }) } as never);
    expect(res.status).toBe(400);
    expect(await remaining(ip)).toBe(200);
    expect(extractOrClassify).not.toHaveBeenCalled();
  });

  it('a poll body is an invalid request', async () => {
    const res = await action({ request: new Request(URL, { method: 'POST', headers: { 'fly-client-ip': '10.3.0.2' }, body: JSON.stringify({ batchId: 'batch_x', pollToken: 't' }) }) } as never);
    expect(res.status).toBe(400);
  });
});

// US-12 AC17: the per-IP daily limit is the upload window's own file cap, so one upload's files fit a fresh day.
describe('US-12 AC17: one IP may send as many files a day as one upload takes', () => {
  it('is 200 files, the website upload cap', async () => {
    expect(IMPORT_LIMITS.websiteFiles).toBe(200);
    expect(await remaining('10.2.0.1')).toBe(200);
  });

  it('takes 200 files from a fresh IP, then refuses the next file with the daily-limit answer', async () => {
    await spend('10.2.0.2', 200);
    const over = await action({ request: single({}, '10.2.0.2') } as never);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' });
  });

  it('the machine cap refuses: the IP is not charged', async () => {
    machineFiles.take('machine', machineFiles.remaining('machine'));
    try {
      const res = await action({ request: single({}, '10.4.0.1') } as never);
      expect(res.status).toBe(429);
      expect(await remaining('10.4.0.1')).toBe(200);
    } finally { machineFiles.reset(); }
  });
});

// US-15 AC34: Haiku 5.5 can decline a file, or stop at its token cap, and the
// same request stops the same way again. The answer says which, so the widget
// does not say "try again", and carries no document text.
describe('a single file that stopped short', () => {
  it('answers a refusal 422 "refused" and reports its category, not an exception', async () => {
    extractOrClassify.mockRejectedValueOnce(new ExtractionStopError('refused', 'general_harms'));
    const answer = await action({ request: single() } as never);
    expect(answer.status).toBe(422);
    expect(await answer.json()).toEqual({ success: false, error: 'Not read', errorCode: 'refused' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Lab import: extraction refused', expect.objectContaining({
      tags: expect.objectContaining({ feature: 'lab_import_v2', path: 'single', refusalCategory: 'general_harms' }),
    }));
  });

  it('US-12 AC17: a single file costs one of the IP\'s 200 files', async () => {
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    const request = single();
    const ip = request.headers.get('fly-client-ip')!;
    await action({ request } as never);
    expect(await remaining(ip)).toBe(199);
  });

  // One deadline for the file: a malformed answer's re-send gets what is left,
  // never a fresh 60 s.
  it('gives the file one 60 s deadline', async () => {
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    await action({ request: single() } as never);
    expect(extractOrClassify).toHaveBeenCalledWith(PAGES, { purpose: 'LABS', timeoutMs: 60_000, retryRateLimit: true });
  });

  it('answers a max_tokens stop 422 "too_long"', async () => {
    extractOrClassify.mockRejectedValueOnce(new ExtractionStopError('too_long'));
    const answer = await action({ request: single() } as never);
    expect(answer.status).toBe(422);
    expect((await answer.json()).errorCode).toBe('too_long');
  });

  it('still answers any other failure 500', async () => {
    extractOrClassify.mockRejectedValueOnce(new Error('extraction returned malformed JSON'));
    expect((await action({ request: single() } as never)).status).toBe(500);
  });
});

// US-12 AC12: a tab opened before the deploy ignores `recordedAt` and would
// save a previous column's values on the report date. Only the new widget
// sends `ownDates: true`; without it, every value with its own day is cut.
describe('US-12 AC12: a value with its own day reaches only a widget that reads it', () => {
  const dated = () => ({
    classification: 'lab_report', reportDate: '2026-03-10', document: null,
    values: [
      { metric: 'ldl', valueSI: 2.1, displayValue: 2.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
      { metric: 'ldl', valueSI: 2.6, displayValue: 2.6, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', recordedAt: '2025-09-02' },
    ],
    additionalValues: [
      { name: 'ferritin', value: 80, unit: 'ug/L' },
      { name: 'ferritin', value: 95, unit: 'ug/L', recordedAt: '2025-09-02' },
    ],
  });

  it('single file, old widget (no flag): the previous column is cut, the primary kept', async () => {
    extractOrClassify.mockResolvedValueOnce(dated());
    const { data } = await (await action({ request: single({}) } as never)).json();
    expect(data.values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1]);
    expect(data.additionalValues.map((v: { value: number }) => v.value)).toEqual([80]);
  });

  it('single file, new widget (ownDates: true): both columns answer', async () => {
    extractOrClassify.mockResolvedValueOnce(dated());
    const { data } = await (await action({ request: single({ ownDates: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, '2025-09-02']);
    expect(data.additionalValues).toHaveLength(2);
  });

  // US-12 AC14: an undated previous column carries the `recordedAt` marker,
  // so an old tab, which would file it on the report date, never gets it.
  const undated = () => {
    const result = dated();
    result.values[1].recordedAt = 'undated';
    result.additionalValues[1].recordedAt = 'undated';
    return result;
  };

  it('US-12 AC14 — no flag: an undated previous value is cut too', async () => {
    extractOrClassify.mockResolvedValueOnce(undated());
    const { data } = await (await action({ request: single({}) } as never)).json();
    expect(data.values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1]);
    expect(data.additionalValues.map((v: { value: number }) => v.value)).toEqual([80]);
  });

  // A tab from before AC14 sends `ownDates` but reads "undated" as a date: it
  // gets the undated column only with `undatedPrev: true`, this widget's flag.
  const undatedAndDated = () => {
    const result = undated();
    result.values.push({ ...result.values[0], valueSI: 2.4, recordedAt: '2025-09-02' });
    return result;
  };

  it('US-12 AC14 — ownDates alone (a tab from before AC14): the undated value is cut, a dated one kept', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ ownDates: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, '2025-09-02']);
    expect(data.additionalValues.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined]);
  });

  it('US-12 AC14 — undatedPrev without ownDates: every own-dated value is still cut', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ undatedPrev: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined]);
  });

  it('US-12 AC14 — ownDates is `true` or absent: any other value (2 included) is an invalid request', async () => {
    for (const ownDates of [2, 3, '2', false]) {
      expect((await action({ request: single({ ownDates }) } as never)).status, String(ownDates)).toBe(400);
    }
    expect(extractOrClassify).not.toHaveBeenCalled();
  });

  it('US-12 AC14 — both flags (this widget): the undated value answers, marked', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ ownDates: true, undatedPrev: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, 'undated', '2025-09-02']);
    expect(data.additionalValues.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, 'undated']);
  });
});

// Issue #166: refused rows count in `droppedValueCount` only here, for a widget
// that predates `refusedValues`, so this widget lists them once (US-12 AC15).
describe('US-12 AC15: a refused value reaches an old widget as a value that could not be read', () => {
  const refusing = () => ({
    classification: 'lab_report', reportDate: '2026-03-10', document: null, droppedValueCount: 1,
    values: [{ metric: 'ldl', valueSI: 2.1, displayValue: 2.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
    additionalValues: [],
    refusedValues: [
      { metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'This unit is usually a urine result.' },
      { metric: 'creatinine', value: 3, unit: 'mg/mmol', reason: 'This unit is usually a urine result.', recordedAt: '2025-09-02' },
    ],
  });
  const FLAGS = { ownDates: true, undatedPrev: true };

  it('single file: an old widget gets each refused value it reads added to droppedValueCount; this one gets them listed, uncounted', async () => {
    extractOrClassify.mockResolvedValueOnce(refusing());
    const old = (await (await action({ request: single(FLAGS) } as never)).json()).data;
    expect(old.droppedValueCount).toBe(3);
    extractOrClassify.mockResolvedValueOnce(refusing());
    const oldest = (await (await action({ request: single({}) } as never)).json()).data;
    expect(oldest.droppedValueCount).toBe(2); // the previous-column one is cut with its column
    extractOrClassify.mockResolvedValueOnce(refusing());
    const now = (await (await action({ request: single({ ...FLAGS, refusedRows: true }) } as never)).json()).data;
    expect(now.droppedValueCount).toBe(1);
    expect(now.refusedValues).toHaveLength(2);
  });

  it('refusedRows is `true` or absent', async () => {
    expect((await action({ request: single({ refusedRows: 1 }) } as never)).status).toBe(400);
  });
});

// The widget and the iPhone name each value the parse dropped (US-12 AC19):
// the route hands the names and reasons on.
describe('US-12 AC19: the dropped values\' names reach the widget', () => {
  const unread = [{ name: 'hdl', reason: 'unreadable' }, { name: 'lpa', reason: 'unreadable' }];
  const partial = () => ({
    classification: 'lab_report', reportDate: '2026-03-10', document: null, droppedValueCount: 2, unreadValues: unread,
    values: [{ metric: 'ldl', valueSI: 2.1, displayValue: 2.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
    additionalValues: [],
  });
  const body = (extra: Record<string, unknown>) => single({ ownDates: true, undatedPrev: true, refusedRows: true, ...extra });

  it('a single file', async () => {
    extractOrClassify.mockResolvedValueOnce(partial());
    const one = (await (await action({ request: body({}) } as never)).json()).data;
    expect(one).toMatchObject({ droppedValueCount: 2, unreadValues: unread });
  });

  it('names only rows from a column this caller is offered, and the count drops the rest with their column', async () => {
    const columns = () => ({ ...partial(), droppedValueCount: 3, unreadValues: [
      { name: 'hdl', reason: 'unreadable' }, { name: 'hdl', reason: 'unreadable', recordedAt: '2025-06-01' }, { name: 'lpa', reason: 'unreadable', recordedAt: 'undated' },
    ] });
    const ask = async (flags: Record<string, unknown>) => {
      extractOrClassify.mockResolvedValueOnce(columns());
      return (await (await action({ request: body({ ownDates: undefined, undatedPrev: undefined, ...flags }) } as never)).json()).data;
    };
    // The iPhone: its own days, no undated column.
    expect(await ask({ ownDates: true })).toMatchObject({ droppedValueCount: 2, unreadValues: [{ name: 'hdl', reason: 'unreadable' }, { name: 'hdl', reason: 'unreadable', recordedAt: '2025-06-01' }] });
    // A widget from before own days: the report's column only.
    expect(await ask({})).toMatchObject({ droppedValueCount: 1, unreadValues: [{ name: 'hdl', reason: 'unreadable' }] });
    // This widget: every column.
    expect(await ask({ ownDates: true, undatedPrev: true })).toMatchObject({ droppedValueCount: 3 });
  });

  it('an unnamed row in a column the caller is not offered leaves the count too (re-check R1)', async () => {
    extractOrClassify.mockResolvedValueOnce({ ...partial(), droppedValueCount: 2, unreadValues: [
      { name: '', reason: 'unreadable' }, { name: '', reason: 'unreadable', recordedAt: 'undated' },
    ] });
    const data = (await (await action({ request: body({ undatedPrev: undefined }) } as never)).json()).data;
    expect(data).toMatchObject({ droppedValueCount: 1, unreadValues: [{ name: '', reason: 'unreadable' }] });
  });
});

describe('lab-import body cap (US-09 AC25)', () => {
  const MB = 1024 * 1024;
  it('answers 413 to a body over 200 MB whose Content-Length lies low, and stops reading', async () => {
    const { request, pulled } = streamingPost(URL, 260 * MB, {
      headers: { 'fly-client-ip': '10.1.8.1', 'content-length': '1000' }, chunkBytes: MB,
    });
    const res = await action({ request } as never);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ success: false, error: 'Request too large' });
    expect(pulled.bytes).toBeLessThanOrEqual(202 * MB);
    expect(extractOrClassify).not.toHaveBeenCalled();
  });

  it('answers 413 to a declared length over 200 MB without reading it', async () => {
    const { request, pulled } = streamingPost(URL, 10, {
      headers: { 'fly-client-ip': '10.1.8.2', 'content-length': String(200 * MB + 1) },
    });
    expect((await action({ request } as never)).status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(10);
  });
});

// US-12 AC17b: an IP or a machine with no file left today can read nothing, so
// its upload is refused after at most 64 KB of it is read (plus the two chunks
// a stream reads ahead); a larger body is not parsed and nothing is charged.
describe('US-12 AC17b: a spent day is refused after at most 64 KB of the upload is read', () => {
  const MB = 1024 * 1024;
  const KB = 1024;
  const limit = { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' };

  it('reads at most 64 KB of an upload from an IP that has used its 200 files', async () => {
    await spend('10.5.0.1', 200);
    extractOrClassify.mockClear();
    const { request, pulled } = streamingPost(URL, 50 * MB, { headers: { 'fly-client-ip': '10.5.0.1' }, chunkBytes: 16 * KB });
    const res = await action({ request } as never);
    expect(pulled.bytes).toBeLessThanOrEqual(64 * KB + 2 * 16 * KB);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(limit);
    expect(extractOrClassify).not.toHaveBeenCalled();
  });

  it('refuses a declared length over 64 KB from that IP unread', async () => {
    await spend('10.5.0.2', 200);
    const { request, pulled } = streamingPost(URL, 10, { headers: { 'fly-client-ip': '10.5.0.2', 'content-length': String(65 * KB) } });
    const res = await action({ request } as never);
    expect(pulled.bytes).toBeLessThanOrEqual(10);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(limit);
  });

  it('reads at most 64 KB of an upload from a fresh IP once the machine cap is spent', async () => {
    machineFiles.take('machine', machineFiles.remaining('machine'));
    try {
      const { request, pulled } = streamingPost(URL, 50 * MB, { headers: { 'fly-client-ip': '10.5.0.4' }, chunkBytes: 16 * KB });
      const res = await action({ request } as never);
      expect(pulled.bytes).toBeLessThanOrEqual(64 * KB + 2 * 16 * KB);
      expect(res.status).toBe(429);
    } finally { machineFiles.reset(); }
  });

  // The 64 KB cap is for a day with no file left, not for a day partly used:
  // a file padded past 64 KB must still be read whole and taken.
  const padded = (ip: string) => new Request(URL, {
    method: 'POST', headers: { 'fly-client-ip': ip }, body: JSON.stringify({ pages: PAGES }) + ' '.repeat(MB),
  });

  it('still reads an upload over 64 KB from an IP with 1 of its 200 files left', async () => {
    await spend('10.5.0.6', 199);
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    expect((await action({ request: padded('10.5.0.6') } as never)).status).toBe(200);
  });

  it('still reads an upload over 64 KB on a machine with 1 file left', async () => {
    machineFiles.take('machine', machineFiles.remaining('machine') - 1);
    try {
      extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
      expect((await action({ request: padded('10.5.0.7') } as never)).status).toBe(200);
    } finally { machineFiles.reset(); }
  });
});

// US-12 AC9 (H65): every daily-limit 429 says so with a code, so the browser
// never mistakes a busy server for the limit. The words stay byte-identical.
describe('US-12 AC9 H65: the daily limit carries code daily_limit', () => {
  const DAILY = { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' };

  it('an over-quota single file', async () => {
    await spend('10.6.0.2', 200);
    extractOrClassify.mockClear();
    const res = await action({ request: single({ unitSystem: 'si' }, '10.6.0.2') } as never);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(DAILY);
    expect(extractOrClassify).not.toHaveBeenCalled();
  });
});
