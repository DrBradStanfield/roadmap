// @vitest-environment jsdom
/**
 * US-16 AC2a, US-11 AC1a (leads H20 to H24): each writer below takes the erase
 * it was asked under as an argument. Asked before an erase, it is refused after
 * the page shows that erase, and writes nothing, though the store's own mark
 * now names the new record. Asked under the erase shown, it lands.
 * deleteDocument (H20) and setLpaUnit (H21) failed this before they took the
 * argument; the rest pin what they already did.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY } from './web-record-host';
import { storeBulkSaveDocuments } from '../testing/bulk-save';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const fileOf = (store: RoadmapStore) => (store as unknown as { file: RoadmapFile }).file;

/** A record erased once, then filled again: a document, a supplement and an LDL, all under the new erase. */
async function erasedAndRefilled() {
  const store = await RoadmapStore.create(new MemoryAdapter(new MemoryCloud()));
  store.showErase(store.eraseIdentity);
  const asked = store.shownErase; // the erase a screen showed before the erase below
  expect((await store.deleteAllData()).success).toBe(true);
  store.showErase(store.eraseIdentity); // the page shows the erased record
  expect(store.shownErase).not.toBe(asked);
  store.saveSupplement('omega3', 'Omega-3', 1, 'g');
  const ldl = store.addMeasurement('ldl', 2.1, '2026-08-15');
  const { saved } = await storeBulkSaveDocuments(store, [{
    documentType: 'lab_report', title: 'Synthetic report', documentDate: '2026-09-01',
    contentMd: 'Synthetic fixture', metadata: {}, sourceFileName: 'synthetic.pdf',
  }]);
  await store.flush();
  if (ldl.status !== 'inserted') throw new Error('setup failed');
  return { store, asked, ids: { ldlId: ldl.row.id, documentId: saved[0].id } };
}

type Ids = { ldlId: string; documentId: string };
/** Each writer this PR passes an erase to: its call under `erase`, its refusal, and what it changes. */
const WRITERS: Array<[string, (s: RoadmapStore, ids: Ids, erase: string) => unknown, unknown, (f: RoadmapFile) => unknown]> = [
  ['deleteDocument (H20)', (s, ids, erase) => s.deleteDocument(ids.documentId, erase), false, (f) => f.documents.filter((d) => d.deleted)],
  ['setLpaUnit (H21)', (s, _ids, erase) => s.setLpaUnit('nmol/L', erase), false, (f) => f.profile.lpaUnit ?? null],
  ['deleteSupplementApi (H22)', (s, _ids, erase) => s.deleteSupplementApi('omega3', erase), false, (f) => f.supplements.filter((x) => x.status === 'stopped')],
  ['correctValue (H23)', (s, ids, erase) => s.correctValue(ids.ldlId, 1.9, erase), 'error', (f) => [...f.measurements, ...f.labValues].filter((v) => v.correctsId)],
  ['bulkSaveMeasurements (H18, the blood pressure widget)', (s, _ids, erase) => s.bulkSaveMeasurements([{ metricType: 'waist', value: 90, recordedAt: '2026-09-02', source: 'manual' }], erase),
    { saved: [], skippedDuplicates: 0, errorCount: 1, refused: [] }, (f) => f.measurements.filter((m) => m.metricType === 'waist')],
  ['moveBloodTest (H24)', (s, ids, erase) => s.moveBloodTest('2026-08-15', '2025-12-01', [ids.ldlId], {}, erase), { status: 'error' },
    (f) => [...f.measurements, ...f.labValues].filter((v) => v.recordedAt.startsWith('2025-12-01'))],
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BACKEND_KEY, 'memory');
});

describe('US-16 AC2a: a writer handed the erase it was asked under', () => {
  it.each(WRITERS)('%s: asked before the erase, refused after it is shown, and the record is unchanged', async (_name, write, refusal) => {
    const { store, asked, ids } = await erasedAndRefilled();
    const before = JSON.stringify(fileOf(store));
    expect(write(store, ids, asked)).toEqual(refusal);
    expect(JSON.stringify(fileOf(store))).toBe(before);
  });

  // The control: under the erase shown, the same call writes, so the row above is not passing on a writer that writes nothing.
  it.each(WRITERS)('%s: asked under the erase shown, it lands', async (_name, write, refusal, changed) => {
    const { store, ids } = await erasedAndRefilled();
    const empty = JSON.stringify(changed(fileOf(store)));
    expect(write(store, ids, store.shownErase)).not.toEqual(refusal);
    expect(JSON.stringify(changed(fileOf(store)))).not.toBe(empty);
  });
});
