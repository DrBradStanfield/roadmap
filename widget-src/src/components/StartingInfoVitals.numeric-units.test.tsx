// @vitest-environment jsdom
// US-02 AC4 / US-05: a unit switch must not conceal rejected numeric syntax.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { formatDisplayValue, type ApiMeasurement, type UnitSystem } from '@roadmap/health-core';
import type { Refused, SaveTask } from '../lib/matrix-save';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

const cases = [
  ['Weight', 'weight', 'draft', '80,4', 80.4],
  ['Weight', 'weight', 'backfill', '80,4', 80.4],
  ['Waist Circumference', 'waist', 'draft', '90,4', 90.4],
  ['Waist Circumference', 'waist', 'backfill', '90,4', 90.4],
] as const;

function vitalsCell(label: string, slot: 'draft' | 'backfill') {
  // A BP-only historical column leaves both scalar slots empty.
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
  const cell = row.querySelector<HTMLElement>(`.bt-cell-${slot}`)!;
  const input = cell.querySelector('input')!;
  const toggle = () => fireEvent.click(within(row).getByRole('button'));
  const save = async () => { await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); }); };
  return { cell, input, onSave, toggle, save };
}

describe('vitals numeric syntax through row-unit changes', () => {
  it.each(cases)('%s %s %s keeps signed raw text and its error, and refuses Save after toggling', async (label, _metric, slot) => {
    const { cell, input, onSave, toggle, save } = vitalsCell(label, slot);
    fireEvent.paste(input, { clipboardData: { getData: () => '+80' } });
    expect(input.value).toBe('+80');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(within(cell).getByText('Type one decimal number, without signs, < > or spaces')).toBeTruthy();
    await save();
    expect(onSave).not.toHaveBeenCalled();

    toggle(); // kg → lbs / cm → in, using the real row control
    await save();
    expect(onSave).not.toHaveBeenCalled();
    expect.soft(input.value).toBe('+80');
    expect.soft(input.getAttribute('aria-invalid')).toBe('true');
    expect.soft(within(cell).queryByText('Type one decimal number, without signs, < > or spaces')).not.toBeNull();
    toggle();
    expect(input.value).toBe('+80');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it.each(cases)('%s %s %s converts a decimal comma and saves the exact typed quantity', async (label, metric, slot, text, quantity) => {
    const { cell, input, onSave, toggle, save } = vitalsCell(label, slot);
    fireEvent.change(input, { target: { value: text } });
    toggle();
    expect(input.value).toBe(formatDisplayValue(metric, quantity, 'conventional'));
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(within(cell).queryByText('Type one decimal number, without signs, < > or spaces')).toBeNull();
    toggle();
    expect(input.value).toBe(text);
    toggle();
    await save();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual([
      expect.objectContaining({ values: { [metric]: quantity }, unit: 'si',
        ...(slot === 'backfill' ? { date: '2026-09-01' } : {}) }),
    ]);
    expect(input.value).toBe('');
  });
});
