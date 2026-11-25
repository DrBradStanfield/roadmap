// @vitest-environment jsdom
/**
 * US-62 AC13 (PR 1579 F3): at stage 1 the vitals grid's New weight cell
 * pulses for attention. Since a draft no longer drives the plan (US-03 AC6),
 * the stage stays 1 while a weight is typed, so the pulse reads the cell's
 * own text: a valid typed weight stops it, an invalid one does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('US-62 AC13: the New weight cell pulses until it holds a valid weight', () => {
  it('stage 1: pulses empty, stops for a valid typed weight, pulses again for one out of range', () => {
    const view = render(
      <StartingInfoVitals vitalsHistory={[]} unitSystem="si" onSave={vi.fn()} formStage={1}
        plan={null} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
    );
    const input = Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight')!
      .querySelector('.bt-cell-draft input') as HTMLInputElement;
    const pulses = () => !!input.closest('.field-attention');
    expect(pulses()).toBe(true);
    fireEvent.change(input, { target: { value: '84.5' } });
    expect(pulses()).toBe(false); // typed and valid, though not yet saved
    fireEvent.change(input, { target: { value: '4' } });
    expect(pulses()).toBe(true); // below the weight range
  });
});
