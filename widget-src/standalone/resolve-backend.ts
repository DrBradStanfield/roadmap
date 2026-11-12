/**
 * The backend a standalone page load runs on: a returning OAuth redirect, a
 * remembered choice, else the on-device tier. Apart from app.tsx, which
 * renders on import, so tests run this real code.
 */
import { DropboxAdapter, GoogleDriveAdapter } from '../src/storage';
import { dropboxConfig } from './dropbox-config';
import { googleDriveConfig } from './google-config';
import {
  connectRefusal,
  liftLocalInto,
  rememberBackend,
  reportConnectFailure,
  resolveRemembered,
  type ResolvedBackend,
} from './connect';
import { trackProductEvent } from '../src/lib/server-api';
import { signInStamp } from '../src/lib/storage';

/** The backend this load runs on, and the connect it refused on the way, if
 *  any (US-09 AC15) — kept apart from the backend so a load-time fallback
 *  cannot drop it. */
export async function resolveBackend(): Promise<{ resolved: ResolvedBackend; refused?: string }> {
  // An OAuth return is a sign-in that started at this page load (US-09 AC45).
  const startedAt = signInStamp();
  // Cancel or Deny at the provider (US-09 AC22; browser Back never returns here): counted once, nothing connected.
  if (DropboxAdapter.claimCancelledRedirect()) trackProductEvent('cloud_connect_cancelled', { provider: 'dropbox' });
  if (GoogleDriveAdapter.claimCancelledRedirect()) trackProductEvent('cloud_connect_cancelled', { provider: 'google-drive' });

  // Returning from a Dropbox OAuth redirect?
  let resumed: DropboxAdapter | null = null;
  let refused: string | undefined;
  try {
    resumed = await DropboxAdapter.completeRedirect(dropboxConfig(), startedAt);
  } catch (error) {
    refused = reportConnectFailure(error, 'dropbox');
  }
  if (resumed) {
    await liftLocalInto(resumed, 'dropbox');
    // Refused after a log-off this page heard meanwhile: the sign-in was taken back.
    if (rememberBackend('dropbox', startedAt)) {
      trackProductEvent('cloud_connect_success', { provider: 'dropbox' });
      return { resolved: { adapter: resumed, backend: 'dropbox' } };
    }
  }

  // Returning from a Google Drive OAuth redirect? (Each completeRedirect only
  // claims a ?code that its own PKCE session entry initiated.)
  let gdResumed: GoogleDriveAdapter | null = null;
  try {
    gdResumed = await GoogleDriveAdapter.completeRedirect(googleDriveConfig(), startedAt);
  } catch (error) {
    refused = connectRefusal(error) ?? reportConnectFailure(error, 'google-drive');
  }
  if (gdResumed) {
    await liftLocalInto(gdResumed, 'google-drive');
    if (rememberBackend('google-drive', startedAt)) {
      trackProductEvent('cloud_connect_success', { provider: 'google-drive' });
      return { resolved: { adapter: gdResumed, backend: 'google-drive' } };
    }
  }

  return { resolved: await resolveRemembered(), refused };
}
