/**
 * The account pin and the account check of a returning cloud sign-in (US-09
 * AC55). The pin names the owner of this device's copy of the record: the
 * provider and an opaque account id the provider names at sign-in, never an
 * email. The host keeps it on the device only; it is never logged, sent in an
 * event or put in a URL. The iPhone has its own account check in Swift.
 */
import { rowRootIds } from './merge';
import type { CloudCheckOutcome } from './product-events';
import { ROW_ARRAYS, type RoadmapFile } from './roadmap-file';

/** Which account of which provider owns this device's copy. */
export interface AccountPin {
  readonly provider: string;
  readonly account: string;
}

/** 'adopt': no pin yet. 'same': the pinned account. 'other': another account or provider. */
export type PinVerdict = 'adopt' | 'same' | 'other';

export function pinVerdict(pinned: AccountPin | null, signedIn: AccountPin): PinVerdict {
  if (!pinned) return 'adopt';
  return pinned.provider === signedIn.provider && pinned.account === signedIn.account ? 'same' : 'other';
}

/** A stored value as a pin, or null for anything else. */
export function parsePin(value: unknown): AccountPin | null {
  if (!value || typeof value !== 'object') return null;
  const { provider, account } = value as { provider?: unknown; account?: unknown };
  return typeof provider === 'string' && provider && typeof account === 'string' && account ? { provider, account } : null;
}

const listOf = (body: object, key: string): unknown[] => {
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
};

/** The root ids of a stored record's rows and of the rows its erases listed; none for anything that is not a record. */
export function recordRowIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const rows = Object.fromEntries(ROW_ARRAYS.map((key) => [key, listOf(body, key).filter((row) => row !== null && typeof row === 'object')]));
  const erased = (body as { erasedRows?: { ids?: unknown } }).erasedRows?.ids;
  return [...rowRootIds(rows as unknown as RoadmapFile), ...(Array.isArray(erased) ? erased.filter((id): id is string => typeof id === 'string') : [])];
}

/** The sync bookkeeping a singleton carries whether or not anything was answered. */
const STAMP_FIELDS = new Set(['updatedAt', 'lamport', 'fieldStamps']);
const answered = (value: unknown): boolean =>
  !!value && typeof value === 'object' && Object.keys(value).some((key) => !STAMP_FIELDS.has(key));

/**
 * A device copy with nothing in it: no stored body, or a record with no row,
 * no erase history (no erase epoch, no erase list, even an empty one: lifted,
 * it would erase there) and no answer kept (profile, screenings, reminder
 * choices, the reminder opt-in, plan snapshots). Rows are judged by the row
 * lists' lengths, not their ids, so a row without an id counts. Anything else,
 * a body this cannot read included, is not empty.
 */
export function deviceCopyEmpty(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const epoch = (record.meta as { eraseEpoch?: unknown } | undefined)?.eraseEpoch;
  const noRows = ROW_ARRAYS.every((key) => { const rows = record[key]; return rows === undefined || (Array.isArray(rows) && rows.length === 0); });
  return noRows && !record.erasedRows && !(typeof epoch === 'number' && epoch > 0)
    && !answered(record.profile) && !answered(record.screenings) && !record.reminderOptIn
    && listOf(body, 'reminderPreferences').length === 0 && listOf(body, 'recommendationSnapshots').length === 0;
}

/**
 * What shows a new sign-in reaches the record this device's copy came from.
 * `earlierAccount`: the account the earlier stored credentials name (absent or
 * null: they could not say). `cachedFileVisible`: the record file id cached
 * here is visible to the new sign-in. `sharesRow`: the record it reaches shares
 * a row id with this device's copy.
 */
export interface OwnerProof {
  earlierAccount?: string | null;
  cachedFileVisible?: boolean;
  sharesRow?: boolean;
}

/** With no pin: an earlier account that differs refuses; otherwise any positive proof keeps; none refuses. */
export function proofVerdict(account: string, proof: OwnerProof): 'keep' | 'refuse' {
  if (typeof proof.earlierAccount === 'string') return proof.earlierAccount === account ? 'keep' : 'refuse';
  return proof.cachedFileVisible === true || proof.sharesRow === true ? 'keep' : 'refuse';
}

/**
 * What the check of a sign-in coming back to the backend this browser still
 * remembers finds. `signedIn` null: the provider did not name the account.
 * With a pin: the pinned account or another. With none (a browser that
 * connected before the pin existed): an empty device copy, or the proof.
 */
export function reconnectOutcome(pinned: AccountPin | null, signedIn: AccountPin | null, deviceEmpty: boolean, proof: OwnerProof): CloudCheckOutcome {
  if (!signedIn) return 'account_not_named';
  if (pinned) return pinVerdict(pinned, signedIn) === 'same' ? 'same_account' : 'other_account';
  if (deviceEmpty) return 'no_pin_empty_copy';
  return proofVerdict(signedIn.account, proof) === 'keep' ? 'no_pin_same_record' : 'no_pin_unproven';
}

/** The check's mode. observe: the outcome is counted; the sign-in is not affected. */
export type AccountCheckMode = 'observe' | 'enforce';

const KEEPS: readonly CloudCheckOutcome[] = ['same_account', 'no_pin_empty_copy', 'no_pin_same_record'];

/** Whether a check's outcome refuses the sign-in in this mode. */
export function checkRefuses(mode: AccountCheckMode, outcome: CloudCheckOutcome): boolean {
  return mode === 'enforce' && !KEEPS.includes(outcome);
}
