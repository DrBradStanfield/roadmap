/**
 * US-09 AC54: a cloud sign-in stays with the account this device first
 * connected; another account is refused until the person logs off. The pure
 * verdicts as tables, and the admit step against in-memory facts.
 */
import { describe, expect, it } from 'vitest';
import { admitSignIn, adoptVerdict, parsePin, pinVerdict, recordRelation, recordRowIds, type AccountPin, type AdoptFacts, type PinVerdict, type SignInCheck } from './account-pin';

const A: AccountPin = { provider: 'google-drive', account: 'id-a' };

describe('US-09 AC54: pinVerdict', () => {
  const table: Array<[string, AccountPin | null, AccountPin, PinVerdict]> = [
    ['no pin yet', null, A, 'adopt'],
    ['the pinned account', A, { ...A }, 'same'],
    ['another account of the same provider', A, { provider: 'google-drive', account: 'id-b' }, 'other'],
    ['the same id at another provider', A, { provider: 'dropbox', account: 'id-a' }, 'other'],
    ['another account at another provider', A, { provider: 'dropbox', account: 'id-b' }, 'other'],
  ];
  it.each(table)('%s', (_name, pinned, signedIn, verdict) => {
    expect(pinVerdict(pinned, signedIn)).toBe(verdict);
  });
});

describe('US-09 AC54: parsePin', () => {
  it.each([null, 'id-a', {}, { provider: 'dropbox' }, { provider: '', account: 'x' }, { provider: 'dropbox', account: 7 }])('%j is no pin', (value) => {
    expect(parsePin(value)).toBeNull();
  });
  it('keeps the two fields and nothing else', () => {
    expect(parsePin({ provider: 'dropbox', account: 'x', gen: 'g' })).toEqual({ provider: 'dropbox', account: 'x' });
  });
});

describe('US-09 AC54: adoptVerdict, the first fact that decides', () => {
  const table: Array<[string, AdoptFacts, 'adopt' | 'refuse']> = [
    ['(i) the earlier account is this one', { earlierAccount: 'id-a', cachedFileVisible: false, record: 'unrelated' }, 'adopt'],
    ['(i) the earlier account is another', { earlierAccount: 'id-b', cachedFileVisible: true, record: 'shared' }, 'refuse'],
    ['(i) unreadable, (ii) the cached file is visible', { earlierAccount: null, cachedFileVisible: true }, 'adopt'],
    ['(ii) the cached file is not visible', { cachedFileVisible: false, record: 'shared' }, 'refuse'],
    ['(iii) the device copy is empty', { record: 'deviceEmpty' }, 'adopt'],
    ['(iii) the reached cloud holds no record', { record: 'noRecord' }, 'adopt'],
    ['(iii) the records share a row', { record: 'shared' }, 'adopt'],
    ['(iii) the records share no row', { record: 'unrelated' }, 'refuse'],
    ['(iii) the reached record could not be read', { record: 'unread' }, 'refuse'],
    ['nothing could decide', { earlierAccount: null }, 'refuse'],
  ];
  it.each(table)('%s', (_name, facts, verdict) => {
    expect(adoptVerdict('id-a', facts)).toBe(verdict);
  });
});

describe('US-09 AC54: recordRelation', () => {
  const record = (...ids: string[]) => ({ schemaVersion: 1, measurements: ids.map((id) => ({ id })), labValues: [null, 'x'] });
  it('reads row ids from a record, and none from anything else', () => {
    expect(recordRowIds(record('m1', 'm2'))).toEqual(['m1', 'm2']);
    expect(recordRowIds(null)).toEqual([]);
    expect(recordRowIds('text')).toEqual([]);
  });
  it.each([
    ['an empty device copy', [], record('m1'), 'deviceEmpty'],
    ['no record there', ['m1'], null, 'noRecord'],
    ['a shared row', ['m1', 'm2'], record('m2', 'm9'), 'shared'],
    ['no shared row', ['m1'], record('m9'), 'unrelated'],
    ['a record with no rows', ['m1'], record(), 'unrelated'],
  ] as const)('%s', (_name, device, cloud, relation) => {
    expect(recordRelation(device, cloud)).toBe(relation);
  });
});

const reads = (id: string) => async () => id;
const unreadable = async (): Promise<string> => { throw new Error('offline'); };
function check(over: Partial<SignInCheck> = {}): SignInCheck {
  return { readAccount: reads('id-a'), switching: false, pinned: () => null, earlierSession: () => false, adoptFacts: async () => ({ record: 'unrelated' }), ...over };
}

describe('US-09 AC54: admitSignIn', () => {
  it('a fresh connect: the account read becomes the pin', async () => {
    expect(await admitSignIn('dropbox', check())).toEqual({ provider: 'dropbox', account: 'id-a' });
  });

  it('an account that cannot be read, or an empty id, is refused, pinned or not', async () => {
    for (const readAccount of [unreadable, reads('')]) {
      expect(await admitSignIn('dropbox', check({ readAccount }))).toBeNull();
      expect(await admitSignIn('google-drive', check({ readAccount, pinned: () => A }))).toBeNull();
      expect(await admitSignIn('google-drive', check({ readAccount, switching: true }))).toBeNull();
    }
  });

  it('the pinned account is kept; another account or provider is refused', async () => {
    expect(await admitSignIn('google-drive', check({ pinned: () => A }))).toEqual(A);
    expect(await admitSignIn('google-drive', check({ pinned: () => A, readAccount: reads('id-b') }))).toBeNull();
    expect(await admitSignIn('dropbox', check({ pinned: () => A }))).toBeNull();
  });

  it('a switch whose hand-off finished replaces the pin with the new account', async () => {
    expect(await admitSignIn('dropbox', check({ pinned: () => A, readAccount: reads('id-b'), switching: true }))).toEqual({ provider: 'dropbox', account: 'id-b' });
  });

  it('no pin over an earlier cloud session\'s copy: adopted only when the facts say so', async () => {
    const earlier = { earlierSession: () => true };
    expect(await admitSignIn('dropbox', check({ ...earlier, adoptFacts: async () => ({ record: 'unrelated' }) }))).toBeNull();
    expect(await admitSignIn('dropbox', check({ ...earlier, adoptFacts: async () => ({ record: 'shared' }) }))).toEqual({ provider: 'dropbox', account: 'id-a' });
  });

  it('the pin is read after the account read, so a pin another page set meanwhile is the one compared', async () => {
    let pinned: AccountPin | null = null;
    const readAccount = async () => { pinned = A; return 'id-b'; };
    expect(await admitSignIn('google-drive', check({ readAccount, pinned: () => pinned }))).toBeNull();
  });
});
