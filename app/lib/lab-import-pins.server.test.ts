/**
 * Byte pins for the lab import's answers and reports (lead S-15). Each client
 * version gets exactly these bytes, and each failure exactly this report: the
 * old-widget adapter and the error report may move, never change what is sent.
 *
 * Clients: the oldest widget sends no flag; a widget from before AC14 sends
 * `ownDates`; one from before AC15 adds `undatedPrev`; this widget sends all
 * three; the iPhone app sends `ownDates` and `refusedRows` on its own route
 * (US-12 AC12, AC14, AC15, AC19; US-52 AC7, AC7c). Stops and failures: US-15 AC34.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createBatch = vi.fn();
const pollBatch = vi.fn();
const extractOrClassify = vi.fn();

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: (...a: unknown[]) => createBatch(...a),
  pollBatch: (...a: unknown[]) => pollBatch(...a),
  extractOrClassify: (...a: unknown[]) => extractOrClassify(...a),
}));
vi.mock('./local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import * as Sentry from '@sentry/react-router';
import { ExtractionStopError, BatchRefusedError } from './anthropic.server';
import { extractOneFile } from './lab-extract-one.server';
import { action } from '../routes/api.lab-import-v2';

const PAGES = [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }];
const APP_OPTS = { timeoutMs: 90_000, oneDeadline: true as const, onRetry: () => {} };

/** Every array an extraction answers, each with a report-day, a dated and an undated row. */
const full = () => ({
  classification: 'lab_report', reportDate: '2026-03-10', document: null, droppedValueCount: 4,
  values: [
    { metric: 'ldl', valueSI: 2.1 },
    { metric: 'ldl', valueSI: 2.6, recordedAt: '2025-09-02' },
    { metric: 'ldl', valueSI: 2.4, recordedAt: 'undated' },
  ],
  additionalValues: [
    { name: 'ferritin', value: 80 },
    { name: 'ferritin', value: 95, recordedAt: '2025-09-02' },
    { name: 'ferritin', value: 70, recordedAt: 'undated' },
  ],
  refusedValues: [
    { metric: 'creatinine', value: 2, reason: 'urine unit' },
    { metric: 'creatinine', value: 3, reason: 'urine unit', recordedAt: '2025-09-02' },
    { metric: 'creatinine', value: 4, reason: 'urine unit', recordedAt: 'undated' },
  ],
  unreadValues: [
    { name: 'hdl', reason: 'unreadable' },
    { name: 'hdl', reason: 'unreadable', recordedAt: '2025-09-02' },
    { name: 'lpa', reason: 'unreadable', recordedAt: 'undated' },
  ],
});
/** No droppedValueCount and no unread rows: an added count lands last. */
const noCount = () => ({
  classification: 'lab_report',
  values: [{ metric: 'ldl', valueSI: 2.1 }, { metric: 'ldl', valueSI: 2.6, recordedAt: '2025-09-02' }],
  refusedValues: [{ metric: 'creatinine', value: 2, reason: 'urine unit' }, { metric: 'creatinine', value: 3, reason: 'urine unit', recordedAt: 'undated' }],
});
const letter = () => ({ classification: 'other', document: { title: 'Letter', markdown: '# Letter' } });

const [V0, V1, VU] = full().values;
const [A0, A1, AU] = full().additionalValues;
const [R0, R1, RU] = full().refusedValues;
const [U0, U1, UU] = full().unreadValues;
const head = { classification: 'lab_report', reportDate: '2026-03-10', document: null };

