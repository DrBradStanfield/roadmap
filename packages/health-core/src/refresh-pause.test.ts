import { describe, expect, it } from 'vitest';
import { REMOTE_THROTTLE_MS, refreshDue, type RefreshReason } from './refresh-pause';

// US-34, lead H31 (Brad 2026-11-26): the five-second pause throttles automatic re-reads only; a pressed
// Sync now always reads. [reason, ms since the last re-read, due].
const rows: Array<[RefreshReason, number, boolean]> = [
  ['automatic', 0, false],
  ['automatic', 1_000, false],
  ['automatic', REMOTE_THROTTLE_MS - 1, false],
  ['automatic', REMOTE_THROTTLE_MS, true],
  ['automatic', 60_000, true],
  ['pressed', 0, true],
  ['pressed', 1_000, true],
  ['pressed', REMOTE_THROTTLE_MS - 1, true],
  ['pressed', REMOTE_THROTTLE_MS, true],
];

describe('refreshDue (H31): only automatic re-reads wait out the pause', () => {
  it.each(rows)('%s, %i ms after the last: due %s', (reason, since, due) => {
    const last = Date.parse('2026-11-26T10:00:00.000Z');
    expect(refreshDue(reason, last + since, last)).toBe(due);
  });

  it('the pause is five seconds', () => {
    expect(REMOTE_THROTTLE_MS).toBe(5_000);
  });
});
