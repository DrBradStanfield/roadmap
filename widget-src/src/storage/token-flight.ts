/**
 * One sign-in refresh at a time per page (US-09 AC47), the web twin of the
 * iPhone's `OAuthClient.accessToken` (M8). Every adapter on the page shares it,
 * the reminders' own instances included, because each instance keeps its own
 * tokens and would otherwise post its own refresh.
 *
 * A flight is keyed by provider AND refresh token: a refresh begun before a new
 * sign-in is never joined after it. The flight carries only the provider's
 * answer. Each caller then re-reads its own stored grant (US-09 AC2f) and
 * decides what to keep or clear, so a joiner judges the answer exactly as the
 * caller that started it does.
 */
import { getSignIn, setSignIn, type LogOffId } from '../lib/storage';

export type TokenProvider = 'google-drive' | 'dropbox';

type Grant = { accessToken: string; refreshToken?: string; expiresAt: number };

/** An access token the provider answered with a 401 (US-09 AC50). A grant with no refresh token (a Drive
 *  popup grant) is spent for every adapter in this browser, in any tab: its stored copy is saved expired,
 *  and `spentHere` reads it. A grant saved since under `key` (a reconnect) is a different token and stays.
 *  With a refresh token only this copy is spent: the refresh decides, and a late 401 must not spend the
 *  token a refresh saved meanwhile. */
export function spendToken<T extends Grant>(key: string, tokens: T, gen: LogOffId): T {
  const spent = { ...tokens, expiresAt: 0 };
  if (!tokens.refreshToken && getSignIn<T>(key)?.accessToken === tokens.accessToken) setSignIn(key, spent, gen);
  return spent;
}

/** `tokens` as this browser now knows them: expired once any adapter spent the same token (US-09 AC50). */
export function spentHere<T extends Grant>(key: string, tokens: T): T {
  const stored = getSignIn<T>(key);
  return stored?.accessToken === tokens.accessToken && stored.expiresAt === 0 ? stored : tokens;
}

/** The refreshes in flight on this page, by provider and refresh token. */
const flights = new Map<string, Promise<unknown>>();

/** The refresh in flight for this grant, or `run()` started as it. The key is
 *  freed when the flight settles, so a later caller starts a new one. */
export function refreshOnce<T>(provider: TokenProvider, refreshToken: string, run: () => Promise<T>): Promise<T> {
  const key = `${provider} ${refreshToken}`;
  const running = flights.get(key);
  if (running) return running as Promise<T>;
  const flight = (async () => run())().finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}