/** What each client is sent for `full()`, key order included. */
const FULL_FOR = {
  oldest: { ...head, droppedValueCount: 3, values: [V0], additionalValues: [A0], refusedValues: [R0], unreadValues: [U0] },
  undatedPrevOnly: { ...head, droppedValueCount: 3, values: [V0], additionalValues: [A0], refusedValues: [R0], unreadValues: [U0] },
  preAC14: { ...head, droppedValueCount: 5, values: [V0, V1], additionalValues: [A0, A1], refusedValues: [R0, R1], unreadValues: [U0, U1] },
  preAC15: { ...head, droppedValueCount: 7, values: [V0, V1, VU], additionalValues: [A0, A1, AU], refusedValues: [R0, R1, RU], unreadValues: [U0, U1, UU] },
  current: { ...head, droppedValueCount: 4, values: [V0, V1, VU], additionalValues: [A0, A1, AU], refusedValues: [R0, R1, RU], unreadValues: [U0, U1, UU] },
  iphone: { ...head, droppedValueCount: 3, values: [V0, V1], additionalValues: [A0, A1], refusedValues: [R0, R1], unreadValues: [U0, U1] },
};
const [N0, N1] = noCount().values;
const [NR0, NRU] = noCount().refusedValues;
const NO_COUNT_FOR = {
  oldest: { classification: 'lab_report', values: [N0], refusedValues: [NR0], droppedValueCount: 1 },
  undatedPrevOnly: { classification: 'lab_report', values: [N0], refusedValues: [NR0], droppedValueCount: 1 },
  preAC14: { classification: 'lab_report', values: [N0, N1], refusedValues: [NR0], droppedValueCount: 1 },
  preAC15: { classification: 'lab_report', values: [N0, N1], refusedValues: [NR0, NRU], droppedValueCount: 2 },
  current: noCount(),
  iphone: { classification: 'lab_report', values: [N0, N1], refusedValues: [NR0] },
};
const WEB_FLAGS = {
  oldest: {}, undatedPrevOnly: { undatedPrev: true }, preAC14: { ownDates: true },
  preAC15: { ownDates: true, undatedPrev: true }, current: { ownDates: true, undatedPrev: true, refusedRows: true },
} as const;
const IPHONE_FLAGS = { ownDates: true, refusedRows: true } as const;

