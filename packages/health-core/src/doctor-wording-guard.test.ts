// US-07 AC17 (Brad 2026-11-20): medicines read as topics to discuss with a doctor, and a range describes
// the number, never a condition on the person. This guard walks the plan's cards (both cascades, every
// step), its "why" reasons, the stat tiles, the medication form, the medicine guides and the US supplement
// overlay, and fails if an instruction-style title, an imperative, a condition label or a retired
// sentence comes back.
import { describe, expect, it } from 'vitest';
import { calculateHealthResults } from './calculations';
import { statTiles } from './stat-tiles';
import { MEDICATION_TEXT, medicationForm } from './input-form';
import { lipidMarkerFor, weightMedicationTrigger } from './suggestions';
import { METRIC_GUIDES } from './metric-guides';
import { BP_TIER_LABEL } from './bp-tier';
import { STAT_CARD_EVIDENCE, SUGGESTION_EVIDENCE } from './evidence';
import { planSections } from './plan-sections';
import { usProductSections } from './us-products';
import { toCanonicalValue } from './units';
import type { MedicationInputs, ScreeningInputs, Suggestion, SuggestionInputs } from './types';

const BANNED_TEXT = [
  'indicates prediabetes', 'indicates stage', 'Medicine suggestions', 'prediabetic range', 'osteoporosis diagnosed',
  // Retired 2026-11-20 (Brad: "I fix the text"): unattributed claims and instructions.
  'Immediate intervention is recommended', 'Statins are the most effective', 'most people need them long term',
  'Tirzepatide is preferred', 'Tirzepatide (preferred)', 'This requires medical management', 'which needs treatment and monitoring',
  'Statins are not recommended',
  // Retired 2026-11-21 (framing): the GLP-1 form hint drops its weight-loss result clause.
  'often leading to significant weight loss',
];
const BANNED_TITLE_START = ['Consider starting', 'Consider increasing'];
const BANNED_TILE_WORDS = ['Obese', 'Diabetic', 'Prediabetic', 'Kidney Failure'];
const BARE_BP_LABEL = /^(Stage \d hypertension|Hypertensive crisis)$/;
const IMPERATIVE = /^(Start|Stop|Take|Increase|Switch to)\b/;
/** A recommendation with no named recommender ("is typically recommended"): say who, "Guidelines typically recommend". */
const UNNAMED_RECOMMENDER = /\b(is|are) typically recommended\b/;
/** The one named exception, card and reason: wording awaits Brad, because at apob-very-high's line guidelines
 *  decide by overall risk, so "Guidelines typically recommend" would not be true. A second hit fails. */
const UNNAMED_EXCEPTION_ID = 'apob-very-high';
const UNNAMED_EXCEPTION_SENTENCES = ['Statin therapy and lifestyle changes are typically recommended at this level.', 'and statin therapy is typically recommended.'];
const SUPPLEMENT_LINE = 'Whether it suits you is worth discussing with your doctor or pharmacist.';
const LPA_MEDICINE_LINE = 'Consider discussing these medicines with your doctor.';
const MEDICINE_GUIDES = ['statin', 'ezetimibe', 'bempedoic_acid', 'pcsk9i', 'glp1', 'sglt2i', 'metformin'];

const person = (over: Partial<SuggestionInputs>): SuggestionInputs => ({
  heightCm: 175, weightKg: 105, waistCm: 110, sex: 'male', birthYear: 1965, birthMonth: 1, creatinine: 80,
  apoB: toCanonicalValue('apob', 140, 'conventional'), hba1c: toCanonicalValue('hba1c', 6.0, 'conventional'),
  triglycerides: toCanonicalValue('triglycerides', 200, 'conventional'), lpa: 200, systolicBp: 135, diastolicBp: 85, ...over,
} as SuggestionInputs);

const PEOPLE: SuggestionInputs[] = [
  person({}),
  person({ hba1c: toCanonicalValue('hba1c', 7.0, 'conventional'), systolicBp: 150, diastolicBp: 95 }),
  person({ systolicBp: 185, diastolicBp: 100, creatinine: 600, triglycerides: toCanonicalValue('triglycerides', 600, 'conventional') }),
  person({ birthYear: undefined, birthMonth: undefined }),
];

