/**
 * Lead TA-2: no write the web store makes saves a last-write-wins stamp later
 * than the saved record's own `meta.updatedAt` (migrate.ts clamps one, and it
 * can then lose a tie, US-10 AC8). Every RoadmapStore mutation runs for real
 * through its RecordSession save, with the browser's clock an hour ahead of
 * the stored record and an hour behind it, and the RAW bytes it wrote are
 * walked (stamp-anchor.test-helpers.ts). Also: the open that moves blood tests
 * out of `measurements` (US-66 AC14), erase, the device copy a failed cloud
 * save or a closing page writes (US-09 AC4, US-06 AC13), its lift back up and
 * the copy down (record-transfer.ts), and the "This device" record.
 *
 * Test-only. Synthetic records, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';
import { stampCount, stampedRecord, stampsAheadOfMeta } from '@roadmap/health-core/stamp-anchor.test-helpers';
import { LocalStorageAdapter } from './local-storage-adapter';
import { RoadmapStore } from './roadmap-store';
import { seedDocuments } from '../testing/seed-record';
import { uploadThrough } from '../testing/upload-save-kit';

const T0 = '2026-09-01T09:00:00.000Z';
const CLOCKS = { ahead: '2026-09-01T10:00:00.000Z', behind: '2026-09-01T08:00:00.000Z' } as const;
const DAY = '2026-08-20'; // stampedRecord's rows
const NEW_DAY = '2026-08-25T00:00:00.000Z';

function seeded(record: unknown = stampedRecord(T0)): MemoryCloud {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(record), version: 1 });
  return cloud;
}
const raw = (cloud: MemoryCloud): unknown => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json);

function expectNoStampAhead(written: unknown): void {
  expect(stampCount(written)).toBeGreaterThan(0);
  expect(stampsAheadOfMeta(written)).toEqual([]);
}

const pdf = { documentType: 'pathology_report', title: 'Lipid panel', documentDate: '2026-08-20', contentMd: 'md', metadata: {}, sourceFileName: 'results.pdf' };

/** Every RoadmapStore write, as the page calls it. Each answers whether it was taken. */
const WRITES: Record<string, (store: RoadmapStore) => unknown> = {
  addMeasurement: (s) => s.addMeasurement('weight', 80, NEW_DAY, s.shownErase).status === 'inserted',
  correctValue: (s) => s.correctValue('w1', 81, s.shownErase) === 'ok',
  moveBloodTest: (s) => {
    const plan = s.previewMove(DAY, NEW_DAY.slice(0, 10));
    return 'rows' in plan && s.moveBloodTest(DAY, NEW_DAY.slice(0, 10), plan.rows.map((r) => r.id), {}, s.shownErase).status === 'ok';
  },
  'saveChangedMeasurements (profile and a value)': (s) => s.saveChangedMeasurements({ heightCm: 180, weightKg: 79 }, { heightCm: 178 }, s.shownErase).ok,
  'saveChangedMeasurements (unit switch)': (s) => s.saveChangedMeasurements({ unitSystem: 'conventional' }, { unitSystem: 'si' }, s.shownErase).ok,
  saveMedication: (s) => s.saveMedication('statin', 'rosuvastatin', 10, 'mg', s.shownErase),
  saveSupplement: (s) => s.saveSupplement('vitamin_d', 'Vitamin D', 2000, 'IU', undefined, undefined, s.shownErase),
  deleteSupplementApi: (s) => s.deleteSupplementApi('vitamin_d', s.shownErase),
  saveScreening: (s) => s.saveScreening('colorectal_last_date', '2025-03', s.shownErase),
  addLabValue: (s) => s.addLabValue({ metricName: 'TSH', unit: 'mIU/L', value: 2.1, day: NEW_DAY.slice(0, 10) }, s.shownErase)?.ok,
  bulkSaveMeasurements: (s) => s.bulkSaveMeasurements([{ metricType: 'waist', value: 90, recordedAt: NEW_DAY, source: 'lab_import' }], s.shownErase).saved.length === 1,
  // The upload's one Save (storage/upload-save-store.ts): its values, and its document with the original.
  'bulkSaveLabValues (the upload Save)': async (s) => {
    const answer = await uploadThrough(s, [{ report: 'labs.pdf', reportDate: NEW_DAY.slice(0, 10), values: [{ name: 'Ferritin', value: 85, unit: 'ug/L' }] }]);
    return answer.ok && answer.outcome.values === 1;
  },
  'bulkSaveDocuments (the upload Save)': async (s) => {
    const answer = await uploadThrough(s, [{ ...pdf, file: new Blob(['synthetic bytes'], { type: 'application/pdf' }) }]);
    return answer.ok && answer.outcome.documents === 1 && answer.outcome.unstored === 0;
  },
  deleteDocument: async (s) => {
    const [doc] = await seedDocuments(s, [{ ...pdf, file: new Blob(['other bytes'], { type: 'application/pdf' }) }]);
    return s.deleteDocument(doc.id, s.shownErase);
  },
  markReportEmailCaptured: (s) => s.markReportEmailCaptured(s.shownErase),
  setLpaUnit: (s) => s.setLpaUnit('mg/dL', s.shownErase),
  setReminderRows: (s) => s.setReminderRows([{ status: 'cancelled', token: 'test-token-good', email: 'a@example.com', provider: 'dropbox' }], s.shownErase),
  deleteAllData: async (s) => (await s.deleteAllData()).success,
};

