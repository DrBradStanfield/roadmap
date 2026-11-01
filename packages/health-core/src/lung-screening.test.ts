// US-06 AC9 (Brad, 2026-11-01, issue #285): lung screening follows the American
// Cancer Society's 2023 guideline. Ages 50 to 80, current or former smoker, at
// least 20 pack-years, however long ago they quit. The plan's "Start" card and
// the form's first "Lung screening" ask share one threshold, so a person shown
// the card can always record that they have started. Once a screening is
// recorded, its follow-up, status cards, reminder and stored answers show at
// any pack-years (adversary R2, 2026-11-01).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateHealthResults } from './calculations';
import { computeNextDueDates } from './reminder-schedule';
import { screeningForm } from './input-form';
import { SUGGESTION_EVIDENCE } from './evidence';
import type { HealthInputs, ScreeningInputs } from './types';

const NOW = new Date('2026-06-15T12:00:00Z');
const bornAged = (age: number) => ({ heightCm: 175, sex: 'male', birthYear: 2026 - age, birthMonth: 1 }) as HealthInputs;
const former = (packYears: number): ScreeningInputs => ({ lungSmokingHistory: 'former_smoker', lungPackYears: packYears });
const started = (packYears: number): ScreeningInputs => ({ ...former(packYears), lungScreening: 'annual_ldct', lungLastDate: '2025-01' });

const lungCard = (age: number, s: ScreeningInputs) =>
  calculateHealthResults(bornAged(age), 'si', undefined, s, undefined, NOW).suggestions.find((x) => x.id === 'screening-lung');
const lungReminder = (age: number, s: ScreeningInputs) =>
  computeNextDueDates({ sex: 'male', age }, s, {}, []).some((i) => i.category === 'screening_lung');
const formAsksLungScreening = (age: number, s: ScreeningInputs) =>
  screeningForm(age, 'male', s).flatMap((sec) => sec.groups).find((g) => g.id === 'lung')
    ?.fields.some((f) => 'key' in f && f.key === 'lung_screening') ?? false;

