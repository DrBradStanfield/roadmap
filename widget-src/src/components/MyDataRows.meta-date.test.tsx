// @vitest-environment jsdom
/**
 * US-62 AC8a (H104): a row's "target · date" line breaks only at the "·". The month and year are
 * one unbreakable unit, so on a narrow phone the date moves whole to the next line and a year is
 * never left on a line of its own ("Target <130/80 · May" / "2026"). The words are unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MetricRows, type RowModel } from './MyDataRows';
import { cascaded } from '../testing/css-cascade';

afterEach(cleanup);

const bp: RowModel = {
  subject: { kind: 'bp' }, label: 'Blood Pressure', target: 'Target <130/80', day: '2026-05-10',
  latest: '126/80', previous: '132/84', unit: 'mmHg', trend: [132, 126], tint: '#e5484d', status: 'warn', graded: 'blood_pressure',
};

describe('US-62 AC8a (H104): the date in a row\'s line never breaks', () => {
  it('holds the month and year in one nowrap span after the target and its "·"', () => {
    const { container } = render(<MetricRows rows={[bp]} onOpen={() => {}}/>);
    const meta = container.querySelector('.md-row-meta')!;
    expect(meta.textContent).toBe('Target <130/80 · May 2026');
    const date = meta.querySelector('.md-row-date')!;
    expect(date.textContent).toBe('May 2026');
    expect(meta.firstChild!.textContent).toBe('Target <130/80 · ');
    for (const width of [375, 390, 1280]) expect(cascaded(date, 'white-space', width)).toBe('nowrap');
  });

  it('keeps a date alone and a target alone as they were', () => {
    const { container } = render(<MetricRows rows={[{ ...bp, target: null }, { ...bp, key: 'creatinine', label: 'Creatinine', day: null, latest: null }]} onOpen={() => {}}/>);
    const [dated, target] = [...container.querySelectorAll('.md-row-meta')];
    expect(dated.textContent).toBe('May 2026');
    expect(dated.querySelector('.md-row-date')!.textContent).toBe('May 2026');
    expect(target.textContent).toBe('Target <130/80');
    expect(target.querySelector('.md-row-date')).toBeNull();
  });
});
