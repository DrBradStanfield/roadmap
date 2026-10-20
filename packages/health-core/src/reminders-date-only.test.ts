import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatReminderDate } from './reminders';

// Both Vitest configs use forks so TZ reaches Node's local date accessors.
const originalTZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe('reminder calendar dates west of UTC (US-17)', () => {
  it.each([
    ['2025-01-01', 'Jan 2025'],
    ['2024-12-01', 'Dec 2024'],
    ['2025-03-01', 'Mar 2025'],
  ])('does not shift %s into the previous month', (input, expected) => {
    expect(formatReminderDate(input)).toBe(expected);
  });

  it('still displays a timestamp in local time', () => {
    expect(formatReminderDate('2025-01-01T00:30:00.000Z')).toBe('Dec 2024');
  });
});