// A real-shaped localStorage holding the page's cloud, as connect.ts remembers
// it: an erase and the failed-save copy need it (US-11 AC6, US-06 AC13).
beforeEach(() => {
  const backing = new Map<string, string>([['health_roadmap_backend', 'memory']]);
  const local = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: local, writable: true, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  vi.useRealTimers();
});

for (const [clock, now] of Object.entries(CLOCKS)) {
  describe(`TA-2: RoadmapStore writes, browser clock ${clock} of the stored record`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
    });

    it.each(Object.keys(WRITES))('%s', async (name) => {
      const cloud = seeded();
      const before = cloud.files.get(ROADMAP_FILE_NAME)!.json;
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      expect(await WRITES[name](store)).toBe(true);
      await store.flush();
      expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).not.toBe(before); // it wrote
      expectNoStampAhead(raw(cloud));
    });

    it('the open that moves blood tests out of measurements (US-66 AC14)', async () => {
      const legacy = stampedRecord(T0);
      legacy.measurements.push(createMeasurement({ id: 'old-ldl', metricType: 'ldl', value: 3, recordedAt: '2026-08-01', createdAt: T0 }));
      const cloud = seeded(legacy);
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      expect(await store.bloodTablesUnified).not.toBeNull();
      const written = raw(cloud) as typeof legacy;
      expect(written.measurements.some((m) => m.metricType === 'ldl')).toBe(false);
      expectNoStampAhead(written);
    });
  });

  describe(`TA-2: the on-device copy a failed cloud save writes, browser clock ${clock} (US-09 AC4)`, () => {
    class TokenExpiredAdapter extends MemoryAdapter {
      async write(): Promise<never> {
        throw new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, undefined, 'no-answer');
      }
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
    });

    it('a profile, a screening and a medication edit whose cloud save failed', async () => {
      const store = await RoadmapStore.create(new TokenExpiredAdapter(seeded()));
      store.saveChangedMeasurements({ heightCm: 181 }, { heightCm: 178 }, store.shownErase);
      store.saveScreening('colorectal_last_date', '2025-03', store.shownErase);
      store.saveMedication('statin', 'rosuvastatin', 10, 'mg', store.shownErase);
      await expect(store.flush()).rejects.toThrow();
      const mirror = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
      expect(mirror.profile.heightCm).toBe(181);
      expect(mirror.medications[0].drugName).toBe('rosuvastatin');
      expectNoStampAhead(mirror);
    });

    it('the next session lifts that device copy up to the cloud (record-transfer liftDeviceCopy)', async () => {
      const cloud = seeded();
      const failing = await RoadmapStore.create(new TokenExpiredAdapter(cloud));
      failing.saveMedication('statin', 'rosuvastatin', 10, 'mg', failing.shownErase);
      await expect(failing.flush()).rejects.toThrow();
      const recovered = await RoadmapStore.create(new MemoryAdapter(cloud));
      await recovered.flush();
      const written = raw(cloud) as { medications: Array<{ drugName: string }> };
      expect(written.medications[0].drugName).toBe('rosuvastatin');
      expectNoStampAhead(written);
    });

    it('leaving the cloud copies the record down to this device (record-transfer copyCloudDown)', async () => {
      const store = await RoadmapStore.create(new MemoryAdapter(seeded()));
      store.saveScreening('colorectal_last_date', '2025-03', store.shownErase);
      await store.copyToDevice();
      const copy = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
      expect(copy.screenings.colorectalLastDate).toBe('2025-03');
      expectNoStampAhead(copy);
    });

    it('a page closing with an unsaved edit: flushSync writes the device copy at once (US-06 AC13)', async () => {
      const store = await RoadmapStore.create(new TokenExpiredAdapter(seeded()));
      store.saveScreening('colorectal_last_date', '2025-03', store.shownErase);
      store.flushSync();
      const mirror = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
      expect(mirror.screenings.colorectalLastDate).toBe('2025-03');
      expectNoStampAhead(mirror);
      await expect(store.flush()).rejects.toThrow();
    });
  });

  describe(`TA-2: "This device" (localStorage) record, browser clock ${clock}`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
    });

    it.each(['flushSync', 'flush'] as const)('a profile, a screening and a medication edit, saved by %s', async (save) => {
      await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, stampedRecord(T0), null);
      const store = await RoadmapStore.create(new LocalStorageAdapter());
      store.saveChangedMeasurements({ heightCm: 181 }, { heightCm: 178 }, store.shownErase);
      store.saveScreening('colorectal_last_date', '2025-03', store.shownErase);
      store.saveMedication('statin', 'rosuvastatin', 10, 'mg', store.shownErase);
      if (save === 'flushSync') store.flushSync();
      else await store.flush();
      const written = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!);
      expect(written.profile.heightCm).toBe(181);
      expect(written.screenings.colorectalLastDate).toBe('2025-03');
      expectNoStampAhead(written);
    });
  });
}
