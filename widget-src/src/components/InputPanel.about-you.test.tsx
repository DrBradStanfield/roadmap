// @vitest-environment jsdom
/**
 * About you, low, as rows (US-62 AC12), drawn by AboutYou.tsx and fed by
 * InputPanel. These hold what the move out of InputPanel must keep: the feet
 * and inches typed outlive the Height row closing (US-02 AC11), and a missing
 * answer's row opens itself and stays open until Done (US-62 AC12).
 */
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

afterEach(cleanup);
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));

const props = (inputs: Partial<HealthInputs>, onChange: (field: keyof HealthInputs, value: unknown) => void, unitSystem: 'si' | 'conventional', settingsOpen = true) => ({
  ...myHealth({ settingsOpen }), // About you, low, sits in Settings (US-62 AC24)
  inputs, effectiveInputs: inputs, onChange, errors: {}, unitSystem,
  unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
  labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), medications: [],
  onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
  onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
  hasApiResponse: true, onboarding: { stage: 4 as const, reached: 4 as const, fullForm: true, aboutYouLow: true }, planBasis: { age: 66 }, grading: {},
}) as unknown as Parameters<typeof InputPanel>[0];

/** InputPanel over a form that takes its own edits, as HealthTool's does. */
function Panel({ start, unitSystem, settingsOpen = true }: { start: Partial<HealthInputs>; unitSystem: 'si' | 'conventional'; settingsOpen?: boolean }) {
  const [inputs, setInputs] = useState(start);
  const onChange = (field: keyof HealthInputs, value: unknown) => setInputs(prev => ({ ...prev, [field]: value }));
  return <InputPanel {...props(inputs, onChange, unitSystem, settingsOpen)}/>;
}

const q = (c: HTMLElement, sel: string) => c.querySelector<HTMLInputElement>(sel);
const done = (c: HTMLElement, key: string) => fireEvent.click(within(q(c, `[data-about="${key}"]`)!).getByRole('button', { name: 'Done' }));

it('US-02 AC11: feet typed with the inches left blank stay as typed after the Height row closes and opens again', () => {
  const { container: c } = render(<Panel start={{ sex: 'male', heightCm: 180, birthYear: 1960, birthMonth: 1 }} unitSystem="conventional"/>);
  fireEvent.click(q(c, '#about-height')!);
  fireEvent.change(q(c, '#heightInches')!, { target: { value: '' } });
  fireEvent.change(q(c, '#heightFeet')!, { target: { value: '5' } });
  expect(q(c, '#heightFeet')!.value).toBe('5');
  expect(q(c, '#heightInches')!.value).toBe('');

  done(c, 'height');
  expect(q(c, '[data-about="height"]')).toBeNull();
  expect(q(c, '#about-height .about-row-value')!.textContent).toBe(`5'0"`);

  fireEvent.click(q(c, '#about-height')!);
  // Still the blank the boxes were left with, not the 0 a fresh pair would read from the height.
  expect(q(c, '#heightFeet')!.value).toBe('5');
  expect(q(c, '#heightInches')!.value).toBe('');
});

it('US-62 AC12: a missing answer\'s row opens itself, stays open once answered, and Done closes it', () => {
  const { container: c } = render(<Panel start={{ heightCm: 180, birthYear: 1960, birthMonth: 1 }} unitSystem="si"/>);
  expect(q(c, '[data-about="sex"] [role="radio"]')).not.toBeNull(); // opened with no tap
  expect(q(c, '#about-sex')).toBeNull();
  expect(q(c, '[data-about="height"]')).toBeNull(); // an answered row stays a row

  fireEvent.click(within(q(c, '[data-about="sex"]')!).getByRole('radio', { name: 'Female' }));
  expect(q(c, '[data-about="sex"]')).not.toBeNull(); // answered, still open until Done

  done(c, 'sex');
  expect(q(c, '[data-about="sex"]')).toBeNull();
  expect(q(c, '#about-sex .about-row-value')!.textContent).toBe('Female');
});

it('US-62 AC12 (2026-11-10): on desktop a row opened by hand closes when the Settings sheet closes', () => {
  const start = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1 };
  const { container: c, rerender } = render(<Panel start={start} unitSystem="si"/>);
  fireEvent.click(q(c, '#about-height')!);
  expect(q(c, '[data-about="height"]')).not.toBeNull();

  rerender(<Panel start={start} unitSystem="si" settingsOpen={false}/>);
  expect(q(c, '#about-height, [data-about="height"]')).toBeNull(); // the sheet, and About you with it, is gone
  rerender(<Panel start={start} unitSystem="si"/>);
  expect(q(c, '[data-about="height"]')).toBeNull();
  expect(q(c, '#about-height')).not.toBeNull(); // back as a row
});
