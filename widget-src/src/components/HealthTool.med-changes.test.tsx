// @vitest-environment jsdom
/**
 * US-06 AC7 (adversarial review, 2026-09-28): changing one medication or its
 * dose never records a change to another, and a cascade step that holds a
 * recorded value always shows. Medication rows are permanent, so a reset that
 * wrote "not taking" for a drug the person still takes was a false record.
 *
 * US-06 AC5: a select shows what the record holds. A dose never recorded
 * reads "Add dose"; an answer the form has no option for reads
 * "Other (recorded)", not the first option.
 *
 * The whole widget renders over a real RoadmapStore on jsdom's localStorage.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { flushRoadmapStore, loadLatestMeasurements, loadMedicationHistory } from '../lib/roadmap-data';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

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

useHealthToolLifecycle();

type Med = [key: string, drug: string, dose?: number];
/** 178 cm, 101.4 kg: BMI 32, so the weight cascade is on. */
const BMI_32 = { sex: 'male' as const, heightCm: 178 };
const WEIGHT: Array<[string, number]> = [['weight', 101.4]];
/** LDL 3.0 mmol/L at BMI 25: the cholesterol cascade is on, the weight one off. */
const LDL_3: Array<[string, number]> = [['weight', 80], ['ldl', 3]];

/** The page for a guest whose record holds these values, once `selector` is on it. */
async function pageWith(measurements: Array<[string, number]>, meds: Med[], selector: string) {
  await seedGuest(BMI_32, measurements, meds);
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
  return view;
}

/** What the record holds for each medication key now: `drug@dose`. */
async function recorded(): Promise<Record<string, string>> {
  const meds = (await loadLatestMeasurements())?.medications ?? [];
  return Object.fromEntries(meds.map((m) => [m.medicationKey, `${m.drugName}@${m.doseValue}`]));
}

/** How many start, stop, switch and dose-change rows each key holds. */
async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of await loadMedicationHistory()) counts[row.medicationKey] = (counts[row.medicationKey] ?? 0) + 1;
  return counts;
}

/** Change a select, then let the form's 300 ms save debounce and the store finish. */
async function choose(container: HTMLElement, selector: string, value: string): Promise<void> {
  fireEvent.change(container.querySelector(selector)!, { target: { value } });
  await new Promise((r) => setTimeout(r, 400));
  await flushRoadmapStore();
}

/** The text of the option a select shows. */
const shown = (container: HTMLElement, selector: string) => {
  const select = container.querySelector<HTMLSelectElement>(selector)!;
  return select.options[select.selectedIndex]?.textContent;
};

