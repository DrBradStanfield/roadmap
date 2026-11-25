/**
 * A cloud sign-in stays with the account this device first connected; another
 * account is refused until the person logs off (US-09 AC54). The iPhone keeps
 * the same rule in Swift (CloudSync.swift); this is the engine's copy, for the
 * web now and any host later.
 *
 * The account is an opaque id the provider names at sign-in (Drive's
 * `about.user.permissionId`, Dropbox's `account_id`, GitHub's user id with the
 * repository): never an email. It is kept on the device only, behind the
 * host's `AccountPinStore`, and is never logged, sent to telemetry or put in a URL.
 */

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

/** The host's door to the one stored pin. `write` is true when it was kept. */
export interface AccountPinStore {
  read(): AccountPin | null;
  write(pin: AccountPin): boolean;
  clear(): void;
}

/** A stored value as a pin, or null for anything else. */
export function parsePin(value: unknown): AccountPin | null {
  if (!value || typeof value !== 'object') return null;
  const { provider, account } = value as { provider?: unknown; account?: unknown };
  return typeof provider === 'string' && provider && typeof account === 'string' && account ? { provider, account } : null;
}

/**
 * Before a sign-in is kept: true when it may be kept. The account is read
 * first and the pin after that read, so a pin another page set meanwhile is
 * the one compared. With no pin the sign-in is kept and pins its account; an
 * account that could not be read leaves the pin for the next good load. With a
 * pin, an account that could not be read is refused: it cannot be shown to be
 * the same one.
 */
export async function admitSignIn(store: AccountPinStore, provider: string, readAccount: () => Promise<string>): Promise<boolean> {
  const account = await readAccount().then((id) => id || null, () => null);
  const pinned = store.read();
  if (!pinned) {
    if (account) store.write({ provider, account });
    return true;
  }
  return account !== null && pinVerdict(pinned, { provider, account }) === 'same';
}
