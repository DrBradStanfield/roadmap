// @vitest-environment jsdom
/**
 * US-12 AC20: a lab result printed as a limit ("< 10", "> 60") reads with its
 * symbol wherever the widget shows it, is coloured only when its bound
 * decides the grade, and sits off every trend line as a hollow dot.
 * LDL "< 1.5" mmol/L does not decide (the 1.4 target lies inside it);
 * Lp(a) "< 10" nmol/L does (every cutoff is at or above 10).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { LIMIT_NOT_GRADED, type ApiMeasurement } from '@roadmap/health-core';
import { BloodTestTimeline } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import { BLOOD_ROWS, MetricRows, coreRow, pressureRow, type RowContext } from './MyDataRows';
import { NumericInputCell } from './NumericInputCell';
import type { ApiLabValue } from '../lib/api-types';

vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
afterEach(cleanup);

const row = (id: string, metricType: string, value: number, day: string, comparator?: ApiMeasurement['comparator']): ApiMeasurement =>
  ({ id, metricType, value, recordedAt: `${day}T00:00:00.000Z`, createdAt: `${day}T00:00:00.000Z`, source: 'lab_import', ...(comparator ? { comparator } : {}) }) as ApiMeasurement;

const history = [
  row('l1', 'ldl', 2.8, '2026-06-01'),
  row('l2', 'ldl', 1.5, '2026-07-01', '<'),
  row('l3', 'ldl', 2.6, '2026-08-01'),
  row('a1', 'lpa', 10, '2026-07-01', '<'),
];

function timeline() {
  const view = render(
    <BloodTestTimeline bloodTestHistory={history} unitSystem="si" unitOverrides={{}} onToggleFieldUnit={() => {}}
      onSaveBatch={vi.fn().mockResolvedValue(new Map())} onCorrectValue={vi.fn().mockResolvedValue('ok')} onDraftValue={() => {}}
      isSaving={false} grading={{ sex: 'male' }} hasApiResponse/>,
  );
  const rowOf = (label: string) => [...view.container.querySelectorAll('.bt-row')]
    .find(r => r.querySelector('.bt-name-label')?.textContent === label) as HTMLElement;
  const savedCell = (label: string, text: string) => [...rowOf(label).querySelectorAll<HTMLElement>('.bt-cell-clickable')]
    .find(c => c.querySelector('.bt-value-num')?.textContent === text)!;
  return { view, rowOf, savedCell };
}

describe('US-12 AC20: the blood-test grid', () => {
  it('shows each limit with its symbol and colours it only when the bound decides', () => {
    const { savedCell } = timeline();
    const ldl = savedCell('LDL Cholesterol', '< 1.5');
    expect(ldl).toBeTruthy();
    expect(ldl.querySelector('.bt-status-tick')!.className).toContain('bt-status-none');
    expect(ldl.getAttribute('title')).toContain(LIMIT_NOT_GRADED);
    expect(ldl.textContent).toContain(LIMIT_NOT_GRADED); // heard, as well as hovered
    const lpa = savedCell('Lp(a)', '< 10');
    expect(lpa).toBeTruthy();
    expect(lpa.querySelector('.bt-status-tick')!.className).toContain('bt-status-ok');
    expect(lpa.textContent).not.toContain(LIMIT_NOT_GRADED);
  });

  it('draws the limit as a hollow dot off the trend line', () => {
    const { rowOf } = timeline();
    const spark = rowOf('LDL Cholesterol').querySelector('.bt-cell-trend svg')!;
    expect(spark.querySelectorAll('circle.bt-spark-limit')).toHaveLength(1);
    expect(spark.querySelector('circle.bt-spark-limit')!.getAttribute('fill')).toBe('none');
    // The line joins the two exact values only: one move, one line segment.
    const line = spark.querySelectorAll('path')[1].getAttribute('d')!;
    expect(line.match(/[ML]/g)).toEqual(['M', 'L']);
  });

  it('opens the correction editor on the bound as a plain number', () => {
    const { savedCell, view } = timeline();
    fireEvent.click(savedCell('LDL Cholesterol', '< 1.5'));
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(input.value).toBe('1.5');
  });
});

describe('US-12 AC20: the additional lab rows', () => {
  it('shows a saved lab limit with its symbol', () => {
    const labs: ApiLabValue[] = [{
      id: 'v1', metricName: 'Made-up marker 7', value: 0.005, unit: 'U/L', referenceLow: 1, referenceHigh: 5,
      recordedAt: '2026-07-01T00:00:00.000Z', source: 'lab_import', createdAt: '2026-07-01T00:00:00.000Z', comparator: '<',
    }];
    const view = render(<AdditionalLabRows labValues={labs}/>);
    fireEvent.click(view.getByRole('button', { name: /Other tests/ }));
    // The bound as printed, not rounded to two places ("< 0.01" would be false).
    expect(view.container.querySelector('.bt-value-num')!.textContent).toBe('< 0.005');
  });
});

describe('US-12 AC20: the phone rows', () => {
  const ctx: RowContext = { grading: { sex: 'male' }, plan: null, unitOf: () => 'si' };
  const rowNamed = (container: HTMLElement, label: string) => [...container.querySelectorAll('.md-row')]
    .find(r => r.querySelector('.md-row-label')?.textContent === label) as HTMLElement;

  it('shows the latest and previous limit with their symbols, ungraded when undecided', () => {
    const rows = [row('l2', 'ldl', 1.5, '2026-07-01', '<'), row('l1', 'ldl', 2.8, '2026-06-01')];
    const view = render(<MetricRows rows={BLOOD_ROWS.map(m => coreRow(m, rows, ctx))} onOpen={() => {}}/>);
    const ldl = rowNamed(view.container, 'LDL Cholesterol');
    const latest = ldl.querySelector('.md-row-latest')!;
    expect(latest.textContent).toBe('< 1.5');
    expect(latest.className).toContain('md-status-none');
    expect(ldl.querySelector('.hr-sr-only')!.textContent).toContain(LIMIT_NOT_GRADED);
  });

  it('colours a decided limit, and its trend dot is hollow and off the line', () => {
    const today = new Date();
    const day = (ago: number) => new Date(today.getTime() - ago * 86_400_000).toISOString().slice(0, 10);
    const rows = [row('a0', 'lpa', 40, day(3)), row('a1', 'lpa', 10, day(1), '<')];
    const view = render(<MetricRows rows={BLOOD_ROWS.map(m => coreRow(m, rows, ctx))} onOpen={() => {}}/>);
    const lpa = rowNamed(view.container, 'Lp(a)');
    expect(lpa.querySelector('.md-row-latest')!.textContent).toBe('< 10');
    expect(lpa.querySelector('.md-row-latest')!.className).toContain('md-status-ok');
    expect(lpa.querySelector('.md-row-prev')!.textContent).toBe(' (40)');
    const dot = lpa.querySelector('circle.md-trend-limit')!;
    expect(dot.getAttribute('fill')).toBe('none');
    // One exact day: no line is drawn through the limit, and the exact day is a filled dot.
    expect(lpa.querySelectorAll('.md-row-trend path')).toHaveLength(0);
    expect([...lpa.querySelectorAll('.md-row-trend circle')].map(c => c.getAttribute('fill'))).toEqual(['#B2598C', 'none']);
  });
});

describe('US-12 AC20a: the phone blood pressure row', () => {
  const ctx: RowContext = { grading: { sex: 'male' }, plan: null, unitOf: () => 'si' };
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  /** Three days of pairs, the middle one with the given limits, and the BP row's trend dots' fills. */
  function bpDots(limits: { sys?: '<' | '>'; dia?: '<' | '>' }) {
    const rows = [
      row('s1', 'systolic_bp', 128, day(5)), row('d1', 'diastolic_bp', 82, day(5)),
      row('s2', 'systolic_bp', 125, day(3), limits.sys), row('d2', 'diastolic_bp', 78, day(3), limits.dia),
      row('s3', 'systolic_bp', 122, day(1)), row('d3', 'diastolic_bp', 79, day(1)),
    ];
    const view = render(<MetricRows rows={[pressureRow(rows, ctx)]} onOpen={() => {}}/>);
    const bp = [...view.container.querySelectorAll('.md-row')]
      .find(r => r.querySelector('.md-row-label')?.textContent === 'Blood Pressure') as HTMLElement;
    return {
      hollow: bp.querySelectorAll('circle.md-trend-limit').length,
      fills: [...bp.querySelectorAll('.md-row-trend circle')].map(c => c.getAttribute('fill')),
    };
  }

  it('draws a day whose systolic was printed as a limit hollow, as the desktop trend does', () => {
    expect(bpDots({ sys: '<' }).hollow).toBe(1);
  });

  it('draws a day whose diastolic alone was printed as a limit hollow too', () => {
    expect(bpDots({ dia: '>' }).hollow).toBe(1);
  });

  it('draws no hollow point when neither half was a limit', () => {
    const { hollow, fills } = bpDots({});
    expect(hollow).toBe(0);
    expect(fills).not.toContain('none');
  });
});

