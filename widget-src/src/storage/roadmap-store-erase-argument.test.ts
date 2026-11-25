// @vitest-environment jsdom
/**
 * US-16 AC2a, US-11 AC1a (leads H20 to H24): each writer below takes the erase
 * it was asked under as an argument. Asked before an erase, it is refused after
 * the page shows that erase, and writes nothing, though the store's own mark
 * now names the new record. Asked under the erase shown, it lands.
 * deleteDocument (H20) and setLpaUnit (H21) failed this before they took the
 * argument; the rest pin what they already did. R5 PR 3 made the argument
 * required on every writer and took the store's own fallback away: the table
 * now names every writer, and the type test below proves none compiles without
 * one. The upload Save's row is roadmap-store-upload-save.test.ts "US-16 AC2a".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import type { RecordSession } from '@roadmap/health-core/record-session';
import { RoadmapStore } from './roadmap-store';
import { BACKEND_KEY } from './web-record-host';
import { seedDocuments } from '../testing/seed-record';
import * as data from '../lib/roadmap-data';

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
  store.saveSupplement('omega3', 'Omega-3', 1, 'g', undefined, undefined, store.shownErase);
  const ldl = store.addMeasurement('ldl', 2.1, '2026-08-15', store.shownErase);
  const saved = await seedDocuments(store, [{
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
  // R5 PR 3: the rest of the store's writers, each now required to name its erase.
  ['addMeasurement', (s, _ids, erase) => s.addMeasurement('weight', 80, '2026-09-03', erase), { status: 'error' }, (f) => f.measurements.filter((m) => m.metricType === 'weight')],
  ['saveChangedMeasurements', (s, _ids, erase) => s.saveChangedMeasurements({ heightCm: 170 }, {}, erase), { ok: false }, (f) => f.profile.heightCm ?? null],
  ['saveMedication', (s, _ids, erase) => s.saveMedication('statin', 'atorvastatin', 20, 'mg', erase), false, (f) => f.medications],
  ['saveSupplement', (s, _ids, erase) => s.saveSupplement('vitamin_d', 'Vitamin D', 1000, 'IU', 'active', undefined, erase), false, (f) => f.supplements.filter((x) => x.supplementKey === 'vitamin_d')],
  ['saveScreening', (s, _ids, erase) => s.saveScreening('colorectal_method', 'colonoscopy_10yr', erase), false, (f) => f.screenings],
  ['addLabValue', (s, _ids, erase) => s.addLabValue({ metricName: 'ferritin', unit: 'ng/mL', value: 80, day: '2026-09-03' }, erase), null, (f) => f.labValues.filter((v) => v.metricName === 'ferritin')],
  ['markReportEmailCaptured', (s, _ids, erase) => s.markReportEmailCaptured(erase), false, (f) => f.profile.reportEmailCaptured ?? null],
  ['setReminderOptIn', (s, _ids, erase) => s.setReminderOptIn({ status: 'active', token: 'test-token-good', email: 'person@example.test', provider: 'dropbox' }, erase), false, (f) => f.reminderOptIn ?? null],
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

// R5 PR 3: the erase is required by the type on every writer, so one that forgets it does not compile (checked by
// `tsc -p widget-src/tsconfig.json`; never run). Each line would compile if the argument were optional again.
export function writersRequireAnErase(s: RoadmapStore, session: RecordSession): void {
  // @ts-expect-error the erase is required
  s.addMeasurement('weight', 80, '2026-09-03');
  // @ts-expect-error the erase is required
  s.correctValue('id', 1);
  // @ts-expect-error the erase is required
  s.moveBloodTest('2026-08-15', '2025-12-01', [], {});
  // @ts-expect-error the erase is required
  s.saveChangedMeasurements({}, {});
  // @ts-expect-error the erase is required
  s.saveMedication('statin', 'atorvastatin', 20, 'mg');
  // @ts-expect-error the erase is required
  s.saveSupplement('vitamin_d', 'Vitamin D', 1000, 'IU', 'active', undefined);
  // @ts-expect-error the erase is required
  s.deleteSupplementApi('vitamin_d');
  // @ts-expect-error the erase is required
  s.saveScreening('colorectal_method', 'colonoscopy_10yr');
  // @ts-expect-error the erase is required
  s.bulkSaveMeasurements([]);
  // @ts-expect-error the erase is required
  s.addLabValue({ metricName: 'ferritin', unit: 'ng/mL', value: 80 });
  // @ts-expect-error the erase is required
  s.deleteDocument('id');
  // @ts-expect-error the erase is required
  s.markReportEmailCaptured();
  // @ts-expect-error the erase is required
  s.setLpaUnit('nmol/L');
  // @ts-expect-error the erase is required
  s.setReminderOptIn({ status: 'cancelled', token: '', email: '', provider: 'dropbox' });
  // @ts-expect-error the erase is required
  s.refuses();
  // @ts-expect-error a Save's state carries its erase (`WebSaving`), a saving state without one does not compile
  void s.saveUpload({} as never, { phase: 'saving', platform: 'web', run: 1, files: [], started: '', firstRead: null, attempt: 1 }, '', true, {} as never);
  // @ts-expect-error the session's own fallback is gone
  session.refuses();
  // @ts-expect-error the session's own fallback is gone
  session.edit(() => {});
  // The data layer, the writers the page calls.
  // @ts-expect-error the erase is required
  void data.addMeasurement('weight', 80, '2026-09-03');
  // @ts-expect-error the erase is required
  void data.correctValue('id', 1);
  // @ts-expect-error the erase is required
  void data.moveBloodTest('2026-08-15', '2025-12-01', [], {});
  // @ts-expect-error the erase is required
  void data.saveChangedMeasurements({}, {});
  // @ts-expect-error the erase is required
  void data.saveMedication('statin', 'atorvastatin', 20, 'mg');
  // @ts-expect-error the erase is required
  void data.saveSupplement('vitamin_d', 'Vitamin D', 1000, 'IU', 'active', undefined);
  // @ts-expect-error the erase is required
  void data.deleteSupplementApi('vitamin_d');
  // @ts-expect-error the erase is required
  void data.saveScreening('colorectal_method', 'colonoscopy_10yr');
  // @ts-expect-error the erase is required
  void data.bulkSaveMeasurements([]);
  // @ts-expect-error the erase is required
  void data.addLabValue({ metricName: 'ferritin', unit: 'ng/mL', value: 80 });
  // @ts-expect-error the erase is required
  void data.deleteDocument('id');
  // @ts-expect-error the erase is required
  data.markReportEmailCaptured();
  // @ts-expect-error the erase is required
  data.setLpaUnit('nmol/L');
  // @ts-expect-error the erase is required
  data.setReminderOptIn({ status: 'cancelled', token: '', email: '', provider: 'dropbox' });
  // @ts-expect-error a Save's state carries its erase
  void data.saveUpload({} as never, { phase: 'saving', platform: 'web', run: 1, files: [], started: '', firstRead: null, attempt: 1 }, '', {} as never);
}
