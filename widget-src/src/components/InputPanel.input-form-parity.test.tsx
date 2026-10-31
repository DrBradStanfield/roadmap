// @vitest-environment jsdom
/**
 * US-25 AC8, US-06 — the web form and the iPhone app ask the same questions.
 * The iPhone app renders health-core's medicationForm and screeningForm; the
 * web form (InputPanel) takes its words, options and write rules from the same
 * module. For a handful of states this renders the web form and checks that
 * its visible labels, intros, notes, hints and select options are exactly the
 * descriptions' for the same state, so the two clients cannot drift.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  medicationForm, medicationsToInputs, screeningForm, screeningsToInputs,
  type ApiMedication, type ApiScreening, type FormSection, type HealthInputs, type LipidMarker,
} from '@roadmap/health-core';
import { InputPanel, type PlanBasis } from './InputPanel';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
// InputPanel reads the phone breakpoint (US-62 AC8); jsdom has no matchMedia. These run as desktop.
vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));

interface State {
  sex?: 'male' | 'female';
  inputs?: Partial<HealthInputs>;
  basis: Partial<PlanBasis>;
  screenings?: Record<string, string>;
  medications?: [string, string, number?][];
}

const screeningRows = (s: Record<string, string> = {}): ApiScreening[] =>
  Object.entries(s).map(([screeningKey, value], i) => ({ id: `s${i}`, screeningKey, value, updatedAt: '' }));
const medicationRows = (m: [string, string, number?][] = []): ApiMedication[] =>
  m.map(([medicationKey, drugName, dose], i) => ({ id: `m${i}`, medicationKey, drugName, doseValue: dose ?? null, doseUnit: dose ? 'mg' : null, updatedAt: '' }));

function renderPanel(state: State): HTMLElement {
  const inputs = { sex: state.sex, heightCm: 178, birthYear: 1970, birthMonth: 1, ...state.inputs };
  const props = {
    inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si', onUnitSystemChange: vi.fn(),
    unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
    labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(),
    medications: medicationRows(state.medications), onMedicationChange: vi.fn(),
    screenings: screeningRows(state.screenings), onScreeningChange: vi.fn(),
    supplements: [], onSupplementChange: vi.fn(), onSupplementDelete: vi.fn(),
    scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false, fieldsSaved: 0,
    hasApiResponse: false, formStage: 3 as const, planBasis: state.basis, grading: {},
  };
  return render(<InputPanel {...(props as unknown as Parameters<typeof InputPanel>[0])} />).container;
}

/** The web's select id for a field key. */
const selectId = (key: string) => ({
  statin: 'statin-name', glp1: 'glp1-name', sglt2i: 'sglt2i-name', endometrial_abnormal_bleeding: 'endometrial-bleeding',
}[key] ?? key.replace(/_/g, '-'));
const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map(el => el.textContent);

/** The web card for each described section matches it: title, intro, notes, labels, hints, options, values. */
function expectParity(container: HTMLElement, sections: FormSection[]) {
  const cards = [...container.querySelectorAll('.section-card')];
  for (const section of sections) {
    const card = cards.find(c => c.querySelector('h3.health-section-title')?.textContent === section.title);
    expect(card, section.title).toBeDefined();
    expect(card!.querySelector('.health-section-desc')!.textContent!.trim()).toBe(section.intro);
    expect(texts(card!, 'h4')).toEqual(section.groups.filter(g => g.title).map(g => g.title));
    expect(texts(card!, '.screening-notice, .screening-age-message').map(t => t!.trim())).toEqual(section.groups.flatMap(g => g.notes));
    const fields = section.groups.flatMap(g => g.fields);
    // A dose select sits beside its drug under the drug's one label.
    expect(texts(card!, 'label')).toEqual(fields.filter(f => !('key' in f && f.key.endsWith('_dose'))).map(f => f.label));
    expect(texts(card!, '.med-step-hint, .field-hint')).toEqual(fields.flatMap(f => ('hint' in f && f.hint ? [f.hint] : [])));
    for (const field of fields) {
      if (field.kind === 'month') expect(card!.querySelector(`#${field.key}-month`), field.key).not.toBeNull();
      if (field.kind !== 'choice') continue;
      const select = card!.querySelector<HTMLSelectElement>(`#${selectId(field.key)}`);
      expect(select, field.key).not.toBeNull();
      expect([...select!.options].map(o => ({ value: o.value, label: o.textContent, ...(o.disabled ? { disabled: true } : null) })), field.key)
        .toEqual(field.options);
      expect(select!.value, field.key).toBe(field.value);
    }
  }
}

