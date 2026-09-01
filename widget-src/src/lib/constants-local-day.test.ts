/**
 * US-07 — a stored day renders as the day it is filed under.
 *
 * `recordedAt` holds a calendar SLOT for anything the user dated:
 * `2026-09-02T00:00:00.000Z` means "2 September", not "midnight UTC". Read back
 * through the reader's own timezone it becomes 1 September in New York, so the
 * widget showed a value one day before the day dedup keys on. Real instants are
 * still moments and still render locally.
 *
 * The timezone is pinned per-file, never suite-wide; vitest.config routes
 * `*-local-day.test.ts` to the `forks` pool, because only a real child process
 * picks up a `process.env.TZ` assignment (a worker thread inherits a copy of
 * the environment and never re-reads the zone).
 */
process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { formatShortDate } from './constants';

describe('formatShortDate — west of Greenwich', () => {
  it('renders a stored day-shape as its own day, not the day before', () => {
    expect(formatShortDate('2026-09-02T00:00:00.000Z')).toBe('Sep 2, 2026');
  });

  it('renders a date-only string as that date', () => {
    expect(formatShortDate('2026-09-02')).toBe('Sep 2, 2026');
  });

  it('still renders a real instant in the reader’s own timezone', () => {
    // 09:00 in Auckland on 2 September is still 1 September in New York.
    expect(formatShortDate('2026-09-01T21:00:00.000Z')).toBe('Sep 1, 2026');
  });
});
