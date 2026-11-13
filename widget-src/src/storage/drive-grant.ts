/**
 * What a Google grant says, read before any token is kept: whether it includes
 * Drive (US-09 AC15), and the verified email in its ID token (US-17 AC7).
 * Moved out of drive.ts unchanged; drive.ts re-exports it.
 */
import { StorageError } from '@roadmap/health-core/adapter';

/**
 * The verified email inside a Google ID token, or null. No signature check:
 * this runs in the user's own browser on a token Google just handed it, and
 * the only consumer is a prefill. The server verifies the token itself.
 */
export function decodeIdTokenEmail(idToken: string): string | null {
  try {
    const payload = idToken.split('.')[1] ?? '';
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: string; email_verified?: boolean };
    return claims.email_verified === true && claims.email ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The one scope Drive access needs; `google-config.ts` builds the request from it. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Google names the approved scopes on both connect paths (the redirect URL,
 * the popup's token response), so a grant with the Drive box left unticked is
 * known BEFORE any token is kept (US-09 AC15). A response that omits the list
 * is trusted, as it was before the check.
 */
export function grantsDrive(scope?: string): boolean {
  return typeof scope !== 'string' || scope.split(' ').includes(DRIVE_FILE_SCOPE);
}

/** A grant without `drive.file`, refused at connect (US-09 AC15). The message
 *  is what the user is told, so it names the box. */
export class DriveGrantRefusedError extends StorageError {
  constructor() {
    super(
      "Google didn't grant this app access to Google Drive, so nothing was connected. " +
        "Try again and tick the Google Drive box on Google's permission screen.",
    );
    this.name = 'DriveGrantRefusedError';
  }
}
