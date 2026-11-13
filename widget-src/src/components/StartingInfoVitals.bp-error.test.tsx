// @vitest-environment jsdom
/**
 * US-13 AC10, as NumericInputCell: a blood pressure input's range error
 * describes the input from the visible error text, never a title, which is
 * captured with the page. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { noteDevicePage, VITALS_DRAFT_KEY } from '../lib/storage';
import { a11yTextWithDigits } from '../testing/a11y-text';
import { SAME_SLOT } from './BloodTestTimeline';
import { StartingInfoVitals } from './StartingInfoVitals';

// This page's record is open, on this device: the drafts and Lp(a) answers it keeps are its own (US-11 AC6).
noteDevicePage();

afterEach(() => { cleanup(); localStorage.clear(); });

function renderVitals(vitalsHistory: ApiMeasurement[] = []) {
  return render(
    <StartingInfoVitals vitalsHistory={vitalsHistory} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={4}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
}

const errors = (root: HTMLElement) => [...root.querySelectorAll('.bt-vitals-bp-inputs + .bt-cell-foot .bt-input-error-text')].map(e => e.textContent);

describe('US-13 AC10: a blood pressure error describes its input; it is not a title', () => {
  it.each([
    ['systolic', 'Systolic blood pressure', 'Diastolic blood pressure'],
    ['diastolic', 'Diastolic blood pressure', 'Systolic blood pressure'],
  ])('an out-of-range %s value', (_, name, other) => {
    const view = renderVitals();
    fireEvent.change(view.getByRole('textbox', { name }), { target: { value: '999' } });
    const [error] = errors(view.container);
    const input = view.getByRole('textbox', { name, description: error! });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('title')).toBeNull();
    // The other half has no error of its own and is not described by this one.
    expect(view.getByRole('textbox', { name: other }).getAttribute('aria-describedby')).toBeNull();
    expect(a11yTextWithDigits(view.container)).toEqual([]);
  });

  it('both halves out of range: both errors shown, each describing its own input', () => {
    const view = renderVitals();
    fireEvent.change(view.getByRole('textbox', { name: 'Systolic blood pressure' }), { target: { value: '999' } });
    fireEvent.change(view.getByRole('textbox', { name: 'Diastolic blood pressure' }), { target: { value: '999' } });
    expect(errors(view.container)).toEqual(['Max 250 mmHg', 'Max 150 mmHg']);
    expect(view.getByRole('textbox', { name: 'Systolic blood pressure', description: 'Max 250 mmHg' })).toBeTruthy();
    expect(view.getByRole('textbox', { name: 'Diastolic blood pressure', description: 'Max 150 mmHg' })).toBeTruthy();
    expect(a11yTextWithDigits(view.container)).toEqual([]);
  });

  /** A kept draft typed before today's reading was saved: its cell is taken, a clash (US-03 AC2). */
  function renderTaken(sys: string) {
    const now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-');
    const row = (id: string, metricType: string, value: number) =>
      ({ id, metricType, value, recordedAt: `${today}T00:00:00.000Z`, createdAt: `${today}T00:00:00.000Z`, status: 'active' as const });
    localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { sys } }, backfills: {}, meta: {} }));
    const view = renderVitals([row('s', 'systolic_bp', 120), row('d', 'diastolic_bp', 80)]);
    return { view, draft: view.container.querySelector('.bt-cell-draft .bt-vitals-bp-inputs')! };
  }

  it('one error for the pair (the day already holds a blood pressure): shown once, describing both inputs', () => {
    const { draft } = renderTaken('130');
    const shown = [...draft.parentElement!.querySelectorAll('.bt-input-error-text')].map(e => e.textContent!);
    expect(shown).toHaveLength(1);
    for (const input of draft.querySelectorAll('input')) {
      expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(shown[0]);
    }
  });

  it('a systolic range error and the clash: both shown, the clash describing both inputs', () => {
    const { view, draft } = renderTaken('999');
    const [range, clash] = [...draft.parentElement!.querySelectorAll('.bt-input-error-text')].map(e => e.textContent!);
    expect(range).toBe('Max 250 mmHg');
    expect(clash).toBe(SAME_SLOT);
    expect(view.getByRole('textbox', { name: 'Systolic blood pressure', description: `${range} ${clash}` })).toBeTruthy();
    expect(view.getByRole('textbox', { name: 'Diastolic blood pressure', description: clash })).toBeTruthy();
  });
});

