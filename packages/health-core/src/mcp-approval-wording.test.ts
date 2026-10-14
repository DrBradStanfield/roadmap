/**
 * The blocklist's count floor (US-36, OPEN 2026-10-14, adversary R6): `isPartialRun` skips the floor only for a
 * run a `-t` filter narrowed. A test parked with `it.skip` or `skipIf` is skipped on every run, so it must not
 * read as a filter, or one parked test would silently switch the floor off for good.
 */
import { describe, expect, it } from 'vitest';
import { isPartialRun } from './mcp-approval-wording.testing';

const test = (name: string, mode = 'run') => ({ type: 'test', name, mode });
function fileOf(...tests: ReturnType<typeof test>[]) {
  const suite = { type: 'suite', name: 'outer', mode: 'run', tasks: tests as unknown[] };
  for (const t of tests) Object.assign(t, { suite });
  return { type: 'suite', name: 'file.test.ts', mode: 'run', tasks: [suite] };
}

// The fixtures pass `null` (no filter) explicitly: an omitted pattern reads the live run's, so under `-t US-36`
// a fixture meant as a whole run would read as filtered (round 3, R5).
describe('isPartialRun (US-36 R6)', () => {
  it('a whole run is not partial, even with a test parked by it.skip or skipIf', () => {
    expect(isPartialRun(fileOf(test('a'), test('b')) as never, null)).toBe(false);
    expect(isPartialRun(fileOf(test('a'), test('parked', 'skip')) as never, null)).toBe(false);
  });

  it('a run a -t filter narrowed is partial; one the filter left whole is not', () => {
    const narrowed = fileOf(test('a US-36'), test('b', 'skip'), test('heard enough (US-36)'));
    expect(isPartialRun(narrowed as never, /US-36/)).toBe(true);
    expect(isPartialRun(narrowed as never, 'US-36')).toBe(true);
    // The full name is the suite's and the test's, as the runner matches it: "outer b" matches /outer/.
    expect(isPartialRun(fileOf(test('a'), test('b')) as never, /outer/)).toBe(false);
  });

  it('no file is partial (the runner gave nothing to check)', () => {
    expect(isPartialRun(undefined, null)).toBe(true);
  });
});
