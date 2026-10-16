/**
 * US-12 AC9: a batch poll names each result by the file it came from. The
 * results carry their request index (custom_id `file-N`), so a line that will
 * not parse cannot shift the files after it onto the wrong name, and a request
 * the provider failed comes back marked as an error, not as a file with no
 * values. Synthetic fixtures only: no health values, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { createBatch, pollBatch } from './anthropic.server';

const letter = JSON.stringify({ classification: 'other', reportDate: null, values: [], additionalValues: [], document: null });
const errorOf = (r: object) => ('errorCode' in r ? r.errorCode : undefined);
const succeeded = (i: number) => JSON.stringify({
  custom_id: `file-${i}`,
  result: { type: 'succeeded', message: { content: [{ type: 'text', text: letter }] } },
});

function stubBatch(lines: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/results')
    ? new Response(lines.join('\n'), { status: 200 })
    : Response.json({
      ended_at: '2026-10-13T00:00:00Z',
      processing_status: 'ended',
      request_counts: { processing: 0, succeeded: 3, errored: 1, expired: 0, canceled: 0 },
    }))));
}

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('US-12 AC9: batch results keep their file identity', () => {
  it('tags each result with its request index, in index order', async () => {
    stubBatch([succeeded(2), succeeded(0), succeeded(1)]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(r => r.index)).toEqual([0, 1, 2]);
    expect(results!.map(errorOf)).toEqual([undefined, undefined, undefined]);
  });

  it('skips a malformed line without shifting the files after it', async () => {
    stubBatch([succeeded(0), '{"custom_id":"file-1", not json', succeeded(2)]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(r => r.index)).toEqual([0, 2]);
  });

  it('marks a request the provider failed, or whose answer will not parse, as a server error', async () => {
    stubBatch([
      succeeded(0),
      JSON.stringify({ custom_id: 'file-1', result: { type: 'errored', error: { type: 'error', error: { type: 'api_error' } } } }),
      JSON.stringify({ custom_id: 'file-2', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'not json' }] } } }),
      JSON.stringify({ custom_id: 'file-3', result: { type: 'expired' } }),
    ]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(r => [r.index, errorOf(r)])).toEqual([[0, undefined], [1, 'server_error'], [2, 'server_error'], [3, 'server_error']]);
  });
});

// US-12 AC1: provider status is a string; progress counts are a separate object.
// Wire contract: https://platform.claude.com/docs/en/api/messages/batches/retrieve
// No live provider requests or real lab reports are used.
describe('US-12 AC1: batch progress uses the provider request counts', () => {
  it.each(['in_progress', 'canceling'])('reports the size of a %s batch without fetching results early', async (processing_status) => {
    const fetchMock = vi.fn(async () => Response.json({
      processing_status,
      ended_at: null,
      request_counts: { processing: 20, succeeded: 0, errored: 0, expired: 0, canceled: 0 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pollBatch('batch_synthetic')).toEqual({ status: 'processing', completed: 0, total: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts every terminal outcome and still returns the extracted results', async () => {
    const request_counts = { processing: 0, succeeded: 14, errored: 2, expired: 1, canceled: 3 };
    const types = [
      ...Array<string>(request_counts.succeeded).fill('succeeded'),
      ...Array<string>(request_counts.errored).fill('errored'),
      ...Array<string>(request_counts.expired).fill('expired'),
      ...Array<string>(request_counts.canceled).fill('canceled'),
    ];
    const lines = types.map((type, index) => type === 'succeeded'
      ? succeeded(index)
      : JSON.stringify({ custom_id: `file-${index}`, result: { type } }));
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/results')
      ? new Response(lines.join('\n'), { status: 200 })
      : Response.json({
        processing_status: 'ended',
        ended_at: '2026-10-13T00:00:00Z',
        request_counts,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await pollBatch('batch_synthetic');
    expect(result).toMatchObject({ status: 'ended', completed: 20, total: 20 });
    expect(result.results?.map(r => r.index)).toEqual(types.map((_, index) => index));
    expect(result.results?.filter(r => 'errorCode' in r)).toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a zero-request ended batch at zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/results')
      ? new Response('', { status: 200 })
      : Response.json({
        processing_status: 'ended',
        ended_at: '2026-10-13T00:00:00Z',
        request_counts: { processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 0 },
      })));
    expect(await pollBatch('batch_synthetic')).toEqual({ status: 'ended', completed: 0, total: 0, results: [], stops: [] });
  });

  it('still returns an ended batch whose status omits request_counts', async () => {
    // Counts are display-only; a missing block must not hold finished results back until the client times out.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/results')
      ? new Response(succeeded(0), { status: 200 })
      : Response.json({ processing_status: 'ended', ended_at: '2026-10-13T00:00:00Z' })));
    const result = await pollBatch('batch_synthetic');
    expect(result).toMatchObject({ status: 'ended', completed: 0, total: 0 });
    expect(result.results?.map(r => r.index)).toEqual([0]);
  });
});

// US-12 AC8: a dot-thousands count the model wrote as a JSON number ("250.000"
// platelets per µL) is refused and counted on the batch path too.
describe('US-12 AC8: a batch result keeps a dot-thousands JSON number a string', () => {
  it('refuses 250.000 cells/µL and counts it', async () => {
    const text = '{"classification":"lab_report","reportDate":null,"values":[],"additionalValues":['
      + '{"name":"platelets","value":250.000,"unit":"cells/µL","referenceLow":150.000,"referenceHigh":450.000},'
      + '{"name":"tsh","value":2.345,"unit":"mIU/L"}],"document":null}';
    stubBatch([JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } } })]);
    const [result] = (await pollBatch('batch_synthetic')).results!;
    expect('errorCode' in result).toBe(false);
    const read = result as Extract<typeof result, { additionalValues: unknown }>;
    expect(read.additionalValues.map(v => [v.name, v.value])).toEqual([['tsh', 2.345]]);
    expect(read.droppedValueCount).toBe(1);
  });
});

// US-15 AC31: each batch request has Haiku 5.5's shape (thinking disabled, no
// sampling param, ending on the user turn), and a result is read by block type.
describe('US-15 AC31: the batch path on Haiku 5.5', () => {
  it('sends each file with thinking disabled, no temperature and no assistant turn', async () => {
    let sent: { requests: Array<{ params: Record<string, any> }> } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return Response.json({ id: 'batch_synthetic' });
    }));
    await createBatch([{ pages: [{ type: 'text', content: 'doc' }] }]);
    const params = sent!.requests[0].params;
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params).not.toHaveProperty('temperature');
    expect(params.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    // No 60 s HTTP call to fit, unlike the website's single file (10000).
    expect(params.max_tokens).toBe(12288);
  });

  it('reads a result that starts with a thinking block', async () => {
    stubBatch([JSON.stringify({
      custom_id: 'file-0',
      result: { type: 'succeeded', message: { content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: letter }] } },
    })]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(errorOf)).toEqual([undefined]);
  });

  it('joins every text block, as the single call does', async () => {
    const half = Math.floor(letter.length / 2);
    stubBatch([JSON.stringify({
      custom_id: 'file-0',
      result: { type: 'succeeded', message: { content: [{ type: 'text', text: letter.slice(0, half) }, { type: 'text', text: letter.slice(half) }] } },
    })]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(errorOf)).toEqual([undefined]);
  });

  it('marks a succeeded message with no text as a server error', async () => {
    stubBatch([JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [] } } })]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(errorOf)).toEqual(['server_error']);
  });
});

describe('US-15 AC31: a batch request that stopped short is its own error, not a parse of its partial text', () => {
  const stoppedAt = (i: number, stop_reason: string, stop_details: unknown = null) => JSON.stringify({
    custom_id: `file-${i}`,
    result: { type: 'succeeded', message: { stop_reason, stop_details, content: [{ type: 'text', text: letter }] } },
  });

  it('marks a refusal "refused" and a max_tokens stop "too_long"', async () => {
    stubBatch([succeeded(0), stoppedAt(1, 'refusal'), stoppedAt(2, 'max_tokens')]);
    const { results } = await pollBatch('batch_synthetic');
    expect(results!.map(errorOf)).toEqual([undefined, 'refused', 'too_long']);
  });

  // The poll handler reports them, once per batch (api.lab-import-v2.test.ts):
  // pollBatch is called on every poll, so it sends nothing itself.
  it('hands each stop back with its bounded category and no text, and reports nothing itself', async () => {
    stubBatch([succeeded(0), stoppedAt(1, 'refusal', { type: 'refusal', category: 'bio', explanation: 'free text that must not leave' }), stoppedAt(2, 'max_tokens')]);
    const { stops } = await pollBatch('batch_synthetic');
    expect(stops!.map(s => [s.code, s.refusalCategory])).toEqual([['refused', 'bio'], ['too_long', undefined]]);
    expect(JSON.stringify(stops)).not.toContain('free text');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
