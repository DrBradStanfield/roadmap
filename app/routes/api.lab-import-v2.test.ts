/**
 * The batch poll is a capability, not a lookup. A batch id comes from
 * Anthropic and is not a secret; the poll it names returns EXTRACTED LAB TEXT.
 * So the POST that creates a batch hands back a random `pollToken`, and a poll
 * that cannot present it gets the same answer as a batch that never existed.
 *
 * And the poll itself is a POST: the server logs request URLs to stdout, so a
 * token in the query string is a logged capability. The GET side polls nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createBatch = vi.fn(async () => ({ batchId: 'batch_abc' }));
const pollBatch = vi.fn(async () => ({ status: 'ended' as const, completed: 1, total: 1, results: [{ fileName: 'a.pdf' }] }));
const extractOrClassify = vi.fn();
const deleteBatch = vi.fn(async () => true);

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  pollBatch: (...a: unknown[]) => pollBatch(...(a as [])),
  extractOrClassify: (...a: unknown[]) => extractOrClassify(...(a as [])),
  deleteBatch: (...a: unknown[]) => deleteBatch(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import * as Sentry from '@sentry/react-router';
import { ExtractionStopError } from '../lib/anthropic.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { action, loader } from './api.lab-import-v2';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }];

let ipCounter = 0;
/** A fresh IP per batch — the per-IP daily quota is module-global. */
function post(ip = `10.1.0.${++ipCounter}`): Request {
  return new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': ip },
    body: JSON.stringify({ batch: true, files: FILES }),
  });
}

/** A poll: POST, token in the body, nothing identifying in the URL. */
function poll(body: Record<string, unknown>): Request {
  return new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': '10.1.9.9' },
    body: JSON.stringify(body),
  });
}

async function newBatch(): Promise<{ batchId: string; pollToken: string }> {
  const created = await (await action({ request: post() } as never)).json();
  expect(created.success).toBe(true);
  return created;
}

beforeEach(() => {
  vi.clearAllMocks();
  createBatch.mockResolvedValue({ batchId: 'batch_abc' });
  deleteBatch.mockResolvedValue(true);
  pollBatch.mockResolvedValue({ status: 'ended', completed: 1, total: 1, results: [{ fileName: 'a.pdf' }] });
});

describe('the batch poll needs the token the upload was given', () => {
  it('hands back a token that is random per batch and not the id', async () => {
    const first = await newBatch();
    createBatch.mockResolvedValue({ batchId: 'batch_two' });
    const second = await newBatch();
    expect(first.pollToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(first.pollToken).not.toBe(first.batchId);
    expect(second.pollToken).not.toBe(first.pollToken);
  });

  it('404s a poll with no token, even though the batch exists', async () => {
    const { batchId } = await newBatch();
    const answer = await action({ request: poll({ batchId }) } as never);
    expect(answer.status).toBe(404);
    expect(pollBatch).not.toHaveBeenCalled();
  });

  it('404s a wrong token — a right-length guess and a short one answer alike', async () => {
    const { batchId, pollToken } = await newBatch();
    const wrongSameLength = 'a'.repeat(pollToken.length);
    for (const token of [wrongSameLength, 'x', `${pollToken}x`, '']) {
      const answer = await action({ request: poll({ batchId, pollToken: token }) } as never);
      expect(answer.status, token).toBe(404);
      expect(await answer.json()).toEqual({ error: 'Batch not found' });
    }
    expect(pollBatch).not.toHaveBeenCalled();
  });

  it('polls with the token', async () => {
    const { batchId, pollToken } = await newBatch();
    const answer = await action({ request: poll({ batchId, pollToken }) } as never);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ status: 'ended', completed: 1, total: 1 });
    expect(pollBatch).toHaveBeenCalledWith(batchId);
  });

  it('404s an id nobody created, token or not — the same answer as a bad token', async () => {
    const answer = await action({ request: poll({ batchId: 'batch_nope', pollToken: 'whatever' }) } as never);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: 'Batch not found' });
  });

  it('never polls from the GET side — a token in the query buys nothing', async () => {
    const { batchId, pollToken } = await newBatch();
    const query = `batchId=${batchId}&pollToken=${encodeURIComponent(pollToken)}`;
    const answer = await loader({
      request: new Request(`https://health-tool-app.fly.dev/api/lab-import-v2?${query}`, {
        headers: { 'fly-client-ip': '10.1.9.9' },
      }),
    } as never);
    expect(pollBatch).not.toHaveBeenCalled();
    expect(await answer.json()).toEqual({ allowed: true, remaining: expect.any(Number) });
  });

  // US-15 AC34: one Sentry message per stopped file, sent when the batch ends,
  // never again when the same ended batch is polled once more.
  it('reports each stopped file once, with its category, however often the ended batch is polled', async () => {
    const ended = {
      status: 'ended', completed: 2, total: 2,
      results: [{ index: 0, errorCode: 'refused' }, { index: 1, errorCode: 'too_long' }],
      stops: [new ExtractionStopError('refused', 'bio'), new ExtractionStopError('too_long')],
    } as never;
    pollBatch.mockResolvedValueOnce(ended).mockResolvedValueOnce(ended);
    const { batchId, pollToken } = await newBatch();
    const answer = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    await action({ request: poll({ batchId, pollToken }) } as never);
    expect(answer).not.toHaveProperty('stops');
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['Lab import: extraction refused', expect.objectContaining({ tags: expect.objectContaining({ path: 'batch', refusalCategory: 'bio' }) })],
      ['Lab import: extraction too_long', expect.objectContaining({ tags: expect.objectContaining({ path: 'batch', stopCode: 'too_long' }) })],
    ]);
  });

  it('a poll costs no quota — only the upload does', async () => {
    pollBatch.mockResolvedValue({ status: 'processing', completed: 0, total: 1 } as never);
    const { batchId, pollToken } = await newBatch();
    for (let i = 0; i < 5; i++) await action({ request: poll({ batchId, pollToken }) } as never);
    expect(pollBatch).toHaveBeenCalledTimes(5);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });
});

