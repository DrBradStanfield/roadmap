// Weekly PR cycle time for the product-health loop (docs/loops/product-health/LOOP.md, GitHub source).
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleTime, toRows, isoWeekLabel, median, p90, main, fetchWithGh } from './pr-cycle-time.mjs';

const H = 3_600_000;
// Window end: Monday 2026-11-16 00:00Z, so the current window is ISO week 2026-W46.
const END = Date.parse('2026-11-16T00:00:00Z');
const human = { login: 'someone', is_bot: false };
let n = 0;
/** A PR merged `mergedHoursBeforeEnd` before END that was open `openHours`. */
const pr = (mergedHoursBeforeEnd: number, openHours: number, extra: Record<string, unknown> = {}) => {
  const merged = END - mergedHoursBeforeEnd * H;
  return {
    number: ++n,
    title: 'A change',
    createdAt: new Date(merged - openHours * H).toISOString(),
    mergedAt: new Date(merged).toISOString(),
    author: human,
    ...extra,
  };
};

describe('isoWeekLabel', () => {
  it('labels the week the window ends in, across a year boundary too', () => {
    expect(isoWeekLabel(END - 1)).toBe('2026-W46');
    expect(isoWeekLabel(Date.parse('2026-11-14T20:47:00Z'))).toBe('2026-W46');
    expect(isoWeekLabel(Date.parse('2021-01-03T12:00:00Z'))).toBe('2020-W53');
  });
});

describe('median and p90', () => {
  it('give the middle value, the mean of the middle two, and nearest-rank p90', () => {
    expect(median([1, 2, 9])).toBe(2);
    expect(median([1, 2, 4, 9])).toBe(3);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(10);
    expect(p90([5])).toBe(5);
  });
});

describe('cycleTime windows', () => {
  it('counts a merge at the window start, not one at the window end', () => {
    const r = cycleTime([pr(7 * 24, 1), pr(0, 1), pr(7 * 24 + 0.01, 2)], END);
    expect(r.current.merged).toBe(1);
    expect(r.prior.merged).toBe(1);
    expect(r.prior.medianH).toBe(2);
  });

  it('gives median and p90 hours on known inputs', () => {
    const prs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].map((h, i) => pr(i + 1, h));
    const r = cycleTime(prs, END);
    expect(r.week).toBe('2026-W46');
    expect(r.current).toMatchObject({ merged: 10, medianH: 5.5, p90H: 9, over7d: 0, maxH: 100 });
  });

  it('keeps long-lived PRs in the stats and counts them', () => {
    const r = cycleTime([pr(1, 2), pr(2, 8 * 24)], END);
    expect(r.current).toMatchObject({ merged: 2, over7d: 1, maxH: 192, medianH: 97 });
  });

  it('leaves out bot authors and generated engine-release PRs, and counts them', () => {
    const r = cycleTime([
      pr(1, 3),
      pr(2, 50, { author: { login: 'dependabot[bot]' } }),
      pr(3, 50, { author: { login: 'x', is_bot: true } }),
      pr(4, 50, { title: 'Engine release 202611111916 (minAppBuild 11)' }),
      pr(5, 4, { title: 'Engine release: a waiting sign approval no longer blocks later releases' }),
    ], END);
    expect(r.current).toMatchObject({ merged: 2, excluded: 3, medianH: 3.5 });
  });

  it('reads the REST/MCP shape as well as gh', () => {
    const rest = { number: 1, title: 't', created_at: '2026-11-15T00:00:00Z', merged_at: '2026-11-15T06:00:00Z', user: { login: 'a', type: 'User' } };
    const bot = { ...rest, number: 2, user: { login: 'b', type: 'Bot' } };
    expect(cycleTime([rest, bot], END).current).toMatchObject({ merged: 1, excluded: 1, medianH: 6 });
  });
});

describe('toRows (metrics.csv format)', () => {
  it('writes three rows with the prior week and a whole-number delta', () => {
    const prs = [pr(1, 10), pr(2, 20), pr(7 * 24 + 1, 10), pr(7 * 24 + 2, 10)];
    const rows = toRows(cycleTime(prs, END));
    expect(rows[0]).toMatch(/^2026-W46,prs_merged,2,2,0,github,"/);
    expect(rows[1]).toMatch(/^2026-W46,pr_cycle_time_median_h,15,10,50,github,"0 open >7d, longest 20h"$/);
    expect(rows[2]).toMatch(/^2026-W46,pr_cycle_time_p90_h,20,10,100,github,/);
  });

  it('keeps an empty week as zero rows, with a blank delta when the prior week was empty too', () => {
    const rows = toRows(cycleTime([], END));
    expect(rows).toEqual([
      '2026-W46,prs_merged,0,0,,github,"opened->merged, PRs merged in the 7d window; 0 bot/engine-release PRs left out"',
      '2026-W46,pr_cycle_time_median_h,0,0,,github,"no merged PRs; 0 open >7d, longest 0h"',
      '2026-W46,pr_cycle_time_p90_h,0,0,,github,"no merged PRs; nearest-rank p90; 0 open >7d, longest 0h"',
    ]);
  });

  it('gives -100 when the week empties after a busy prior week', () => {
    const rows = toRows(cycleTime([pr(7 * 24 + 1, 4)], END));
    expect(rows[0]).toMatch(/^2026-W46,prs_merged,0,1,-100,/);
  });
});

describe('main', () => {
  it('reads a JSON file and windows on --end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-cycle-'));
    const file = join(dir, 'prs.json');
    writeFileSync(file, JSON.stringify([pr(1, 5)]));
    const out = main(['--file', file, '--end', '2026-11-16T00:00:00Z']);
    expect(out.split('\n')[1]).toMatch(/^2026-W46,pr_cycle_time_median_h,5,0,,/);
  });

  it('asks gh once per window with margin, dedupes the overlap, and refuses a result at the 1000-result search cap', () => {
    const calls: string[][] = [];
    const overlap = pr(7 * 24, 3);
    const got = fetchWithGh(END, (_cmd: string, a: string[]) => {
      calls.push(a);
      return JSON.stringify(calls.length === 1 ? [pr(1, 1), overlap] : [overlap, pr(8 * 24, 2)]);
    });
    expect(calls.map((a) => a[a.indexOf('--search') + 1])).toEqual(['merged:2026-11-08..2026-11-17', 'merged:2026-11-01..2026-11-10']);
    expect(calls[0]).toContain('1000');
    expect(got).toHaveLength(3);
    expect(got.filter((p) => p.number === overlap.number)).toHaveLength(1);
    const full = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ number: i })));
    expect(() => fetchWithGh(END, () => full)).toThrow(/search cap/);
    const r = cycleTime(fetchWithGh(END, () => JSON.stringify(Array.from({ length: 999 }, (_, i) => pr(1, 1, { number: 10_000 + i })))), END);
    expect(r.current.merged).toBe(999);
  });

  it('refuses a bad --end', () => {
    expect(() => main(['--end', 'soon'], { fetch: () => [] })).toThrow(/Bad --end/);
  });
});
