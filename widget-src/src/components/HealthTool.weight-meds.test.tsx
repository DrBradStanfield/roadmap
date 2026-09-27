// @vitest-environment jsdom
/**
 * US-06 AC5: the form follows the plan. Its Weight & Diabetes Medications
 * section recommends a weight medication only when the plan's own trigger is
 * on, and it names the plan's reasons and BMI. Its Cholesterol Medications
 * section, blood-pressure target and cascade steps read the plan's lipid
 * marker, age and step decisions. Brad ruled on 2026-09-25 that the form must
 * never recommend what the plan does not, and on 2026-09-26 that the form
 * follows the plan.
 *
 * The whole widget renders over a real RoadmapStore on this browser's
 * localStorage, so the plan and the form read one record through HealthTool's
 * own wiring. Only the network edges and the chat are stubbed. Every guest is
 * 178 cm tall, so 1 kg is 0.32 of BMI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent, type RenderResult } from '@testing-library/react';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import {
  addMeasurement,
  flushRoadmapStore,
  initRoadmapStore,
  saveChangedMeasurements,
  saveMedication,
} from '../lib/roadmap-data';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

const NEUTRAL = 'Are you currently taking any weight or diabetes medications? Recording these helps track your health over time.';
const recommends = (bmi: string, reasons?: string) => (reasons
  ? `Your BMI of ${bmi} and ${reasons} suggest you may benefit from medications that support weight management and metabolic health.`
  : `Your BMI of ${bmi} suggests you may benefit from medications that support weight management and metabolic health.`);
/** The plan's GLP-1 card text (US-06 AC6). */
const glp1Card = (bmi: string, reasons: string) =>
  `With a BMI of ${bmi} and ${reasons}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health.`;

interface GuestRecord {
  sex?: 'male';
  birthYear?: number;
  birthMonth?: number;
  /** cm; 178 unless given. */
  height?: number;
  weight: number;
  waist?: number;
  hba1c?: number;
  triglycerides?: number;
  bp?: [number, number];
  /** Lipids in mmol/L. */
  lipids?: { total?: number; hdl?: number; ldl?: number };
  /** [medication key, drug name, dose in mg] */
  meds?: [string, string, number?][];
}

/** A guest whose record holds these values, and the page showing it. */
async function guestWith(r: GuestRecord): Promise<RenderResult> {
  const day = '2026-09-01';
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({
    ...(r.sex ? { sex: r.sex } : {}), ...(r.birthYear ? { birthYear: r.birthYear } : {}),
    ...(r.birthMonth ? { birthMonth: r.birthMonth } : {}), heightCm: r.height ?? 178,
  }, {});
  await addMeasurement('weight', r.weight, day);
  if (r.waist) await addMeasurement('waist', r.waist, day);
  if (r.hba1c) await addMeasurement('hba1c', r.hba1c, day);
  if (r.triglycerides) await addMeasurement('triglycerides', r.triglycerides, day);
  if (r.bp) {
    await addMeasurement('systolic_bp', r.bp[0], day);
    await addMeasurement('diastolic_bp', r.bp[1], day);
  }
  if (r.lipids?.total) await addMeasurement('total_cholesterol', r.lipids.total, day);
  if (r.lipids?.hdl) await addMeasurement('hdl', r.lipids.hdl, day);
  if (r.lipids?.ldl) await addMeasurement('ldl', r.lipids.ldl, day);
  for (const [key, drug, dose] of r.meds ?? []) await saveMedication(key, drug, dose ?? null, dose ? 'mg' : null);
  await flushRoadmapStore();
  return render(<HealthTool />);
}

/** The BMI on the plan, once the plan has read the record. */
const bmiTile = (container: HTMLElement) => Array.from(container.querySelectorAll('.stat-card'))
  .find((c) => c.querySelector('.stat-label')?.textContent === 'BMI')?.querySelector('.stat-value')?.textContent;

/** The plan's "Consider a GLP-1 medication" card text, if the plan has one. */
function planGlp1(container: HTMLElement): string | undefined {
  const title = Array.from(container.querySelectorAll('.suggestion-title'))
    .find((t) => t.textContent === 'Consider a GLP-1 medication');
  return title?.parentElement?.querySelector('.suggestion-desc')?.textContent ?? undefined;
}

