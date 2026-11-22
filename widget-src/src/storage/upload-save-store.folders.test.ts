/**
 * US-14 AC10: the web's Save tells the engine whether its cloud makes a ref's folders in the write itself. Dropbox
 * does (an overwrite upload makes the parents), so its originals pool from the first write; every other backend
 * keeps the solo first write per folder (Google Drive's find-or-create). Synthetic state only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordSession } from '@roadmap/health-core/record-session';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import type { UploadSaveIO } from '@roadmap/health-core/upload-save';
import { saveUploadThrough, type Original, type UploadEngine } from './upload-save-store';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

async function ioFor(backend: string): Promise<UploadSaveIO<Original>> {
  let seen: UploadSaveIO<Original> | null = null;
  const engine = {
    uploadSave: async (_s: UploadState, _r: unknown, _n: string, _c: boolean, io: UploadSaveIO<Original>) => {
      seen = io;
      return { ok: false, reason: 'not-ready', message: 'stop here' } as const;
    },
  } as unknown as UploadEngine;
  const session = { shownErase: 'e', refuses: () => false, file: {} } as unknown as RecordSession;
  const io = { holds: () => false, original: () => null, mimeType: () => '' };
  await saveUploadThrough(session, { write: async () => {}, backend }, engine, {} as UploadState, '2026-02-01T00:00:00.000Z', true, io);
  return seen!;
}

describe('the web Save says whether its cloud makes folders (US-14 AC10)', () => {
  it('Dropbox: makesFolders; Google Drive, GitHub and the device: the default solo first write', async () => {
    expect((await ioFor('dropbox')).makesFolders).toBe(true);
    for (const backend of ['google-drive', 'github', 'local', 'self-host']) expect((await ioFor(backend)).makesFolders, backend).toBe(false);
  });
});
