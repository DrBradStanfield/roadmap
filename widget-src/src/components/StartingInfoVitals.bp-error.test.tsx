// @vitest-environment jsdom
/**
 * US-13 AC10, as NumericInputCell: a blood pressure input's range error
 * describes the input from the visible error text, never a title, which is
 * captured with the page. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { VITALS_DRAFT_KEY } from '../lib/storage';
import { a11yTextWithDigits } from '../testing/a11y-text';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

function renderVitals(vitalsHistory: ApiMeasurement[] = []) {
  return render(
    <StartingInfoVitals vitalsHistory={vitalsHistory} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={() => {}} formStage={3}
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

  it('one error for the pair (the day already holds a blood pressure): shown once, describing both inputs', () => {
    const now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-');
    const row = (id: string, metricType: string, value: number) =>
      ({ id, metricType, value, recordedAt: `${today}T00:00:00.000Z`, createdAt: `${today}T00:00:00.000Z`, status: 'active' as const });
    // A kept draft typed before today's reading was saved: its cell is taken (US-03 AC2).
    localStorage.setItem(VITALS_DRAFT_KEY, JSON.stringify({ draft: { values: { sys: '130' } }, backfills: {}, meta: {} }));
    const view = renderVitals([row('s', 'systolic_bp', 120), row('d', 'diastolic_bp', 80)]);
    const draft = view.container.querySelector('.bt-cell-draft .bt-vitals-bp-inputs')!;
    const shown = [...draft.parentElement!.querySelectorAll('.bt-input-error-text')].map(e => e.textContent!);
    expect(shown).toHaveLength(1);
    for (const input of draft.querySelectorAll('input')) {
      expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(shown[0]);
    }
  });
});