/** A plan card whose title is, or (for `weight-med`) is any weight-medication step. */
function planCard(container: HTMLElement, title: string): Element | undefined {
  const steps = ['Consider a GLP-1 medication', 'Consider increasing GLP-1 dose', 'Consider switching to Tirzepatide',
    'Consider adding an SGLT2 inhibitor', 'Consider adding Metformin'];
  const titles = title === 'weight-med' ? steps : [title];
  return Array.from(container.querySelectorAll('.suggestion-title')).find((t) => titles.includes(t.textContent ?? ''));
}

/** The opening sentence of one of the form's sections, once it is on the page. */
function sectionIntro(container: HTMLElement, section: string): Promise<string> {
  return waitFor(() => {
    const title = Array.from(container.querySelectorAll('.health-section-title'))
      .find((t) => t.textContent === section);
    if (!title) throw new Error('the section is not on the page');
    return title.parentElement!.querySelector('.health-section-desc')!.textContent!;
  });
}
const weightMedsIntro = (container: HTMLElement) => sectionIntro(container, 'Weight & Diabetes Medications');
const cholesterolIntro = (container: HTMLElement) => sectionIntro(container, 'Cholesterol Medications');
/** The local mirror as the widget writes it: a saved weight row in
 *  `previousMeasurements`, which opens the vitals matrix at mount. */
const SAVED_WEIGHT_MIRROR = JSON.stringify({
  inputs: { heightCm: 178, sex: 'male' },
  previousMeasurements: [{ id: 'm1', metricType: 'weight', value: 80, recordedAt: '2026-09-01T12:00:00.000Z', createdAt: '2026-09-01T12:00:00.000Z' }],
});
const CHOLESTEROL_NEUTRAL = 'Are you currently taking any cholesterol medications? Recording these helps track your health over time.';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Wide desktop: the plan and the form both on screen.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  Element.prototype.scrollIntoView ??= () => {}; // jsdom has no layout to scroll
});
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('US-06 AC5: the form recommends a weight medication only when the plan does', () => {
  it("Brad's ruling: BMI 28.6 with a healthy waist and no raised marker is neutral, as the plan is silent", async () => {
    const view = await guestWith({ sex: 'male', weight: 90.6, waist: 83.7 }); // BMI 28.6, WHtR 0.47
    await waitFor(() => expect(bmiTile(view.container)).toBe('28.6'));
    expect(planGlp1(view.container)).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('BMI 26, a healthy waist and BP 135/85: raised blood pressure counts, so the plan and the form both recommend (US-06 AC6)', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 81.9, bp: [135, 85] }); // BMI 26.0, WHtR 0.46
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBe(glp1Card('26', 'elevated blood pressure'));
    expect(await weightMedsIntro(view.container)).toBe(recommends('26', 'elevated blood pressure'));
  });

  it('when the plan recommends, the form does too, with the same reasons', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 92.6, triglycerides: 2.0 }); // BMI 26.0, WHtR 0.52
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBe(glp1Card('26', 'elevated triglycerides and elevated waist-to-height ratio'));
    expect(await weightMedsIntro(view.container)).toBe(recommends('26', 'elevated triglycerides and elevated waist-to-height ratio'));
  });

  // Adversarial review, 2026-09-25: with every step answered the trigger is
  // still on, so the form recommended while the plan showed no card.
  it('BMI 25.0 with a raised HbA1c and every step answered is neutral: the plan shows no card', async () => {
    // 79.1 kg is BMI 24.97, which the plan rounds to 25.0: Overweight, with no waist on record.
    const view = await guestWith({
      sex: 'male', weight: 79.1, hba1c: 40,
      meds: [['glp1', 'not_tolerated'], ['sglt2i', 'not_tolerated'], ['metformin', 'not_tolerated']],
    });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25'));
    expect(planCard(view.container, 'weight-med')).toBeUndefined(); // the trigger is on; every step is answered
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('BMI 32 with an HbA1c of 40 and every step not tolerated is neutral, as the plan shows no card', async () => {
    const view = await guestWith({
      sex: 'male', weight: 101.4, hba1c: 40, // BMI 32.0
      meds: [['glp1', 'not_tolerated'], ['sglt2i', 'not_tolerated'], ['metformin', 'not_tolerated']],
    });
    await waitFor(() => expect(bmiTile(view.container)).toBe('32'));
    expect(planCard(view.container, 'weight-med')).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('a later step\'s card counts too: GLP-1 not tolerated, the plan suggests an SGLT2 inhibitor, and the form recommends', async () => {
    const view = await guestWith({ sex: 'male', weight: 101.4, hba1c: 40, meds: [['glp1', 'not_tolerated']] });
    await waitFor(() => expect(bmiTile(view.container)).toBe('32'));
    expect(planCard(view.container, 'Consider adding an SGLT2 inhibitor')).toBeDefined();
    expect(await weightMedsIntro(view.container)).toBe(recommends('32', 'prediabetic HbA1c'));
  });

  it('BMI 25.0 with no raised marker is neutral, as the plan is silent', async () => {
    const view = await guestWith({ sex: 'male', weight: 79.1 });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25'));
    expect(planGlp1(view.container)).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('a WHtR of 0.4978 is 0.50 to the plan, so the form names the waist too', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 88.6 }); // BMI 26.0, WHtR 0.4978
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBe(glp1Card('26', 'elevated waist-to-height ratio'));
    expect(await weightMedsIntro(view.container)).toBe(recommends('26', 'elevated waist-to-height ratio'));
  });

  it('before there is a plan (no sex yet), the section is neutral', async () => {
    const view = await guestWith({ weight: 95 }); // BMI 30.0
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('a value the plan sets aside as invalid does not make the form recommend', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, hba1c: 200 }); // above the 195 mmol/mol bound
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });
});

