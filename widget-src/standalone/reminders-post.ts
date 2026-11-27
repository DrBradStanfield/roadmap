/**
 * The reminders route's posts, moved whole out of reminders.ts (file budget),
 * so Turn off (reminders-turn-off.ts) and the rest share them. All POSTs use
 * the text/plain CORS simple-request protocol (remix-serve can't answer
 * preflights).
 */
import { GoogleDriveAdapter } from '../src/storage';
import { googleDriveConfig } from './google-config';
import { BRAD_SERVER_ORIGIN } from './server-origin';
import type { ReminderBackend } from './providers';

const REMINDERS_API_URL = `${BRAD_SERVER_ORIGIN}/api/reminders-v2`;

export async function post(body: unknown, keepalive = false): Promise<Response> {
  return fetch(REMINDERS_API_URL, {
    method: 'POST',
    // No Content-Type header → text/plain → CORS simple request (no preflight).
    body: JSON.stringify(body),
    keepalive,
  });
}

/** The ID token for a Drive-verified cancel (hard delete); null on any other lane or failure. */
export async function cancelProofFor(backend: ReminderBackend): Promise<string | null> {
  switch (backend) {
    case 'google-drive':
      return new GoogleDriveAdapter(googleDriveConfig()).getReminderIdToken().catch(() => null);
    case 'dropbox':
    case 'github':
      return null;
    default: {
      // Exhaustive at compile time; at run time the file's provider is not
      // validated, so an unknown one cancels without proof, as it always has.
      const unlisted: never = backend;
      void unlisted;
      return null;
    }
  }
}

/** A cancel, with the ID token only when there is one: the route's zod
 *  `.optional()` takes a missing key but answers null with a 400 (US-17 AC1b). */
export function postCancel(token: string, idToken: string | null, keepalive = false): Promise<Response> {
  return post({ op: 'cancel', token, ...(idToken ? { idToken } : {}) }, keepalive);
}
