// @vitest-environment jsdom
/**
 * US-06 AC16: every screening date on the web is one select of whole months, grouped by year.
 * One choice is one write of a complete YYYY-MM through screeningWrites; "Month and year"
 * writes ''. There is no half-picked date to save or keep, and a stored month outside the
 * list shows as stored and is never rewritten by drawing the form.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiScreening } from '@roadmap/health-core/mappings';
import { InputPanel } from './InputPanel';
import { MY_HEALTH_PROPS } from '../testing/my-health-props';

const spy = vi.hoisted(() => ({ screeningWrites: vi.fn() }));
vi.mock('@roadmap/health-core/input-form', async importOriginal => {
  const real = await importOriginal<typeof import('@roadmap/health-core/input-form')>();
  spy.screeningWrites.mockImplementation(real.screeningWrites);
  return { ...real, screeningWrites: spy.screeningWrites };
});
vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 12, 12)); });
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => { spy.screeningWrites.mockClear(); });
afterEach(cleanup);

const rows = (s: Record<string, string>): ApiScreening[] =>
  Object.entries(s).map(([screeningKey, value], i) => ({ id: `s${i}`, screeningKey, value, updatedAt: '' }));

function panel(screenings: Record<string, string>, sex: 'female' | 'male' = 'female', age = 66) {
  const onScreeningChange = vi.fn();
  const inputs = { sex, heightCm: 170, birthYear: 2026 - age, birthMonth: 1 };
  const props = {
    ...MY_HEALTH_PROPS,
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si',
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(),
    medications: [], onMedicationChange: vi.fn(), screenings: rows(screenings), onScreeningChange,
    supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    hasApiResponse: false, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: { age }, grading: {},
  };
  const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  const date = (key: string) => container.querySelector<HTMLSelectElement>(`select#${key}`);
  return { container, date, onScreeningChange };
}

const values = (s: HTMLSelectElement) => [...s.options].map(o => o.value).filter(Boolean);
const groups = (s: HTMLSelectElement) => [...s.querySelectorAll('optgroup')].map(g => g.label);

/** Every date the form asks: past dates, and DEXA's scheduled review. */
const PAST = {
  colorectal_method: 'fit_annual', colorectal_last_date: '2025-03', colorectal_result: 'abnormal',
  colorectal_followup_status: 'completed', colorectal_followup_date: '2025-06',
  breast_frequency: 'biennial', breast_last_date: '2025-02', breast_result: 'abnormal',
  breast_followup_status: 'completed', breast_followup_date: '2025-05',
  cervical_method: 'pap_every_3yr', cervical_last_date: '2024-09', cervical_result: 'abnormal',
  cervical_followup_status: 'completed', cervical_followup_date: '2024-11',
  lung_smoking_history: 'former_smoker', lung_pack_years: '25', lung_screening: 'annual_ldct', lung_last_date: '2025-01',
  lung_result: 'abnormal', lung_followup_status: 'completed', lung_followup_date: '2025-04',
  dexa_screening: 'dexa_scan', dexa_last_date: '2025-01', dexa_result: 'osteoporosis', dexa_followup_status: 'scheduled', dexa_followup_date: '2027-01',
};
const DATES = ['colorectal_last_date', 'colorectal_followup_date', 'breast_last_date', 'breast_followup_date',
  'cervical_last_date', 'cervical_followup_date', 'lung_last_date', 'lung_followup_date', 'dexa_last_date', 'dexa_followup_date'];

describe('US-06 AC16: the screening month picker', () => {
  it('every screening date, bone density too, is the same one select, labelled by its field', () => {
    // Cervical screening stops at 65 and DEXA starts there: one woman of 60 and one of 66.
    for (const key of DATES) {
      const { container, date } = panel(PAST, 'female', key.startsWith('dexa') ? 66 : 60);
      const s = date(key);
      expect(s, key).not.toBeNull();
      expect(s!.value, key).toBe(PAST[key as keyof typeof PAST]);
      expect(s!.options[0].value, key).toBe('');
      expect(s!.options[0].textContent, key).toBe('Month and year');
      expect(s!.querySelectorAll('optgroup').length, key).toBeGreaterThan(1);
      expect(container.querySelector(`label[for="${key}"]`)?.textContent, key).toBeTruthy();
      expect(container.querySelector(`#${key}-month, #${key}-year, .date-picker-row`), key).toBeNull();
      cleanup();
    }
  });

  it('one choice is one write of a complete month', () => {
    const { date, onScreeningChange } = panel(PAST);
    fireEvent.change(date('colorectal_last_date')!, { target: { value: '2024-07' } });
    expect(spy.screeningWrites).toHaveBeenCalledTimes(1);
    expect(spy.screeningWrites.mock.calls[0].slice(1)).toEqual(['colorectal_last_date', '2024-07']);
    expect(onScreeningChange.mock.calls).toEqual([['colorectal_last_date', '2024-07']]);
  });

  it('"Month and year" writes \'\'', () => {
    const { date, onScreeningChange } = panel(PAST);
    fireEvent.change(date('dexa_last_date')!, { target: { value: '' } });
    expect(spy.screeningWrites).toHaveBeenCalledTimes(1);
    expect(spy.screeningWrites.mock.calls[0].slice(1)).toEqual(['dexa_last_date', '']);
    expect(onScreeningChange.mock.calls).toEqual([['dexa_last_date', '']]);
  });

  it('a past date offers nothing after this month, newest year and month first', () => {
    const s = panel(PAST).date('breast_last_date')!;
    const vs = values(s);
    expect(vs.every(v => v <= '2026-11')).toBe(true);
    expect(vs.slice(0, 3)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(vs.at(-1)).toBe('2016-01');
    expect(groups(s)).toEqual(['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016']);
    expect(s.options[1].textContent).toBe('November 2026');
  });

  it('a scheduled date offers nothing before this month, earliest year and month first', () => {
    const s = panel(PAST).date('dexa_followup_date')!;
    const vs = values(s);
    expect(vs.every(v => v >= '2026-11')).toBe(true);
    expect(vs.slice(0, 3)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(vs.at(-1)).toBe('2031-12');
    expect(groups(s)).toEqual(['2026', '2027', '2028', '2029', '2030', '2031']);
  });

  it('a stored month outside the list shows as stored, and drawing the form writes nothing', () => {
    const { date, onScreeningChange } = panel({ ...PAST, colorectal_last_date: '2010-03', dexa_followup_date: '2025-01' });
    for (const [key, stored, label] of [['colorectal_last_date', '2010-03', 'March 2010'], ['dexa_followup_date', '2025-01', 'January 2025']]) {
      const s = date(key)!;
      expect(s.value, key).toBe(stored);
      expect(s.selectedOptions[0].textContent, key).toBe(label);
      expect([...s.options].filter(o => o.value === stored), key).toHaveLength(1);
    }
    expect(spy.screeningWrites).not.toHaveBeenCalled();
    expect(onScreeningChange).not.toHaveBeenCalled();
  });
});
