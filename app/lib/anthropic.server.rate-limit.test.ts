/**
 * US-12 AC1a: an Anthropic 429 on a lab read is retried once on the server
 * when its wait leaves more than 6 s of the read's deadline. Only the two lab
 * read routes opt in (extractOneFile); chat and every other caller keep the
 * rule that a 429 is structural and never retried.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./cron-helpers.server', () => ({ sleep: vi.fn() }));

process.env.ANTHROPIC_API_KEY = 'test-key-placeholder';

import * as Sentry from '@sentry/react-router';
import { callAnthropicWithUsage, extractOrClassify } from './anthropic.server';
import { parseRetryAfterMs, rateLimitWaitMs } from './anthropic-fetch.server';
import { extractOneFile } from './lab-extract-one.server';
import { sleep } from './cron-helpers.server';

const REAL_FETCH = global.fetch;
const validUnifiedJson = JSON.stringify({ classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null });
const ok = () => Response.json({ content: [{ type: 'text', text: validUnifiedJson }], usage: { input_tokens: 1, output_tokens: 1 } });
const rateLimited = (retryAfter?: string) => Response.json(
  { type: 'error', error: { type: 'rate_limit_error', message: 'x' } },
  { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
);
const after = (ms: number, res: () => Response) => async () => { vi.advanceTimersByTime(ms); return res(); };
const pages = [{ type: 'text' as const, content: 'x' }];

describe('US-12 AC1a: a lab read retries an Anthropic 429 once inside its deadline', () => {
  let timeouts: MockInstance<typeof AbortSignal.timeout>;
  let warn: MockInstance;
  let error: MockInstance;
  let random: MockInstance;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    random = vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter unless a test sets it
    timeouts = vi.spyOn(AbortSignal, 'timeout');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sleep).mockImplementation(async (ms: number) => { vi.advanceTimersByTime(ms); });
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    vi.mocked(sleep).mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function run(replies: Array<() => Promise<Response> | Response>, opts: Parameters<typeof extractOrClassify>[1]) {
    const fetchMock = vi.fn();
    for (const r of replies) fetchMock.mockImplementationOnce(r);
    global.fetch = fetchMock as unknown as typeof fetch;
    return { fetchMock, result: extractOrClassify(pages, opts) };
  }

  it.each([
    { name: 'web: a 429 then a 200 lands the read, after the retry-after wait', opts: { timeoutMs: 60_000 }, retryAfter: '3', wait: 3_000 },
    { name: 'web: no retry-after waits 2 s', opts: { timeoutMs: 60_000 }, retryAfter: undefined, wait: 2_000 },
    { name: 'iPhone: a 429 then a 200 lands the read', opts: { timeoutMs: 90_000, oneDeadline: true as const }, retryAfter: '1', wait: 1_000 },
  ])('$name', async ({ opts, retryAfter, wait }) => {
    const onRetry = vi.fn();
    const { fetchMock, result } = run([after(5_000, () => rateLimited(retryAfter)), ok], { ...opts, retryRateLimit: true, onRetry });
    await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(wait);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The rescued 429 reaches Sentry once, as a warning with its status and wait only.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Anthropic 429 retried', { level: 'warning', extra: { status: 429, waitMs: wait } });
    // The retried attempt gets only what is left of the read's deadline.
    expect(timeouts.mock.calls.at(-1)![0]).toBe(opts.timeoutMs - 5_000 - wait);
  });

  it.each([
    { name: '7 s left, 2 s wait: 5 s would remain', at: 53_000, retryAfter: undefined },
    { name: '10 s left, 5 s wait: 5 s would remain', at: 50_000, retryAfter: '5' },
  ])('no retry when 6 s or less of the deadline would remain: $name', async ({ at, retryAfter }) => {
    const { fetchMock, result } = run([after(at, () => rateLimited(retryAfter))], { timeoutMs: 60_000, retryRateLimit: true });
    await expect(result).rejects.toThrow(/status 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with just over 6 s left after the wait', async () => {
    const { fetchMock, result } = run([after(51_900, () => rateLimited()), ok], { timeoutMs: 60_000, retryRateLimit: true });
    await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a second 429 fails the read as today', async () => {
    const { fetchMock, result } = run([() => rateLimited('1'), () => rateLimited('1')], { timeoutMs: 60_000, retryRateLimit: true });
    await expect(result).rejects.toThrow('Anthropic API error (status 429) (rate_limit_error)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Captured once, as the exception it was before; no rescue warning.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('a 429 is not retried without the opt-in (the connector import, any other caller)', async () => {
    const { fetchMock, result } = run([() => rateLimited('1'), ok], { timeoutMs: 60_000 });
    await expect(result).rejects.toThrow(/status 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("chat's path still never retries a 429", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited('0')).mockResolvedValueOnce(ok());
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(callAnthropicWithUsage({ model: 'x' })).rejects.toThrow(/status 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('both lab routes opt in through extractOneFile', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => rateLimited('1')).mockImplementationOnce(ok);
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await extractOneFile({ pages } as Parameters<typeof extractOneFile>[0]);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { header: '999999999', waits: 60_000 },
    { header: '-5', waits: 2_000 },
    { header: 'soon', waits: 2_000 },
    { header: 'NaN', waits: 2_000 },
    { header: 'Wed, 21 Oct 2026 07:28:00 GMT', waits: 2_000 },
    { header: '1e3', waits: 2_000 },
    { header: '', waits: 2_000 },
    { header: ' 4 ', waits: 4_000 },
    { header: '0.5', waits: 500 },
  ])('a hostile retry-after "$header" is clamped to $waits ms', async ({ header, waits }) => {
    expect(parseRetryAfterMs(header)).toBe(waits);
    const { result } = run([() => rateLimited(header), ok], { timeoutMs: 90_000, oneDeadline: true, retryRateLimit: true });
    await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(waits);
  });

  it('a retry-after carrying text reaches no console line and no Sentry call, while the retry still runs', async () => {
    const MARKER = 'MARKER_q7_lab_name';
    const { fetchMock, result } = run([() => rateLimited(`${MARKER} 30`), ok], { timeoutMs: 60_000, retryRateLimit: true });
    await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const seen = JSON.stringify([warn.mock.calls, error.mock.calls, vi.mocked(Sentry.captureMessage).mock.calls, vi.mocked(Sentry.captureException).mock.calls]);
    expect(seen).not.toContain(MARKER);
  });

  it('jitter: up to 1.5 s is added to the wait, so two reads retry at different times', async () => {
    expect(rateLimitWaitMs('3', () => 0)).toBe(3_000);
    expect(rateLimitWaitMs('3', () => 0.999_9)).toBe(4_500);
    expect(rateLimitWaitMs(null, () => 0.5)).toBe(2_750);
    for (const draw of [0.2, 0.8]) {
      random.mockReturnValue(draw);
      const { result } = run([() => rateLimited('1'), ok], { timeoutMs: 60_000, retryRateLimit: true });
      await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    }
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual([1_300, 2_200]);
  });

  it.each([
    { name: '9.5 s left: 2 s + 1.5 s jitter leaves exactly 6 s, no retry', at: 50_500, calls: 1 },
    { name: '9.6 s left: just over 6 s remains, retried', at: 50_400, calls: 2 },
  ])('the deadline rule uses the jittered wait at max jitter: $name', async ({ at, calls }) => {
    random.mockReturnValue(0.999_9);
    const { fetchMock, result } = run([after(at, () => rateLimited()), ok], { timeoutMs: 60_000, retryRateLimit: true });
    if (calls === 2) await expect(result).resolves.toMatchObject({ classification: 'lab_report' });
    else await expect(result).rejects.toThrow(/status 429/);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('parses a missing header as the 2 s default', () => {
    expect(parseRetryAfterMs(null)).toBe(2_000);
  });
});
