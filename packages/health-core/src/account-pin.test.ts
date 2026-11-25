/**
 * US-09 AC55: a cloud sign-in stays with the account this browser connected.
 * The pure rules as tables.
 */
import { describe, expect, it } from 'vitest';
import { checkRefuses, deviceCopyEmpty, parsePin, pinVerdict, proofVerdict, reconnectOutcome, recordRowIds, type AccountCheckMode, type AccountPin, type OwnerProof, type PinVerdict } from './account-pin';
import { CLOUD_CHECK_OUTCOMES, type CloudCheckOutcome } from './product-events';
import { buildErasedFile } from './erase';
import { createEmptyFile, ROW_ARRAYS, type RoadmapFile } from './roadmap-file';

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

describe('US-09 AC55: reconnectOutcome', () => {
  const table: Array<[string, AccountPin | null, AccountPin | null, boolean, OwnerProof, CloudCheckOutcome]> = [
    ['pinned: the same account', A, A, false, {}, 'same_account'],
    ['pinned: another account, even over an empty copy with a shared row', B, A, true, { sharesRow: true }, 'other_account'],
    ['no pin, an empty device copy', null, A, true, {}, 'no_pin_empty_copy'],
    ['no pin, a copy and a proof', null, A, false, { sharesRow: true }, 'no_pin_same_record'],
    ['no pin, a copy and no proof', null, A, false, {}, 'no_pin_unproven'],
    ['no pin, a copy and an earlier account that differs', null, A, false, { earlierAccount: 'id-b', sharesRow: true }, 'no_pin_unproven'],
    ['the provider did not name the account, pinned or not', A, null, true, { sharesRow: true }, 'account_not_named'],
  ];
  it.each(table)('%s', (_name, pinned, signedIn, empty, proof, outcome) => {
    expect(reconnectOutcome(pinned, signedIn, empty, proof)).toBe(outcome);
  });
  it('names every outcome the event may carry', () => {
    expect(new Set(table.map((row) => row[5]))).toEqual(new Set(CLOUD_CHECK_OUTCOMES));
  });
});

describe('US-09 AC55: checkRefuses, outcome by mode', () => {
  const keeps: Record<CloudCheckOutcome, boolean> = {
    same_account: true, no_pin_empty_copy: true, no_pin_same_record: true,
    other_account: false, no_pin_unproven: false, account_not_named: false,
  };
  const rows = CLOUD_CHECK_OUTCOMES.flatMap((outcome) => (['observe', 'enforce'] as AccountCheckMode[]).map((mode) => [mode, outcome] as const));
  it.each(rows)('%s, %s', (mode, outcome) => {
    expect(checkRefuses(mode, outcome)).toBe(mode === 'enforce' && !keeps[outcome]);
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

/** What an erase leaves of a record holding a profile answer only: its erase history must travel with it. */
function erasedProfileOnly(): RoadmapFile {
  const own = createEmptyFile({ deviceId: 'd', now: '2026-11-01T00:00:00.000Z' });
  own.profile = { ...own.profile, birthYear: 1970 };
  return buildErasedFile({ stored: null, own, device: null, ctx: { deviceId: 'd', now: '2026-11-25T00:00:00.000Z' } });
}

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
    ['an empty erase list', { ...empty, erasedRows: { fromEpoch: 1, ids: [] } }, false],
    ['an erase epoch only', { ...empty, meta: { ...stamp, eraseEpoch: 1 } }, false],
    ['a profile-only record once erased', erasedProfileOnly(), false],
    ['one row', { ...empty, measurements: [{ id: 'm1' }] }, false],
    ['a body that is not a record', 'unreadable', false],
    ['a row with no id', { ...empty, measurements: [{ metricType: 'weight' }] }, false],
    ['a row whose id is not a string', { ...empty, measurements: [{ id: 7 }] }, false],
    ['a row that is not an object', { ...empty, measurements: ['m1'] }, false],
    ['a row list that is not a list', { ...empty, measurements: { id: 'm1' } }, false],
  ];
  it.each(table)('%s', (_name, body, verdict) => {
    expect(deviceCopyEmpty(body)).toBe(verdict);
  });
  it.each(ROW_ARRAYS.map((key) => [key]))('one entry in %s, even without an id, is not empty', (key) => {
    expect(deviceCopyEmpty({ ...empty, [key]: [{}] })).toBe(false);
  });
});
