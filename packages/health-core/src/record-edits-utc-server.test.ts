/**
 * US-31 AC11 / AC6 — a server in UTC must not refuse the day its user is in.
 *
 * The hosted MCP server runs on a Fly machine in UTC, and the day it would
 * call "today" is behind every user east of Greenwich. The connector states
 * the user's own calendar day on every write (`recordedAt` is required), so
 * the future check it passes in is the one thing a server CAN know: the latest
 * calendar day anywhere on Earth, UTC+14. Anything later has been reached by
 * nobody and is still refused — and a LOCAL writer (the CLI, the widget),
 * which passes no `latestDay`, keeps the strict local-day check.
 *
 * TZ is pinned here, not suite-wide, and vitest's `forks` pool is what makes a
 * `process.env.TZ` assignment take — a worker thread never re-reads the zone.
 */
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import { latestDayOnEarth } from './merge';
import { appendLabValue, appendMeasurement } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

/** 22:00 UTC on 2 September is 10am on 3 September in Auckland. */
const NOW = '2026-09-02T22:00:00.000Z';
const USERS_TODAY = '2026-09-03';

/** What the hosted server hands `record-edits`. */
const HOSTED = { now: NOW, latestDay: latestDayOnEarth(NOW) };
/** What the CLI and the stdio server hand it: nothing but the clock. */
const LOCAL = { now: NOW };

function base(): RoadmapFile {
  return createEmptyFile({ deviceId: 'us31_utc_server', now: NOW });
}

describe('US-31 AC11 — a UTC server accepts the day the user is living in', () => {
  it('takes a measurement dated the user’s today, a day ahead of the server’s', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: USERS_TODAY, ...HOSTED });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.recordedAt).toBe(USERS_TODAY);
  });

  it('takes a lab value on the same day', () => {
    const result = appendLabValue(base(), { metricName: 'ferritin', value: 210, unit: 'ug/L', recordedAt: USERS_TODAY, ...HOSTED });
    expect(result.ok).toBe(true);
  });

  it('still refuses a day nobody on Earth has reached', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: '2026-09-04', ...HOSTED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future-date');
  });

  it('leaves the shared primitive strict: a local writer refuses tomorrow', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: USERS_TODAY, ...LOCAL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future-date');
  });

  it('an invalid date is still an invalid date, not a future one', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: '2026-02-30', ...HOSTED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-date');
  });
});
