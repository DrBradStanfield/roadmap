// @vitest-environment jsdom
/**
 * US-04 AC1 (adversary R5): a saved-value editor closes late, after its
 * 150 ms click-away timer. Its close cleared whichever cell was marked
 * active by then, so the draft cell the user had moved to lost its
 * highlight. A closing cell clears only its own mark, as the blood-test
 * matrix's cells do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState, type MutableRefObject } from 'react';
import type { ApiMeasurement, UnitSystem } from '@roadmap/health-core';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { press, pressMouse, pressWithoutFocus, releaseMouse } from '../testing/matrix-gestures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

describe('US-04 AC1: a vitals editor that closes late leaves the next cell marked active', () => {
  it('weight editor opened, then the draft weight cell pressed: the draft cell keeps its highlight after the editor closes', async () => {
    const history: ApiMeasurement[] = [{
      id: 'w1', metricType: 'weight', value: 82, recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
    }];
    const onCorrectValue = vi.fn().mockResolvedValue('ok');
    const view = render(
      <StartingInfoVitals vitalsHistory={history} unitSystem="si"
        onSave={vi.fn()} onCorrectValue={onCorrectValue} onDraftValue={() => {}} formStage={3}
        plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
    );
    const weight = Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
    fireEvent.click(weight.querySelector('.bt-cell-clickable')!);
    expect(weight.querySelector('.bt-cell-correcting input')).toBeTruthy();
    const draft = weight.querySelector('.bt-cell-draft input') as HTMLInputElement;
    press(draft); // the editor loses the focus: its click-away timer starts
    expect(draft.className).toContain('bt-input-active');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(weight.querySelector('.bt-cell-correcting')).toBeNull();
    expect(onCorrectValue).not.toHaveBeenCalled(); // the number was not changed
    expect(draft.className).toContain('bt-input-active');
  });
});

// Adversary R7: a draft or backfill cell losing the focus cleared whichever
// cell was marked active by then, so the chat's flash on another cell went too.
describe('US-04 AC1: a typed cell losing the focus clears only its own mark', () => {
  it('the chat\'s waist, flashed while the draft weight cell has the focus, keeps its highlight when the weight cell is left', () => {
    const prefillRef: MutableRefObject<VitalsPrefillFn | null> = { current: null };
    const view = render(
      <StartingInfoVitals vitalsHistory={[]} unitSystem="si"
        onSave={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={() => {}} formStage={3} prefillRef={prefillRef}
        plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
    );
    const draft = (label: string) => Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!.querySelector('.bt-cell-draft input') as HTMLInputElement;
    press(draft('Weight'));
    act(() => { prefillRef.current!('waist', 90, 'si', null); });
    expect(draft('Waist Circumference').className).toContain('bt-input-active');
    act(() => draft('Weight').blur());
    expect(draft('Waist Circumference').className).toContain('bt-input-active');
  });
});

// US-04 AC1 / US-05 AC2: a typed correction is saved only in the unit shown
// when it was typed. A press on the weight's kg-lb chip, held or not, writes
// nothing and says so, in the vitals' one live region.
describe('US-04 AC1 / US-05 AC2: a unit switch while correcting a weight', () => {
  const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';
  function weightEditor() {
    const history: ApiMeasurement[] = [{
      id: 'w1', metricType: 'weight', value: 82, recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
    }];
    const onCorrectValue = vi.fn().mockResolvedValue('ok');
    function Page() {
      const [overrides, setOverrides] = useState<Record<string, UnitSystem>>({});
      return (
        <StartingInfoVitals vitalsHistory={history} unitSystem="si"
          onSave={vi.fn()} onCorrectValue={onCorrectValue} onDraftValue={() => {}} formStage={3}
          plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={overrides}
          onToggleFieldUnit={(field) => setOverrides((o) => ({ ...o, [field]: o[field] === 'conventional' ? 'si' : 'conventional' }))}/>
      );
    }
    const view = render(<Page/>);
    const weight = () => Array.from(view.container.querySelectorAll('.bt-row'))
      .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight')! as HTMLElement;
    fireEvent.click(weight().querySelector('.bt-cell-clickable')!);
    const input = weight().querySelector('.bt-cell-correcting input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '85' } });
    const chip = () => weight().querySelector('.bt-unit-chip') as HTMLElement;
    const region = () => view.container.querySelector('.bt-vitals-card [role="status"].bt-cell-messages') as HTMLElement;
    return { view, weight, chip, region, onCorrectValue };
  }

  it('a slow press on the kg chip (held 200 ms) that takes no focus (Safari) writes nothing and says to choose the unit first, in the region too', async () => {
    const w = weightEditor();
    expect(w.region().tagName).toBe('P');
    expect(w.region().textContent).toBe('\u00a0'); // never empty: the theme may hide an empty p or div
    pressWithoutFocus(w.chip());
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    releaseMouse(w.chip());
    expect(w.chip().textContent).toBe('lbs');
    expect(w.weight().querySelector('.bt-cell-correcting')).toBeNull();
    expect(within(w.weight()).getByText(UNIT_FIRST)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(w.onCorrectValue).not.toHaveBeenCalled();
    expect(w.region().textContent).toBe(UNIT_FIRST);
  });

  it('a slow press on the kg chip (held 200 ms) that takes the focus (Chrome) writes nothing and says to choose the unit first', async () => {
    const w = weightEditor();
    pressMouse(w.chip());
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    releaseMouse(w.chip());
    expect(w.chip().textContent).toBe('lbs');
    expect(within(w.weight()).getByText(UNIT_FIRST)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(w.onCorrectValue).not.toHaveBeenCalled();
    expect(w.region().textContent).toBe(UNIT_FIRST);
  });

  // Codex R2 / adversary R3: a live region set to the text it already holds
  // changes nothing in the page, so the second message went unheard.
  it('the same message twice in a row is a fresh change each time: cleared, then said', async () => {
    const w = weightEditor();
    pressWithoutFocus(w.chip());
    releaseMouse(w.chip());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(w.region().textContent).toBe(UNIT_FIRST);
    fireEvent.click(w.weight().querySelector('.bt-cell-clickable')!);
    fireEvent.change(w.weight().querySelector('.bt-cell-correcting input')!, { target: { value: '190' } });
    pressWithoutFocus(w.chip());
    releaseMouse(w.chip());
    expect(w.region().textContent).toBe('\u00a0');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(w.region().textContent).toBe(UNIT_FIRST);
    expect(w.onCorrectValue).not.toHaveBeenCalled();
  });
});