// US-12 AC18: the poll never deletes. A lost answer must not lose the batch:
// a re-poll gets the same results until the sweep deletes it
// (api.lab-import-v2.sweep.test.ts).
describe('US-12 AC18: the poll answers an ended batch again and deletes nothing', () => {
  it('serves the results to a second poll, with no delete', async () => {
    const { batchId, pollToken } = await newBatch();
    const first = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    const again = await action({ request: poll({ batchId, pollToken }) } as never);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(deleteBatch).not.toHaveBeenCalled();
  });
});

// US-12 AC17: the per-IP daily limit is the upload window's own file cap, so
// any batch the window takes fits a fresh day.
describe('US-12 AC17: one IP may send as many files a day as one upload takes', () => {
  const many = (n: number, ip: string) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST', headers: { 'fly-client-ip': ip },
    body: JSON.stringify({ batch: true, files: Array.from({ length: n }, () => FILES[0]) }),
  });

  it('is 200 files, the website upload cap', async () => {
    expect(IMPORT_LIMITS.websiteFiles).toBe(200);
    const preflight = await loader({ request: new Request('https://health-tool-app.fly.dev/api/lab-import-v2', { headers: { 'fly-client-ip': '10.2.0.1' } }) } as never);
    expect(await preflight.json()).toEqual({ allowed: true, remaining: 200 });
  });

  it('takes a 200-file batch from a fresh IP, then refuses the next file with the daily-limit answer', async () => {
    const full = await action({ request: many(200, '10.2.0.2') } as never);
    expect(full.status).toBe(200);
    const over = await action({ request: many(1, '10.2.0.2') } as never);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ success: false, error: 'Daily upload limit reached. You can upload more tomorrow.' });
  });
});

// Privacy: a file name can hold a patient's name. The server reads results by
// request index, so it takes no name, and drops one an older widget still sends
// (and the `file-N` label the current widget sends for older servers).
describe('privacy: the batch takes no file name', () => {
  const PAGES = FILES[0].pages;
  const batch = (files: unknown[]) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ batch: true, files }),
  });

  it('accepts a batch of pages alone', async () => {
    const created = await (await action({ request: batch([{ pages: PAGES }]) } as never)).json();
    expect(created.success).toBe(true);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });

  it('drops the name an older widget sends before the batch is built', async () => {
    await action({ request: batch([{ fileName: 'Jane Citizen bloods.pdf', pages: PAGES }]) } as never);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });

  it('drops the compatibility label the current widget sends (US-12 AC9)', async () => {
    await action({ request: batch([{ fileName: 'file-1', pages: PAGES }]) } as never);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });
});

