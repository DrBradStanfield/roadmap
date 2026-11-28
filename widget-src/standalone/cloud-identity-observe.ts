/**
 * US-09 AC67: a measurement that precedes a design. On the Shopify build's
 * full app with a cloud record open, at most once a day per provider, count
 * whether the cloud account id can be read on the web, and how many record
 * copies Drive lists as owned. The iPhone already reads this id; the web will
 * need it for a planned storage change.
 *
 * It changes nothing a person sees. It uses the token the page's own adapter
 * holds and never refreshes one. Each call is a bare, bounded fetch with no
 * retry, outside the adapter, so a refusal here never touches the page's
 * sign-in. Answers are judged into closed words (health-core's
 * cloud-identity.ts) and dropped. The only thing written is the day key.
 */
import { useEffect } from 'react';
import { fetchOrFail, ROADMAP_FILE_NAME, type StorageAdapter } from '@roadmap/health-core/adapter';
import { classifyCopies, classifyIdentityRead, type IdentityGrant, type IdentityProvider, type TokenReplyWord } from '@roadmap/health-core/cloud-identity';
import { DRIVE_API } from '@roadmap/health-core/drive-rest';
import { DropboxAdapter, GitHubAdapter, GoogleDriveAdapter } from '../src/storage';
import { ACCOUNT_URL as DROPBOX_ACCOUNT_URL } from '../src/storage/dropbox';
import { lostSignIn } from '../src/storage/sign-in-state';
import { trackProductEvent } from '../src/lib/server-api';
import { SHOPIFY_SURFACE } from '../src/lib/build-flags';
import { healthWritesAllowed, IDENTITY_DAY_KEY, ownLogOffHasBegun, safeGetItem, safeSetItem } from '../src/lib/storage';

const CALL_TIMEOUT_MS = 8_000;

const DRIVE_ABOUT_URL = `${DRIVE_API}/about?fields=${encodeURIComponent('user(permissionId)')}`;
/** The record lookup's own name and space (drive-rest-record.ts), one page of 100. */
const DRIVE_COPIES_URL = `${DRIVE_API}/files?q=${encodeURIComponent(`name='${ROADMAP_FILE_NAME}' and trashed=false`)}`
  + `&spaces=drive&fields=${encodeURIComponent('files(ownedByMe),nextPageToken,incompleteSearch')}&pageSize=100`;
const GITHUB_USER_URL = 'https://api.github.com/user';

interface Held { provider: IdentityProvider; token: string | null; grant: IdentityGrant; tokenReply?: TokenReplyWord }

/** The page's adapter's provider and held token, and a Dropbox adapter's redirect word (taken once);
 *  null for any other store (the device, WebDAV). */
function heldBy(adapter: StorageAdapter): Held | null {
  if (adapter instanceof GoogleDriveAdapter) return { provider: 'google-drive', ...adapter.heldToken() };
  if (adapter instanceof DropboxAdapter) return { provider: 'dropbox', ...adapter.heldToken(), tokenReply: adapter.takeTokenReply() ?? undefined };
  if (adapter instanceof GitHubAdapter) return { provider: 'github', ...adapter.heldToken() };
  return null;
}

/** One call: its status and parsed body, or a null status when no answer came. Never throws. */
async function ask(url: string, init: RequestInit): Promise<{ status: number | null; body: unknown }> {
  try {
    // no-store: an answer is never served from, or kept in, the browser's HTTP cache.
    const res = await fetchOrFail('cloud', url, { ...init, cache: 'no-store', timeoutMs: CALL_TIMEOUT_MS });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  } catch {
    return { status: null, body: undefined };
  }
}

function readIdentity(provider: IdentityProvider, auth: Record<string, string>): Promise<{ status: number | null; body: unknown }> {
  if (provider === 'google-drive') return ask(DRIVE_ABOUT_URL, { headers: auth });
  // The same no-argument call as the reminders' email read (dropbox.ts).
  if (provider === 'dropbox') return ask(DROPBOX_ACCOUNT_URL, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: 'null' });
  return ask(GITHUB_USER_URL, { headers: { ...auth, Accept: 'application/vnd.github+json' } });
}

/** Fire and forget. Every failure is silent. */
export async function observeCloudIdentity(adapter: StorageAdapter): Promise<void> {
  try {
    if (!SHOPIFY_SURFACE) return;
    const held = heldBy(adapter);
    if (!held) return;
    // The adapter a Dropbox redirect made carries its token-reply word, and reads even if today's read
    // is done: a sign-in usually follows a load that already read.
    const { provider, token, grant, tokenReply } = held;
    const key = IDENTITY_DAY_KEY + provider;
    const day = new Date().toISOString().slice(0, 10);
    if (safeGetItem(key) === day && !tokenReply) return;
    // The log-off barrier: a page whose writes have stopped writes no key and asks nothing.
    if (!healthWritesAllowed() || ownLogOffHasBegun()) return;
    // The day's slot is taken only if the write was taken and reads back: a refused or full storage asks
    // nothing and sends nothing, even where an earlier write left today's day in place.
    if (!safeSetItem(key, day) || safeGetItem(key) !== day) return;
    const read = { provider, grant, ...(tokenReply ? { tokenReply } : {}) };
    if (!token || lostSignIn()) {
      trackProductEvent('cloud_identity_read', { ...read, outcome: 'skipped' });
      return;
    }
    const auth = { Authorization: `Bearer ${token}` };
    // Drive's two calls are independent, so they run together; the events keep their order.
    const [identity, copies] = await Promise.all([
      readIdentity(provider, auth),
      provider === 'google-drive' ? ask(DRIVE_COPIES_URL, { headers: auth }) : null,
    ]);
    trackProductEvent('cloud_identity_read', { ...read, outcome: classifyIdentityRead(provider, identity.status, identity.body) });
    if (copies) trackProductEvent('drive_record_copies', classifyCopies(copies.status, copies.body));
  } catch {
    /* a measurement never breaks the page */
  }
}

/** Starts the observation once the full app has committed its first render. Under Strict Mode the
 *  effect runs twice; the day key (and the Dropbox word, taken once) makes the second a no-op. */
export function CloudIdentityObserver({ adapter }: { adapter: StorageAdapter }): null {
  useEffect(() => { void observeCloudIdentity(adapter); }, [adapter]);
  return null;
}