describe('US-06 AC5: the weight sentence names the plan\'s BMI', () => {
  it('BMI 32 with no raised marker: "Your BMI of 32 suggests ..."', async () => {
    const view = await guestWith({ sex: 'male', weight: 101.4 });
    await waitFor(() => expect(bmiTile(view.container)).toBe('32'));
    expect(planGlp1(view.container)).toBeDefined();
    expect(await weightMedsIntro(view.container)).toBe(recommends('32'));
  });
});

describe('US-06 AC5: the weight cascade steps through what the plan does', () => {
  it('on a GLP-1 with no dose recorded, the plan suggests an SGLT2 inhibitor and the form shows its field', async () => {
    const view = await guestWith({ sex: 'male', weight: 101.4, meds: [['glp1', 'semaglutide_injection']] }); // BMI 32
    await waitFor(() => expect(planCard(view.container, 'Consider adding an SGLT2 inhibitor')).toBeDefined());
    expect(await weightMedsIntro(view.container)).toBe(recommends('32'));
    expect(view.container.querySelector('#sglt2i-name')).not.toBeNull();
  });

  it("an escalation answer other than 'not yet' moves on in both places", async () => {
    const view = await guestWith({
      sex: 'male', weight: 101.4, meds: [['glp1', 'semaglutide_injection', 1], ['glp1_escalation', 'yes']],
    });
    await waitFor(() => expect(planCard(view.container, 'Consider adding an SGLT2 inhibitor')).toBeDefined());
    await weightMedsIntro(view.container);
    expect(view.container.querySelector('#sglt2i-name')).not.toBeNull();
  });
});

