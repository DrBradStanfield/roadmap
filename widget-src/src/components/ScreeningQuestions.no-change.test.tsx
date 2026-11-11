// @vitest-environment jsdom
/**
 * US-06, audit A2-1 step 7: the web screening questions read the one screening table
 * (screeningForm) instead of their own ages and gates, and nothing a person sees changes.
 * This pin was written on the old JSX and its snapshot taken there: for every age and sex
 * in the grid, with no answers and with every answer, plus the follow-up states, the
 * cancer screening card's groups, notes, labels, controls and text must stay the same.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SCREENING_TEXT } from '@roadmap/health-core/input-form';
import type { ApiScreening } from '@roadmap/health-core/mappings';
import { InputPanel } from './InputPanel';
import { MY_HEALTH_PROPS } from '../testing/my-health-props';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

// The month pickers list years from today: hold the date still so the snapshot does not age.
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 11, 12)); });
afterAll(() => { vi.useRealTimers(); });
afterEach(cleanup);

const rows = (s: Record<string, string>): ApiScreening[] =>
  Object.entries(s).map(([screeningKey, value], i) => ({ id: `s${i}`, screeningKey, value, updatedAt: '' }));

function cancerCard(sex: 'female' | 'male' | undefined, age: number, screenings: Record<string, string>) {
  const inputs = { sex, heightCm: 178, birthYear: 1970, birthMonth: 1 };
  const props = {
    ...MY_HEALTH_PROPS,
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si',
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(),
    medications: [], onMedicationChange: vi.fn(), screenings: rows(screenings), onScreeningChange: vi.fn(),
    supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false, fieldsSaved: 0,
    hasApiResponse: false, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: { age }, grading: {},
  };
  const { container } = render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />);
  const card = [...container.querySelectorAll('.section-card')]
    .find(c => c.querySelector('.health-section-desc')?.textContent?.trim() === SCREENING_TEXT.intro);
  if (!card) return null;
  const all = (sel: string, f: (el: Element) => string) => [...card.querySelectorAll(sel)].map(f);
  const view = {
    groups: all('h4:not(.mh-group-label)', el => el.textContent!),
    notes: all('.screening-notice, .screening-age-message', el => `${el.className}: ${el.textContent!.trim()}`),
    labels: all('label', el => `${el.getAttribute('for')}: ${el.textContent}`),
    controls: all('select, input', el => `${el.tagName.toLowerCase()}#${el.id || el.getAttribute('aria-label')}${el instanceof HTMLSelectElement || el instanceof HTMLInputElement ? `=${el.value}` : ''}`),
    hints: all('.field-hint', el => el.textContent!),
    text: card.textContent!.replace(/\s+/g, ' ').trim(),
  };
  cleanup();
  return view;
}

const AGES = [24, 25, 34, 35, 39, 40, 44, 45, 49, 50, 64, 65, 66, 74, 75, 76, 79, 80, 81, 85, 86];
const SEXES = ['female', 'male', undefined] as const;

/** Every answer, each opening the next question: the deepest the form goes. */
const EVERY: Record<string, string> = {
  colorectal_method: 'fit_annual', colorectal_last_date: '2025-03', colorectal_result: 'abnormal',
  colorectal_followup_status: 'scheduled', colorectal_followup_date: '2027-01',
  breast_frequency: 'biennial', breast_last_date: '2025-02', breast_result: 'abnormal',
  breast_followup_status: 'completed', breast_followup_date: '2025-05',
  cervical_method: 'pap_every_3yr', cervical_last_date: '2024-09', cervical_result: 'abnormal', cervical_followup_status: 'not_organized',
  lung_smoking_history: 'former_smoker', lung_pack_years: '25', lung_screening: 'annual_ldct', lung_last_date: '2025-01',
  lung_result: 'abnormal', lung_followup_status: 'completed', lung_followup_date: '2025-04',
  prostate_discussion: 'will_screen',
  endometrial_discussion: 'discussed', endometrial_abnormal_bleeding: 'no',
};

describe('US-06 A2-1 step 7 — the cancer screening card does not change', () => {
  for (const sex of SEXES) {
    it(`no answers, ${sex ?? 'no sex'}, across the age grid`, () => {
      expect(Object.fromEntries(AGES.map(age => [age, cancerCard(sex, age, {})]))).toMatchSnapshot();
    });
    it(`every answer, ${sex ?? 'no sex'}, across the age grid`, () => {
      expect(Object.fromEntries(AGES.map(age => [age, cancerCard(sex, age, EVERY)]))).toMatchSnapshot();
    });
  }

  const states: Array<[string, 'female' | 'male', number, Record<string, string>]> = [
    ['colorectal colonoscopy, normal', 'male', 55, { colorectal_method: 'colonoscopy_10yr', colorectal_last_date: '2020-01', colorectal_result: 'normal' }],
    ['colorectal other, abnormal, completed', 'male', 55, { colorectal_method: 'other', colorectal_last_date: '2024-01', colorectal_result: 'abnormal', colorectal_followup_status: 'completed' }],
    ['colorectal not yet started', 'female', 50, { colorectal_method: 'not_yet_started' }],
    ['colorectal method, no date', 'female', 50, { colorectal_method: 'fit_annual' }],
    ['breast annual, awaiting', 'female', 47, { breast_frequency: 'annual', breast_last_date: '2025-06', breast_result: 'awaiting' }],
    ['cervical HPV, abnormal, scheduled', 'female', 30, { cervical_method: 'hpv_every_5yr', cervical_last_date: '2025-01', cervical_result: 'abnormal', cervical_followup_status: 'scheduled' }],
    ['lung never smoked', 'male', 60, { lung_smoking_history: 'never_smoked' }],
    ['lung 15 pack-years, nothing else', 'male', 60, { lung_smoking_history: 'current_smoker', lung_pack_years: '15' }],
    ['lung 15 pack-years, not yet started', 'male', 60, { lung_smoking_history: 'current_smoker', lung_pack_years: '15', lung_screening: 'not_yet_started' }],
    ['lung 81, smoker, no LDCT answer', 'male', 81, { lung_smoking_history: 'former_smoker', lung_pack_years: '25' }],
    ['lung 81, LDCT normal', 'male', 81, { lung_smoking_history: 'former_smoker', lung_pack_years: '25', lung_screening: 'annual_ldct', lung_last_date: '2025-01', lung_result: 'normal' }],
    // Lung's "data present, so ask" branches (US-07 AC1f, AC1g): the group past 80 and the LDCT question below 20 pack-years, from stored data alone.
    ['US-07 AC1g: lung 82, 15 pack-years, abnormal result, no LDCT answer', 'male', 82, { lung_smoking_history: 'former_smoker', lung_pack_years: '15', lung_result: 'abnormal' }],
    ['US-07 AC1f: lung 60, 15 pack-years, only a last date', 'male', 60, { lung_smoking_history: 'former_smoker', lung_pack_years: '15', lung_last_date: '2025-01' }],
    ['US-07 AC1f: lung 60, 15 pack-years, only a result', 'male', 60, { lung_smoking_history: 'former_smoker', lung_pack_years: '15', lung_result: 'normal' }],
    ['prostate elected not to', 'male', 52, { prostate_discussion: 'elected_not_to' }],
    ['prostate not yet', 'male', 46, { prostate_discussion: 'not_yet' }],
  ];
  it.each(states)('%s', (_name, sex, age, screenings) => {
    expect(cancerCard(sex, age, screenings)).toMatchSnapshot();
  });
});
