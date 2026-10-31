// @vitest-environment jsdom
/**
 * US-05 AC2a: after a unit toggle, a vitals cell's shown error must agree with
 * whether the commit saves it.
 *
 * The cell shows the typed quantity re-expressed and rounded in the new unit,
 * and NumericInputCell validates that rounded text in the new unit, while the
 * commit (vitalsCellsOf) validates the original text in the unit it was typed
 * in. Near a range end the two disagree:
 *   - 19.9 kg → toggle to lbs shows "44" (dp 0), valid in lbs, but the commit
 *     refuses 19.9 kg (min 20): no error shown, nothing saved.
 *   - 79 in → toggle to cm shows "201" with "Max 200 cm", but the commit
 *     accepted 79 in (then the inch maximum) and saved 200.66 cm. Since
 *     US-05 AC2b the inch maximum is 78.7 (200 cm rounded inward), so 79 in
 *     is refused and shows an error in either unit.
 * The assertion is fix-agnostic: an error is shown exactly when nothing saves.
 * Harness copied from StartingInfoVitals.numeric-units.test.tsx. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import type { ApiMeasurement, UnitSystem } from '@roadmap/health-core';
import type { Refused, SaveTask } from '../lib/matrix-save';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

function vitalsDraftCell(label: string, backfill = false) {
  const history: ApiMeasurement[] = [{
    id: 'sys1', metricType: 'systolic_bp', value: 120,
    recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const onSave = vi.fn<(tasks: SaveTask[]) => Promise<Refused>>().mockResolvedValue(new Map());
  function Page() {
    const [overrides, setOverrides] = useState<Record<string, UnitSystem>>({});
    return <StartingInfoVitals vitalsHistory={history} unitSystem="si"
      onSave={onSave} onDraftValue={() => {}} formStage={4} plan={null}
      unitOverrides={overrides}
      onToggleFieldUnit={field => setOverrides(o => ({
        ...o, [field]: o[field] === 'conventional' ? 'si' : 'conventional',
      }))}/>;
  }
  const view = render(<Page/>);
  const row = Array.from(view.container.querySelectorAll<HTMLElement>('.bt-row'))
    .find(r => r.querySelector('.bt-name-label')?.textContent === label)!;
  const input = row.querySelector<HTMLElement>(backfill ? '.bt-cell-backfill' : '.bt-cell-draft')!.querySelector('input')!;
  const toggle = () => fireEvent.click(within(row).getByRole('button'));
  const save = async () => { await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); }); };
  return { input, onSave, toggle, save };
}

describe('US-05 AC2a: the shown error agrees with the save after a unit toggle', () => {
  it('weight 19.9 kg shown in lbs', async () => {
    const { input, onSave, toggle, save } = vitalsDraftCell('Weight');
    fireEvent.change(input, { target: { value: '19.9' } }); // typed in kg (below 20)
    toggle(); // kg → lbs: shows 43.87 rounded to "44"
    const shownError = input.getAttribute('aria-invalid') === 'true';
    await save();
    expect(shownError).toBe(onSave.mock.calls.length === 0);
  });

  it('waist 79 in shown in cm', async () => {
    const { input, onSave, toggle, save } = vitalsDraftCell('Waist Circumference');
    toggle(); // cm → in
    fireEvent.change(input, { target: { value: '79' } }); // typed in inches (max 79)
    toggle(); // in → cm: shows 200.66 rounded to "201", over 200
    const shownError = input.getAttribute('aria-invalid') === 'true';
    await save();
    expect(shownError).toBe(onSave.mock.calls.length === 0);
  });

  // Every direction, at the end where the rounded display crosses the bound.
  // `typedFirstToggled`: toggle once before typing, so the value is typed in
  // the other unit; then toggle to show it in the first.
  it.each([
    { label: 'Weight', typedFirstToggled: false, typed: '19.9', shows: '44', error: true }, // kg → lbs
    { label: 'Weight', typedFirstToggled: true, typed: '661.4', shows: '300.0', error: true }, // lbs → kg
    { label: 'Waist Circumference', typedFirstToggled: false, typed: '40', shows: '15.7', error: false }, // cm → in
    { label: 'Waist Circumference', typedFirstToggled: true, typed: '15.9', shows: '40', error: true }, // in → cm
    { label: 'Waist Circumference', typedFirstToggled: true, typed: '79', shows: '201', error: true }, // in → cm, over 78.7 in (US-05 AC2b)
    { label: 'Waist Circumference', typedFirstToggled: true, typed: '78.7', shows: '200', error: false }, // in → cm, the inch maximum
  ])('$label typed $typed, shown as $shows: error $error, saved exactly when no error', async ({ label, typedFirstToggled, typed, shows, error }) => {
    const { input, onSave, toggle, save } = vitalsDraftCell(label);
    if (typedFirstToggled) toggle();
    fireEvent.change(input, { target: { value: typed } });
    toggle();
    expect(input.value).toBe(shows);
    expect(input.getAttribute('aria-invalid')).toBe(String(error));
    await save();
    expect(onSave).toHaveBeenCalledTimes(error ? 0 : 1);
  });

  it('78.7 in, the inch maximum, is saved as 199.90 cm, inside the record\'s 200 (US-05 AC2b)', async () => {
    const { input, onSave, toggle, save } = vitalsDraftCell('Waist Circumference');
    toggle();
    fireEvent.change(input, { target: { value: '78.7' } });
    toggle();
    await save();
    const task = onSave.mock.calls[0][0][0];
    expect(Object.values(task.values)[0]).toBeCloseTo(199.898, 2);
  });

  it('the same holds in a saved column\'s empty cell (backfill)', async () => {
    const { input, onSave, toggle, save } = vitalsDraftCell('Weight', true);
    fireEvent.change(input, { target: { value: '19.9' } });
    toggle();
    const shownError = input.getAttribute('aria-invalid') === 'true';
    await save();
    expect(shownError).toBe(onSave.mock.calls.length === 0);
  });

  it('the error names the unit the value was typed in', () => {
    const { input, toggle } = vitalsDraftCell('Weight');
    fireEvent.change(input, { target: { value: '19.9' } });
    toggle();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby')!;
    expect(document.getElementById(errorId)?.textContent).toMatch(/kg/);
  });

  it('control: a mid-range value toggled shows no error and saves', async () => {
    const { input, onSave, toggle, save } = vitalsDraftCell('Weight');
    fireEvent.change(input, { target: { value: '80' } });
    toggle();
    expect(input.getAttribute('aria-invalid')).toBe('false');
    await save();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('control: an out-of-range value with no toggle still shows its error and does not save', async () => {
    const { input, onSave, save } = vitalsDraftCell('Weight');
    fireEvent.change(input, { target: { value: '19.9' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await save();
    expect(onSave).not.toHaveBeenCalled();
  });
});
