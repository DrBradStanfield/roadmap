/**
 * A cloud sign-in stays with the account this device first connected; another
 * account is refused until the person logs off (US-09 AC54). The iPhone keeps
 * the same rule in Swift (CloudSync.swift); this is the engine's copy, for the
 * web now and any host later.
 *
 * The account is an opaque id the provider names at sign-in (Drive's
 * `about.user.permissionId`, Dropbox's `account_id`, GitHub's user id with the
 * repository): never an email. It is kept on the device only, by the host,
 * and is never logged, sent to telemetry or put in a URL.
 */
import { rowRootIds } from './merge';
import { ROW_ARRAYS, type RoadmapFile } from './roadmap-file';

/** Which account of which provider this device syncs with. */
export interface AccountPin {
  readonly provider: string;
  readonly account: string;
}

/** 'adopt': no pin yet, so this sign-in sets it. 'same': the pinned account.
 *  'other': another account or another provider, refused. */
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

/** The root ids of a stored record's rows; none for anything that is not a record. */
export function recordRowIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const rows = (key: string): unknown[] => {
    const value = (body as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.filter((row) => row !== null && typeof row === 'object') : [];
  };
  return rowRootIds(Object.fromEntries(ROW_ARRAYS.map((key) => [key, rows(key)])) as unknown as RoadmapFile);
}

/** How the record a new sign-in reaches stands to this device's copy. */
export type RecordRelation = 'deviceEmpty' | 'noRecord' | 'shared' | 'unrelated' | 'unread';

/** Compare the device copy with the record the new sign-in reaches (null: none there). */
export function recordRelation(deviceIds: readonly string[], cloud: unknown): RecordRelation {
  if (deviceIds.length === 0) return 'deviceEmpty';
  if (cloud === null || cloud === undefined) return 'noRecord';
  const here = new Set(deviceIds);
  return recordRowIds(cloud).some((id) => here.has(id)) ? 'shared' : 'unrelated';
}

/**
 * What a device with no pin, holding a copy from an earlier cloud session,
 * knows about a new sign-in, gathered in this order: (i) the earlier account,
 * read with that provider's credentials still stored here (null: they could
 * not name it); (ii) Drive: whether the new sign-in can see the record file id
 * cached here; (iii) the record the new sign-in reaches, against the device copy.
 */
export interface AdoptFacts {
  earlierAccount?: string | null;
  cachedFileVisible?: boolean;
  record?: RecordRelation;
}

/** May the new sign-in become this device's pin? The first fact that decides, decides. */
export function adoptVerdict(account: string, facts: AdoptFacts): 'adopt' | 'refuse' {
  if (typeof facts.earlierAccount === 'string') return facts.earlierAccount === account ? 'adopt' : 'refuse';
  if (facts.cachedFileVisible !== undefined) return facts.cachedFileVisible ? 'adopt' : 'refuse';
  return facts.record === 'deviceEmpty' || facts.record === 'noRecord' || facts.record === 'shared' ? 'adopt' : 'refuse';
}

/** What the host knows when a sign-in comes back. Read lazily, in order. */
export interface SignInCheck {
  /** The new sign-in's account, read with its own credentials. */
  readAccount(): Promise<string>;
  /** A deliberate switch whose hand-off finished: the new account replaces the pin. */
  switching: boolean;
  /** The pin, read after the account read so a pin another page set meanwhile is the one compared. */
  pinned(): AccountPin | null;
  /** No pin, and this device holds a copy from an earlier cloud session. */
  earlierSession(): boolean;
  adoptFacts(account: string): Promise<AdoptFacts>;
}

/**
 * Before a sign-in is kept: the pin to keep with it, or null to refuse it.
 * A sign-in whose account cannot be read is refused: it cannot be pinned, or
 * shown to be the pinned one. The caller keeps the pin in the same step as
 * the sign-in, so a refused, failed or stopped attempt leaves no pin.
 */
export async function admitSignIn(provider: string, check: SignInCheck): Promise<AccountPin | null> {
  const account = await check.readAccount().then((id) => id || null, () => null);
  if (!account) return null;
  const signedIn: AccountPin = { provider, account };
  if (check.switching) return signedIn;
  const pinned = check.pinned();
  if (pinned) return pinVerdict(pinned, signedIn) === 'same' ? pinned : null;
  if (!check.earlierSession()) return signedIn;
  return adoptVerdict(account, await check.adoptFacts(account)) === 'adopt' ? signedIn : null;
}
