/**
 * The web's door to the account pin (US-09 AC55): a cloud sign-in stays with
 * the account this browser connected. The rule is health-core's
 * (account-pin.ts); the mode is ACCOUNT_CHECK_MODE's. This keeps the one pin in
 * localStorage as a sign-in entry (AC45), so log-off and the load sweep remove
 * it with the rest.
 *
 * Set by every fresh connect that is kept, in the same write as its tokens,
 * and adopted at a good load by a browser that has none. Released by log-off,
 * by "Use this browser only" and by a switch once its copy-down succeeded.
 * Checked only when a sign-in comes back to the backend this browser still
 * remembers, each check counted once. Never logged, sent in an event or put in a URL.
 */
import { checkRefuses, deviceCopyEmpty, parsePin, reconnectOutcome, recordRowIds, type AccountPin, type OwnerProof } from '@roadmap/health-core/account-pin';
import { ROADMAP_FILE_NAME, StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import type { CloudCheckOutcome } from '@roadmap/health-core/product-events';
import { getSignIn, logOffId, safeRemoveItem, setSignIn, setSignIns, type LogOffId } from '../lib/storage';
import { recordFailure } from '../lib/error-diagnostics';
import { Sentry } from '../lib/sentry';
import { trackProductEvent } from '../lib/server-api';
import { ACCOUNT_CHECK_MODE } from './account-check-mode';
import { LocalStorageAdapter } from './local-storage-adapter';

export const ACCOUNT_PIN_KEY = 'health_roadmap_account_pin';

/** The words for a connect that did not complete (US-09 AC1a): true of a refused sign-in too, as nothing was kept. */
export function notConnected(label: string): string {
  return `${label} did not connect, so nothing changed. Please try again.`;
}

/** A sign-in that is not this browser's account, or whose account could not be read (`unread`: a fault to report). */
export class AccountRefusedError extends StorageError {
  constructor(readonly provider: string, label: string, readonly unread = false) {
    super(notConnected(label), undefined, undefined, undefined, undefined, 'refused');
    this.name = 'AccountRefusedError';
  }
}

export const readPin = (): AccountPin | null => parsePin(getSignIn<object>(ACCOUNT_PIN_KEY));

/** Log-off, "Use this browser only" and a switch's finished copy-down: this device's copy has no owner. */
export function releasePin(): void {
  safeRemoveItem(ACCOUNT_PIN_KEY);
}

const enforcing = (): boolean => ACCOUNT_CHECK_MODE === 'enforce';

/** A sign-in whose account the provider did not name is a fault: reported once, with the provider only. */
export function reportUnnamed(error: AccountRefusedError): void {
  Sentry.captureException(recordFailure(error, 'Cloud connect failed'), { tags: { area: 'cloud-connect', backend: error.provider } });
}

/** Count a check's outcome, once (US-09 AC55). When the check enforces, an outcome that does not keep the
 *  sign-in throws AccountRefusedError; when it observes, nothing is refused and an unnamed account is reported here. */
export function settleCheck(provider: 'google-drive' | 'dropbox', label: string, outcome: CloudCheckOutcome): void {
  trackProductEvent('cloud_connect_checked', { provider, outcome });
  const unnamed = outcome === 'account_not_named';
  if (checkRefuses(ACCOUNT_CHECK_MODE, outcome)) throw new AccountRefusedError(provider, label, unnamed);
  if (unnamed) reportUnnamed(new AccountRefusedError(provider, label, true));
}

/** The pin a kept sign-in writes (null: none, its account unnamed), and the pin it was decided against (absent for a fresh connect). */
export interface PinDecision {
  readonly provider: string;
  readonly pin: AccountPin | null;
  readonly label: string;
  readonly against?: AccountPin | null;
  /** Kept with no pin only because this device's copy was empty: its lift must find it still empty. */
  readonly onEmpty?: boolean;
}

/** A fresh connect: the account it signed in with. One the provider did not name is refused when the check
 *  enforces; when it observes, the connect is kept with no pin and the fault reported. */
export async function freshDecision(provider: StorageAdapter['id'], label: string, account: () => Promise<string>): Promise<PinDecision> {
  const id = await account().catch(() => '');
  if (id) return { provider, pin: { provider, account: id }, label };
  const unnamed = new AccountRefusedError(provider, label, true);
  if (enforcing()) throw unnamed;
  reportUnnamed(unnamed);
  return { provider, pin: null, label };
}

/** What a sign-in coming back to the remembered backend is checked with. */
export interface ReconnectCheck {
  provider: 'google-drive' | 'dropbox';
  label: string;
  account(): Promise<string>;
  /** The account the credentials still stored here name. */
  earlierAccount?: () => Promise<string>;
  /** Drive: whether the new sign-in can see the record file id cached here. */
  cachedFileVisible?: () => Promise<boolean>;
  /** The record the new sign-in reaches, read only; null when there is none. */
  cloudRecord(): Promise<unknown>;
  /** The working record open on this page, if any: a later save mirrors it to the device and the lift sends it, so it is judged too. */
  live?: () => unknown;
  /** The Drive popup: an empty-copy outcome is settled by the caller, once the copy is read again before its lift. */
  settlesEmptyLater?: boolean;
}

/** The positive proofs, stopping at the first that decides. Any read that fails proves nothing. */
async function proofFor(check: ReconnectCheck, copies: unknown[]): Promise<OwnerProof> {
  const earlierAccount = check.earlierAccount ? await check.earlierAccount().catch(() => null) : null;
  if (earlierAccount) return { earlierAccount };
  if (check.cachedFileVisible && (await check.cachedFileVisible().catch(() => false))) return { cachedFileVisible: true };
  const here = new Set(copies.flatMap(recordRowIds));
  return { sharesRow: await check.cloudRecord().then((cloud) => recordRowIds(cloud).some((id) => here.has(id)), () => false) };
}

/** A sign-in coming back to the remembered backend: kept for the pinned account, or with no pin on proof; any other
 *  outcome refuses when the check enforces (settleCheck). Without a pin, the copy is empty only when both the
 *  stored body and the page's open record are. The pin written is the account that signed in, or none when unnamed. */
export async function reconnectDecision(check: ReconnectCheck): Promise<PinDecision> {
  const id = await check.account().catch(() => '');
  const pin = id ? { provider: check.provider, account: id } : null;
  const against = readPin();
  const copies = pin ? [await storedCopy(), check.live?.() ?? null] : []; // an unnamed account is decided without reading
  const empty = copies.length > 0 && copies.every(deviceCopyEmpty);
  const proof = pin && !against && !empty ? await proofFor(check, copies) : {};
  const outcome = reconnectOutcome(against, pin, empty, proof);
  if (!(check.settlesEmptyLater && outcome === 'no_pin_empty_copy')) settleCheck(check.provider, check.label, outcome);
  return { provider: check.provider, pin, label: check.label, against, onEmpty: outcome === 'no_pin_empty_copy' };
}

/** This device's stored copy; one that cannot be read is not empty. */
const storedCopy = (): Promise<unknown> => new LocalStorageAdapter().read(ROADMAP_FILE_NAME).then((r) => r.body, () => 'unreadable');

/** Read again just before a lift: true while this device's stored copy is still empty. */
export async function storedCopyEmpty(): Promise<boolean> {
  return deviceCopyEmpty(await storedCopy());
}

const samePin = (a: AccountPin | null, b: AccountPin | null): boolean => a?.provider === b?.provider && a?.account === b?.account;

/** Keep a sign-in's entries with its pin, in one write; with no pin, the entries and then the pin removed. A reconnect
 *  whose pin changed since it was decided (another tab) is refused when the check enforces. */
export function keepWithPin(entries: Record<string, object>, decision: PinDecision, gen: LogOffId): boolean {
  if (enforcing() && decision.against !== undefined && !samePin(readPin(), decision.against)) throw new AccountRefusedError(decision.provider, decision.label);
  if (!decision.pin) {
    const saved = setSignIns(entries, gen);
    if (saved) releasePin();
    return saved;
  }
  return setSignIns({ ...entries, [ACCOUNT_PIN_KEY]: { ...decision.pin } }, gen);
}

/** An adapter that can name the account it is signed in to. */
interface Named {
  readonly gen: LogOffId;
  account(): Promise<string>;
}
const named = (adapter: StorageAdapter): adapter is StorageAdapter & Named =>
  typeof (adapter as Partial<Named>).account === 'function' && 'gen' in adapter;

/** After a good load: a browser with a working sign-in and no pin adopts its account. Bound to the
 *  adapter's own log-off id and re-checked after the read, so a log-off, a switch or a pin set meanwhile keeps nothing. */
export async function adoptPinAtLoad(adapter: StorageAdapter, stillSignedIn: () => boolean): Promise<void> {
  if (!named(adapter) || readPin() || adapter.gen !== logOffId()) return;
  const account = await adapter.account().catch(() => '');
  if (!account || readPin() || adapter.gen !== logOffId() || !stillSignedIn()) return;
  setSignIn(ACCOUNT_PIN_KEY, { provider: adapter.id, account }, adapter.gen);
}
