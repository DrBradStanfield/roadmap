// US-14 AC5: the originals a Save stores. The first write into each folder runs alone only where the provider
// needs it (Google Drive's find-or-create of a folder, the default); a writer whose provider makes the folders in
// the write itself (Dropbox, `makesFolders`) pools every write, still at most three at once. Synthetic bytes only.
import { describe, expect, it } from 'vitest';
import { createEmptyFile } from './roadmap-file';
import { labArchivePayload, saveDocuments, type DocumentPayload, type DocumentSaveIO } from './document-save';

const bytes = (text: string) => new TextEncoder().encode(text);
const TYPES = ['clinic_letter', 'scan_result', 'other'] as const;
/** 18 originals across 4 folders: 3 lab reports (Lab results), then 15 others round the other three folders. */
const EIGHTEEN: DocumentPayload<Uint8Array>[] = [
  ...Array.from({ length: 3 }, (_, i) => labArchivePayload(`lab${i}.pdf`, `2026-01-0${i + 1}`, bytes(`lab ${i}`))),
  ...Array.from({ length: 15 }, (_, i) => ({
    documentType: TYPES[i % 3], title: `Doc ${i}`, documentDate: '2026-01-01', contentMd: '', metadata: {},
    sourceFileName: `doc${i}.pdf`, file: bytes(`doc ${i}`),
  })),
];
const folderOf = (ref: string) => ref.split('/')[0];

/** A writer whose writes wait until the test releases them, oldest first; it records every start and end. */
function gated(makesFolders?: boolean) {
  const events: Array<{ kind: 'start' | 'end'; ref: string }> = [];
  const waiting: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  let n = 0;
  const io: DocumentSaveIO<Uint8Array> = {
    hash: async (b) => `sha256-${new TextDecoder().decode(b)}`,
    write: (ref) => new Promise<void>((resolve) => {
      events.push({ kind: 'start', ref });
      peak = Math.max(peak, ++active);
      waiting.push(() => { active--; events.push({ kind: 'end', ref }); resolve(); });
    }),
    mimeType: () => 'application/pdf',
    now: () => '2026-02-01T00:00:00.000Z',
    newId: () => `doc-${++n}`,
    ...(makesFolders === undefined ? {} : { makesFolders }),
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Release one write at a time until the save ends. */
  async function drain(done: Promise<unknown>) {
    let over = false;
    void done.then(() => { over = true; });
    await settle();
    while (!over) {
      waiting.shift()?.();
      await settle();
    }
  }
  return { io, events, waiting, peak: () => peak, settle, drain };
}

describe('saveDocuments: the solo first write per folder (US-14 AC5)', () => {
  it('a writer that makes its folders: 18 originals across 4 folders start three at once, no solo round, never more than 3 in flight', async () => {
    const t = gated(true);
    const done = saveDocuments(createEmptyFile({ deviceId: 'd', now: '2026-02-01T00:00:00.000Z' }), EIGHTEEN, t.io);
    await t.settle();
    // The first three writes start before any resolves.
    expect(t.events.filter((e) => e.kind === 'start')).toHaveLength(3);
    expect(t.events.some((e) => e.kind === 'end')).toBe(false);
    await t.drain(done);
    const plan = await done;
    expect(new Set(t.events.map((e) => folderOf(e.ref)))).toEqual(new Set(['Lab results', 'Clinic letters', 'Scans', 'Other documents']));
    expect(t.events.filter((e) => e.kind === 'start')).toHaveLength(18);
    expect(t.peak()).toBe(3);
    expect(plan.unstored).toBe(0);
  });

  it('the default writer (Drive): the first write into each folder completes before a second write into that folder starts', async () => {
    const t = gated();
    const done = saveDocuments(createEmptyFile({ deviceId: 'd', now: '2026-02-01T00:00:00.000Z' }), EIGHTEEN, t.io);
    await t.settle();
    expect(t.events.filter((e) => e.kind === 'start')).toHaveLength(1);
    await t.drain(done);
    for (const folder of ['Lab results', 'Clinic letters', 'Scans', 'Other documents']) {
      const here = t.events.map((e, i) => ({ ...e, i })).filter((e) => folderOf(e.ref) === folder);
      const first = here[0];
      const firstEnd = here.find((e) => e.kind === 'end' && e.ref === first.ref)!.i;
      const secondStart = here.filter((e) => e.kind === 'start')[1].i;
      expect(firstEnd, folder).toBeLessThan(secondStart);
    }
    expect(t.peak()).toBe(3);
  });
});
