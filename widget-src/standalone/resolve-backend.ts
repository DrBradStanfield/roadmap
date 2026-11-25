/**
 * The backend a standalone page load runs on: a returning OAuth redirect, a
 * remembered choice, else the on-device tier. Apart from app.tsx, which
 * renders on import, so it can be imported alone.
 */
import { DropboxAdapter, GoogleDriveAdapter, markSyncPending } from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import {
  connectRefusal,
  liftLocalInto,
  rememberSignIn,
  reportConnectFailure,
  resolveRemembered,
  type ResolvedBackend,
} from './connect';
import { trackProductEvent } from '../src/lib/server-api';
import { SignInUnfinishedError } from '../src/storage/pkce';
import { sweepStaleSignIns } from '../src/lib/storage';
import { SIGN_IN_KEYS } from './providers';

/** A sign-in that began before a log-off on this device opens as a guest (US-09 AC45), and says so
 *  (lead C29; words Brad 2026-11-26). Not a defect, so not reported. */
export const SIGN_IN_UNFINISHED = 'Sign-in did not finish because this browser was logged off. Please try again.';

/** The line a redirect return that failed shows: one sentence per cause. */
function returnFailure(error: unknown, backend: 'dropbox' | 'google-drive'): string {
  return error instanceof SignInUnfinishedError ? SIGN_IN_UNFINISHED : reportConnectFailure(error, backend);
}

/** The backend this load runs on, and the connect it refused on the way, if
 *  any (US-09 AC15) — kept apart from the backend so a load-time fallback
 *  cannot drop it. */
export async function resolveBackend(): Promise<{ resolved: ResolvedBackend; refused?: string }> {
  sweepStaleSignIns(SIGN_IN_KEYS); // every page load: sign-ins from before the latest log-off (US-09 AC45)
  // Cancel or Deny at the provider (US-09 AC22; browser Back never returns here): counted once, nothing connected.
  if (DropboxAdapter.claimCancelledRedirect()) trackProductEvent('cloud_connect_cancelled', { provider: 'dropbox' });
  if (GoogleDriveAdapter.claimCancelledRedirect()) trackProductEvent('cloud_connect_cancelled', { provider: 'google-drive' });

  // Returning from a Dropbox OAuth redirect?
  let resumed: DropboxAdapter | null = null;
  let refused: string | undefined;
  try {
    resumed = await DropboxAdapter.completeRedirect(dropboxConfig());
  } catch (error) {
    refused = returnFailure(error, 'dropbox');
  }
  // A returned adapter saved its own sign-in under the log-off id it began
  // under (US-09 AC45); otherwise the page opens as if nothing was tried.
  if (resumed && rememberSignIn(true, 'dropbox', resumed.gen)) {
    markSyncPending();
    await liftLocalInto(resumed, 'dropbox');
    trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
    return { resolved: { adapter: resumed, backend: 'dropbox' } };
  }

  // Returning from a Google Drive OAuth redirect? (Each completeRedirect only
  // claims a ?code that its own PKCE session entry initiated.)
  let gdResumed: GoogleDriveAdapter | null = null;
  try {
    gdResumed = await GoogleDriveAdapter.completeRedirect(googleDriveConfig());
  } catch (error) {
    refused = connectRefusal(error) ?? returnFailure(error, 'google-drive');
  }
  if (gdResumed && rememberSignIn(true, 'google-drive', gdResumed.gen)) {
    markSyncPending();
    await liftLocalInto(gdResumed, 'google-drive');
    trackProductEvent('cloud_connect_success', { provider: 'google-drive' });
    return { resolved: { adapter: gdResumed, backend: 'google-drive' } };
  }

  return { resolved: await resolveRemembered(), refused };
}
