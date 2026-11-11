// @vitest-environment jsdom
/**
 * US-14 AC8 (Brad 2026-11-09): My health's Documents list the newest document first, as the
 * iPhone does (US-73 AC12), whatever order they were filed in; an undated one goes last.
 * The order is health-core's `byNewestDocument`, shared with the iPhone's engine.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';
import type { ApiDocument } from '../lib/api-types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

const doc = (id: string, documentType: string, documentDate: string | null, createdAt: string): ApiDocument => ({
  id, documentType, title: `Title ${id}`, documentDate, contentMd: `# ${id}`, metadata: {}, sourceFileName: null, createdAt,
});

function titles(documents: ApiDocument[]) {
  const inputs = { sex: 'female' as const, heightCm: 165, birthYear: 1970, birthMonth: 1 };
  const props = {
    ...myHealth({ healthDocuments: documents }),
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si',
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
    onMedicationChange: vi.fn(), screenings: [], onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false, fieldsSaved: 0,
    hasApiResponse: false, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: { age: 56 }, grading: {},
  };
  const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  return [...container.querySelectorAll('.health-records-section')].map(section =>
    [...section.querySelectorAll('.health-record-title')].map(t => t.textContent));
}

describe('US-14 AC8: Documents newest first, on the web as on the iPhone', () => {
  it('two letters filed oldest first show the newer letter first', () => {
    expect(titles([
      doc('march', 'clinic_letter', '2025-03-02', '2026-10-01T00:00:00Z'),
      doc('september', 'clinic_letter', '2026-09-14', '2026-10-02T00:00:00Z'),
    ])).toEqual([['Title september', 'Title march']]);
  });

  it('scan results stay apart, each list newest first, an undated letter last', () => {
    expect(titles([
      doc('undated', 'discharge_summary', null, '2026-10-05T00:00:00Z'),
      doc('old-scan', 'scan_result', '2024-01-01', '2026-10-01T00:00:00Z'),
      doc('letter', 'clinic_letter', '2026-01-01', '2026-10-02T00:00:00Z'),
      doc('new-scan', 'scan_result', '2026-05-01', '2026-10-03T00:00:00Z'),
    ])).toEqual([['Title new-scan', 'Title old-scan'], ['Title letter', 'Title undated']]);
  });
});
