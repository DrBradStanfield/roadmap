import { describe, expect, it } from 'vitest';
import { digest, emptyCheckpoint, encode, fold, readCheckpoint, readTransaction } from './model';
import { scheduleModel } from './schedules';
import { transaction } from './fixtures';

describe('US-38 AC1/3/5: reference replay retains full claims', () => {
  it('retains full commands and rejects a receipt with only a hash or altered content', () => {
    const checkpoint = fold(emptyCheckpoint(), [transaction('a')]);
    expect(readCheckpoint(encode(checkpoint))).toEqual(checkpoint);
    expect(checkpoint.entries[0].transaction.edits).toHaveLength(1);
    const changed = structuredClone(checkpoint);
    changed.entries[0].transaction.edits[0].value = 'changed';
    expect(() => readCheckpoint(encode(changed))).toThrow('cover');
    const hashOnly = { ...checkpoint, entries: [{ digest: digest(transaction('a')), outcome: 'applied' }] };
    expect(() => readCheckpoint(encode(hashOnly))).toThrow('schema');
    const missingEffect = { ...checkpoint, registers: [] };
    expect(() => readCheckpoint(encode(missingEffect))).toThrow('cover');
  });

  it('deduplicates retries but rejects reused operation IDs and writer sequences', () => {
    const a = transaction('a');
    expect(fold(emptyCheckpoint(), [a, a]).entries).toHaveLength(1);
    expect(() => fold(emptyCheckpoint(), [a, transaction('a', { edits: [{ key: 'a', expected: null, value: 'changed' }] })])).toThrow('identity');
    expect(() => fold(emptyCheckpoint(), [a, transaction('b', { writerId: 'a' })])).toThrow('sequence');
    expect(fold(emptyCheckpoint(), [transaction('ten', { writerId: 'writer', sequence: 10 }),
      transaction('nine', { writerId: 'writer', sequence: 9 })]).entries).toHaveLength(2);
  });

  it('converges through dependent-first delivery and separate compactions', () => {
    const add = transaction('add', { edits: [{ key: 'row-original', expected: null, value: 'active' }] });
    const correct = transaction('correct', { dependsOn: ['add'], edits: [
      { key: 'row-original', expected: 'add', value: 'superseded' },
      { key: 'row-correction', expected: null, value: 'corrected' },
    ] });
    const deferred = fold(emptyCheckpoint(), [correct]);
    expect(deferred.entries[0].outcome).toBe('deferred');
    expect(deferred.registers).toEqual([]);
    expect(fold(deferred, [add])).toEqual(fold(fold(emptyCheckpoint(), [add]), [correct]));
    expect(fold(deferred, [add])).toEqual(fold(emptyCheckpoint(), [correct, add]));
    expect(fold(deferred, [add]).registers.map(row => row.value)).toEqual(['corrected', 'superseded']);
  });

  it('keeps both competing corrections and applies neither half of their transactions', () => {
    const add = transaction('add');
    const correction = (id: string) => transaction(id, { dependsOn: ['add'], edits: [
      { key: 'add', expected: 'add', value: 'superseded' }, { key: id, expected: null, value: 'correction' },
    ] });
    const left = correction('left'); const right = correction('right');
    const expected = fold(emptyCheckpoint(), [add, left, right]);
    expect(fold(fold(emptyCheckpoint(), [add, left]), [right])).toEqual(expected);
    expect(fold(fold(emptyCheckpoint(), [add, right]), [left])).toEqual(expected);
    expect(expected.entries.map(entry => entry.outcome)).toEqual(['applied', 'conflict', 'conflict']);
    expect(expected.registers).toEqual([{ key: 'add', value: 'add', head: 'add' }]);
  });

  it('merges different profile fields without choosing a clock winner for the whole profile', () => {
    const a = transaction('a', { edits: [{ key: 'profile-height', expected: null, value: 'synthetic-height' }] });
    const b = transaction('b', { edits: [{ key: 'profile-birth', expected: null, value: 'synthetic-birth' }] });
    expect(fold(emptyCheckpoint(), [a, b])).toEqual(fold(emptyCheckpoint(), [b, a]));
    expect(fold(emptyCheckpoint(), [a, b]).registers).toHaveLength(2);
  });

  it('retains dependency cycles and missing dependencies without terminal rejection', () => {
    const result = fold(emptyCheckpoint(), [transaction('a', { dependsOn: ['b'] }), transaction('b', { dependsOn: ['a'] }), transaction('c', { dependsOn: ['missing'] })]);
    expect(result.entries.map(entry => entry.outcome)).toEqual(['deferred', 'deferred', 'deferred']);
    expect(readCheckpoint(encode(result))).toEqual(result);
  });

  it('does not apply a dependent transaction whose parent is conflicted', () => {
    const a = transaction('a'); const b = transaction('b', { edits: a.edits });
    const dependent = transaction('c', { dependsOn: ['a'] });
    expect(fold(emptyCheckpoint(), [dependent, a, b]).entries.map(entry => entry.outcome)).toEqual(['conflict', 'conflict', 'conflict']);
  });

  it('refuses future schema, invalid numbers, duplicate register edits and capacity overflow', () => {
    for (const bad of [{ ...transaction('a'), protocol: 2 }, { ...transaction('a'), sequence: -1 },
      { ...transaction('a'), edits: [...transaction('a').edits, ...transaction('a').edits] }]) {
      expect(() => readTransaction(encode(bad))).toThrow('schema');
    }
    expect(() => fold(emptyCheckpoint(), Array.from({ length: 129 }, (_, i) => transaction(`x${i}`)))).toThrow('capacity');
    expect(() => readCheckpoint('x'.repeat(256 * 1024 + 1))).toThrow('capacity');
  });
});

it('US-38 AC2: reproduces all 35 schedules and the unconditional-publication loss', () => {
  expect(scheduleModel(false)).toEqual({ schedules: 35, losses: 4 });
  expect(scheduleModel(true)).toEqual({ schedules: 35, losses: 0 });
});
