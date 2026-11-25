/**
 * US-09 AC54: a cloud sign-in stays with the account this device first
 * connected; another account is refused until the person logs off. The pure
 * verdict as a table, and the admit step against an in-memory pin store.
 */
import { describe, expect, it } from 'vitest';
import { admitSignIn, parsePin, pinVerdict, type AccountPin, type AccountPinStore, type PinVerdict } from './account-pin';

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

function memoryStore(pin: AccountPin | null = null, writable = true): AccountPinStore & { pin: AccountPin | null } {
  const store = {
    pin,
    read: () => store.pin,
    write: (next: AccountPin) => { if (writable) store.pin = next; return writable; },
    clear: () => { store.pin = null; },
  };
  return store;
}
const reads = (id: string) => async () => id;
const unreadable = async (): Promise<string> => { throw new Error('offline'); };

describe('US-09 AC54: admitSignIn', () => {
  it('with no pin: kept, and the account is pinned', async () => {
    const store = memoryStore();
    expect(await admitSignIn(store, 'dropbox', reads('id-a'))).toBe(true);
    expect(store.pin).toEqual({ provider: 'dropbox', account: 'id-a' });
  });

  it('with no pin and an account that cannot be read: kept, nothing pinned (the next good load adopts)', async () => {
    const store = memoryStore();
    expect(await admitSignIn(store, 'dropbox', unreadable)).toBe(true);
    expect(store.pin).toBeNull();
  });

  it('the pinned account: kept, the pin unchanged', async () => {
    const store = memoryStore(A);
    expect(await admitSignIn(store, 'google-drive', reads('id-a'))).toBe(true);
    expect(store.pin).toEqual(A);
  });

  it('another account, another provider, an empty id, or an account that cannot be read: refused, the pin unchanged', async () => {
    for (const [provider, read] of [['google-drive', reads('id-b')], ['dropbox', reads('id-a')], ['google-drive', reads('')], ['google-drive', unreadable]] as const) {
      const store = memoryStore(A);
      expect(await admitSignIn(store, provider, read)).toBe(false);
      expect(store.pin).toEqual(A);
    }
  });

  it('a pin set by another page during the account read is the one compared', async () => {
    const store = memoryStore();
    const read = async () => { store.pin = A; return 'id-b'; };
    expect(await admitSignIn(store, 'google-drive', read)).toBe(false);
    expect(store.pin).toEqual(A);
  });
});
