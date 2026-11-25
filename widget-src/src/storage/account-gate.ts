/**
 * The web's door to the account pin (US-09 AC54): a cloud sign-in stays with
 * the account this browser first connected; another account is refused until
 * the person logs off. The rule is health-core's (account-pin.ts); this keeps
 * the one pin in localStorage beside the other sign-in entries.
 *
 * The pin is a sign-in entry (US-09 AC45): saved under the log-off id it began
 * under, removed by log-off with every other sign-in entry (SIGN_IN_KEYS), and
 * swept at load once a log-off in any tab made it stale. Losing a token, a
 * reconnect, or the guest fallback after lost credentials keep it. A deliberate
 * switch that completes (prepareSwitch) clears it, and the next connect sets it.
 * It is never logged, sent in an event or put in a URL.
 */
import { admitSignIn, parsePin, type AccountPinStore } from '@roadmap/health-core/account-pin';
import { StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { getSignIn, logOffId, safeRemoveItem, setSignIn, type LogOffId } from '../lib/storage';

export const ACCOUNT_PIN_KEY = 'health_roadmap_account_pin';

/** The words for a connect that did not complete: true here too, as nothing was kept. */
export function notConnected(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} did not connect, so nothing changed. Please try again.`;
}

/** A sign-in refused because it is not the account this browser syncs with. */
export class AccountRefusedError extends StorageError {
  constructor(readonly provider: StorageAdapter['id'], label: string) {
    super(notConnected(label));
    this.name = 'AccountRefusedError';
  }
}

/** The pin store, writing only while `gen` is this device's log-off id. */
export function accountPinStore(gen: LogOffId = logOffId()): AccountPinStore {
  return {
    read: () => parsePin(getSignIn<object>(ACCOUNT_PIN_KEY)),
    write: (pin) => setSignIn(ACCOUNT_PIN_KEY, { provider: pin.provider, account: pin.account }, gen),
    clear: () => safeRemoveItem(ACCOUNT_PIN_KEY),
  };
}

/** Before a sign-in begun under `gen` is kept: throws AccountRefusedError for
 *  another account, so the caller keeps nothing, lifts nothing and writes nothing. */
export async function admitAccount(provider: StorageAdapter['id'], label: string, readAccount: () => Promise<string>, gen: LogOffId): Promise<void> {
  if (!(await admitSignIn(accountPinStore(gen), provider, readAccount))) throw new AccountRefusedError(provider, label);
}

/** An adapter that can name the account it is signed in to. */
interface AccountReader {
  account(): Promise<string>;
}
const readsAccount = (adapter: StorageAdapter): adapter is StorageAdapter & AccountReader =>
  typeof (adapter as Partial<AccountReader>).account === 'function';

/** After a good load on a cloud: a browser that connected before the pin existed
 *  adopts the account it is signed in to now. Once pinned, this reads nothing. */
export async function adoptPinAtLoad(adapter: StorageAdapter): Promise<void> {
  const gen = logOffId();
  if (!readsAccount(adapter) || accountPinStore(gen).read()) return;
  await admitSignIn(accountPinStore(gen), adapter.id, () => adapter.account());
}
