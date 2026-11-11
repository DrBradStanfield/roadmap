// @vitest-environment jsdom
/** US-02 AC6c: a value edited back during the 800 ms wait (useAutoAdvance) to one that would not move the focus cancels
 *  the wait, in the first-time systolic and US inches boxes, as the weight's callers and the grid's cell already do. Synthetic values. */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { StartingInfoVitals } from './StartingInfoVitals';
import { myHealth } from '../testing/my-health-props';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
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
const $ = (s: string) => document.querySelector<HTMLInputElement>(s)!;
/** Keys typed into a box that keeps the focus: each value in turn, 100 ms apart. */
const typeAll = (el: HTMLInputElement, values: string[]) => values.forEach((value, i) => {
  act(() => { if (i) vi.advanceTimersByTime(100); else el.focus(); }); fireEvent.change(el, { target: { value } }); });
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** The id of the box with the focus, so a failure names it. */
const at = () => document.activeElement?.id;
const usHeight = () => { render(<Panel start={{}} stage={1} us/>); typeAll($('#heightFeet'), ['5']); wait(20); };
const vitals = (rested?: () => void) => render(<StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={vi.fn()} onCorrectValue={vi.fn()}
  onDraftValue={() => {}} formStage={4} plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}} rested={rested}/>);
const systolic = () => render(<Panel start={DONE} stage={4}/>);

describe('US-02 AC6c: a value edited back during the wait to one that does not move on cancels the move', () => {
  it.each([
    ['first-time systolic', '"65" to "6"', systolic, 'systolicBp', ['65', '6']],
    ['first-time systolic', '"85" to "850"', systolic, 'systolicBp', ['85', '850']],
    ['first-time systolic', '"65" cleared', systolic, 'systolicBp', ['65', '']],
    ['5 ft, inches', '"1" cleared', usHeight, 'heightInches', ['1', '']],
    ['5 ft, inches', '"1" to "13"', usHeight, 'heightInches', ['1', '13']],
  ] as const)('%s %s: the focus stays there', (_, __, draw, box, values) => {
    draw();
    typeAll($(`#${box}`), [...values]);
    wait(900);
    expect(at()).toBe(box);
  });
});

describe('US-02 AC6, AC6c: what still moves, and the callers this does not change', () => {
  it('retyped complete, it moves: systolic "65", "6", "65" hops 800 ms after the last "65"; "6", "60" likewise', () => {
    systolic();
    for (const values of [['65', '6', '65'], ['6', '60']]) {
      typeAll($('#systolicBp'), values);
      wait(700);
      expect(at()).toBe('systolicBp');
      wait(200);
      expect(at()).toBe('diastolicBp');
    }
  });
  it('systolic "6" then "120" hops at once; a diastolic already typed means no hop', () => {
    systolic();
    typeAll($('#systolicBp'), ['6', '120']);
    wait(20); // focusById: the next frame
    expect(at()).toBe('diastolicBp');
    typeAll($('#diastolicBp'), ['70']);
    typeAll($('#systolicBp'), ['80']);
    wait(900);
    expect(at()).toBe('systolicBp');
  });
  it('inches "1" to "10" moves at once; "1" alone moves after the wait; "1" retyped after "" moves', () => {
    usHeight();
    typeAll($('#heightInches'), ['1', '10']);
    wait(20);
    expect(at()).toBe('weightKg');
    cleanup();
    usHeight();
    typeAll($('#heightInches'), ['1', '', '1']);
    wait(700);
    expect(at()).toBe('heightInches');
    wait(200);
    expect(at()).toBe('weightKg');
  });
  it('inches never move on with the feet empty or a weight already there', () => {
    for (const start of [{}, { weightKg: 80 }]) {
      render(<Panel start={start} stage={1} us/>);
      if (start.weightKg) { typeAll($('#heightFeet'), ['5']); wait(20); }
      typeAll($('#heightInches'), ['6']);
      wait(900);
      expect(at()).toBe('heightInches');
      cleanup();
    }
  });
  it('a cm height never waits: "180" moves at once', () => {
    render(<Panel start={{}} stage={1}/>);
    typeAll($('#heightCm'), ['180']);
    wait(20);
    expect(at()).toBe('weightKg');
  });
  it('the weight box and the grid\'s weight already cancel: "25" to "2" reports no rest; "25" alone does', () => {
    const draw = [
      (rested: () => void) => { render(<Panel start={{ ...DONE, weightKg: undefined }} stage={1} rested={rested}/>); return $('#weightKg'); },
      (rested: () => void) => { vitals(rested); return [...document.querySelectorAll('.bt-row')]
        .find(r => r.querySelector('.bt-name-label')?.textContent === 'Weight')!.querySelector<HTMLInputElement>('.bt-cell-draft input')!; },
    ];
    for (const field of draw) {
      for (const [values, rests] of [[['25', '2'], 0], [['25'], 1]] as const) {
        const rested = vi.fn();
        typeAll(field(rested), [...values]);
        wait(900);
        expect(rested).toHaveBeenCalledTimes(rests);
        cleanup();
      }
    }
  });
  it('the grid\'s pressure cell already cancels: "65" to "6" means no hop', () => {
    vitals();
    const sys = $('input[aria-label="Systolic blood pressure"]');
    typeAll(sys, ['65', '6']);
    wait(900);
    expect(document.activeElement).toBe(sys);
  });
});
