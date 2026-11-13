/**
 * The Google Drive code exchange's answer. A refused exchange fails with its
 * status. A 2xx reply is used only when whole (US-09 AC37,
 * issue #924), as Dropbox's is (AC1a): a non-empty access token and a finite
 * expiry. Anything else, a 200 whose body is not JSON included, fails as a
 * StorageError and the caller keeps nothing. The refresh grant's call lives
 * here too.
 */
import * as z from '@roadmap/health-core/zod';
import { StorageError } from '@roadmap/health-core/adapter';
import { TRANSFER_DEADLINE_MS, timeoutDeadline } from '@roadmap/health-core/transfer-deadline';

const codeGrantSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresIn: z.number().finite(),
  idToken: z.string().optional(),
});

export async function codeGrantReply(res: Response): Promise<z.infer<typeof codeGrantSchema>> {
  if (!res.ok) {
    throw new StorageError(`Google Drive connect failed (${res.status}): ${await res.text()}`, undefined, undefined, res.status);
  }
  const reply = codeGrantSchema.safeParse(await res.json().catch(() => null));
  if (!reply.success) throw new StorageError('Google Drive sent an incomplete sign-in reply. Please reconnect.');
  return reply.data;
}

type RefreshGrant = { accessToken: string; expiresIn: number; idToken?: string };

/**
 * POST a refresh grant to the stateless endpoint and read a 2xx body, both in
 * one 5 s deadline and one catch. This runs at page load before first render:
 * a black-holing server must fail fast into the on-device + Reconnect
 * fallback, not hang. Null when the call or the body read failed (no answer, a
 * body that stalls past the deadline, dies or is not JSON), which the caller
 * treats as transient, never a rejection (review of #788). A 400 or 401 body is
 * read only for Google's error code, which the endpoint passes on: only
 * `invalid_grant` means the grant is dead (US-09 AC47). Other non-2xx bodies
 * are not read; a 2xx whose body is JSON `null` comes back with `json: null`.
 */
export async function postRefreshGrant(url: string, refreshToken: string): Promise<{ status: number; json?: RefreshGrant | null; error?: unknown } | null> {
  const deadline = timeoutDeadline(TRANSFER_DEADLINE_MS.tokenRefresh);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // No Content-Type: keep it a CORS simple request (no preflight).
      body: JSON.stringify({ grantType: 'refresh', refreshToken }),
      signal: deadline.signal,
    });
    if (res.status === 400 || res.status === 401) {
      return { status: res.status, error: ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error };
    }
    return { status: res.status, json: res.ok ? ((await res.json()) as RefreshGrant | null) : undefined };
  } catch {
    return null;
  } finally {
    deadline.clear();
  }
}