const MEDS: MedicationInputs[] = [
  {},
  { statin: { drug: 'none', dose: null }, glp1: { drug: 'none', dose: null } },
  { statin: { drug: 'atorvastatin', dose: null }, ezetimibe: 'yes', glp1: { drug: 'semaglutide_injection', dose: null } },
  { statin: { drug: 'atorvastatin', dose: 10 }, ezetimibe: 'not_yet' },
  { statin: { drug: 'atorvastatin', dose: 10 }, ezetimibe: 'yes', glp1: { drug: 'semaglutide_injection', dose: 0.25 } },
  { statin: { drug: 'simvastatin', dose: 40 }, ezetimibe: 'yes', glp1: { drug: 'dulaglutide', dose: 4.5 } },
  { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes', glp1: { drug: 'tirzepatide', dose: 15 }, glp1Escalation: 'not_tolerated' },
  { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'not_yet', glp1: { drug: 'other', dose: null } },
  { statin: { drug: 'not_tolerated', dose: null }, pcsk9i: 'not_tolerated', ezetimibe: 'not_tolerated', sglt2i: { drug: 'empagliflozin', dose: 10 } },
  // Every lipid medicine taken: the Lp(a) checklist names them all, none "not started".
  { statin: { drug: 'rosuvastatin', dose: 40 }, ezetimibe: 'yes', pcsk9i: 'yes', glp1: { drug: 'tirzepatide', dose: 15 }, sglt2i: { drug: 'empagliflozin', dose: 10 }, metformin: 'xr_1000' },
];

/** A text's sentences and lines, each trimmed of a leading checklist mark. */
const sentences = (text: string): string[] =>
  text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.replace(/^[^A-Za-z(]+/, '').trim()).filter(Boolean);

interface Shown { formIntros: string[]; titles: string[]; text: string[]; tileWords: string[]; supplements: string[]; medicineTitles: string[]; medicineText: string[]; lpaCards: string[] }

function shownText(): Shown {
  const out: Shown = { formIntros: [], titles: [], text: [], tileWords: [], supplements: [], medicineTitles: [], medicineText: [], lpaCards: [] };
  const card = (s: Suggestion) => {
    out.titles.push(s.title);
    out.text.push(s.title, s.description, s.reason ?? '');
    if (s.category === 'supplements') { out.supplements.push(s.description); out.medicineText.push(s.description); }
    if (s.category === 'medication') { out.medicineTitles.push(s.title); out.medicineText.push(s.title, s.description, s.reason ?? ''); }
    if (s.id === 'lpa-elevated') out.lpaCards.push(s.description);
  };
  // A woman of 60 with a recorded DEXA result of osteoporosis: the follow-up card's opening.
  const dexa = { dexaScreening: 'dexa_scan', dexaResult: 'osteoporosis', dexaLastDate: '2025-01' } as ScreeningInputs;
  calculateHealthResults(person({ sex: 'female' }), 'si', {}, dexa).suggestions.forEach(card);
  for (const inputs of PEOPLE) {
    for (const meds of MEDS) {
      const results = calculateHealthResults(inputs, 'si', meds);
      results.suggestions.forEach(card);
      // The US overlay's supplement cards (US-61), as the US web and iPhone show them.
      for (const section of usProductSections(planSections(results.suggestions), results, true, 'web') ?? []) {
        if (section.key === 'supplements') for (const c of section.cards) out.supplements.push(...c.suggestions.map((s) => s.description));
      }
      for (const t of statTiles(results, { unitSystem: 'si', sex: 'male' })) {
        if (t.status) out.tileWords.push(t.status.label);
        out.text.push(t.about, t.evidence?.reason ?? '');
      }
      const basis = {
        lipidMarker: lipidMarkerFor(inputs, results), weightMedTrigger: weightMedicationTrigger(inputs, results), bmi: results.bmi,
        hasLipidInput: true, hasWeightInput: true, unitFor: () => 'si' as const,
      };
      for (const section of medicationForm(meds, basis)) {
        out.text.push(section.title, section.intro);
        out.medicineText.push(section.intro);
        out.formIntros.push(section.intro);
        for (const f of section.groups.flatMap((g) => g.fields)) {
          const hint = 'hint' in f ? f.hint ?? '' : '';
          out.text.push(f.label, hint);
          out.medicineText.push(hint);
        }
      }
    }
  }
  // No cascade on: the plain questions, under the neutral intro.
  const flat = { lipidMarker: null, weightMedTrigger: { on: false, reasons: [] }, bmi: undefined, hasLipidInput: true, hasWeightInput: true, unitFor: () => 'si' as const };
  for (const section of medicationForm({}, flat)) out.formIntros.push(section.intro);
  for (const [key, g] of Object.entries(METRIC_GUIDES)) {
    const words = [g.title, g.whatItIs, g.whyItMatters, ...g.howTo.points];
    out.text.push(...words);
    if (MEDICINE_GUIDES.includes(key)) out.medicineText.push(...words);
  }
  return out;
}

/** One sweep, read by both guards below. */
const shown = shownText();

describe('US-07 AC17: doctor-discussion wording guard', () => {
  it('walks the medicine cards, the overlay and the Lp(a) checklist (the guard is not vacuous)', () => {
    expect(shown.titles).toContain('Consider discussing a statin with your doctor');
    expect(shown.text).toContain(MEDICATION_TEXT.glp1Hint);
    expect(shown.titles).toContain('Consider discussing your GLP-1 dose with your doctor');
    expect(shown.titles).toContain('Consider discussing a PCSK9 inhibitor with your doctor');
    expect(shown.titles).toContain('HbA1c in the diabetes range');
    expect(shown.titles).toContain('Very high triglycerides');
    expect(shown.tileWords).toContain('Obesity range');
    expect(shown.text.some((t) => t.startsWith('You recorded a result of osteoporosis'))).toBe(true);
    // The overlay's creatine card is the US variant: strength only, no memory sentence (US-61 AC3).
    expect(shown.supplements.some((d) => d.startsWith('One of the most-studied supplements') && !d.includes('memory'))).toBe(true);
    expect(shown.lpaCards.some((d) => d.includes('PCSK9 inhibitor: taking'))).toBe(true);
    expect(shown.lpaCards.some((d) => d.includes('Statin: not tolerated'))).toBe(true);
  });

  it('every supplement card ends with its doctor line, the US overlay too', () => {
    expect(shown.supplements.filter((d) => !d.endsWith(SUPPLEMENT_LINE))).toEqual([]);
  });

  it('the Lp(a) card carries one doctor line whenever its checklist names a medicine, in every state', () => {
    const names = /Statin:|Ezetimibe:|PCSK9 inhibitor:/;
    const missing = shown.lpaCards.filter((d) => names.test(d) && !d.endsWith(LPA_MEDICINE_LINE));
    expect(missing).toEqual([]);
    expect(shown.lpaCards.filter((d) => d.split(/discuss/i).length > 2)).toEqual([]);
  });

  it('no card title tells the person to start or raise a medicine; every medicine step title says discuss', () => {
    expect(shown.titles.filter((t) => BANNED_TITLE_START.some((b) => t.startsWith(b)))).toEqual([]);
    // The two dose cards ask for a recorded dose (data entry), not a medicine step.
    const steps = shown.medicineTitles.filter((t) => !/^Add your (statin|GLP-1) dose$/.test(t));
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.filter((t) => !/discuss/i.test(t))).toEqual([]);
  });

  it('no medicine sentence opens with an instruction to start, stop, take, raise or switch', () => {
    expect(shown.medicineText.flatMap(sentences).filter((s) => IMPERATIVE.test(s))).toEqual([]);
  });

  it('every medication form section, cascade or not, says once to discuss its medicines with a doctor', () => {
    expect(shown.formIntros.length).toBeGreaterThan(0);
    expect(shown.formIntros.filter((intro) => (intro.match(/with your doctor/g) ?? []).length !== 1)).toEqual([]);
  });

  it('a recommendation names who makes it, in shown text and in every "why" reason (one named exception)', () => {
    const reasons = Object.entries({ ...SUGGESTION_EVIDENCE, ...STAT_CARD_EVIDENCE }).filter(([, e]) => UNNAMED_RECOMMENDER.test(e.reason));
    expect(reasons.map(([id]) => id)).toEqual([UNNAMED_EXCEPTION_ID]);
    expect((reasons[0][1].reason.match(new RegExp(UNNAMED_RECOMMENDER, 'g')) ?? []).length).toBe(1);
    const unexcused = (t: string) => UNNAMED_EXCEPTION_SENTENCES.reduce((rest, ok) => rest.replace(ok, ''), t);
    expect(shown.text.filter((t) => UNNAMED_RECOMMENDER.test(unexcused(t)))).toEqual([]);
  });

  it('no blood pressure label or card title is a bare condition name', () => {
    expect(Object.values(BP_TIER_LABEL).filter((l) => BARE_BP_LABEL.test(l))).toEqual([]);
    expect(shown.titles.filter((t) => BARE_BP_LABEL.test(t))).toEqual([]);
  });

  it('no shown sentence names a condition or makes a claim the way the retired wording did', () => {
    expect(shown.text.filter((t) => BANNED_TEXT.some((b) => t.includes(b)))).toEqual([]);
  });

  it('no tile shows a condition word', () => {
    expect(shown.tileWords.filter((w) => BANNED_TILE_WORDS.includes(w))).toEqual([]);
  });
});