describe('US-06 AC9: lung screening at 20 pack-years (ACS 2023)', () => {
  it('a 60-year-old former smoker with 17 pack-years gets no card, no reminder and no screening question', () => {
    expect(lungCard(60, former(17))).toBeUndefined();
    expect(lungReminder(60, former(17))).toBe(false);
    expect(formAsksLungScreening(60, former(17))).toBe(false);
  });

  it('at 19 nothing; at 20 the card, the reminder and the form question all appear', () => {
    expect(lungCard(60, former(19))).toBeUndefined();
    expect(formAsksLungScreening(60, former(19))).toBe(false);

    const card = lungCard(60, former(20));
    expect(card?.title).toBe('Start lung cancer screening');
    expect(card?.description).toContain('20 pack-years');
    expect(lungReminder(60, started(20))).toBe(true);
    expect(formAsksLungScreening(60, former(20))).toBe(true);
  });

  it('a former smoker qualifies however long ago they quit: there is no quit-window question', () => {
    // At 80, someone with 40 pack-years who quit at 50 (30 years ago) still qualifies.
    expect(lungCard(80, former(40))).toBeDefined();
    expect(lungReminder(80, started(40))).toBe(true);
    // The form asks exactly these three: a quit-date or quit-window question would break this.
    const lung = screeningForm(80, 'male', former(40)).flatMap((sec) => sec.groups).find((g) => g.id === 'lung')!;
    expect(lung.fields.map((f) => ('key' in f ? f.key : f.metric))).toEqual(['lung_smoking_history', 'lung_pack_years', 'lung_screening']);
  });

  it('a screening already recorded below 20 pack-years keeps its follow-up, reminder and stored answers', () => {
    const recorded: ScreeningInputs = {
      ...started(18), lungLastDate: '2026-03', lungResult: 'abnormal', lungFollowupStatus: 'not_organized',
    };
    const plan = calculateHealthResults(bornAged(60), 'si', undefined, recorded, undefined, NOW).suggestions;
    expect(plan.find((x) => x.id === 'screening-lung')).toBeUndefined();
    const followup = plan.find((x) => x.id === 'screening-lung-followup');
    expect(followup?.priority).toBe('urgent');
    expect(lungReminder(60, recorded)).toBe(true);
    const lung = screeningForm(60, 'male', recorded).flatMap((sec) => sec.groups).find((g) => g.id === 'lung')!;
    expect(lung.fields.map((f) => ('key' in f ? f.key : f.metric))).toEqual([
      'lung_smoking_history', 'lung_pack_years', 'lung_screening', 'lung_last_date', 'lung_result', 'lung_followup_status',
    ]);

    // An up-to-date annual LDCT at 18 pack-years shows its status card.
    const upToDate = calculateHealthResults(bornAged(60), 'si', undefined, { ...started(18), lungLastDate: '2026-03' }, undefined, NOW).suggestions;
    expect(upToDate.find((x) => x.id === 'screening-lung-upcoming')?.title).toBe('Lung screening up to date');

    // The age window and smoking history still apply.
    expect(lungReminder(81, recorded)).toBe(false);
    expect(lungReminder(60, { ...recorded, lungSmokingHistory: 'never_smoked' })).toBe(false);
  });

  it('ages 49 and 81 get no card and no reminder, even at 30 pack-years', () => {
    for (const age of [49, 81]) {
      expect(lungCard(age, former(30)), `age ${age}`).toBeUndefined();
      expect(lungReminder(age, started(30)), `age ${age}`).toBe(false);
    }
    expect(lungCard(50, former(30))).toBeDefined();
    expect(lungCard(80, former(30))).toBeDefined();
  });

  it('the form hint names the same threshold the plan uses', () => {
    const lung = screeningForm(60, 'male', former(20)).flatMap((sec) => sec.groups).find((g) => g.id === 'lung')!;
    const packYears = lung.fields.find((f) => 'key' in f && f.key === 'lung_pack_years');
    expect(packYears && 'hint' in packYears ? packYears.hint : undefined).toContain('20 pack-years');
  });

  it('evidence, algorithm doc and roadmap_text.html all say ACS 2023 and 20 pack-years', () => {
    const ev = SUGGESTION_EVIDENCE['screening-lung'];
    expect(ev.reason).toContain('American Cancer Society');
    expect(ev.reason).toContain('20 pack-years');
    expect(ev.reason).not.toContain('15 pack-years');
    expect(ev.guidelines).toEqual(['ACS 2023']);
    // The card's Why panel carries the guideline's two caveats (adversary R3).
    expect(ev.reason).toContain('help to quit');
    expect(ev.reason).toContain('serious illness limits life expectancy');
    expect(ev.references.map((r) => r.url)).toContain('https://doi.org/10.3322/caac.21811');

    const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const algo = readFileSync(join(root, 'health_roadmap_algorithm.md'), 'utf8');
    expect(algo).toMatch(/\| Lung \| 50-80 \| Both \| Former\/current smoker AND >= 20 pack-years[^\n]*ACS 2023/);
    const text = readFileSync(join(root, 'roadmap_text.html'), 'utf8');
    const lungSection = text.slice(text.indexOf('Lung Cancer:'), text.indexOf('Prostate Cancer:'));
    expect(lungSection).toContain('at least a 20 pack-year smoking history');
    expect(lungSection).not.toContain('15 pack-year');
    expect(lungSection).not.toContain('quit within the past 15 years');
    // ACS 2023 does not say screening stops at 80 (adversary R1); the plan's window still ends there.
    expect(lungSection).not.toContain('Regular screenings are no longer recommended');
    expect(lungSection).toContain('evidence suggests it may still help people in good health [132]');
    expect(text).toContain('10.3322/caac.21811');
  });
});
