// @vitest-environment jsdom
/**
 * US-35 AC17 — the PSA field's min and max are the unit table's, so the form
 * cannot drift from the record's own ceiling (Brad 2026-10-19: 200 ng/mL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { UNIT_DEFS } from '@roadmap/health-core';
import { InputPanel } from './InputPanel';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);

describe('US-35 AC17 — the PSA input takes the unit table range', () => {
  it.each(['si', 'conventional'] as const)('pins min and max to UNIT_DEFS.psa in %s units', unitSystem => {
    const inputs = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1 };
    const props = {
      inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem, onUnitSystemChange: vi.fn(),
      unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
      labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
      onMedicationChange: vi.fn(), screenings: [{ id: 's1', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: '' }],
      onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
      scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false, fieldsSaved: 0,
      hasApiResponse: false, formStage: 3 as const, planBasis: { age: 66 }, grading: {},
    };
    const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
    const psa = container.querySelector<HTMLInputElement>('#psa-input');
    expect(psa).not.toBeNull();
    const range = UNIT_DEFS.psa.validationRange[unitSystem];
    expect([psa!.min, psa!.max]).toEqual([String(range.min), String(range.max)]);
    expect(range.max).toBe(200);
  });
});