let ip = 0;
const post = (body: unknown) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
  method: 'POST', headers: { 'fly-client-ip': `10.9.0.${++ip}` }, body: JSON.stringify(body),
});
/** Status, content type and the exact bytes. */
const sent = async (res: Response) => ({ status: res.status, type: res.headers.get('content-type'), body: await res.text() });
const json = (status: number, body: unknown) => ({ status, type: 'application/json', body: JSON.stringify(body) });

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('success: the bytes each client is sent for one file', () => {
  for (const [client, flags] of Object.entries(WEB_FLAGS) as Array<[keyof typeof WEB_FLAGS, object]>) {
    it(`website, ${client}`, async () => {
      for (const [result, expected] of [[full(), FULL_FOR[client]], [noCount(), NO_COUNT_FOR[client]], [letter(), letter()]] as const) {
        extractOrClassify.mockResolvedValueOnce(result);
        // A fresh IP has 200 files a day; this one spent one.
        expect(await sent(await action({ request: post({ pages: PAGES, ...flags }) } as never)))
          .toEqual(json(200, { success: true, data: expected, remaining: 199 }));
      }
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  }

  it('iPhone app', async () => {
    for (const [result, expected] of [[full(), FULL_FOR.iphone], [noCount(), NO_COUNT_FOR.iphone], [letter(), letter()]] as const) {
      extractOrClassify.mockResolvedValueOnce(result);
      expect(await sent(await extractOneFile({ pages: PAGES, ...IPHONE_FLAGS } as never, undefined, APP_OPTS)))
        .toEqual(json(200, { success: true, data: expected }));
    }
  });
});

describe('success: the bytes each client is sent for a batch poll', () => {
  for (const client of ['oldest', 'preAC14', 'preAC15', 'current'] as const) {
    it(`website batch, ${client}`, async () => {
      createBatch.mockResolvedValueOnce({ batchId: `batch_pin_${client}` });
      const created = await (await action({ request: post({ batch: true, files: [{ pages: PAGES }], ...WEB_FLAGS[client] }) } as never)).json();
      pollBatch.mockResolvedValueOnce({
        status: 'ended', completed: 3, total: 3,
        results: [{ index: 0, ...full() }, { index: 1, ...noCount() }, { index: 2, errorCode: 'server_error' }],
      });
      expect(await sent(await action({ request: post({ batchId: created.batchId, pollToken: created.pollToken }) } as never))).toEqual(json(200, {
        status: 'ended',
        results: [{ index: 0, ...FULL_FOR[client] }, { index: 1, ...NO_COUNT_FOR[client] }, { index: 2, errorCode: 'server_error' }],
        completed: 3, total: 3,
      }));
    });
  }

  it('reports each stopped batch file with fixed text and tags', async () => {
    createBatch.mockResolvedValueOnce({ batchId: 'batch_pin_stops' });
    const created = await (await action({ request: post({ batch: true, files: [{ pages: PAGES }, { pages: PAGES }] }) } as never)).json();
    pollBatch.mockResolvedValueOnce({
      status: 'ended', completed: 2, total: 2,
      results: [{ index: 0, errorCode: 'refused' }, { index: 1, errorCode: 'too_long' }],
      stops: [new ExtractionStopError('refused', 'bio'), new ExtractionStopError('too_long')],
    });
    expect(await sent(await action({ request: post({ batchId: created.batchId, pollToken: created.pollToken }) } as never))).toEqual(json(200, {
      status: 'ended', results: [{ index: 0, errorCode: 'refused' }, { index: 1, errorCode: 'too_long' }], completed: 2, total: 2,
    }));
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toStrictEqual([
      ['Lab import: extraction refused', { level: 'warning', tags: { feature: 'lab_import_v2', path: 'batch', stopCode: 'refused', refusalCategory: 'bio' } }],
      ['Lab import: extraction too_long', { level: 'warning', tags: { feature: 'lab_import_v2', path: 'batch', stopCode: 'too_long' } }],
    ]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

/** The website route and the iPhone app's call, for one file. */
const CALLERS = {
  website: async (flags: object) => action({ request: post({ pages: PAGES, ...flags }) } as never),
  iphone: async () => extractOneFile({ pages: PAGES, ...IPHONE_FLAGS } as never, undefined, APP_OPTS),
};

describe('each refusal: a 422 and one warning, the same for every client', () => {
  const STOPS = [
    [new ExtractionStopError('refused', 'general_harms'), { stopCode: 'refused', refusalCategory: 'general_harms' }, 'refused'],
    [new ExtractionStopError('refused'), { stopCode: 'refused' }, 'refused'],
    [new ExtractionStopError('too_long'), { stopCode: 'too_long' }, 'too_long'],
  ] as const;
  const runs = [
    ...Object.entries(WEB_FLAGS).map(([name, flags]) => [`website ${name}`, () => CALLERS.website(flags)] as const),
    ['iphone', CALLERS.iphone] as const,
  ];
  for (const [name, call] of runs) {
    it(name, async () => {
      for (const [error, tags, code] of STOPS) {
        vi.mocked(Sentry.captureMessage).mockClear();
        extractOrClassify.mockRejectedValueOnce(error);
        expect(await sent(await call())).toEqual(json(422, { success: false, error: 'Not read', errorCode: code }));
        expect(vi.mocked(Sentry.captureMessage).mock.calls).toStrictEqual([
          [`Lab import: extraction ${code}`, { level: 'warning', tags: { feature: 'lab_import_v2', path: 'single', ...tags } }],
        ]);
      }
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });
  }
});

describe('each failure: a 500 and one exception report', () => {
  const timeout = () => new DOMException('signal timed out', 'TimeoutError');
  const FAILURES = [
    ['a malformed answer', () => new Error('extraction returned malformed JSON'), 'Error', { name: 'Error', code: 'unknown' }, false],
    ['a timeout', timeout, 'TimeoutError', { name: 'TimeoutError', code: 'unknown' }, true],
    ['a network error', () => new TypeError('fetch failed'), 'TypeError', { name: 'TypeError', code: 'unknown' }, false],
    ['a thrown string', () => 'not an error', 'unknown', { code: 'unknown' }, false],
  ] as const;

  for (const [what, make, errorName, logged, timedOut] of FAILURES) {
    for (const caller of ['website', 'iphone'] as const) {
      it(`${what}, ${caller}`, async () => {
        const error = make();
        extractOrClassify.mockRejectedValueOnce(error);
        const res = caller === 'website' ? await CALLERS.website(WEB_FLAGS.current) : await CALLERS.iphone();
        // Only the phone's one deadline answers a timeout in plain words (US-52 AC7c).
        const words = caller === 'iphone' && timedOut ? 'The server took too long to read this report. Please try again.' : 'Failed to process request';
        expect(await sent(res)).toEqual(json(500, { success: false, error: words }));
        expect(consoleError.mock.calls).toStrictEqual([['Lab import error (v2):', logged]]);
        const calls = vi.mocked(Sentry.captureException).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(error);
        // No page count or types: nothing read them (US-52 AC7d, lead C7).
        expect(calls[0][1]).toStrictEqual({ tags: { feature: 'lab_import_v2', errorName } });
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
      });
    }
  }
});

describe('retries exhausted: the real extraction gives up after its two HTTP attempts', () => {
  for (const caller of ['website', 'iphone'] as const) {
    it(`502 twice, ${caller}`, async () => {
      const real = await vi.importActual<typeof import('./anthropic.server')>('./anthropic.server');
      extractOrClassify.mockImplementation(real.extractOrClassify);
      vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-dummy');
      const fetchMock = vi.fn(async () => new Response('{}', { status: 502 }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const res = caller === 'website' ? await CALLERS.website(WEB_FLAGS.current) : await CALLERS.iphone();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(await sent(res)).toEqual(json(500, { success: false, error: 'Failed to process request' }));
        expect(consoleError.mock.calls).toStrictEqual([
          ['Anthropic API error (status 502) (unknown)'],
          ['Lab import error (v2):', { name: 'Error', code: 'unknown' }],
        ]);
        const calls = vi.mocked(Sentry.captureException).mock.calls;
        expect(calls.map(([e]) => (e as Error).message)).toEqual(['Anthropic API error (status 502) (unknown)', 'Anthropic API error (status 502) (unknown)']);
        expect(calls[0][0]).toBe(calls[1][0]);
        expect(calls.map(([, ctx]) => ctx)).toStrictEqual([
          { tags: { anthropic_error_type: 'unknown' }, extra: { status: 502, attempt: 2, errorType: 'unknown' } },
          { tags: { feature: 'lab_import_v2', errorName: 'Error' } },
        ]);
      } finally {
        extractOrClassify.mockReset();
        vi.unstubAllEnvs();
      }
    }, 10_000);
  }
});

describe('a failure outside the one-file extraction: the route\'s own report', () => {
  for (const [what, error, logged] of [
    ['a batch that could not be made', new Error('Batch API error (status 500)'), { name: 'Error', code: 'unknown' }],
    ['a batch Anthropic refused', new BatchRefusedError('ANTHROPIC_API_KEY not configured'), { name: 'Error', code: 'unknown' }],
    ['a timeout making the batch', new DOMException('signal timed out', 'TimeoutError'), { name: 'TimeoutError', code: 'unknown' }],
  ] as const) {
    it(what, async () => {
      createBatch.mockRejectedValueOnce(error);
      expect(await sent(await action({ request: post({ batch: true, files: [{ pages: PAGES }], ...WEB_FLAGS.current }) } as never)))
        .toEqual(json(500, { success: false, error: 'Failed to process request' }));
      expect(consoleError.mock.calls).toStrictEqual([['Lab import error (v2):', logged]]);
      const calls = vi.mocked(Sentry.captureException).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(error);
      // No errorName and no page counts on this path.
      expect(calls[0][1]).toStrictEqual({ tags: { feature: 'lab_import_v2' } });
    });
  }
});
