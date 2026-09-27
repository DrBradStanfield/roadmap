// @vitest-environment jsdom
/**
 * US-06 AC5, US-07 AC5: the waist's "Target: <X" label follows the plan's
 * rule, and its colour is the plan's grade. The cell shows the plain value,
 * the number a typed value is compared against (US-03 AC3), so a waist within
 * one display step of the line can read on the other side of the label:
 * 88.1 cm at 178 cm tall is healthy (ratio 0.49) but reads 34.7 in, beside
 * "<34.7 in".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ApiMeasurement, UnitSystem } from '@roadmap/health-core';
import { StartingInfoVitals } from './StartingInfoVitals';

afterEach(() => { cleanup(); localStorage.clear(); });

/** The waist row's label, its saved value and that value's status, 178 cm tall. */
function waistRow(cm: number, unit: UnitSystem) {
  const history: ApiMeasurement[] = [{
    id: 'w1', metricType: 'waist', value: cm, recordedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', status: 'active',
  }];
  const view = render(
    <StartingInfoVitals inputs={{ sex: 'male', heightCm: 178 }} vitalsHistory={history} unitSystem={unit}
      onSave={vi.fn()} onCorrectValue={vi.fn()} onDraftValue={() => {}} formStage={3}
      plan={{ age: 50, idealBodyWeight: 73, heightCm: 178 }} unitOverrides={{}} onToggleFieldUnit={() => {}}/>,
  );
  const row = Array.from(view.container.querySelectorAll('.bt-row'))
    .find((r) => r.querySelector('.bt-name-label')?.textContent === 'Waist Circumference')!;
  return [
    row.querySelector('.bt-ref-label')?.textContent,
    row.querySelector('.bt-cell-value .bt-value-num')?.textContent,
    row.querySelector('.bt-cell-value .bt-status-tick')?.className,
  ];
}

describe('US-06 AC5: the waist shows its plain value, coloured by the plan\'s grade', () => {
  it.each([
    [88.1, 'conventional', ['Target: <34.7 in', '34.7', 'bt-status-tick bt-status-ok']],
    [88.11, 'conventional', ['Target: <34.7 in', '34.7', 'bt-status-tick bt-status-warn']],
    [88, 'si', ['Target: <89 cm', '88', 'bt-status-tick bt-status-ok']],
    [88.4, 'si', ['Target: <89 cm', '88', 'bt-status-tick bt-status-warn']], // ratio 0.4966 rounds to 0.50
    [90, 'conventional', ['Target: <34.7 in', '35.4', 'bt-status-tick bt-status-warn']],
  ] as const)('%s cm shown in %s', (cm, unit, expected) => {
    expect(waistRow(cm, unit)).toEqual(expected);
  });
});
