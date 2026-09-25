// @vitest-environment jsdom
/**
 * US-06 AC5: the form's Weight & Diabetes Medications section follows the
 * plan. It recommends a weight medication only when the plan's own trigger is
 * on, and it names the plan's reasons. Brad ruled on 2026-09-25 that the form
 * must never recommend what the plan does not.
 *
 * The whole widget renders over a real RoadmapStore on this browser's
 * localStorage, so the plan and the form read one record through HealthTool's
 * own wiring. Only the network edges and the chat are stubbed. Every guest is
 * 178 cm tall, so 1 kg is 0.32 of BMI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, type RenderResult } from '@testing-library/react';
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
const recommends = (reasons?: string) => (reasons
  ? `Your BMI and ${reasons} suggest you may benefit from medications that support weight management and metabolic health.`
  : 'Your BMI suggests you may benefit from medications that support weight management and metabolic health.');

interface GuestRecord {
  sex?: 'male';
  weight: number;
  waist?: number;
  hba1c?: number;
  triglycerides?: number;
  bp?: [number, number];
  /** [medication key, drug name] */
  meds?: [string, string][];
}

/** A guest whose record holds these values, and the page showing it. */
async function guestWith(r: GuestRecord): Promise<RenderResult> {
  const day = '2026-09-01';
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ ...(r.sex ? { sex: r.sex } : {}), heightCm: 178 }, {});
  await addMeasurement('weight', r.weight, day);
  if (r.waist) await addMeasurement('waist', r.waist, day);
  if (r.hba1c) await addMeasurement('hba1c', r.hba1c, day);
  if (r.triglycerides) await addMeasurement('triglycerides', r.triglycerides, day);
  if (r.bp) {
    await addMeasurement('systolic_bp', r.bp[0], day);
    await addMeasurement('diastolic_bp', r.bp[1], day);
  }
  for (const [key, drug] of r.meds ?? []) await saveMedication(key, drug);
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

/** The opening sentence of the form's Weight & Diabetes Medications section. */
function weightMedsIntro(container: HTMLElement): Promise<string> {
  return waitFor(() => {
    const title = Array.from(container.querySelectorAll('.health-section-title'))
      .find((t) => t.textContent === 'Weight & Diabetes Medications');
    if (!title) throw new Error('the section is not on the page');
    return title.parentElement!.querySelector('.health-section-desc')!.textContent!;
  });
}

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

  it('BMI 26, a healthy waist and a systolic of 135 is neutral, matching the plan today (group 2 is still open)', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 81.9, bp: [135, 85] }); // BMI 26.0, WHtR 0.46
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toBeUndefined();
    expect(await weightMedsIntro(view.container)).toBe(NEUTRAL);
  });

  it('when the plan recommends, the form does too, with the same reasons', async () => {
    const view = await guestWith({ sex: 'male', weight: 82.4, waist: 92.6, triglycerides: 2.0 }); // BMI 26.0, WHtR 0.52
    await waitFor(() => expect(bmiTile(view.container)).toBe('26'));
    expect(planGlp1(view.container)).toContain('With an elevated BMI and elevated triglycerides, elevated waist-to-height ratio, ');
    expect(await weightMedsIntro(view.container)).toBe(recommends('elevated triglycerides, elevated waist-to-height ratio'));
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
    expect(await weightMedsIntro(view.container)).toBe(recommends('prediabetic HbA1c'));
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
    expect(planGlp1(view.container)).toContain('With an elevated BMI and elevated waist-to-height ratio, ');
    expect(await weightMedsIntro(view.container)).toBe(recommends('elevated waist-to-height ratio'));
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