describe('US-02 AC8: a blood pressure the wrong way up is the pair\'s error', () => {
  it('80/120 shows the rule once, describing both inputs', () => {
    const view = renderVitals();
    fireEvent.change(view.getByRole('textbox', { name: 'Systolic blood pressure' }), { target: { value: '80' } });
    fireEvent.change(view.getByRole('textbox', { name: 'Diastolic blood pressure' }), { target: { value: '120' } });
    const rule = 'The top number (systolic) must be higher than the bottom number (diastolic).';
    expect(errors(view.container)).toEqual([rule]);
    expect(view.getByRole('textbox', { name: 'Systolic blood pressure', description: rule })).toBeTruthy();
    expect(view.getByRole('textbox', { name: 'Diastolic blood pressure', description: rule })).toBeTruthy();
  });

  it('80/120 does not save (review R1)', () => {
    const onSave = vi.fn(async () => new Map());
    const view = render(
      <StartingInfoVitals vitalsHistory={[]} unitSystem="si"
        onSave={onSave} onCorrectValue={vi.fn()} formStage={4}
        plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
    );
    fireEvent.change(view.getByRole('textbox', { name: 'Systolic blood pressure' }), { target: { value: '80' } });
    const dia = view.getByRole('textbox', { name: 'Diastolic blood pressure' });
    fireEvent.change(dia, { target: { value: '120' } });
    fireEvent.keyDown(dia, { key: 'Enter' }); // the commit
    expect(onSave).not.toHaveBeenCalled();
    expect((dia as HTMLInputElement).value).toBe('120'); // kept, with the pair's error
  });
});


describe('US-02 AC9: a vitals range error waits while more digits could fix it', () => {
  const draftOf = (root: HTMLElement, name: string) => Array.from(root.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === name)!.querySelector('.bt-cell-draft input') as HTMLInputElement;
  const cellErrors = (root: HTMLElement) => [...root.querySelectorAll('.bt-input-error-text')].map(e => e.textContent);

  it('a waist of "4" (on the way to 40-something) says nothing until the cell is left', () => {
    const view = renderVitals();
    const waist = draftOf(view.container, 'Waist Circumference');
    act(() => waist.focus());
    fireEvent.change(waist, { target: { value: '4' } });
    expect(cellErrors(view.container)).toEqual([]);
    expect(waist.getAttribute('aria-invalid')).toBe('false');
    act(() => waist.blur());
    expect(cellErrors(view.container)).toEqual(['Min 40 cm']);
  });

  it('a waist of "3" can never fit and says so at once', () => {
    const view = renderVitals();
    const waist = draftOf(view.container, 'Waist Circumference');
    act(() => waist.focus());
    fireEvent.change(waist, { target: { value: '3' } });
    expect(cellErrors(view.container)).toEqual(['Min 40 cm']);
  });

  it('a systolic "6" (60 to 69 still fit) says nothing until left; Enter shows it', () => {
    const view = renderVitals();
    const sys = view.getByRole('textbox', { name: 'Systolic blood pressure' });
    act(() => sys.focus());
    fireEvent.change(sys, { target: { value: '6' } });
    expect(errors(view.container)).toEqual([]);
    fireEvent.keyDown(sys, { key: 'Enter' });
    expect(errors(view.container)).toEqual(['Min 60 mmHg']);
  });
});
