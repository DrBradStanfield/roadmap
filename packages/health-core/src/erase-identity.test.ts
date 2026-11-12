/**
 * US-11 AC6: a clear is owed only for an erase later than the one this device
 * kept as cleared for. `eraseLater(record, kept)` is that order, over two
 * erase identities: a higher epoch, or the same epoch with a later erasedAt
 * (none counts as earliest). An unreadable kept identity is earlier than any
 * readable one; an unreadable record identity is never later.
 */
import { describe, expect, it } from 'vitest';
import { clearOwed, eraseLater } from './erase-identity';

const at = (epoch: number, erasedAt: string | null) => JSON.stringify([epoch, erasedAt]);
const T1 = '2026-10-21T10:00:00.000Z';
const T2 = '2026-10-21T10:05:00.000Z';

describe('eraseLater (US-11 AC6)', () => {
  it.each([
    ['a higher epoch', at(3, T1), at(2, T2), true],
    ['a lower epoch', at(1, T2), at(3, T1), false],
    ['the same epoch, a later erasedAt', at(2, T2), at(2, T1), true],
    ['the same epoch, an earlier erasedAt', at(2, T1), at(2, T2), false],
    ['the same erase', at(2, T1), at(2, T1), false],
    ['the same epoch, the record has none', at(0, null), at(0, null), false],
    ['the same epoch, an erasedAt over none', at(1, T1), at(1, null), true],
    ['the same epoch, none over an erasedAt', at(1, null), at(1, T1), false],
    ['the same instant spelled with an offset', at(1, '2026-10-21T11:00:00.000+01:00'), at(1, T1), false],
    ['a kept identity that is not JSON', at(0, null), 'garbage', true],
    ['a kept identity of the wrong shape', at(0, null), '{"epoch":3}', true],
    ['a kept identity with a non-number epoch', at(0, null), '["3",null]', true],
    ['an empty kept identity', at(0, null), '', true],
    ['a record identity that is not JSON', 'garbage', at(0, null), false],
    ['a record identity of the wrong shape', '[3]', at(0, null), false],
  ])('%s', (_case, record, kept, later) => {
    expect(eraseLater(record, kept)).toBe(later);
  });
});

/**
 * US-11 AC6: the one rule for whether a clear is owed, at open and in session:
 * the record's erase is later than the erase the off-file data was cleared
 * for. No value that cannot be read, on either side, ever owes a clear.
 */
describe('clearOwed (US-11 AC6)', () => {
  it.each([
    ['an earlier erase', at(1, T2), at(2, T1), false],
    ['the same erase', at(2, T1), at(2, T1), false],
    ['a later erase', at(3, T2), at(2, T1), true],
    ['a higher epoch with an earlier time', at(3, T1), at(2, T2), true],
    ['the same epoch, a later time', at(2, T2), at(2, T1), true],
    ['a never-erased record over a never-erased clear', at(0, null), at(0, null), false],
    ['a record identity that cannot be read', 'garbage', at(0, null), false],
    ['a record identity of the wrong shape', '[3]', at(0, null), false],
    ['a cleared-for identity that cannot be read', at(5, T2), 'garbage', false],
    ['an empty cleared-for identity', at(5, T2), '', false],
    ['a cleared-for identity of the wrong shape', at(5, T2), '{"epoch":3}', false],
    ['neither can be read', 'garbage', 'garbage', false],
  ])('%s', (_case, record, clearedFor, owed) => {
    expect(clearOwed(record, clearedFor)).toBe(owed);
  });
});
