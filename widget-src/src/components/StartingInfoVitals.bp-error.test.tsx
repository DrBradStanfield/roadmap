// @vitest-environment jsdom
/**
 * US-13 AC10, as NumericInputCell: a blood pressure input's range error
 * describes the input from the visible error text, never a title, which is
 * captured with the page. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

function renderVitals() {
  return render(
    <StartingInfoVitals vitalsHistory={[]} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={() => {}} formStage={3}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
}

const titles = (root: HTMLElement) => [...root.querySelectorAll('[title]')].map(el => el.getAttribute('title')!);

describe('US-13 AC10: a blood pressure error describes its input; it is not a title', () => {
  it.each([
    ['systolic', 'Systolic blood pressure', 'Diastolic blood pressure'],
    ['diastolic', 'Diastolic blood pressure', 'Systolic blood pressure'],
  ])('an out-of-range %s value', (_, name, other) => {
    const view = renderVitals();
    fireEvent.change(view.getByRole('textbox', { name }), { target: { value: '999' } });
    const error = view.container.querySelector('.bt-vitals-bp-inputs + .bt-cell-foot .bt-input-error-text')!.textContent!;
    const input = view.getByRole('textbox', { name, description: error });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('title')).toBeNull();
    // The other half has no error of its own and is not described by this one.
    expect(view.getByRole('textbox', { name: other }).getAttribute('aria-describedby')).toBeNull();
    expect(titles(view.container).filter(t => /\d/.test(t))).toEqual([]);
  });
});