describe('US-06 AC5: the form recommends a cholesterol medication only when the plan does', () => {
  // US-07 AC5 (Brad, 2026-09-28): the target itself is above target. The plan
  // compares non-HDL unrounded and shows it to one decimal place.
  it('TC 3.84 and HDL 2.20: non-HDL 1.64 is above the 1.6 target, so the plan and the form both suggest a statin, showing 1.6', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { total: 3.84, hdl: 2.2 } });
    await waitFor(() => expect(planCard(view.container, 'Consider starting a statin')).toBeDefined());
    expect(await cholesterolIntro(view.container))
      .toMatch(/^Your non-HDL cholesterol is 1\.6 mmol\/L; the treatment target is below 1\.6 mmol\/L\. /);
  });

  it('TC 3.76 and HDL 2.20: non-HDL 1.56 is below the 1.6 target, though it shows as 1.6, so both stay neutral', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { total: 3.76, hdl: 2.2 } });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    expect(planCard(view.container, 'Consider starting a statin')).toBeUndefined();
    expect(await cholesterolIntro(view.container)).toBe(CHOLESTEROL_NEUTRAL);
  });

  it('TC 3.74 and HDL 2.20: non-HDL 1.5 is below the target, so the plan shows no statin card and the form is neutral', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { total: 3.74, hdl: 2.2 } });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    expect(planCard(view.container, 'Consider starting a statin')).toBeUndefined();
    expect(await cholesterolIntro(view.container)).toBe(CHOLESTEROL_NEUTRAL);
  });

  it('an LDL above the 12.9 mmol/L bound: the plan sets it aside and the form is neutral', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { ldl: 13 } });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    expect(planCard(view.container, 'Consider starting a statin')).toBeUndefined();
    expect(await cholesterolIntro(view.container)).toBe(CHOLESTEROL_NEUTRAL);
  });

  it('when the plan suggests a statin, the form names the same marker and target', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { total: 3.9, hdl: 2.2 } }); // non-HDL 1.7
    await waitFor(() => expect(planCard(view.container, 'Consider starting a statin')).toBeDefined());
    expect(await cholesterolIntro(view.container))
      .toMatch(/^Your non-HDL cholesterol is 1\.7 mmol\/L; the treatment target is below 1\.6 mmol\/L\. /);
  });

  it('the form opens with the plan card\'s own sentence, word for word and digit for digit', async () => {
    const view = await guestWith({ sex: 'male', weight: 80, lipids: { ldl: 3 } });
    await waitFor(() => expect(planCard(view.container, 'Consider starting a statin')).toBeDefined());
    const sentence = 'Your LDL-c is 3.0 mmol/L; the treatment target is below 1.4 mmol/L.';
    expect(planCard(view.container, 'Consider starting a statin')!.parentElement!.querySelector('.suggestion-desc')!.textContent)
      .toMatch(new RegExp(`^${sentence.replace(/\./g, '\\.')} `));
    expect(await cholesterolIntro(view.container)).toMatch(new RegExp(`^${sentence.replace(/\./g, '\\.')} `));
  });

  it('on a statin with no dose recorded and ezetimibe, the plan suggests a PCSK9 inhibitor and the form shows its field', async () => {
    const view = await guestWith({
      sex: 'male', weight: 80, lipids: { ldl: 3 }, meds: [['statin', 'rosuvastatin'], ['ezetimibe', 'ezetimibe', 10]],
    });
    await waitFor(() => expect(planCard(view.container, 'Consider a PCSK9 inhibitor')).toBeDefined());
    await cholesterolIntro(view.container);
    expect(view.container.querySelector('#pcsk9i')).not.toBeNull();
  });

  it('with every step answered the plan shows no cholesterol card, so the form states no target', async () => {
    const view = await guestWith({
      sex: 'male', weight: 80, lipids: { ldl: 3 },
      meds: [['statin', 'rosuvastatin', 40], ['ezetimibe', 'ezetimibe', 10], ['bempedoic_acid', 'bempedoic_acid', 180], ['pcsk9i', 'pcsk9i', 140]],
    });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    expect(Array.from(view.container.querySelectorAll('.suggestion-title')).map((t) => t.textContent)
      .filter((t) => /statin|Ezetimibe|bempedoic|PCSK9/.test(t ?? ''))).toEqual([]);
    expect(await cholesterolIntro(view.container)).toBe(CHOLESTEROL_NEUTRAL);
  });
});

