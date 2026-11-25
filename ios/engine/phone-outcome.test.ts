// US-10 AC17 (root fix R6, PR 3b): the iPhone's own raise sites name their outcome. A token
// refresh Swift says got no answer is raised before its call ('no-answer'), and a phone file
// write Swift refused left the file as it was ('refused': Swift writes atomically). Before,
// neither named one, so a save that met either inside its write marked it may have landed
// (write-refusal.ts afterWrite). Read through SyncManager.save, as the session's save and erase
// read it: `mayHaveLanded` is what decides whether a failed erase is put back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME, StorageError } from '../../packages/health-core/src/adapter';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import { SyncManager } from '../../packages/health-core/src/sync-manager';
import { mayHaveLanded } from '../../packages/health-core/src/write-refusal';
import { PhoneCloudAdapter, PhoneFileAdapter } from './cloud-adapters';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { deviceId: 'ios-1', now: NOW };
const record = JSON.stringify(ROADMAP_DOC.migrate(null, ctx));

function natives(overrides: Record<string, unknown>): void {
  vi.stubGlobal('__native', {
    phoneRead: () => JSON.stringify({ text: record }),
    phoneWrite: () => '',
    notify: () => {},
    ...overrides,
  });
}

async function saveError(adapter: ConstructorParameters<typeof SyncManager>[0]): Promise<unknown> {
  const sync = new SyncManager(adapter, 'ios-1', ROADMAP_DOC, { now: () => NOW });
  return sync.save(ROADMAP_DOC.migrate(null, ctx)).then(() => null, (e: unknown) => e);
}

afterEach(() => vi.unstubAllGlobals());

describe('US-10 AC17: the iPhone adapters name their outcome', () => {
  it('a token refresh with no answer, met by the write before its upload: no-answer, not landed (was landed)', async () => {
    let asks = 0;
    let uploads = 0;
    natives({
      // The read's token is granted; the write's gets no answer, as Swift words it.
      accessToken: (_p: string, _f: boolean, done: (t: string | null, e: string | null, s: boolean) => void) =>
        (++asks === 1 ? done('test-token-good', null, false) : done(null, 'Dropbox did not answer.', false)),
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/files/upload')) uploads++;
      return new Response(record, { headers: { 'dropbox-api-result': JSON.stringify({ rev: 'r1' }) } });
    }));
    const error = await saveError(new PhoneCloudAdapter('dropbox', 1));
    expect(error).toBeInstanceOf(StorageError);
    expect({ outcome: (error as StorageError).outcome, landed: mayHaveLanded(error), uploads }).toEqual({ outcome: 'no-answer', landed: false, uploads: 0 });
  });

  it('a phone file write Swift refused: refused, not landed, the file unchanged (was landed)', async () => {
    natives({ phoneWrite: () => 'The disk is full.' });
    const error = await saveError(new PhoneFileAdapter());
    expect(error).toBeInstanceOf(StorageError);
    expect({ outcome: (error as StorageError).outcome, landed: mayHaveLanded(error) }).toEqual({ outcome: 'refused', landed: false });
    expect(JSON.parse(await new PhoneFileAdapter().read(ROADMAP_FILE_NAME).then((r) => JSON.stringify(r.body)))).toEqual(JSON.parse(record));
  });
});
