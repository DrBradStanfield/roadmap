/**
 * US-06 AC16: a screening date is one select of whole months, grouped by year. A past date
 * lists the newest month first, a future one the earliest; neither offers a month on the
 * wrong side of today, and a stored month outside the range shows as stored.
 */
import { describe, expect, it } from 'vitest';
import { monthOptions } from './month-options';

const TODAY = '2026-11-12';
const values = (r: ReturnType<typeof monthOptions>) => r.groups.flatMap(g => g.options.map(o => o.value));

describe('US-06 AC16: monthOptions', () => {
  it.each([
    // when, first, last, count, years
    ['past', '2026-11', '2016-01', 131, ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016']],
    ['future', '2026-11', '2031-12', 62, ['2026', '2027', '2028', '2029', '2030', '2031']],
  ] as const)('%s: %s to %s, %i months', (when, first, last, count, years) => {
    const r = monthOptions({ when, today: TODAY });
    const vs = values(r);
    expect([vs[0], vs.at(-1), vs.length]).toEqual([first, last, count]);
    expect(r.groups.map(g => g.year)).toEqual(years);
    expect(r.extra).toBeUndefined();
  });

  it('past: never a month after today; months newest first inside each year', () => {
    const r = monthOptions({ when: 'past', today: TODAY });
    expect(values(r).every(v => v <= '2026-11')).toBe(true);
    expect(r.groups[0].options.map(o => o.label).slice(0, 3)).toEqual(['November 2026', 'October 2026', 'September 2026']);
    expect(r.groups[1].options.map(o => o.value)).toEqual(['12', '11', '10', '09', '08', '07', '06', '05', '04', '03', '02', '01'].map(m => `2025-${m}`));
  });

  it('future: never a month before today; months earliest first inside each year', () => {
    const r = monthOptions({ when: 'future', today: TODAY });
    expect(values(r).every(v => v >= '2026-11')).toBe(true);
    expect(r.groups[0].options.map(o => o.label)).toEqual(['November 2026', 'December 2026']);
    expect(r.groups[1].options.map(o => o.value)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map(m => `2027-${m}`));
  });

  it.each([
    // stored, when, extra
    ['2010-03', 'past', { value: '2010-03', label: 'March 2010' }],
    ['2027-01', 'past', { value: '2027-01', label: 'January 2027' }],
    ['2025-01', 'future', { value: '2025-01', label: 'January 2025' }],
    ['2024-03-15', 'past', { value: '2024-03-15', label: '15 March 2024' }],
    ['2024-03-05', 'future', { value: '2024-03-05', label: '5 March 2024' }],
    ['2024-03-32', 'past', { value: '2024-03-32', label: '2024-03-32' }],
    ['2024-3-15', 'past', { value: '2024-3-15', label: '2024-3-15' }],
    ['2019', 'past', { value: '2019', label: '2019' }],
    ['2024-05', 'past', undefined],
    ['', 'past', undefined],
  ] as const)('stored %s on a %s date: one extra option, exactly as stored', (stored, when, extra) => {
    const r = monthOptions({ when, today: TODAY, stored });
    expect(r.extra).toEqual(extra);
    expect(values(r)).not.toContain(extra ? stored : '__none__');
  });
});

// US-07 AC1j: `min` (the form field's, YYYY-MM) removes every month before it. A stored month before it still
// shows as the extra option, exactly as stored; nothing rewrites it.
describe('US-07 AC1j: monthOptions with min', () => {
  it.each([
    // when, min, first, last, count
    ['past', '2025-11', '2026-11', '2025-11', 13],
    ['past', '2026-11', '2026-11', '2026-11', 1],
    ['past', '2010-01', '2026-11', '2016-01', 131],
    ['future', '2027-03', '2027-03', '2031-12', 58],
  ] as const)('%s with min %s: %s to %s, %i months', (when, min, first, last, count) => {
    const vs = values(monthOptions({ when, today: TODAY, min }));
    expect([vs[0], vs.at(-1), vs.length]).toEqual([first, last, count]);
    expect(vs.every(v => v >= min)).toBe(true);
  });

  it.each([
    // stored, min, extra
    ['2025-06', '2025-11', { value: '2025-06', label: 'June 2025' }],
    ['2025-11', '2025-11', undefined],
    ['2026-02', '2025-11', undefined],
    ['', '2025-11', undefined],
  ] as const)('stored %s with min %s: a month before min is the extra option, exactly as stored', (stored, min, extra) => {
    const r = monthOptions({ when: 'past', today: TODAY, stored, min });
    expect(r.extra).toEqual(extra);
    expect(values(r).every(v => v >= min)).toBe(true);
  });

  it("'' or no min leaves the list whole", () => {
    expect(values(monthOptions({ when: 'past', today: TODAY, min: '' }))).toEqual(values(monthOptions({ when: 'past', today: TODAY })));
  });
});
