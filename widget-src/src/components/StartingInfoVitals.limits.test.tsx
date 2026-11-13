// @vitest-environment jsdom
/**
 * US-12 AC21 (Brad 2026-11-02, "grade only when certain"): the desktop vitals table reads a weight,
 * waist or blood pressure printed as a limit with its symbol, and grades it as the phone rows do:
 * only when certain, else no colour and the "Printed as a limit" note.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LIMIT_NOT_GRADED, type Comparator } from '@roadmap/health-core/lab-limits';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

const row = (id: string, metricType: string, value: number, comparator?: Comparator): ApiMeasurement => ({
  id, metricType, value, recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  ...(comparator ? { comparator } : {}),
} as ApiMeasurement);

/** A row's saved cell: its text, its grade and whether it says the note. 178 cm, ideal weight 73 kg, BP target 120/80. */
function cell(history: ApiMeasurement[], label: string, plan: { age?: number; idealBodyWeight?: number; heightCm: number } | null = { age: 50, idealBodyWeight: 73, heightCm: 178 }) {
  const view = render(
    <StartingInfoVitals vitalsHistory={history} unitSystem="si"
      onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={4}
      plan={plan} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
  const found = Array.from(view.container.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === label)!;
  const value = found.querySelector('.bt-cell-value')!;
  return {
    text: value.querySelector('.bt-value-num')?.textContent ?? value.querySelector('input, button, span')?.textContent,
    grade: /bt-status-(?!tick)(\w+)/.exec(value.querySelector('.bt-status-tick')?.className ?? '')?.[1],
    note: (value.textContent ?? '').includes(LIMIT_NOT_GRADED) || value.getAttribute('title') === LIMIT_NOT_GRADED,
  };
}

describe('US-12 AC21: the vitals table grades a limit only when certain', () => {
  it('blood pressure "< 125/78" reads with its symbol, has no colour and says the note', () => {
    expect(cell([row('s', 'systolic_bp', 125, '<'), row('d', 'diastolic_bp', 78)], 'Blood Pressure')).toEqual({ text: '< 125/78', grade: 'none', note: true });
  });

  it('blood pressure "> 160/< 90" is certainly high; an exact pair as before', () => {
    expect(cell([row('s', 'systolic_bp', 160, '>'), row('d', 'diastolic_bp', 90, '<')], 'Blood Pressure')).toEqual({ text: '> 160/< 90', grade: 'bad', note: false });
    expect(cell([row('s', 'systolic_bp', 125), row('d', 'diastolic_bp', 78)], 'Blood Pressure')).toEqual({ text: '125/78', grade: 'warn', note: false });
  });

  it('weight "> 73" reads with its symbol, has no colour and says the note; "> 90" is certainly red', () => {
    expect(cell([row('w', 'weight', 73, '>')], 'Weight')).toMatchObject({ grade: 'none', note: true });
    expect(cell([row('w', 'weight', 90, '>')], 'Weight')).toMatchObject({ grade: 'bad', note: false });
  });

  it('no plan: no colour and no note, as an exact value', () => {
    expect(cell([row('s', 'systolic_bp', 125, '<'), row('d', 'diastolic_bp', 78)], 'Blood Pressure', null)).toEqual({ text: '< 125/78', grade: 'none', note: false });
  });

  it('draws a limit hollow on the trend, off the line, as the phone rows do', () => {
    const view = render(
      <StartingInfoVitals vitalsHistory={[
        { ...row('w1', 'weight', 80), recordedAt: '2026-07-01T00:00:00.000Z' },
        { ...row('w2', 'weight', 85, '>'), recordedAt: '2026-08-01T00:00:00.000Z' },
        { ...row('w3', 'weight', 82), recordedAt: '2026-09-01T00:00:00.000Z' },
      ]} unitSystem="si" onSave={vi.fn()} onCorrectValue={vi.fn()} formStage={4}
        plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
    );
    const weight = Array.from(view.container.querySelectorAll('.bt-row')).find((r) => r.querySelector('.bt-name-label')?.textContent === 'Weight')!;
    expect(weight.querySelectorAll('.bt-cell-trend circle.bt-spark-limit')).toHaveLength(1);
  });
});