// US-15 AC34: Haiku 5.5 can decline a file, or stop at its token cap, and the
// same request stops the same way again. The answer says which, so the widget
// does not say "try again", and carries no document text.
describe('a single file that stopped short', () => {
  const single = () => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ pages: FILES[0].pages }),
  });

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

  // One deadline for the file: a malformed answer's re-send gets what is left,
  // never a fresh 60 s.
  it('gives the file one 60 s deadline', async () => {
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    await action({ request: single() } as never);
    expect(extractOrClassify).toHaveBeenCalledWith(FILES[0].pages, { timeoutMs: 60_000 });
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
  const single = (extra: Record<string, unknown>) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ pages: FILES[0].pages, ...extra }),
  });
  const batch = (extra: Record<string, unknown>) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ batch: true, files: FILES, ...extra }),
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

  it('batch, old widget: each ended file loses its dated values; an error entry passes through', async () => {
    const { batchId, pollToken } = await (await action({ request: batch({}) } as never)).json();
    pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 2, total: 2, results: [{ index: 0, ...dated() }, { index: 1, errorCode: 'server_error' }] } as never);
    const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    expect(results[0].values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1]);
    expect(results[0].additionalValues.map((v: { value: number }) => v.value)).toEqual([80]);
    expect(results[1]).toEqual({ index: 1, errorCode: 'server_error' });
  });

  // US-12 AC14: an undated previous column carries the `recordedAt` marker,
  // so an old tab, which would file it on the report date, never gets it.
  const undated = () => {
    const result = dated();
    result.values[1].recordedAt = 'undated';
    result.additionalValues[1].recordedAt = 'undated';
    return result;
  };

  it('US-12 AC14 — no flag: an undated previous value is cut too, single file and batch', async () => {
    extractOrClassify.mockResolvedValueOnce(undated());
    const { data } = await (await action({ request: single({}) } as never)).json();
    expect(data.values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1]);
    expect(data.additionalValues.map((v: { value: number }) => v.value)).toEqual([80]);
    const { batchId, pollToken } = await (await action({ request: batch({}) } as never)).json();
    pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, ...undated() }] } as never);
    const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    expect(results[0].values.map((v: { valueSI: number }) => v.valueSI)).toEqual([2.1]);
    expect(results[0].additionalValues.map((v: { value: number }) => v.value)).toEqual([80]);
  });

  // A tab from before AC14 sends `ownDates` but reads "undated" as a date: it
  // gets the undated column only with `undatedPrev: true`, this widget's flag.
  const undatedAndDated = () => {
    const result = undated();
    result.values.push({ ...result.values[0], valueSI: 2.4, recordedAt: '2025-09-02' });
    return result;
  };

  it('US-12 AC14 — ownDates alone (a tab from before AC14): the undated value is cut, a dated one kept, single file and batch', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ ownDates: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, '2025-09-02']);
    expect(data.additionalValues.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined]);
    const { batchId, pollToken } = await (await action({ request: batch({ ownDates: true }) } as never)).json();
    pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, ...undatedAndDated() }] } as never);
    const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    expect(results[0].values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, '2025-09-02']);
    expect(results[0].additionalValues.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined]);
  });

  it('US-12 AC14 — undatedPrev without ownDates: every own-dated value is still cut', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ undatedPrev: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined]);
  });

  it('US-12 AC14 — ownDates is `true` or absent: any other value (2 included) is an invalid request, single file and batch', async () => {
    for (const ownDates of [2, 3, '2', false]) {
      expect((await action({ request: single({ ownDates }) } as never)).status, String(ownDates)).toBe(400);
      expect((await action({ request: batch({ ownDates }) } as never)).status, String(ownDates)).toBe(400);
    }
    expect(extractOrClassify).not.toHaveBeenCalled();
  });

  it('US-12 AC14 — both flags (this widget): the undated value answers, marked, single file and batch', async () => {
    extractOrClassify.mockResolvedValueOnce(undatedAndDated());
    const { data } = await (await action({ request: single({ ownDates: true, undatedPrev: true }) } as never)).json();
    expect(data.values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, 'undated', '2025-09-02']);
    expect(data.additionalValues.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, 'undated']);
    const { batchId, pollToken } = await (await action({ request: batch({ ownDates: true, undatedPrev: true }) } as never)).json();
    pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, ...undatedAndDated() }] } as never);
    const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    expect(results[0].values.map((v: { recordedAt?: string }) => v.recordedAt)).toEqual([undefined, 'undated', '2025-09-02']);
  });

  it('batch, new widget: the poll answers both columns', async () => {
    const { batchId, pollToken } = await (await action({ request: batch({ ownDates: true }) } as never)).json();
    pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, ...dated() }] } as never);
    const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    expect(results[0].values).toHaveLength(2);
    expect(results[0].additionalValues).toHaveLength(2);
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
  const single = (extra: Record<string, unknown>) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST', headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ pages: FILES[0].pages, ...extra }),
  });
  const batch = (extra: Record<string, unknown>) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST', headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ batch: true, files: FILES, ...extra }),
  });

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

  it('batch: the same rule on the poll', async () => {
    for (const [extra, dropped] of [[FLAGS, 3], [{ ...FLAGS, refusedRows: true }, 1]] as const) {
      const { batchId, pollToken } = await (await action({ request: batch(extra) } as never)).json();
      pollBatch.mockResolvedValueOnce({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, ...refusing() }] } as never);
      const { results } = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
      expect(results[0].droppedValueCount).toBe(dropped);
    }
  });

  it('refusedRows is `true` or absent', async () => {
    expect((await action({ request: single({ refusedRows: 1 }) } as never)).status).toBe(400);
    expect((await action({ request: batch({ refusedRows: 'yes' }) } as never)).status).toBe(400);
  });
});
