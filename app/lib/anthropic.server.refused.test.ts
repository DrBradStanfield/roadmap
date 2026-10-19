/**
 * Issue #166 on the server's two paths (US-12 AC15, AC16): a urine ratio the
 * model filed as creatinine comes back refused, not converted, from the single
 * call and from a batch. Synthetic model JSON only; fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { extractOrClassify, pollBatch } from './anthropic.server';

const ANSWER = JSON.stringify({
  classification: 'lab_report', reportDate: '2026-10-10', document: null, additionalValues: [],
  values: [
    { metric: 'creatinine', value: 2, unit: 'mg/mmol', confidence: 'high' },
    { metric: 'ldl', value: 2.8, unit: '', confidence: 'high' },
  ],
});
const REFUSED = [{ metric: 'creatinine', value: 2, unit: 'mg/mmol', reason: 'This unit is usually a urine result.' }];

beforeEach(() => { vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('US-12 AC15: the server refuses a creatinine it cannot read, on both paths', () => {
  it('single file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' })));
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.values.map(v => [v.metric, v.unitGuessed])).toEqual([['ldl', true]]);
    expect(result.refusedValues).toEqual(REFUSED);
    expect(result.droppedValueCount).toBe(0);
  });

  it('batch', async () => {
    const line = JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' } } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/results')
      ? new Response(line, { status: 200 })
      : Response.json({ ended_at: '2026-10-13T00:00:00Z', request_counts: { processing: 0, succeeded: 1 } }))));
    const [result] = (await pollBatch('batch_synthetic')).results!;
    expect(result).toMatchObject({ index: 0, refusedValues: REFUSED, droppedValueCount: 0 });
    expect((result as { values: Array<{ metric: string }> }).values.map(v => v.metric)).toEqual(['ldl']);
  });
});
