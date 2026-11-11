// @vitest-environment jsdom
/**
 * US-02 AC6b: a deferred auto-advance (800 ms, useAutoAdvance) jumps only if
 * the focus is still where the value was typed. Every caller that waits: the
 * first-time systolic box, the US inches box, the weight box and the vitals
 * grid's weight (both report `rested`, US-62 AC25b), and the grid's pressure
 * cell. Synthetic values.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from '../components/InputPanel';
import { StartingInfoVitals } from '../components/StartingInfoVitals';
import { myHealth } from '../testing/my-health-props';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('./server-api', async importOriginal => ({ ...await importOriginal<typeof import('./server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });

const DONE = { sex: 'male' as const, heightCm: 180, weightKg: 80, birthYear: 1960, birthMonth: 1 };
/** First-time fields, the panel holding its own inputs as HealthTool does. */
function Panel({ start, stage, us = false, rested }: { start: Partial<HealthInputs>; stage: 1 | 4; us?: boolean; rested?: () => void }) {
  const [inputs, setInputs] = useState(start);
  const props = {
    ...myHealth({ settingsOpen: false }),
    inputs, effectiveInputs: inputs, onChange: (f: keyof HealthInputs, v: unknown) => setInputs(p => ({ ...p, [f]: v })),
    errors: {}, unitSystem: us ? 'conventional' : 'si', unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [],
    bloodTestHistory: [], vitalsHistory: [], labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(),
    medications: [], onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
    onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
    fieldsSaved: 0, hasApiResponse: true, planBasis: { age: 66 }, grading: {},
    onboarding: { stage, reached: stage, fullForm: stage === 4, aboutYouLow: stage === 4, rested, left: rested && vi.fn() },
  } as unknown as Parameters<typeof InputPanel>[0];
  return <InputPanel {...props}/>;
}
const vitals = (rested?: () => void) => render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={vi.fn()} onCorrectValue={vi.fn()}
  onDraftValue={() => {}} formStage={4} plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}} rested={rested}/>);
const $ = (s: string) => document.querySelector<HTMLInputElement>(s)!;
const sys = () => $('input[aria-label="Systolic blood pressure"]');
const dia = () => $('input[aria-label="Diastolic blood pressure"]');
const weightCell = () => [...document.querySelectorAll('.bt-row')]
  .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!.querySelector<HTMLInputElement>('.bt-cell-draft input')!;
const focus = (el: HTMLElement) => act(() => { el.focus(); });
const type = (el: HTMLInputElement, value: string) => { focus(el); fireEvent.change(el, { target: { value } }); };
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const focused = () => document.activeElement;

/** Each caller that waits: draw it, type a value that could still grow, and say how to tell it jumped. */
const CALLERS = {
  'the first-time systolic box, "80"': () => {
    render(<Panel start={DONE} stage={4}/>); type($('#systolicBp'), '80');
    return { field: $('#systolicBp'), elsewhere: $('#waistCm'), jumped: () => focused() === $('#diastolicBp') };
  },
  'US height 5 ft, inches "1"': () => {
    render(<Panel start={{}} stage={1} us/>); type($('#heightFeet'), '5'); wait(20); type($('#heightInches'), '1');
    return { field: $('#heightInches'), elsewhere: $('#heightFeet'), jumped: () => focused() === $('#weightKg') };
  },
  'the weight box, "25" (its rest)': () => {
    const rested = vi.fn(); render(<Panel start={{ ...DONE, weightKg: undefined }} stage={1} rested={rested}/>); type($('#weightKg'), '25');
    return { field: $('#weightKg'), elsewhere: $('#heightCm'), jumped: () => rested.mock.calls.length === 1 };
  },
  'the vitals grid\'s weight, "25" (its rest)': () => {
    const rested = vi.fn(); vitals(rested); type(weightCell(), '25');
    return { field: weightCell(), elsewhere: sys(), jumped: () => rested.mock.calls.length === 1 };
  },
  'the vitals grid\'s pressure cell, "80"': () => {
    vitals(); type(sys(), '80');
    return { field: sys(), elsewhere: weightCell(), jumped: () => focused() === dia() };
  },
};
/** After typing: stay; leave for another field; leave and come back before the wait ends. */
const GESTURES = [['stays', false, false], ['leaves', true, false], ['leaves and comes back', true, true]] as const;

describe('US-02 AC6b: the wait ends in a jump only if the field has the focus', () => {
  it.each(Object.keys(CALLERS).flatMap(c => GESTURES.map(([g, away, back]) => [c, g, away, back] as const)))('%s, the person %s', (c, _, away, back) => {
    const { field, elsewhere, jumped } = CALLERS[c as keyof typeof CALLERS]();
    if (away) focus(elsewhere);
    wait(400);
    if (back) focus(field);
    wait(500);
    expect(jumped()).toBe(!away || back);
    if (away && !back) expect(focused()).toBe(elsewhere);
  });
});

describe('US-02 AC6, AC6b: what does not wait, or never jumps, is unchanged', () => {
  it('first-time boxes: systolic "120" and a cm height of "180" move at once; a diastolic already typed means no hop', () => {
    render(<Panel start={{ sex: 'male', birthYear: 1960, birthMonth: 1 }} stage={1}/>);
    type($('#heightCm'), '180');
    wait(20); // focusById: the next frame
    expect(focused()).toBe($('#weightKg'));
    cleanup();
    render(<Panel start={DONE} stage={4}/>);
    type($('#systolicBp'), '120');
    wait(20);
    expect(focused()).toBe($('#diastolicBp'));
    type($('#diastolicBp'), '70');
    type($('#systolicBp'), '80');
    wait(900);
    expect(focused()).toBe($('#systolicBp'));
  });
  it('the first-time systolic box: a new digit during the wait starts it again', () => {
    render(<Panel start={DONE} stage={4}/>);
    type($('#systolicBp'), '80');
    wait(400);
    type($('#systolicBp'), '85');
    wait(500);
    expect(focused()).toBe($('#systolicBp'));
    wait(400);
    expect(focused()).toBe($('#diastolicBp'));
  });
  it('the grid\'s pressure cell: "120" hops at once; "6", "80" then "6", or a diastolic already typed, means no hop', () => {
    vitals();
    type(sys(), '120');
    expect(focused()).toBe(dia());
    for (const typed of [['6'], ['80', '6']]) {
      type(dia(), ''); // the hop needs an empty diastolic
      for (const v of typed) type(sys(), v);
      wait(900);
      expect(focused()).toBe(sys());
    }
    type(dia(), '70');
    type(sys(), '80');
    wait(900);
    expect(focused()).toBe(sys());
  });
});