describe('US-12 AC20: an editable limit cell (the upload review)', () => {
  it('shows the symbol before the bound, graded only when it decides', () => {
    const view = render(<>
      <NumericInputCell metric="ldl" display="si" grading={{ sex: 'male' }} value="1.5" valueSI={1.5} comparator="<"
        onChange={() => {}} wrapperClass="a" ariaLabel="LDL"/>
      <NumericInputCell metric="lpa" display="si" grading={{ sex: 'male' }} value="10" valueSI={10} comparator="<"
        onChange={() => {}} wrapperClass="b" ariaLabel="Lp(a)"/>
    </>);
    const ldl = view.container.querySelector('.a')!;
    expect(ldl.querySelector('.bt-cell-limit')!.textContent).toBe('<');
    expect(ldl.querySelector('.bt-status-tick')!.className).toContain('bt-status-none');
    expect(ldl.getAttribute('title')).toBe(LIMIT_NOT_GRADED);
    const ldlInput = view.getByLabelText('LDL');
    const heard = ldlInput.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!.textContent);
    expect(heard).toEqual(['<', LIMIT_NOT_GRADED]);
    const lpa = view.container.querySelector('.b')!;
    expect(lpa.querySelector('.bt-status-tick')!.className).toContain('bt-status-ok');
  });
});
