// @vitest-environment jsdom
/**
 * US-07 AC1j (screening Change 2b, Brad 2026-11-12): the web form asks "Did the colonoscopy report
 * give a follow-up time?" only while the colorectal result is abnormal and the follow-up completed.
 * It saves the number of years; "Not given" removes the answer. The words come from the shared form
 * (input-form.ts screeningForm), which the iPhone draws too.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiScreening } from '@roadmap/health-core/mappings';
import { InputPanel } from './InputPanel';
import { MY_HEALTH_PROPS } from '../testing/my-health-props';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 12, 12)); });
afterAll(() => { vi.useRealTimers(); });
afterEach(cleanup);

const rows = (s: Record<string, string>): ApiScreening[] =>
  Object.entries(s).map(([screeningKey, value], i) => ({ id: `s${i}`, screeningKey, value, updatedAt: '' }));

function panel(screenings: Record<string, string>) {
  const onScreeningChange = vi.fn();
  const inputs = { sex: 'male', heightCm: 178, birthYear: 1966, birthMonth: 1 };
  const props = {
    ...MY_HEALTH_PROPS,
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si',
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(),
    medications: [], onMedicationChange: vi.fn(), screenings: rows(screenings), onScreeningChange,
    supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false, fieldsSaved: 0,
    hasApiResponse: false, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: { age: 60 }, grading: {},
  };
  const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  const select = container.querySelector<HTMLSelectElement>('select#colorectal-followup-interval');
  const label = container.querySelector('label[for="colorectal-followup-interval"]')?.textContent;
  return { select, label, onScreeningChange };
}

const DONE = {
  colorectal_method: 'fit_annual', colorectal_last_date: '2025-01', colorectal_result: 'abnormal',
  colorectal_followup_status: 'completed', colorectal_followup_date: '2025-06',
};

describe('US-07 AC1j: the colonoscopy follow-up time on the web form', () => {
  it('shows under the gate, labelled with the question, "Not given" first and selected when absent', () => {
    const { select, label } = panel(DONE);
    expect(label).toBe('Did the colonoscopy report give a follow-up time?');
    expect([...select!.options].map(o => o.textContent)).toEqual(['Not given', '1 year', ...Array.from({ length: 9 }, (_, i) => `${i + 2} years`)]);
    expect(select!.value).toBe('');
  });

  it('shows a saved answer', () => {
    expect(panel({ ...DONE, colorectal_followup_interval_years: '4' }).select!.value).toBe('4');
  });

  it('does not show while the follow-up is scheduled or not organised, or the result is not abnormal', () => {
    for (const s of [
      { ...DONE, colorectal_followup_status: 'scheduled', colorectal_followup_date: '2027-01' },
      { ...DONE, colorectal_followup_status: 'not_organized' },
      { ...DONE, colorectal_result: 'normal' },
    ]) {
      expect(panel(s).select, JSON.stringify(s)).toBeNull();
    }
  });

  it('saves the number of years, and "Not given" removes it', () => {
    const { select, onScreeningChange } = panel({ ...DONE, colorectal_followup_interval_years: '3' });
    fireEvent.change(select!, { target: { value: '5' } });
    expect(onScreeningChange).toHaveBeenLastCalledWith('colorectal_followup_interval_years', '5');
    fireEvent.change(select!, { target: { value: '' } });
    expect(onScreeningChange).toHaveBeenLastCalledWith('colorectal_followup_interval_years', '');
  });

  it('a status no longer completed also clears the follow-up time', () => {
    const { onScreeningChange } = panel({ ...DONE, colorectal_followup_interval_years: '3' });
    const status = document.querySelector<HTMLSelectElement>('select#colorectal-followup-status')!;
    fireEvent.change(status, { target: { value: 'scheduled' } });
    expect(onScreeningChange.mock.calls).toEqual([
      ['colorectal_followup_status', 'scheduled'], ['colorectal_followup_interval_years', ''],
    ]);
  });
});
