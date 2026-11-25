/**
 * The web's door to the account pin (US-09 AC54): a cloud sign-in stays with
 * the account this browser first connected; another account is refused until
 * the person logs off. The rule is health-core's (account-pin.ts); this keeps
 * the one pin in localStorage beside the other sign-in entries.
 *
 * The pin is a sign-in entry (US-09 AC45): kept in the same step as the
 * sign-in it admits (`admitAccount` hands it to the caller's setSignIns), so a
 * refused, failed or stopped attempt leaves none; removed by log-off with
 * every other sign-in entry (SIGN_IN_KEYS), and swept at load once a log-off
 * in any tab made it stale. Losing a token, a reconnect, or the guest fallback
 * after lost credentials keep it. A deliberate switch keeps it until the new
 * sign-in is kept, which then replaces it; "Use this browser only" clears it.
 * It is never logged, sent in an event or put in a URL.
 */
import { admitSignIn, parsePin, recordRelation, recordRowIds, type AdoptFacts, type AccountPin } from '@roadmap/health-core/account-pin';
import { ROADMAP_FILE_NAME, StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { BACKEND_KEY, getSignIn, logOffId, safeGetItem, safeRemoveItem, setSignIn, type LogOffId } from '../lib/storage';
import { LocalStorageAdapter, deviceRecordStored } from './local-storage-adapter';

export const ACCOUNT_PIN_KEY = 'health_roadmap_account_pin';
/** A browser with no pin whose cloud sign-in was lost at load: its device copy came from that cloud. */
export const CLOUD_COPY_KEY = 'health_roadmap_cloud_copy';
/** The switch a redirect return may complete, kept across the provider's page. */
const SWITCH_KEY = 'health_roadmap_switch_to';

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

const readPin = (): AccountPin | null => parsePin(getSignIn<object>(ACCOUNT_PIN_KEY));
/** Bumped whenever the pin is cleared or a switch begins: an adoption read before then keeps nothing. */
let pinEpoch = 0;

/** "Use this browser only", or the picker's move to this browser: the record is this browser's alone now. */
export function forgetAccountPin(): void {
  pinEpoch++;
  safeRemoveItem(ACCOUNT_PIN_KEY);
  safeRemoveItem(CLOUD_COPY_KEY);
}

/** A load whose remembered cloud lost its credentials: with no pin, mark the device copy as that cloud's. */
export function noteCloudCopy(provider: string): void {
  if (!readPin()) setSignIn(CLOUD_COPY_KEY, { provider }, logOffId());
}

let switchTo: { to: string; gen: LogOffId } | null = null;

/** A switch's hand-off finished (the old cloud is copied down and signed out): the next
 *  sign-in to `to` under `gen` replaces the pin. Kept across the provider's page for this tab only. */
export function beginSwitch(to: string, gen: LogOffId = logOffId()): void {
  pinEpoch++;
  switchTo = { to, gen };
  try { sessionStorage.setItem(SWITCH_KEY, JSON.stringify(switchTo)); } catch { /* the form connects still see it */ }
}

/** At load: the switch this page's redirect return may complete, taken once. */
export function claimSwitch(): void {
  let raw: unknown = null;
  try {
    raw = JSON.parse(sessionStorage.getItem(SWITCH_KEY) ?? 'null');
    sessionStorage.removeItem(SWITCH_KEY);
  } catch { /* none */ }
  const { to, gen } = (raw ?? {}) as { to?: unknown; gen?: unknown };
  switchTo = typeof to === 'string' && (typeof gen === 'string' || gen === null) ? { to, gen } : null;
}
/** The load's redirect returns are done: a switch none of them completed is over. */
export function endSwitch(): void {
  switchTo = null;
}

/** What a provider knows when one of its sign-ins comes back, before anything is kept. */
export interface ProviderCheck {
  provider: StorageAdapter['id'];
  label: string;
  /** The new sign-in's account, read with its own credentials. */
  account(): Promise<string>;
  /** The record the new sign-in reaches, read only; null when there is none. */
  readRecord(): Promise<unknown>;
  /** (i) The earlier account of this provider, read with the credentials still stored here. */
  earlierAccount?: () => Promise<string>;
  /** (ii) Drive: can the new sign-in see the record file id cached here? */
  cachedFileVisible?: () => Promise<boolean>;
  /** A reconnect of the record in place, never a switch's end. */
  reconnect?: boolean;
}

async function adoptFacts(check: ProviderCheck): Promise<AdoptFacts> {
  const earlierAccount = check.earlierAccount ? await check.earlierAccount().catch(() => null) : undefined;
  if (typeof earlierAccount === 'string') return { earlierAccount };
  const cachedFileVisible = check.cachedFileVisible ? await check.cachedFileVisible().catch(() => undefined) : undefined;
  if (cachedFileVisible !== undefined) return { cachedFileVisible };
  const device = recordRowIds((await new LocalStorageAdapter().read(ROADMAP_FILE_NAME).catch(() => null))?.body);
  if (device.length === 0) return { record: 'deviceEmpty' };
  return { record: await check.readRecord().then((cloud) => recordRelation(device, cloud), () => 'unread' as const) };
}

/**
 * Before a sign-in begun under `gen` is kept, and after its credentials were
 * validated: the pin entry to save in the same setSignIns as the sign-in.
 * Throws AccountRefusedError for another account, or one that cannot be read
 * or shown to reach this browser's record, so the caller keeps nothing,
 * lifts nothing and writes nothing.
 */
export async function admitAccount(check: ProviderCheck, gen: LogOffId): Promise<Record<string, AccountPin>> {
  const switching = !check.reconnect && switchTo?.to === check.provider && switchTo.gen === gen;
  const pin = await admitSignIn(check.provider, {
    readAccount: () => check.account(),
    switching,
    pinned: readPin,
    earlierSession: () => deviceRecordStored() && !!(safeGetItem(BACKEND_KEY) || getSignIn(CLOUD_COPY_KEY)),
    adoptFacts: () => adoptFacts(check),
  });
  if (!pin) throw new AccountRefusedError(check.provider, check.label);
  if (switching) switchTo = null;
  return { [ACCOUNT_PIN_KEY]: { provider: pin.provider, account: pin.account } };
}

/** An adapter that can name the account it is signed in to, under the log-off id it was built with. */
interface AccountReader {
  account(): Promise<string>;
  readonly gen: LogOffId;
}
const readsAccount = (adapter: StorageAdapter): adapter is StorageAdapter & AccountReader =>
  typeof (adapter as Partial<AccountReader>).account === 'function' && 'gen' in adapter;

/** After a good load on a cloud: a browser that connected before the pin existed
 *  adopts the account this load signed in with. Bound to the adapter's own log-off
 *  id: a log-off, a switch or a pin set meanwhile keeps nothing. Once pinned, this reads nothing. */
export async function adoptPinAtLoad(adapter: StorageAdapter): Promise<void> {
  if (!readsAccount(adapter) || adapter.gen !== logOffId() || readPin()) return;
  const epoch = pinEpoch;
  const account = await adapter.account().catch(() => null);
  if (!account || epoch !== pinEpoch || readPin() || safeGetItem(BACKEND_KEY) !== adapter.id) return;
  setSignIn(ACCOUNT_PIN_KEY, { provider: adapter.id, account }, adapter.gen);
}