describe('US-06 AC5: the form\'s age-based targets and sections follow the plan\'s age', () => {
  /** The form's blood-pressure target hint. */
  const bpHint = (container: HTMLElement) => waitFor(() => {
    const hint = Array.from(container.querySelectorAll('.field-hint')).find((h) => h.textContent?.startsWith('Target: <1'));
    if (!hint) throw new Error('no BP target on the page');
    return hint.textContent;
  });

  it('born 1958 with no month and BP 135/85: the plan and the form both say <130/80', async () => {
    const view = await guestWith({ sex: 'male', birthYear: 1958, weight: 80, bp: [135, 85] });
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.suggestion-desc'))
      .some((d) => d.textContent?.includes('Target is <130/80'))).toBe(true));
    expect(await bpHint(view.container)).toBe('Target: <130/80 mmHg');
  });

  it('the returning-user vitals matrix reads the plan\'s age too: an invalid birth year gives <120/80', async () => {
    // A saved weight in the legacy mirror opens the matrix at mount.
    localStorage.setItem('health_roadmap_data', SAVED_WEIGHT_MIRROR);
    const view = await guestWith({ sex: 'male', birthYear: 1899, weight: 80, bp: [135, 85] });
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.suggestion-desc'))
      .some((d) => d.textContent?.includes('Target is <120/80'))).toBe(true));
    const matrixBpTarget = await waitFor(() => {
      const label = Array.from(view.container.querySelectorAll('.bt-ref-label')).find((l) => l.textContent?.includes('/80 mmHg'));
      if (!label) throw new Error('no vitals matrix on the page');
      return label.textContent;
    });
    expect(matrixBpTarget).toBe('Target: <120/80 mmHg');
  });

  // Codex R1 (2026-09-28): with no plan, blood pressure stays neutral, like weight and waist.
  it('with no plan (no height), the form states no blood-pressure target', async () => {
    const view = await guestWith({ sex: 'male', height: 0, weight: 80, bp: [135, 85] });
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.collapsed-field-value'))
      .some((v) => v.textContent?.includes('135/85'))).toBe(true));
    expect(Array.from(view.container.querySelectorAll('.field-hint')).map((h) => h.textContent)
      .filter((t) => t?.includes('/80 mmHg'))).toEqual([]);
  });

  it('a returning user who clears their height: the matrix states no BP target and colours no BP status', async () => {
    localStorage.setItem('health_roadmap_data', SAVED_WEIGHT_MIRROR);
    const view = await guestWith({ sex: 'male', birthYear: 1970, weight: 80, bp: [135, 85] });
    const bpRow = () => Array.from(view.container.querySelectorAll('.bt-row')).find((r) => r.textContent?.includes('Blood Pressure'));
    await waitFor(() => expect(bpRow()?.querySelector('.bt-ref-label')?.textContent).toBe('Target: <120/80 mmHg'));
    expect(Array.from(bpRow()!.querySelectorAll('.bt-status-tick')).map((t) => t.className)).toContain('bt-status-tick bt-status-bad');
    fireEvent.change(view.container.querySelector('#heightCm')!, { target: { value: '' } });
    await waitFor(() => expect(bpRow()?.querySelector('.bt-ref-label')?.textContent).toBe('Set sex + height to see target'));
    expect(Array.from(bpRow()!.querySelectorAll('.bt-status-tick')).map((t) => t.className.replace('bt-status-tick ', ''))
      .filter((c) => c !== 'bt-status-none')).toEqual([]);
  });

  it('born June 1899: the plan sets the year aside, so the summary states no age', async () => {
    const view = await guestWith({ sex: 'male', birthYear: 1899, birthMonth: 6, weight: 80 });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    expect(view.container.querySelector('.prefill-summary')?.textContent).toBe('Male · 178 cm tall · Born Jun 1899');
  });

  it('born December 1981: the summary states the plan\'s age', async () => {
    const view = await guestWith({ sex: 'male', birthYear: 1981, birthMonth: 12, weight: 80 });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    const now = new Date();
    const age = now.getFullYear() - 1981 - (now.getMonth() + 1 < 12 ? 1 : 0);
    expect(view.container.querySelector('.prefill-summary')?.textContent).toBe(`Male · 178 cm tall · Born Dec 1981 (Age ${age})`);
  });

  it('a birth year the plan sets aside as invalid gives the form no age: no screening or bone density sections', async () => {
    const view = await guestWith({ sex: 'male', birthYear: 1899, weight: 80 }); // before the 1900 bound
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    await weightMedsIntro(view.container); // the medication sections are on the page
    const titles = Array.from(view.container.querySelectorAll('.health-section-title')).map((t) => t.textContent);
    expect(titles).not.toContain('Cancer Screening');
    expect(titles).not.toContain('Bone Density');
  });
});

