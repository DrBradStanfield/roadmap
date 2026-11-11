import { describe, it, expect } from 'vitest';
import { numberPaths } from './number-leak.test-helpers';

// US-16 AC2a: the erase pins asserted a value's absence by substring of the
// serialized record, and failed the deploy gate (run 42947068545) when a row's
// createdAt was "2026-11-11T02:45:01.990Z". The helper they use now must not.
describe('numberPaths: a number pin ignores timestamps and ids (US-16 AC2a)', () => {
  const row = { id: 'a7771f90-0819-4c1a-9777-81aa19e0a777', value: 81, createdAt: '2026-11-11T02:45:01.990Z' };

  it('a timestamp or UUID holding the digits is not the number', () => {
    expect(JSON.stringify(row)).toContain('1.9'); // the old pin's false match
    expect(numberPaths(row, 1.9)).toEqual([]);
    expect(numberPaths(row, 777)).toEqual([]);
    expect(numberPaths(row, 2026)).toEqual([]);
    expect(numberPaths(row, 45)).toEqual([]);
    expect(numberPaths({ note: 'took 11.9 or 1.95 or v1.9' }, 1.9)).toEqual([]);
  });

  it('finds the number as a number, anywhere in the value', () => {
    expect(numberPaths({ ...row, value: 1.9 }, 1.9)).toEqual(['$.value']);
    expect(numberPaths([{ deep: { list: [3, 1.9] } }], 1.9)).toEqual(['$.0.deep.list.1']);
    expect(numberPaths(row, 81)).toEqual(['$.value']);
  });

  it('finds the number standing alone in a string, serialized JSON included', () => {
    expect(numberPaths({ text: '1.9 mmol/L' }, 1.9)).toEqual(['$.text']);
    expect(numberPaths({ text: 'LDL was 1.9.' }, 1.9)).toEqual(['$.text']);
    expect(numberPaths(JSON.stringify({ ...row, value: 1.9 }), 1.9)).toEqual(['$']);
    expect(numberPaths(JSON.stringify({ heightCm: 191 }), 191)).toEqual(['$']);
  });
});