describe('US-06 AC7: changing one medication never records a change to another', () => {
  const onAll: Med[] = [['glp1', 'semaglutide_injection', 1], ['sglt2i', 'empagliflozin', 10], ['metformin', 'xr_1000']];

  it('semaglutide 1 mg to 1.7 mg with empagliflozin and metformin XR: no SGLT2 or metformin row, both still shown', async () => {
    const view = await pageWith(WEIGHT, onAll, '#glp1-dose');
    const before = await rowCounts();
    await choose(view.container, '#glp1-dose', '1.7');
    const after = await rowCounts();
    expect(after.glp1).toBe(before.glp1 + 1);
    expect(after.sglt2i).toBe(before.sglt2i);
    expect(after.metformin).toBe(before.metformin);
    expect(await recorded()).toMatchObject({ glp1: 'semaglutide_injection@1.7', sglt2i: 'empagliflozin@10', metformin: 'xr_1000@null' });
    expect((view.container.querySelector('#sglt2i-name') as HTMLSelectElement | null)?.value).toBe('empagliflozin');
    expect((view.container.querySelector('#metformin') as HTMLSelectElement | null)?.value).toBe('xr_1000');
  });

  it('switching the GLP-1 drug writes no SGLT2 or metformin row', async () => {
    const view = await pageWith(WEIGHT, onAll, '#glp1-name');
    const before = await rowCounts();
    await choose(view.container, '#glp1-name', 'tirzepatide');
    const after = await rowCounts();
    expect(after.sglt2i).toBe(before.sglt2i);
    expect(after.metformin).toBe(before.metformin);
    expect(await recorded()).toMatchObject({ sglt2i: 'empagliflozin@10', metformin: 'xr_1000@null' });
  });

  it('a GLP-1 dose change resets only its own escalation answer', async () => {
    const view = await pageWith(WEIGHT, [...onAll, ['glp1_escalation', 'not_tolerated']], '#glp1-dose');
    await choose(view.container, '#glp1-dose', '1.7');
    expect(await recorded()).toMatchObject({ glp1_escalation: 'not_yet@null', sglt2i: 'empagliflozin@10', metformin: 'xr_1000@null' });
  });

  it('an SGLT2 inhibitor dose change writes no metformin row', async () => {
    const view = await pageWith(WEIGHT, onAll, '#sglt2i-dose');
    const before = await rowCounts();
    await choose(view.container, '#sglt2i-dose', '25');
    expect((await rowCounts()).metformin).toBe(before.metformin);
    expect(await recorded()).toMatchObject({ sglt2i: 'empagliflozin@25', metformin: 'xr_1000@null' });
  });

  it('answering the GLP-1 escalation question writes no SGLT2 or metformin row', async () => {
    const view = await pageWith(WEIGHT, [['glp1', 'semaglutide_injection', 1], ['glp1_escalation', 'yes'], ['sglt2i', 'empagliflozin', 10], ['metformin', 'xr_1000']], '#glp1-escalation');
    const before = await rowCounts();
    await choose(view.container, '#glp1-escalation', 'not_tolerated');
    const after = await rowCounts();
    expect(after.sglt2i).toBe(before.sglt2i);
    expect(after.metformin).toBe(before.metformin);
    expect(await recorded()).toMatchObject({ glp1_escalation: 'not_tolerated@null', sglt2i: 'empagliflozin@10', metformin: 'xr_1000@null' });
  });

  const onStatinAndMore: Med[] = [['statin', 'atorvastatin', 20], ['ezetimibe', 'ezetimibe', 10], ['pcsk9i', 'not_tolerated']];

  it.each([
    ['dose', '#statin-dose', '40'],
    ['drug', '#statin-name', 'rosuvastatin'],
  ])('a statin %s change writes no ezetimibe or PCSK9 inhibitor row, and both stay shown', async (_what, selector, value) => {
    const view = await pageWith(LDL_3, onStatinAndMore, selector);
    const before = await rowCounts();
    await choose(view.container, selector, value);
    const after = await rowCounts();
    expect(after.statin).toBe(before.statin + 1);
    expect(after.ezetimibe).toBe(before.ezetimibe);
    expect(after.pcsk9i).toBe(before.pcsk9i);
    expect(await recorded()).toMatchObject({ ezetimibe: 'ezetimibe@10', pcsk9i: 'not_tolerated@null' });
    expect((view.container.querySelector('#ezetimibe') as HTMLSelectElement | null)?.value).toBe('yes');
    expect((view.container.querySelector('#pcsk9i') as HTMLSelectElement | null)?.value).toBe('not_tolerated');
  });
});

// US-06 AC8 (adversarial review, 2026-09-28): adding a missing dose resets the
// drug's escalation answer, as any dose change does (AC7), so the question is
// asked again. Keeping it was tried and reverted: a chat edit can switch the
// drug without a dose, so the answer on record may belong to another drug, and
// keeping it would skip that drug's step up. A re-ask costs one click.
describe('US-06 AC8: adding a missing dose asks the escalation question again', () => {
  it('a GLP-1 with no dose and "didn\'t tolerate a higher dose": choosing 1 mg resets the answer', async () => {
    const view = await pageWith(WEIGHT, [['glp1', 'semaglutide_injection'], ['glp1_escalation', 'not_tolerated']], '#glp1-dose');
    await choose(view.container, '#glp1-dose', '1');
    expect(await recorded()).toMatchObject({ glp1: 'semaglutide_injection@1', glp1_escalation: 'not_yet@null' });
  });

  it('a statin with no dose and "didn\'t tolerate a higher dose": choosing 20 mg resets the answer', async () => {
    const view = await pageWith(LDL_3, [['statin', 'atorvastatin'], ['ezetimibe', 'ezetimibe', 10], ['statin_escalation', 'not_tolerated']], '#statin-dose');
    await choose(view.container, '#statin-dose', '20');
    expect(await recorded()).toMatchObject({ statin: 'atorvastatin@20', statin_escalation: 'not_yet@null' });
  });
});

