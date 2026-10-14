/**
 * US-12 AC9: a batch poll names each result by the file it came from. The
 * results carry their request index (custom_id `file-N`), so a line that will
 * not parse cannot shift the files after it onto the wrong name, and a request
 * the provider failed comes back marked as an error, not as a file with no
 * values. Synthetic fixtures only: no health values, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollBatch } from './anthropic.server';

const letter = JSON.stringify({ classification: 'other', reportDate: null, values: [], additionalValues: [], document: null });
const errorOf = (r: object) => ('errorCode' in r ? r.errorCode : undefined);
const succeeded = (i: number) => JSON.stringify({
  custom_id: `file-${i}`,
  result: { type: 'succeeded', message: { content: [{ type: 'text', text: letter }] } },
});

function stubBatch(lines: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/results')
    ? new Response(lines.join('\n'), { status: 200 })
    : Response.json({ ended_at: '2026-10-13T00:00:00Z', processing_status: { succeeded: 3, errored: 1 } }))));
}

beforeEach(() => { vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key'); });
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
