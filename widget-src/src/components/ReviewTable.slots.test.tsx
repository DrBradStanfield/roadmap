// @vitest-environment jsdom
/**
 * US-12 AC12, AC14: one reading per (test, day). When two readings in one
 * review land on the same slot, the report's own reading wins, then a dated
 * previous column's, then an undated one's, then file order. The loser is
 * hidden and counted in one notice, with no values in it, so what Save says
 * it will write is what it writes. Synthetic values, differing, in both
 * file orders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ApiMeasurement } from '@roadmap/health-core';
import { ReviewTable, type FileResult } from './ReviewTable';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T12:00:00Z')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const U = 'undated';
const v = (metric: string, valueSI: number, recordedAt?: string, displayUnit = 'mmol/L') =>
  ({ metric, valueSI, displayValue: valueSI, displayUnit, confidence: 'high' as const, ...(recordedAt ? { recordedAt } : {}) });
const file = (fileName: string, reportDate: string, values: FileResult['values'], additionalValues: FileResult['additionalValues'] = []): FileResult =>
  ({ fileName, reportDate, values, additionalValues });
const held = (id: string, metricType: string, value: number, day: string): ApiMeasurement =>
  ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z` });

function review(results: FileResult[], measurements: ApiMeasurement[] = []) {
  const onSave = vi.fn();
  const view = render(<ReviewTable grading={{}} results={results} history={{ measurements, labValues: [], documents: [] }}
    unitSystem="si" onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
  const save = () => view.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
  const pick = (day: string) => { for (const p of view.queryAllByLabelText('Choose the date of the previous results')) fireEvent.change(p, { target: { value: day } }); };
  const input = (value: string) => Array.from(view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')).find(i => i.value === value)!;
  const notice = () => view.queryByText(/not saved: another reading holds that test on that day/)?.textContent ?? null;
  const rows = (call = 0) => [...onSave.mock.calls[call][0].values.map((x: { metric: string; valueSI: number; recordedAt: string }) => `${x.metric}=${x.valueSI}@${x.recordedAt.slice(0, 10)}`),
    ...onSave.mock.calls[call][0].labValues.map((x: { name: string; value: number; recordedAt: string }) => `${x.name}=${x.value}@${x.recordedAt.slice(0, 10)}`)].sort();
  return { view, onSave, save, pick, input, notice, rows };
}

/** The value count Save's own label promises ("Save 2 Values + 1 Additional"). */
const promised = (save: HTMLButtonElement) => [...(save.textContent ?? '').matchAll(/(\d+) (?:Values?|Additional)/g)].reduce((n, m) => n + Number(m[1]), 0);

