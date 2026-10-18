// Audit witnesses for US-12 AC9. Synthetic provider responses only; no real network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollBatch } from './anthropic.server';

const answer = JSON.stringify({ classification: 'other', reportDate: null, values: [], additionalValues: [], document: null });
const ok = (custom_id: string) => ({ custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: answer }] } } });
function responses(lines: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/results')
    ? new Response(lines.join('\n'), { status: 200 })
    : Response.json({ ended_at: '2026-10-15T00:00:00Z', request_counts: { processing: 0, succeeded: lines.length, errored: 0, expired: 0, canceled: 0 } })));
}
beforeEach(() => vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-not-a-real-key'));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('US-12 AC9 batch JSONL audit witnesses', () => {
  it('preserves the legacy literal-newline repair even when a continuation is valid JSON', async () => {
    const split = JSON.stringify({ ...ok('file-0'), note: 'first\n123\nlast' }).replace(/\\n/g, '\n');
    responses([split, JSON.stringify(ok('file-1'))]);
    expect((await pollBatch('synthetic')).results?.map(r => r.index)).toEqual([0, 1]);
  });
  it('isolates a damaged record between valid records', async () => {
    responses([JSON.stringify(ok('file-0')), '{"custom_id":"file-1", not json', JSON.stringify(ok('file-2'))]);
    expect((await pollBatch('synthetic')).results?.map(r => r.index)).toEqual([0, 2]);
  });
  it('accepts blank lines and CRLF without a final newline', async () => {
    responses(['', JSON.stringify(ok('file-0')) + '\r', '', JSON.stringify(ok('file-1'))]);
    expect((await pollBatch('synthetic')).results?.map(r => r.index)).toEqual([0, 1]);
  });
  it.each(['file--1', 'file-01', 'file-0\n', 'file-9007199254740992', null, 0])('ignores noncanonical or unsafe identity %s', async custom_id => {
    responses([JSON.stringify(ok('file-0')), JSON.stringify({ custom_id, result: { type: 'expired' } })]);
    const results = (await pollBatch('synthetic')).results!;
    expect(results.map(r => r.index)).toEqual([0]);
    expect(results[0]).not.toHaveProperty('errorCode');
  });
  it('control: canonical records retain every identity', async () => {
    responses([JSON.stringify(ok('file-0')), JSON.stringify(ok('file-1'))]);
    expect((await pollBatch('synthetic')).results?.map(r => r.index)).toEqual([0, 1]);
  });
  it.each(['key order', 'leading whitespace', 'space after opening brace'])('accepts legal JSONL variation: %s', async variant => {
    const record = ok('file-1');
    const line = variant === 'key order' ? JSON.stringify({ result: record.result, custom_id: record.custom_id })
      : variant === 'leading whitespace' ? '  ' + JSON.stringify(record)
      : JSON.stringify(record).replace('{', '{ ');
    responses([JSON.stringify(ok('file-0')), line, JSON.stringify(ok('file-2'))]);
    expect((await pollBatch('synthetic')).results?.map(r => r.index)).toEqual([0, 1, 2]);
  });
  it.each(['file-0junk', '0', 'file-0.5'])('does not let malformed identity %s overwrite file-0', async custom_id => {
    responses([JSON.stringify(ok('file-0')), JSON.stringify({ custom_id, result: { type: 'expired' } })]);
    const results = (await pollBatch('synthetic')).results!;
    expect(results.map(r => r.index)).toEqual([0]);
    expect(results[0]).not.toHaveProperty('errorCode');
  });
});
