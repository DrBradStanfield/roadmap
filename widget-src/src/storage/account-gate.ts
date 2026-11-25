/**
 * The web's door to the account pin (US-09 AC55): a cloud sign-in stays with
 * the account this browser connected; another account is refused. The rule is
 * health-core's (account-pin.ts); this keeps the one pin in localStorage as a
 * sign-in entry (AC45), so log-off and the load sweep remove it with the rest.
 *
 * Set by every fresh connect that is kept, in the same write as its tokens,
 * and adopted at a good load by a browser that has none. Released by log-off,
 * by "Use this browser only" and by a switch once its copy-down succeeded.
 * Checked only when a sign-in comes back to the backend this browser still
 * remembers. Never logged, sent in an event or put in a URL.
 */
import { deviceCopyEmpty, parsePin, reconnectVerdict, recordRowIds, type AccountPin, type OwnerProof } from '@roadmap/health-core/account-pin';
import { ROADMAP_FILE_NAME, StorageError, type StorageAdapter } from '@roadmap/health-core/adapter';
import { getSignIn, logOffId, safeRemoveItem, setSignIn, setSignIns, type LogOffId } from '../lib/storage';
import { LocalStorageAdapter } from './local-storage-adapter';

export const ACCOUNT_PIN_KEY = 'health_roadmap_account_pin';

/** The words for a connect that did not complete (US-09 AC1a): true of a refused sign-in too, as nothing was kept. */
export function notConnected(label: string): string {
  return `${label} did not connect, so nothing changed. Please try again.`;
}

/** A sign-in that is not this browser's account, or whose account could not be read (`unread`: a fault to report). */
export class AccountRefusedError extends StorageError {
  constructor(readonly provider: string, label: string, readonly unread = false) {
    super(notConnected(label));
    this.name = 'AccountRefusedError';
  }
}

export const readPin = (): AccountPin | null => parsePin(getSignIn<object>(ACCOUNT_PIN_KEY));

/** Log-off, "Use this browser only" and a switch's finished copy-down: this device's copy has no owner. */
export function releasePin(): void {
  safeRemoveItem(ACCOUNT_PIN_KEY);
}

/** The pin a kept sign-in writes, and the pin it was decided against (absent for a fresh connect). */
export interface PinDecision {
  readonly pin: AccountPin;
  readonly label: string;
  readonly against?: AccountPin | null;
  /** Kept with no pin only because this device's copy was empty: its lift must find it still empty. */
  readonly onEmpty?: boolean;
}

/** A fresh connect: the account it signed in with, or refused when that cannot be read. */
export async function freshDecision(provider: StorageAdapter['id'], label: string, account: () => Promise<string>): Promise<PinDecision> {
  const id = await account().catch(() => '');
  if (!id) throw new AccountRefusedError(provider, label, true);
  return { pin: { provider, account: id }, label };
}

/** What a sign-in coming back to the remembered backend is checked with. */
export interface ReconnectCheck {
  provider: StorageAdapter['id'];
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
}

/** The positive proofs, stopping at the first that decides. Any read that fails proves nothing. */
async function proofFor(check: ReconnectCheck, copies: unknown[]): Promise<OwnerProof> {
  const earlierAccount = check.earlierAccount ? await check.earlierAccount().catch(() => null) : null;
  if (earlierAccount) return { earlierAccount };
  if (check.cachedFileVisible && (await check.cachedFileVisible().catch(() => false))) return { cachedFileVisible: true };
  const here = new Set(copies.flatMap(recordRowIds));
  return { sharesRow: await check.cloudRecord().then((cloud) => recordRowIds(cloud).some((id) => here.has(id)), () => false) };
}

/** A sign-in coming back to the remembered backend: kept for the pinned account, or with no pin on proof; refused otherwise.
 *  Without a pin, the copy is empty only when both the stored body and the page's open record are. */
export async function reconnectDecision(check: ReconnectCheck): Promise<PinDecision> {
  const { pin } = await freshDecision(check.provider, check.label, () => check.account());
  const against = readPin();
  const copies = [await storedCopy(), check.live?.() ?? null];
  const empty = copies.every(deviceCopyEmpty);
  const proof = against || empty ? {} : await proofFor(check, copies);
  if (reconnectVerdict(against, pin, empty, proof) === 'refuse') throw new AccountRefusedError(check.provider, check.label);
  return { pin, label: check.label, against, onEmpty: !against && empty };
}

/** This device's stored copy; one that cannot be read is not empty. */
const storedCopy = (): Promise<unknown> => new LocalStorageAdapter().read(ROADMAP_FILE_NAME).then((r) => r.body, () => 'unreadable');

/** Read again just before a lift: true while this device's stored copy is still empty. */
export async function storedCopyEmpty(): Promise<boolean> {
  return deviceCopyEmpty(await storedCopy());
}

const samePin = (a: AccountPin | null, b: AccountPin | null): boolean => a?.provider === b?.provider && a?.account === b?.account;

/** Keep a sign-in's entries with its pin, in one write. A reconnect whose pin changed since it was decided (another tab) is refused. */
export function keepWithPin(entries: Record<string, object>, decision: PinDecision, gen: LogOffId): boolean {
  if (decision.against !== undefined && !samePin(readPin(), decision.against)) throw new AccountRefusedError(decision.pin.provider, decision.label);
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