describe('US-12 AC14: one reading per (test, day), the loser counted, never silent', () => {
  for (const order of ['a first', 'b first'] as const) {
    const ordered = (a: FileResult, b: FileResult) => (order === 'a first' ? [a, b] : [b, a]);

    it(`two undated columns on one day, different values (${order}): the earlier file's saves, one notice, Save says what it writes`, () => {
      const a = file('a.docx', '2026-03-10', [v('hdl', 1.2, U)]);
      const b = file('b.docx', '2026-04-10', [v('hdl', 1.4, U)]);
      const t = review(ordered(a, b));
      t.pick('2025-09-02');
      expect(t.notice()).toBe('1 reading not saved: another reading holds that test on that day.');
      const label = promised(t.save());
      fireEvent.click(t.save());
      expect(t.rows()).toEqual([`hdl=${order === 'a first' ? 1.2 : 1.4}@2025-09-02`]);
      expect(t.onSave.mock.calls[0][0].values.length + t.onSave.mock.calls[0][0].labValues.length).toBe(label);
    });

    it(`an undated value picked onto another file's dated previous column (${order}): the dated one wins`, () => {
      const a = file('a.docx', '2026-03-10', [v('hdl', 1.2, U)]);
      const b = file('b.pdf', '2026-04-10', [v('ldl', 2.0), v('hdl', 1.4, '2025-09-02')]);
      const t = review(ordered(a, b));
      t.pick('2025-09-02');
      expect(t.notice()).toBe('1 reading not saved: another reading holds that test on that day.');
      const label = promised(t.save());
      fireEvent.click(t.save());
      expect(t.rows()).toEqual(['hdl=1.4@2025-09-02', 'ldl=2@2026-04-10']);
      expect(t.rows()).toHaveLength(label);
    });

    it(`lab rows too (${order}): two undated sodium readings on one day save once`, () => {
      const a = file('a.docx', '2026-03-10', [], [{ name: 'sodium', value: 139, unit: 'mmol/L', recordedAt: U }]);
      const b = file('b.docx', '2026-04-10', [], [{ name: 'Sodium', value: 141, unit: 'mmol/L', recordedAt: U }]);
      const t = review(ordered(a, b));
      t.pick('2025-09-02');
      expect(t.notice()).toBe('1 reading not saved: another reading holds that test on that day.');
      const label = promised(t.save());
      fireEvent.click(t.save());
      expect(t.rows()).toEqual([order === 'a first' ? 'sodium=139@2025-09-02' : 'Sodium=141@2025-09-02']);
      expect(t.rows()).toHaveLength(label);
    });
  }

  it('equal readings on one slot are one reading: no notice', () => {
    const t = review([file('a.docx', '2026-03-10', [v('hdl', 1.2, U)]), file('b.docx', '2026-04-10', [v('hdl', 1.2, U)])]);
    t.pick('2025-09-02');
    expect(t.notice()).toBeNull();
  });

  it('an edited value that loses its slot is counted, even when its extracted value matched the winner', () => {
    const t = review([file('b.pdf', '2025-09-02', [v('hdl', 1.2)]), file('a.docx', '2026-03-10', [v('hdl', 1.2, U)])]);
    fireEvent.change(t.view.container.querySelectorAll<HTMLInputElement>('.bt-cell-input input')[0], { target: { value: '1.5' } });
    expect(t.input('1.5')).toBeDefined();
    t.pick('2025-09-02');
    expect(t.notice()).toBe('1 reading not saved: another reading holds that test on that day.');
    fireEvent.click(t.save());
    expect(t.rows()).toEqual(['hdl=1.2@2025-09-02']);
  });

  it('BP held on the picked day shows as context in the undated column (US-13 AC3)', () => {
    const t = review([file('a.docx', '2026-03-10', [v('systolic_bp', 130, U, 'mmHg'), v('diastolic_bp', 85, U, 'mmHg')])],
      [held('hs', 'systolic_bp', 130, '2025-09-02'), held('hd', 'diastolic_bp', 80, '2025-09-02')]);
    t.pick('2025-09-02');
    const context = Array.from(t.view.container.querySelectorAll('.bt-cell-context .bt-value-num')).map(e => e.textContent);
    expect(context).toContain('130');
    // The differing diastolic is a conflict, Replace unticked.
    expect((t.view.getByRole('checkbox', { name: /Replace the saved diastolic_bp value/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(t.save());
    expect(t.onSave).toHaveBeenCalledTimes(0);
  });

  it('a Replace tick is cleared when the edit comes back to the saved value, and stays unticked after', () => {
    const t = review([file('a.docx', '2026-03-10', [v('hdl', 1.2, U)])], [held('H', 'hdl', 1.2, '2025-09-02')]);
    fireEvent.change(t.input('1.2'), { target: { value: '1.5' } });
    t.pick('2025-09-02');
    fireEvent.click(t.view.getByRole('checkbox', { name: /Replace the saved hdl value/ }));
    fireEvent.change(t.input('1.5'), { target: { value: '1.2' } });
    expect(t.view.queryByRole('checkbox', { name: /Replace the saved hdl value/ })).toBeNull();
    fireEvent.change(t.input('1.2'), { target: { value: '1.7' } });
    expect((t.view.getByRole('checkbox', { name: /Replace the saved hdl value/ }) as HTMLInputElement).checked).toBe(false);
  });

  it('the header names every limit: the printed month and the report day', () => {
    const t = review([file('a.docx', '2026-03-10', [{ ...v('hdl', 1.2, U), printedMonth: '2025-06' }])]);
    expect(t.view.container.querySelector('.bt-header-row')?.textContent).toContain('Pick a day in Jun 2025 before 10 Mar 2026');
  });
});
