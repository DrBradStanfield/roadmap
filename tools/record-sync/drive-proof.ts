/** An opt-in experiment on an ALREADY CREATED synthetic file. Never creates or deletes files. */
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const fixture = z.object({ recordSyncProbe: z.literal(1), writer: z.enum(['seed', 'new', 'stale']) }).strict();
interface DriveObservation {
  observation: 'missing-strong-etag' | 'fresh-write-rejected' | 'stale-write-rejected' | 'stale-write-not-rejected' | 'inconclusive';
  staleStatus?: number;
  newerContentRetained?: boolean;
  productionCleanupEnabled: false;
}

/** Observing 412 is necessary evidence, not a guarantee about every write/list/migration path. */
export async function probeDrive(fileId: string, token: string, request: typeof fetch = fetch): Promise<DriveObservation> {
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(fileId) || !token) throw new Error('A dedicated synthetic file and token are required');
  const metadataUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,version`;
  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
  const headers = { Authorization: `Bearer ${token}` };
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    // No redirects with a credential. A timeout is inconclusive, never permission to clean.
    return request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { ...headers, ...init.headers } });
  }
  async function readFixture(): Promise<z.infer<typeof fixture>> {
    const response = await call(mediaUrl);
    if (!response.ok) throw new Error('Synthetic fixture could not be read');
    const parsed = fixture.safeParse(await response.json());
    if (!parsed.success) throw new Error('Refusing a file that is not the synthetic probe fixture');
    return parsed.data;
  }
  const metadata = await call(metadataUrl);
  if (!metadata.ok) throw new Error('Synthetic metadata could not be read');
  // Metadata then content, like the existing adapter. Never infer an ETag from version.
  await readFixture();
  const etag = metadata.headers.get('etag');
  if (!etag || etag.startsWith('W/')) return { observation: 'missing-strong-etag', productionCleanupEnabled: false };
  const write = (writer: 'new' | 'stale') => call(uploadUrl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify({ recordSyncProbe: 1, writer }),
  });
  const fresh = await write('new');
  if (!fresh.ok) return { observation: 'fresh-write-rejected', productionCleanupEnabled: false };
  if ((await readFixture()).writer !== 'new') throw new Error('Fresh synthetic write was not observed');
  // Delayed old writer acts only AFTER the newer writer received and verified success.
  const stale = await write('stale');
  const newerContentRetained = (await readFixture()).writer === 'new';
  return {
    observation: stale.status === 412 && newerContentRetained ? 'stale-write-rejected'
      : stale.ok ? 'stale-write-not-rejected' : 'inconclusive',
    staleStatus: stale.status, newerContentRetained, productionCleanupEnabled: false,
  };
}

if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [flag, fileId, ...extra] = process.argv.slice(2);
  if (flag !== '--live' || !fileId || extra.length) {
    console.error('Usage: RECORD_SYNC_DRIVE_TOKEN=... node --import tsx tools/record-sync/drive-proof.ts --live SYNTHETIC_FILE_ID');
    process.exitCode = 1;
  } else {
    try {
      const result = await probeDrive(fileId, process.env.RECORD_SYNC_DRIVE_TOKEN ?? '');
      console.log(JSON.stringify(result, null, 2));
      if (result.observation !== 'stale-write-rejected') process.exitCode = 1;
    } catch {
      console.error('Drive probe was inconclusive. No production cleanup is enabled.');
      process.exitCode = 1;
    }
  }
}
