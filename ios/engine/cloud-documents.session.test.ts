// US-52 AC13d: documentSave keeps to the cloud session it was asked of. One that waits in the
// document queue while that session closes and another opens in its place (at the same erase
// identity) answers not-open and writes nothing to the new one. `./cloud` is a stand-in here whose
// open session the test swaps, as in upload-save-door.session.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { BusyError } from '../../packages/health-core/src/adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const cloud = vi.hoisted(() => ({ open: null as unknown, commits: [] as unknown[] }));
vi.mock('./cloud', () => ({
  get open() { return cloud.open; },
  NOT_OPEN: 'The cloud record is not open.',
  ERASED: 'Your record was erased on another device, so this was not saved.',
  commit: (at: unknown, file: unknown) => { cloud.commits.push([at, file]); return null; },
}));
const { documentSave, oneDocumentSaveAtATime } = await import('./cloud-documents');

/** A session as the door reads it: its record, its erase and a store that counts puts. */
function session(name: string) {
  const puts: string[] = [];
  const file = createEmptyFile({ deviceId: name, now: NOW });
  return { puts, at: { session: { file, refuses: () => false, eraseIdentity: '[0,null]' }, host: { store: { writeDocument: async (ref: string) => void puts.push(ref) } } } };
}
const letter = JSON.stringify({ classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: {} } });
const choice = JSON.stringify({ kind: 'document', sourceFileName: 'Letter.pdf', title: 'Synthetic letter', documentDate: null, mimeType: 'application/pdf', contentHash: 'sha256-letter' });

describe('documentSave keeps to the session it was asked of (US-52 AC13d)', () => {
  it('the session closes and another opens at the same erase while it waits: not-open, nothing put, nothing committed', async () => {
    const a = session('a');
    const b = session('b');
    cloud.open = a.at;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holding = oneDocumentSaveAtATime(() => gate.then(() => '{}'));
    const queued = documentSave('', letter, choice, new Uint8Array([1]).buffer, '[0,null]', NOW, 'phone');
    cloud.open = b.at;
    release();
    await holding;
    expect(JSON.parse(await queued)).toMatchObject({ ok: false, reason: 'not-open' });
    expect(b.puts).toEqual([]);
    expect(cloud.commits).toEqual([]);
  });
});

describe('documentSave checks for an erase before every write, retries included (US-11 AC1a)', () => {
  it('a busy refusal, then an erase during the wait: no second write, erased, nothing committed', async () => {
    vi.useFakeTimers();
    const a = session('a');
    let erased = false;
    a.at.session.refuses = () => erased;
    a.at.host.store.writeDocument = async (ref: string) => {
      a.puts.push(ref);
      setTimeout(() => { erased = true; }, 1); // the erase lands during the retry's wait
      throw new BusyError('busy', 0, 409);
    };
    cloud.open = a.at;
    cloud.commits.length = 0;
    const answer = documentSave('', letter, choice, new Uint8Array([1]).buffer, '[0,null]', NOW, 'phone');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(JSON.parse(await answer)).toMatchObject({ ok: false, reason: 'erased' });
    expect(a.puts).toHaveLength(1);
    expect(cloud.commits).toEqual([]);
  });
});
