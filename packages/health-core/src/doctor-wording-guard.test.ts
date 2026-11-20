// US-07 AC17 (Brad 2026-11-20): medicines read as topics to discuss with a doctor, and a range describes
// the number, never a condition on the person. This guard walks the plan's cards (both cascades, every
// step), its "why" reasons, the stat tiles, the medication form and the medicine guides, and fails if an
// instruction-style title or a condition label comes back.
import { describe, expect, it } from 'vitest';
import { calculateHealthResults } from './calculations';
import { statTiles } from './stat-tiles';
import { medicationForm } from './input-form';
import { lipidMarkerFor, weightMedicationTrigger } from './suggestions';
import { METRIC_GUIDES } from './metric-guides';
import { toCanonicalValue } from './units';
import type { MedicationInputs, ScreeningInputs, SuggestionInputs } from './types';

const BANNED_TEXT = ['indicates prediabetes', 'indicates stage', 'Medicine suggestions', 'prediabetic range', 'osteoporosis diagnosed'];
const BANNED_TITLE_START = ['Consider starting', 'Consider increasing'];
const BANNED_TILE_WORDS = ['Obese', 'Diabetic', 'Prediabetic', 'Kidney Failure'];

const person = (over: Partial<SuggestionInputs>): SuggestionInputs => ({
  heightCm: 175, weightKg: 105, waistCm: 110, sex: 'male', birthYear: 1965, birthMonth: 1, creatinine: 80,
  apoB: toCanonicalValue('apob', 140, 'conventional'), hba1c: toCanonicalValue('hba1c', 6.0, 'conventional'),
  triglycerides: toCanonicalValue('triglycerides', 200, 'conventional'), lpa: 200, systolicBp: 135, diastolicBp: 85, ...over,
} as SuggestionInputs);

const PEOPLE: SuggestionInputs[] = [
  person({}),
  person({ hba1c: toCanonicalValue('hba1c', 7.0, 'conventional'), systolicBp: 150, diastolicBp: 95 }),
  person({ systolicBp: 185, diastolicBp: 100, creatinine: 600 }),
  person({ birthYear: undefined, birthMonth: undefined }),
];

const MEDS: MedicationInputs[] = [
  {},
  { statin: { drug: 'none', dose: null }, glp1: { drug: 'none', dose: null } },
  { statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes', glp1: { drug: 'semaglutide_injection', dose: null } },
  { statin: { drug: 'atorvastatin', dose: 10 }, ezetimibe: 'yes', glp1: { drug: 'semaglutide_injection', dose: 0.25 } },
  { statin: { drug: 'simvastatin', dose: 40 }, ezetimibe: 'yes', glp1: { drug: 'dulaglutide', dose: 4.5 } },
  { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes', glp1: { drug: 'tirzepatide', dose: 15 }, glp1Escalation: 'not_tolerated' },
  { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'not_tolerated', ezetimibe: 'not_tolerated', sglt2i: { drug: 'empagliflozin', dose: 10 } },
];

/** Every card, reason, tile word, tile line, form intro, label and hint, and guide sentence. */
function shownText(): { titles: string[]; text: string[]; tileWords: string[]; supplements: string[] } {
  const titles: string[] = [];
  const text: string[] = [];
  const tileWords: string[] = [];
  const supplements: string[] = [];
  // A woman of 60 with a recorded DEXA result of osteoporosis: the follow-up card's opening.
  const dexa = { dexaScreening: 'dexa_scan', dexaResult: 'osteoporosis', dexaLastDate: '2025-01' } as ScreeningInputs;
  for (const s of calculateHealthResults(person({ sex: 'female' }), 'si', {}, dexa).suggestions) {
    titles.push(s.title);
    text.push(s.title, s.description, s.reason ?? '');
  }
  for (const inputs of PEOPLE) {
    for (const meds of MEDS) {
      const results = calculateHealthResults(inputs, 'si', meds);
      for (const s of results.suggestions) {
        if (s.category === 'supplements') supplements.push(s.description);
        titles.push(s.title);
        text.push(s.title, s.description, s.reason ?? '');
      }
      for (const t of statTiles(results, { unitSystem: 'si', sex: 'male' })) {
        if (t.status) tileWords.push(t.status.label);
        text.push(t.about, t.evidence?.reason ?? '');
      }
      const basis = {
        lipidMarker: lipidMarkerFor(inputs, results), weightMedTrigger: weightMedicationTrigger(inputs, results), bmi: results.bmi,
        hasLipidInput: true, hasWeightInput: true, unitFor: () => 'si' as const,
      };
      for (const section of medicationForm(meds, basis)) {
        text.push(section.title, section.intro);
        for (const f of section.groups.flatMap((g) => g.fields)) text.push(f.label, 'hint' in f ? f.hint ?? '' : '');
      }
    }
  }
  for (const g of Object.values(METRIC_GUIDES)) text.push(g.title, g.whatItIs, g.whyItMatters, ...g.howTo.points);
  return { titles, text, tileWords, supplements };
}

describe('US-07 AC17: doctor-discussion wording guard', () => {
  const { titles, text, tileWords, supplements } = shownText();

  it('walks the medicine cards (the guard is not vacuous)', () => {
    expect(titles).toContain('Consider discussing a statin with your doctor');
    expect(titles).toContain('Consider discussing your GLP-1 dose with your doctor');
    expect(titles).toContain('HbA1c in the diabetes range');
    expect(tileWords).toContain('Obesity range');
    expect(text.some((t) => t.startsWith('You recorded a result of osteoporosis'))).toBe(true);
  });

  it('every supplement card ends with its doctor line', () => {
    expect(supplements.length).toBeGreaterThan(0);
    expect(supplements.filter((d) => !d.endsWith('Whether it suits you is worth discussing with your doctor or pharmacist.'))).toEqual([]);
  });

  it('no card title tells the person to start or raise a medicine', () => {
    expect(titles.filter((t) => BANNED_TITLE_START.some((b) => t.startsWith(b)))).toEqual([]);
  });

  it('no shown sentence names a condition the way the old wording did', () => {
    expect(text.filter((t) => BANNED_TEXT.some((b) => t.includes(b)))).toEqual([]);
  });

  it('no tile shows a condition word', () => {
    expect(tileWords.filter((w) => BANNED_TILE_WORDS.includes(w))).toEqual([]);
  });
});
