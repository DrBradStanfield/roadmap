// @vitest-environment jsdom
/**
 * US-62 AC28 (H108): a row's value stays inside its fixed 104px value track. "126/80 (132/84)"
 * is 106.8px in real WebKit and "142/100 (150/104)" 124px, so on one line they ran into the gap
 * before the trend. The value may now break at the one space before the previous value, which
 * then sits whole on the line below; the latest value and the bracketed previous one never break.
 * jsdom has no layout, so this pins the structure and the CSS that make it fit; real WebKit is
 * the proof (PR body).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MetricRows, type RowModel } from './MyDataRows';
import { cascaded } from '../testing/css-cascade';

afterEach(cleanup);

const bp: RowModel = {
  subject: { kind: 'bp' }, label: 'Blood Pressure', target: 'Target <130/80', day: '2026-05-10',
  latest: '142/100', previous: '150/104', unit: 'mmHg', trend: [150, 142], tint: '#e5484d', status: 'bad', graded: 'blood_pressure',
};

describe('US-62 AC28 (H108): a value with its previous one fits the fixed value track', () => {
  it('breaks only at the space between the latest value and its bracketed previous one', () => {
    const { container } = render(<MetricRows rows={[bp]} onOpen={() => {}}/>);
    const value = container.querySelector('.md-row-value')!;
    expect(value.textContent).toBe('142/100 (150/104)');
    const [latest, gap, prev] = [...value.childNodes];
    expect(latest.textContent).toBe('142/100');
    expect(gap.nodeType).toBe(Node.TEXT_NODE); // the space belongs to the wrapping parent, not a nowrap span
    expect(gap.textContent).toBe(' ');
    expect((prev as Element).className).toBe('md-row-prev');
    expect(prev.textContent).toBe('(150/104)');
    for (const width of [375, 390, 1440]) {
      expect(cascaded(value, 'white-space', width)).toBe('normal'); // set, so a theme's nowrap button cannot undo it
      expect(cascaded(latest as Element, 'white-space', width)).toBe('nowrap');
      expect(cascaded(prev as Element, 'white-space', width)).toBe('nowrap');
    }
  });

  it('keeps the value track fixed at 104px (AC28)', () => {
    const { container } = render(<MetricRows rows={[bp]} onOpen={() => {}}/>);
    const row = container.querySelector('.md-row')!;
    expect(cascaded(row, 'grid-template-columns', 389)).toBe('minmax(0, 1fr) 44px 104px');
    expect(cascaded(row, 'grid-template-columns', 390)).toBe('minmax(0, 1fr) 56px 104px');
  });
});