// US-07 AC19 (Brad 2026-11-27, "Capitals everywhere. Every medicine name gets a capital, in titles and
// sentences."): a specific medicine's name starts with a capital wherever the engine shows it, and no
// sentence carries the "(listed first)" note. Drug classes ("a statin", "SGLT2 inhibitors") are not names.
// The scan reads every title, card text, reason, tile, form title, intro, label, hint and option label
// and every metric guide the sweep above reaches, plus every "why" reason in the evidence tables.
const MEDICINE_NAMES = [
  'tirzepatide', 'semaglutide', 'dulaglutide', 'liraglutide', 'exenatide',
  'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'pitavastatin', 'lovastatin', 'fluvastatin',
  'ezetimibe', 'bempedoic acid', 'evolocumab', 'alirocumab', 'inclisiran',
  'empagliflozin', 'dapagliflozin', 'canagliflozin', 'ertugliflozin', 'metformin', 'orlistat',
  'warfarin', 'finasteride', 'dutasteride', 'tretinoin', 'adapalene',
];
/** A medicine name in lower case anywhere: after a space, a digit, a bracket, a slash, a colon or a dash. */
const LOWER_CASE_NAME = new RegExp(`(?<![A-Za-z_])(?:${MEDICINE_NAMES.join('|')})(?![A-Za-z_])`);