// US-06 AC7 (final review, 2026-09-28): flat mode shows no escalation field,
// so a drug or dose change there must not reset an answer the user cannot
// see; every change writes a permanent row. Only the drug's own row is written.
describe('US-06 AC7: in flat mode a change writes only the drug\'s own row', () => {
  /** LDL 1.0 mmol/L at BMI 25: both sections show flat, no cascade. */
  const FLAT: Array<[string, number]> = [['weight', 80], ['ldl', 1]];

  it.each([
    ['dose', '#statin-dose', '40'],
    ['drug', '#statin-name', 'rosuvastatin'],
  ])('a statin %s change writes one statin row and nothing else', async (_what, selector, value) => {
    const view = await pageWith(FLAT, [['statin', 'atorvastatin', 20], ['statin_escalation', 'not_tolerated'], ['ezetimibe', 'ezetimibe', 10], ['glp1_escalation', 'not_tolerated']], selector);
    expect(view.container.querySelector('#statin-escalation')).toBeNull();
    const before = await rowCounts();
    await choose(view.container, selector, value);
    expect(await rowCounts()).toEqual({ ...before, statin: before.statin + 1 });
    expect(await recorded()).toMatchObject({ statin_escalation: 'not_tolerated@null', ezetimibe: 'ezetimibe@10', glp1_escalation: 'not_tolerated@null' });
  });

  it.each([
    ['dose', '#glp1-dose', '1.7'],
    ['drug', '#glp1-name', 'tirzepatide'],
  ])('a GLP-1 %s change writes one GLP-1 row and nothing else', async (_what, selector, value) => {
    const view = await pageWith(FLAT, [['glp1', 'semaglutide_injection', 1], ['glp1_escalation', 'not_tolerated'], ['sglt2i', 'empagliflozin', 10], ['statin_escalation', 'not_tolerated']], selector);
    expect(view.container.querySelector('#glp1-escalation')).toBeNull();
    const before = await rowCounts();
    await choose(view.container, selector, value);
    expect(await rowCounts()).toEqual({ ...before, glp1: before.glp1 + 1 });
    expect(await recorded()).toMatchObject({ glp1_escalation: 'not_tolerated@null', sglt2i: 'empagliflozin@10', statin_escalation: 'not_tolerated@null' });
  });
});

