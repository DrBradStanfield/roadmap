/**
 * US-09 AC55: a cloud sign-in stays with the account this browser connected;
 * another account is refused. The pure rules as tables.
 */
import { describe, expect, it } from 'vitest';
import { deviceCopyEmpty, parsePin, pinVerdict, proofVerdict, reconnectVerdict, recordRowIds, type AccountPin, type OwnerProof, type PinVerdict } from './account-pin';

const A: AccountPin = { provider: 'google-drive', account: 'id-a' };
const B: AccountPin = { provider: 'google-drive', account: 'id-b' };

describe('US-09 AC55: pinVerdict', () => {
  const table: Array<[string, AccountPin | null, AccountPin, PinVerdict]> = [
    ['no pin yet', null, A, 'adopt'],
    ['the pinned account', A, { ...A }, 'same'],
    ['another account of the same provider', A, B, 'other'],
    ['the same id at another provider', A, { provider: 'dropbox', account: 'id-a' }, 'other'],
  ];
  it.each(table)('%s', (_name, pinned, signedIn, verdict) => {
    expect(pinVerdict(pinned, signedIn)).toBe(verdict);
  });
});

describe('US-09 AC55: parsePin', () => {
  it.each([null, 'id-a', {}, { provider: 'dropbox' }, { provider: '', account: 'x' }, { provider: 'dropbox', account: 7 }])('%j is no pin', (value) => {
    expect(parsePin(value)).toBeNull();
  });
  it('keeps the two fields and nothing else', () => {
    expect(parsePin({ provider: 'dropbox', account: 'x', gen: 'g' })).toEqual({ provider: 'dropbox', account: 'x' });
  });
});

describe('US-09 AC55: proofVerdict, positive proof only', () => {
  const table: Array<[string, OwnerProof, 'keep' | 'refuse']> = [
    ['the earlier account is this one', { earlierAccount: 'id-a' }, 'keep'],
    ['the earlier account is another, whatever else is shown', { earlierAccount: 'id-b', cachedFileVisible: true, sharesRow: true }, 'refuse'],
    ['the earlier account could not be read, the cached file is visible', { earlierAccount: null, cachedFileVisible: true }, 'keep'],
    ['a stale cached file id with a shared row', { cachedFileVisible: false, sharesRow: true }, 'keep'],
    ['a shared row alone', { sharesRow: true }, 'keep'],
    ['the cached file not visible and no shared row', { cachedFileVisible: false, sharesRow: false }, 'refuse'],
    ['no proof at all', {}, 'refuse'],
  ];
  it.each(table)('%s', (_name, proof, verdict) => {
    expect(proofVerdict('id-a', proof)).toBe(verdict);
  });
});

describe('US-09 AC55: reconnectVerdict', () => {
  const table: Array<[string, AccountPin | null, boolean, OwnerProof, 'keep' | 'refuse']> = [
    ['pinned: the same account', A, false, {}, 'keep'],
    ['pinned: another account, even over an empty copy with a shared row', B, true, { sharesRow: true }, 'refuse'],
    ['no pin, an empty device copy', null, true, {}, 'keep'],
    ['no pin, a copy and a proof', null, false, { sharesRow: true }, 'keep'],
    ['no pin, a copy and no proof', null, false, {}, 'refuse'],
  ];
  it.each(table)('%s', (_name, pinned, empty, proof, verdict) => {
    expect(reconnectVerdict(pinned, A, empty, proof)).toBe(verdict);
  });
});

describe('US-09 AC55: recordRowIds', () => {
  it('reads row ids and erased ids from a record, and none from anything else', () => {
    const record = { measurements: [{ id: 'm1' }, null, 'x'], labValues: [{ id: 'l1' }], erasedRows: { fromEpoch: 1, ids: ['gone', 7] } };
    expect(recordRowIds(record).sort()).toEqual(['gone', 'l1', 'm1']);
    expect(recordRowIds(null)).toEqual([]);
    expect(recordRowIds('text')).toEqual([]);
  });
});

describe('US-09 AC55: deviceCopyEmpty', () => {
  const stamp = { updatedAt: '2026-11-25T00:00:00Z', lamport: 0 };
  const empty = { schemaVersion: 3, meta: { ...stamp }, profile: { ...stamp }, screenings: { ...stamp, fieldStamps: {} }, measurements: [], reminderPreferences: [], recommendationSnapshots: [] };
  const table: Array<[string, unknown, boolean]> = [
    ['nothing stored', null, true],
    ['a record with nothing answered', empty, true],
    ['a profile answer only', { ...empty, profile: { ...stamp, birthYear: 1970 } }, false],
    ['a unit choice only', { ...empty, profile: { ...stamp, unitSystem: 'si' } }, false],
    ['a screening answer only', { ...empty, screenings: { ...stamp, colorectalMethod: 'fit' } }, false],
    ['a reminder choice only', { ...empty, reminderPreferences: [{ ...stamp, category: 'x', enabled: false }] }, false],
    ['a reminder opt-in only', { ...empty, reminderOptIn: { ...stamp, status: 'cancelled' } }, false],
    ['an erase list only', { ...empty, erasedRows: { fromEpoch: 1, ids: ['m1'] } }, false],
    ['one row', { ...empty, measurements: [{ id: 'm1' }] }, false],
    ['a body that is not a record', 'unreadable', false],
  ];
  it.each(table)('%s', (_name, body, verdict) => {
    expect(deviceCopyEmpty(body)).toBe(verdict);
  });
});
