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
// R2: a spy that calls through, so a date write that skipped the shared rules fails the last test.
vi.mock('@roadmap/health-core/input-form', async importOriginal => {
  const real = await importOriginal<typeof import('@roadmap/health-core/input-form')>();
  return { ...real, screeningWrites: vi.fn(real.screeningWrites) };
});
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

// US-07 AC1j (Brad 2026-11-12): "The new abnormal result starts the follow-up again." A date write never clears:
// the web picker writes intermediate dates (December first writes that year's December). With a last date later
// than the follow-up, the form asks the result again (blank, follow-up hidden); choosing Abnormal clears the
// follow-up status, date and time through screeningWrites, the iPhone's one write path (ios/engine/my-data-forms.ts).
describe('US-07 AC1j: a newer last screening asks the result again on the web form', () => {
  const pick = (key: string, part: 'month' | 'year', value: string) =>
    fireEvent.change(document.querySelector<HTMLSelectElement>(`select#${key}-${part}`)!, { target: { value } });
  const result = () => document.querySelector<HTMLSelectElement>('select#colorectal-result')!;

  it('picking a later year writes the date alone; the result then shows blank; Abnormal writes the result and the three clears', () => {
    const { onScreeningChange } = panel({ ...DONE, colorectal_followup_interval_years: '3' });
    pick('colorectal_last_date', 'year', '2026');
    expect(onScreeningChange.mock.calls).toEqual([['colorectal_last_date', '2026-01']]);
    cleanup();
    const next = panel({ ...DONE, colorectal_last_date: '2026-01', colorectal_followup_interval_years: '3' });
    expect(result().value).toBe('');
    expect(document.querySelector('select#colorectal-followup-status')).toBeNull();
    fireEvent.change(result(), { target: { value: 'abnormal' } });
    expect(next.onScreeningChange.mock.calls).toEqual([
      ['colorectal_result', 'abnormal'], ['colorectal_followup_status', ''],
      ['colorectal_followup_date', ''], ['colorectal_followup_interval_years', ''],
    ]);
  });

  it('a last date in the follow-up\'s month or earlier writes only the date, and the result shows as stored', () => {
    const { onScreeningChange } = panel({ ...DONE, colorectal_followup_interval_years: '3' });
    pick('colorectal_last_date', 'month', '06');
    expect(onScreeningChange.mock.calls).toEqual([['colorectal_last_date', '2025-06']]);
    expect(result().value).toBe('abnormal');
  });
});

// US-07 AC1j (review of PR 1371): the follow-up date picker never writes a month before the last screening. The web
// picker writes each in-between date; a year change that would land before the last screening clamps the month up to
// it, so the result never blanks mid-pick. The bound is the shared form field's `min` (input-form.ts screeningForm).
describe('US-07 AC1j: the colonoscopy date picker stays on or after the last screening', () => {
  const STORED = {
    colorectal_method: 'fit_annual', colorectal_last_date: '2025-11', colorectal_result: 'abnormal',
    colorectal_followup_status: 'completed', colorectal_followup_date: '2026-02', colorectal_followup_interval_years: '5',
  };
  /** The panel over its own stored answers: each write lands, as on the live page, and is recorded. */
  function live(initial: Record<string, string>) {
    const writes: Array<[string, string]> = [];
    let state = { ...initial };
    const view = panel(state);
    view.onScreeningChange.mockImplementation((k: string, v: string) => { writes.push([k, v]); state = { ...state, [k]: v }; });
    const sync = () => { cleanup(); const next = panel(state); next.onScreeningChange.mockImplementation(view.onScreeningChange.getMockImplementation()!); };
    return { writes, sync, state: () => state };
  }
  const select = (id: string) => document.querySelector<HTMLSelectElement>(`select#${id}`);
  const offered = (id: string) => [...select(id)!.options].map(o => o.value).filter(Boolean);

  it('picking 2025 writes 2025-11 (clamped), the result and follow-up stay, then December writes 2025-12', () => {
    const run = live(STORED);
    expect(offered('colorectal_followup_date-year').map(Number).every(y => y >= 2025)).toBe(true);
    fireEvent.change(select('colorectal_followup_date-year')!, { target: { value: '2025' } });
    expect(run.writes).toEqual([['colorectal_followup_date', '2025-11']]);
    run.sync();
    expect(select('colorectal-result')!.value).toBe('abnormal');
    expect(select('colorectal-followup-status')!.value).toBe('completed');
    expect(select('colorectal-followup-interval')!.value).toBe('5');
    expect(offered('colorectal_followup_date-month')).toEqual(['11', '12']);
    fireEvent.change(select('colorectal_followup_date-month')!, { target: { value: '12' } });
    expect(run.writes).toEqual([['colorectal_followup_date', '2025-11'], ['colorectal_followup_date', '2025-12']]);
    run.sync();
    expect(select('colorectal-result')!.value).toBe('abnormal');
  });

  it('other date pickers keep their plain ranges: the last-screening picker still offers ten years back', () => {
    live(STORED);
    expect(offered('colorectal_last_date-year')).toContain('2016');
    expect(offered('colorectal_followup_date-year')).not.toContain('2024');
  });

  it('R2: the date picker writes through screeningWrites, the shared write rules', async () => {
    const forms = await import('@roadmap/health-core/input-form');
    live(STORED);
    fireEvent.change(select('colorectal_followup_date-month')!, { target: { value: '03' } });
    expect(vi.mocked(forms.screeningWrites)).toHaveBeenLastCalledWith(expect.objectContaining({ colorectalLastDate: '2025-11' }), 'colorectal_followup_date', '2026-03');
  });
});