describe('US-06 AC5: the vitals matrix takes its weight and waist targets from the plan', () => {
  /** The matrix's reference label for a row, once the matrix is on the page. */
  const matrixTarget = (container: HTMLElement, row: string) => waitFor(() => {
    const name = Array.from(container.querySelectorAll('.bt-row')).find((r) => r.textContent?.includes(row));
    const label = name?.querySelector('.bt-ref-label')?.textContent;
    if (!label) throw new Error('no vitals matrix on the page');
    return label;
  });
  // A saved weight in the legacy mirror opens the matrix at mount.
  beforeEach(() => localStorage.setItem('health_roadmap_data', SAVED_WEIGHT_MIRROR));

  it("with a plan, the weight target is the plan's ideal body weight and the waist target the plan's own waist line", async () => {
    const view = await guestWith({ sex: 'male', weight: 80, waist: 85 });
    await waitFor(() => expect(bmiTile(view.container)).toBe('25.2'));
    const ibw = Array.from(view.container.querySelectorAll('.stat-card'))
      .find((c) => c.querySelector('.stat-label')?.textContent === 'Ideal Body Weight')?.querySelector('.stat-value')?.textContent;
    expect(await matrixTarget(view.container, 'Weight')).toBe(`Target: ${ibw}`);
    // At 178 cm the plan's ratio rounds to 0.50 from 88.11 cm: 88 cm is
    // healthy and 89 cm elevated, so the label is the first elevated value.
    expect(await matrixTarget(view.container, 'Waist Circumference')).toBe('Target: <89 cm');
  });

  /** The status ticks on the waist row. */
  const waistTicks = (container: HTMLElement) => Array.from(
    Array.from(container.querySelectorAll('.bt-row')).find((r) => r.textContent?.includes('Waist Circumference'))
      ?.querySelectorAll('.bt-status-tick') ?? [],
  ).map((t) => t.className.replace('bt-status-tick ', ''));

  it('a waist of 88.6 cm at 178 cm is 0.50 to the plan, so the matrix flags it too', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 88.6 }); // WHtR 0.4978, 0.50 rounded
    expect(await matrixTarget(view.container, 'Waist Circumference')).toBe('Target: <89 cm');
    await waitFor(() => expect(planGlp1(view.container)).toContain('elevated waist-to-height ratio'));
    await waitFor(() => expect(waistTicks(view.container)).toContain('bt-status-warn'));
    expect(waistTicks(view.container)).not.toContain('bt-status-ok');
  });

  it('a waist of 87.9 cm at 178 cm is healthy to the plan and the matrix', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 87.9 }); // WHtR 0.4938
    expect(await matrixTarget(view.container, 'Waist Circumference')).toBe('Target: <89 cm');
    await waitFor(() => expect(waistTicks(view.container)).toContain('bt-status-ok'));
    expect(planGlp1(view.container)).toBeUndefined();
  });

  it('a height the plan sets aside as invalid gives the matrix no weight or waist target', async () => {
    const view = await guestWith({ sex: 'male', height: 260, weight: 80, waist: 85 }); // above the 250 cm bound
    expect(await matrixTarget(view.container, 'Weight')).toBe('Set sex + height to see target');
    expect(await matrixTarget(view.container, 'Waist Circumference')).toBe('Set sex + height to see target');
  });
});


describe('US-06 AC6: from BMI 25 a raised marker counts even with a healthy waist, in the plan and the form', () => {
  it('BMI 26 with a healthy waist and an HbA1c of 40: the plan shows the GLP-1 card and the form recommends', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 81.9, hba1c: 40 }); // BMI 26.0, WHtR 0.46
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBe(glp1Card('26', 'prediabetic HbA1c'));
    expect(await weightMedsIntro(view.container)).toBe(recommends('26', 'prediabetic HbA1c'));
  });

  it('BMI 26 with a healthy waist and nothing raised: both stay neutral', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 81.9 }); // BMI 26.0, WHtR 0.46
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });
});