describe('US-06 AC5: a select shows what the record holds', () => {
  it('tirzepatide with no dose recorded reads "Add dose", not 2.5 mg', async () => {
    const view = await pageWith(WEIGHT, [['glp1', 'tirzepatide']], '#glp1-dose');
    expect(shown(view.container, '#glp1-dose')).toBe('Add dose');
  });

  it('a raw "ezetimibe" row with no dose reads "Other (recorded)"', async () => {
    const view = await pageWith(LDL_3, [['statin', 'atorvastatin', 20], ['ezetimibe', 'ezetimibe']], '#ezetimibe');
    expect(shown(view.container, '#ezetimibe')).toBe('Other (recorded)');
  });

  it('an escalation answer of "yes" written by an agent reads "Other (recorded)"', async () => {
    const view = await pageWith(WEIGHT, [['glp1', 'semaglutide_injection', 1], ['glp1_escalation', 'yes']], '#glp1-escalation');
    expect(shown(view.container, '#glp1-escalation')).toBe('Other (recorded)');
  });

  // The plan reads an empty or non-string name as unanswered, so the form
  // must not say an answer is on record.
  it.each([
    ['an empty statin name', 'statin', '#statin-name', ''],
    ['an empty GLP-1 name', 'glp1', '#glp1-name', ''],
  ])('%s reads "Not recorded", not "Other (recorded)"', async (_what, key, selector, name) => {
    const measurements = key === 'glp1' ? WEIGHT : LDL_3;
    const view = await pageWith(measurements, [[key, name]], selector);
    expect(shown(view.container, selector)).toBe('Not recorded');
  });

  // A number or an object where a drug name belongs (a hand-edited file) is
  // unanswered, as if no row were recorded. A number once crashed the page
  // (statinDrug.charAt in suggestions.ts).
  it.each([
    ['a number', 42],
    ['an object', { nested: 'x' }],
  ])('%s for a statin name renders, and reads as no statin recorded', async (_what, name) => {
    const view = await pageWith(LDL_3, [['statin', name as unknown as string, 20]], '#statin-name');
    expect(shown(view.container, '#statin-name')).toBe("Haven't tried yet");
  });

  it('a legacy statin value reads "Other (recorded)"', async () => {
    const view = await pageWith(LDL_3, [['statin', 'tier_1']], '#statin-name');
    expect(shown(view.container, '#statin-name')).toBe('Other (recorded)');
  });
});

// US-06 AC5/AC7 (round-2 review): an escalation answer on record always shows,
// but when the plan asks no step-up question (no higher dose, no stronger
// drug, or an earlier step still open) it shows under a neutral label, never
// an increase or switch pitch.
describe('US-06 AC5, AC7: an escalation question the plan is not asking stays neutral', () => {
  /** The escalation field's label, hint and shown answer. */
  const field = (container: HTMLElement, id: string) => {
    const wrap = container.querySelector(`#${id}`)!.closest('.health-field')!;
    return {
      label: wrap.querySelector('label')?.textContent,
      hint: wrap.querySelector('.med-step-hint')?.textContent ?? null,
      shown: shown(container, `#${id}`),
    };
  };

  it('tirzepatide 12.5 mg to 15 mg after "didn\'t tolerate a higher dose": no switch to tirzepatide', async () => {
    const view = await pageWith(WEIGHT, [['glp1', 'tirzepatide', 12.5], ['glp1_escalation', 'not_tolerated']], '#glp1-escalation');
    expect(field(view.container, 'glp1-escalation').label).toBe('Tried increasing GLP-1 dose?');
    await choose(view.container, '#glp1-dose', '15');
    await waitFor(() => expect(field(view.container, 'glp1-escalation')).toEqual({ label: 'Higher dose or switch (recorded answer)', hint: null, shown: 'Not tried' }));
  });

  it.each([
    ['rosuvastatin 40 mg', [['statin', 'rosuvastatin', 40]]],
    ['a statin not tolerated', [['statin', 'not_tolerated']]],
    ['a statin with no dose', [['statin', 'atorvastatin']]],
  ] as Array<[string, Med[]]>)('%s with a recorded answer: no increase or switch pitch', async (_name, statin) => {
    const view = await pageWith(LDL_3, [...statin, ['ezetimibe', 'ezetimibe', 10], ['statin_escalation', 'not_tolerated']], '#statin-escalation');
    expect(field(view.container, 'statin-escalation')).toEqual({ label: 'Higher dose or switch (recorded answer)', hint: null, shown: "Didn't tolerate" });
  });

  it('a question the plan is asking keeps its pitch', async () => {
    const view = await pageWith(LDL_3, [['statin', 'atorvastatin', 20], ['ezetimibe', 'ezetimibe', 10], ['statin_escalation', 'not_tolerated']], '#statin-escalation');
    expect(field(view.container, 'statin-escalation')).toMatchObject({ label: 'Tried increasing statin dose?', shown: "Didn't tolerate a higher dose" });
  });
});