describe('US-07 AC19: medicine names start with a capital', () => {
  const optionLabels = (meds: MedicationInputs) => {
    const basis = { lipidMarker: null, weightMedTrigger: { on: true, reasons: [] }, bmi: 30, hasLipidInput: true, hasWeightInput: true, unitFor: () => 'si' as const };
    return medicationForm(meds, basis).flatMap((s) => s.groups.flatMap((g) => g.fields))
      .flatMap((f) => ('options' in f ? f.options.map((o) => o.label) : []));
  };
  const reasons = Object.values({ ...SUGGESTION_EVIDENCE, ...STAT_CARD_EVIDENCE }).map((e) => e.reason);
  const all = [...shown.text, ...reasons, ...MEDS.flatMap(optionLabels)];

  it('walks the text that names a medicine (the scan is not vacuous)', () => {
    const joined = all.join('\n');
    for (const phrase of [
      'Consider discussing Tirzepatide or Semaglutide with your doctor.',
      'Consider discussing Bempedoic acid with your doctor',
      'Consider discussing one, such as Empagliflozin or Dapagliflozin, with your doctor.',
      'Dr Brad suggests discussing Ezetimibe with your doctor first.',
      'You take the highest dose of Simvastatin this plan lists, or close to it.',
      'Dulaglutide (Trulicity)',
    ]) expect(joined).toContain(phrase);
  });

  it('no shown text carries "(listed first)" or a medicine name in lower case', () => {
    expect(all.filter((t) => t.includes('(listed first)'))).toEqual([]);
    expect([...new Set(all.filter((t) => LOWER_CASE_NAME.test(t)))]).toEqual([]);
  });
});
