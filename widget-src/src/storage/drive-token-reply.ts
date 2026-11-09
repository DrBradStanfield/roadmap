/**
 * The Google Drive code exchange's answer. A refused exchange fails with its
 * status. A 2xx reply is used only when whole (US-09 AC37,
 * issue #924), as Dropbox's is (AC1a): a non-empty access token and a finite
 * expiry. Anything else, a 200 whose body is not JSON included, fails as a
 * StorageError and the caller keeps nothing.
 */
import * as z from '@roadmap/health-core/zod';
import { StorageError } from '@roadmap/health-core/adapter';

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
