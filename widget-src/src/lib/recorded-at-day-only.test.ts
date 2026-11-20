/**
 * PR 1906 owner ruling 2026-11-20 (recordedAtDayOnly): an upload's rows now carry `recordedAt` as
 * `YYYY-MM-DD`, beside older rows' `YYYY-MM-DDT00:00:00.000Z`. The web's display path must show both
 * on the same calendar day in a zone east of Greenwich and one west of it: the value page and the saved
 * lines (`formatShortDate`), the charts (`chartTimestamp`), and the within-day order (`compareRecordedAt`).
 * Node reads a `process.env.TZ` assignment at once; each case checks the zone took.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { compareRecordedAt } from '@roadmap/health-core/measurement-history';
import { chartTimestamp, formatShortDate } from './constants';

const DAY = '2026-10-01';
const ISO = `${DAY}T00:00:00.000Z`;
const before = process.env.TZ;
afterAll(() => { process.env.TZ = before; });

describe('a day-only recordedAt reads as the same day as ISO midnight (owner ruling 2026-11-20)', () => {
  for (const [zone, offset] of [['Pacific/Auckland', -780], ['America/Los_Angeles', 420]] as const) {
    it(`in ${zone}`, () => {
      process.env.TZ = zone;
      expect(new Date(ISO).getTimezoneOffset()).toBe(offset);
      const shown = formatShortDate(DAY);
      expect(shown).toMatch(/\b1\b/);
      expect(shown).toMatch(/Oct/);
      expect(formatShortDate(ISO)).toBe(shown);
      expect(chartTimestamp(DAY)).toBe(chartTimestamp(ISO));
      expect(new Date(chartTimestamp(DAY)).getDate()).toBe(1);
      expect(compareRecordedAt(DAY, ISO)).toBe(0);
    });
  }
});