describe('US-25 AC8, US-06 — the web screening cards are screeningForm', () => {
  const cases: Array<[string, number, 'male' | 'female', Record<string, string>]> = [
    ['woman of 30', 30, 'female', {}],
    ['woman of 50, FIT, dated, abnormal, follow-up scheduled', 50, 'female', {
      colorectal_method: 'fit_annual', colorectal_last_date: '2025-03', colorectal_result: 'abnormal', colorectal_followup_status: 'scheduled',
    }],
    ['man of 60, former smoker, 25 pack-years, annual LDCT', 60, 'male', {
      lung_smoking_history: 'former_smoker', lung_pack_years: '25', lung_screening: 'annual_ldct',
    }],
    ['man of 55 who will screen', 55, 'male', { prostate_discussion: 'will_screen' }],
    ['man of 72, DEXA osteoporosis', 72, 'male', {
      dexa_screening: 'dexa_scan', dexa_last_date: '2024-06', dexa_result: 'osteoporosis', dexa_followup_status: 'completed',
    }],
  ];
  it.each(cases)('%s', (_name, age, sex, screenings) => {
    const container = renderPanel({ sex, basis: { age }, screenings });
    const sections = screeningForm(age, sex, screeningsToInputs(screeningRows(screenings)));
    expect(sections.length).toBeGreaterThan(0);
    expectParity(container, sections);
  });
});

describe('US-25 AC8, US-06 — the web medication cards are medicationForm', () => {
  const ldl: LipidMarker = { kind: 'ldl', label: 'LDL-c', value: 3.5, target: 2.6, elevated: true };
  const off = { on: false, reasons: [] };
  const cases: Array<[string, State]> = [
    ['flat cholesterol card with a lipid value', { sex: 'male', inputs: { ldlC: 2 }, basis: { age: 56, lipidMarker: null, weightMedTrigger: off } }],
    ['lipid cascade with a statin recorded', {
      sex: 'male', inputs: { ldlC: 3.5 }, basis: { age: 56, lipidMarker: ldl, weightMedTrigger: off }, medications: [['statin', 'atorvastatin', 20]],
    }],
    ['lipid cascade with a legacy answer and no dose', {
      sex: 'male', inputs: { ldlC: 3.5 }, basis: { age: 56, lipidMarker: ldl, weightMedTrigger: off },
      medications: [['statin', 'rosuvastatin'], ['ezetimibe', 'tier_1'], ['statin_escalation', 'not_tolerated']],
    }],
    ['weight cascade on', {
      sex: 'male', inputs: { weightKg: 100, hba1c: 45 },
      basis: { age: 56, bmi: 31.6, lipidMarker: null, weightMedTrigger: { on: true, reasons: ['an HbA1c of 45 mmol/mol'] } },
      medications: [['glp1', 'tirzepatide', 5], ['glp1_escalation', 'not_yet']],
    }],
  ];
  it.each(cases)('%s', (_name, state) => {
    const container = renderPanel(state);
    const inputs = { heightCm: 178, ...state.inputs };
    const sections = medicationForm(medicationsToInputs(medicationRows(state.medications)), {
      lipidMarker: state.basis.lipidMarker ?? null,
      weightMedTrigger: state.basis.weightMedTrigger!,
      bmi: state.basis.bmi,
      hasLipidInput: inputs.ldlC !== undefined,
      hasWeightInput: inputs.hba1c !== undefined || inputs.weightKg !== undefined,
      unitFor: () => 'si',
    });
    expect(sections.length).toBeGreaterThan(0);
    expectParity(container, sections);
  });
});
