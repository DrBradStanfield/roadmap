// @vitest-environment jsdom
/**
 * US-62 AC40: My health draws a question part only where HealthTool's forms (lib/plan-forms.ts)
 * name its section, and draws what InputPanel's renderer for it returns. If a renderer draws a
 * section the forms do not name, the question is dropped from the page; if the forms name one the
 * renderer does not draw, a suggestion is placed on a question that is not there. For generated
 * records, every section a renderer draws is named by the forms, and every section they name is drawn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { mulberry32 } from '@roadmap/health-core/plan-topics.fixtures';
import type { ApiMedication, ApiScreening } from '@roadmap/health-core/mappings';
import type { HealthInputs } from '@roadmap/health-core/types';
import { InputPanel, type PlanBasis } from './InputPanel';
import type { FormSlots, Placement } from './MyHealth';
import { medicineInputs, planForms } from '../lib/plan-forms';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);

const AGES = [undefined, 15, 25, 30, 45, 50, 55, 65, 72, 76, 81, 86];
const SEXES = [undefined, 'male', 'female'] as const;
/** Screening answers that open, keep or close groups (lung past 80, DEXA, prostate). */
const SCREENING_ANSWERS: Array<[string, string]> = [
  ['lung_smoking_history', 'former_smoker'], ['lung_pack_years', '25'], ['lung_screening', 'annual_ldct'], ['lung_last_date', '2025-01'],
  ['lung_result', 'abnormal'], ['colorectal_method', 'fit_annual'], ['prostate_discussion', 'will_screen'], ['dexa_screening', 'dexa_scan'],
];
const LIPIDS = ['apoB', 'ldlC', 'totalCholesterol', 'hdlC'] as const;
const WEIGHT = ['hba1c', 'triglycerides', 'weightKg'] as const;

interface Record { inputs: Partial<HealthInputs>; basis: Partial<PlanBasis> | null; screenings: ApiScreening[]; medications: ApiMedication[] }

function record(seed: number): Record {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const age = pick(AGES);
  const inputs: Partial<HealthInputs> = { sex: pick(SEXES), ...(r() < 0.8 ? { heightCm: 170 } : null) };
  for (const k of LIPIDS) if (r() < 0.2) inputs[k] = 2;
  for (const k of WEIGHT) if (r() < 0.2) inputs[k] = k === 'weightKg' ? 90 : 40;
  const basis: Partial<PlanBasis> | null = r() < 0.1 ? null : {
    ...(age !== undefined ? { age, screeningAge: age } : null), // the screening questions read screeningAge (US-23 AC6c)
    lipidMarker: r() < 0.3 ? { kind: 'ldl', label: 'LDL-c', value: 3.5, target: 2.6, elevated: r() < 0.7 } : null,
    weightMedTrigger: r() < 0.3 ? { on: true, reasons: ['a BMI of 31'] } : { on: false, reasons: [] },
    ...(r() < 0.5 ? { bmi: 31 } : null),
  };
  const screenings = SCREENING_ANSWERS.filter(() => r() < 0.3).map(([screeningKey, value], i): ApiScreening => ({ id: `s${i}`, screeningKey, value, updatedAt: '' }));
  const medications: ApiMedication[] = r() < 0.3 ? [{ id: 'm0', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '' }] : [];
  return { inputs, basis, screenings, medications };
}

/** The sections InputPanel's renderers draw for the record: a renderer that returns anything draws its section. */
function drawn(rec: Record): string[] {
  let slots: FormSlots | null = null;
  const props = {
    children: (form: FormSlots) => { slots = form; return null; },
    inputs: rec.inputs, effectiveInputs: rec.inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si',
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()),
    medications: rec.medications, onMedicationChange: vi.fn(), screenings: rec.screenings, onScreeningChange: vi.fn(),
    supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    hasApiResponse: false, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: rec.basis, grading: {},
  };
  render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])}/>);
  const form = slots as FormSlots | null;
  if (!form) throw new Error('InputPanel handed no slots');
  const place: Placement = { on: () => null, in: () => null, noteShown: () => true };
  const parts: Array<[string, unknown]> = [
    ['lipid-medications', form.lipidMedications(place)], ['weight-medications', form.weightMedications(place)],
    ['cancer-screening', form.screening(place)], ['bone-density', form.boneDensity(place)],
  ];
  return parts.filter(([, node]) => node !== null && node !== undefined && node !== false).map(([id]) => id).sort();
}

/** The sections HealthTool's forms name for the same record. */
function named(rec: Record): string[] {
  const forms = planForms({ ...medicineInputs(rec.inputs), medications: rec.medications, screenings: rec.screenings, planBasis: rec.basis, sex: rec.inputs.sex, unitOverrides: {}, unitSystem: 'si' });
  return [...forms.medications, ...forms.screenings].map(s => s.id).sort();
}

describe("US-62 AC40: HealthTool's forms name exactly the sections InputPanel's renderers draw", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => i + 1);

  it('the generated records reach every section, drawn and not', () => {
    const all = seeds.map(seed => named(record(seed)));
    for (const id of ['lipid-medications', 'weight-medications', 'cancer-screening', 'bone-density']) {
      expect(all.some(ids => ids.includes(id)), `${id} named`).toBe(true);
      expect(all.some(ids => !ids.includes(id)), `${id} not named`).toBe(true);
    }
  });

  it.each(seeds)('seed %i: both ways', seed => {
    const rec = record(seed);
    expect(drawn(rec), JSON.stringify(rec)).toEqual(named(rec));
  });
});
