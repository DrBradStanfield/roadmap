/**
 * US-31 AC6 / US-07 — "today" is the user's LOCAL calendar day, not UTC's.
 *
 * A New Zealander writing at 11am on 2 September is at 2026-09-01T23:00Z. If
 * "today" is the UTC day, the default date lands on yesterday and an explicit
 * `--date 2026-09-02` is refused as the future. Both are wrong, and both are
 * silent — the row simply sits on the wrong day.
 *
 * The timezone is pinned HERE rather than suite-wide, where it would hide
 * UTC-only assumptions everywhere. vitest.config runs the whole suite in the
 * `forks` pool: only a real child process picks up a `process.env.TZ`
 * assignment (a worker thread inherits a copy of the environment and never
 * re-reads the zone), so in the default pool this pin would do nothing.
 */
process.env.TZ = 'Pacific/Auckland';

import { describe, it, expect } from 'vitest';
import { appendLabValue, appendMeasurement } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

/** 2026-09-01T23:00Z is 2026-09-02, 11am, in Auckland. */
const NOW = '2026-09-01T23:00:00.000Z';
const LOCAL_TODAY = '2026-09-02';

function base(): RoadmapFile {
  return createEmptyFile({ deviceId: 'us31_local_day', now: NOW });
}

describe('US-31 AC6 — the default date is the local calendar day', () => {
  it('slots a measurement written "now" on the local day, not the UTC day', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.recordedAt).toBe(LOCAL_TODAY);
  });

  it('slots a lab value written "now" on the local day', () => {
    const result = appendLabValue(base(), { metricName: 'ferritin', value: 210, unit: 'ug/L', now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.recordedAt).toBe(LOCAL_TODAY);
  });
});

describe('US-07 — the future-date guard measures the future in local days', () => {
  it('accepts an explicit date equal to local today', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: LOCAL_TODAY, now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.recordedAt).toBe(LOCAL_TODAY);
  });

  it('still refuses local tomorrow', () => {
    const result = appendMeasurement(base(), { metricType: 'weight', value: 80, recordedAt: '2026-09-03', now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('future-date');
  });
});
