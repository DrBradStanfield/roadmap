/**
 * Issue #166 on the server's two paths (US-12 AC15, AC16): a urine ratio the
 * model filed as creatinine comes back refused, not converted. Synthetic model JSON only; fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { extractOrClassify } from './anthropic.server';

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

describe('US-12 AC15: the server refuses a creatinine it cannot read', () => {
  it('single file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' })));
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }], { purpose: 'LABS' });
    expect(result.values.map(v => [v.metric, v.unitGuessed])).toEqual([['ldl', true]]);
    expect(result.refusedValues).toEqual(REFUSED);
    expect(result.droppedValueCount).toBe(0);
  });

});
