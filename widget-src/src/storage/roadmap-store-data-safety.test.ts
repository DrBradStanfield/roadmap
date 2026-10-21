import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core';
import { ERASE_UNREACHABLE, RoadmapStore, PENDING_MIRROR_KEY, markSyncPending, isSyncPending } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { LocalStorageAdapter } from './local-storage-adapter';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';
import { DRAFTS_CLEARED_EVENT } from '../lib/storage';

/** The file as it landed in the (simulated) cloud after a flush. */
function readCloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

/** Unwrap an addMeasurement result the setup expects to have inserted. */
function insertedRow(result: ReturnType<RoadmapStore['addMeasurement']>) {
  if (result.status !== 'inserted') throw new Error('setup failed');
  return result.row;
}

// US-04 · Correcting a saved value (FHIR) — coverage priority #1
// (docs/user-stories.md: "RoadmapStore.correctMeasurement itself untested"; renamed
// correctValue on 2026-09-24, when it took on lab rows through record-edits).
describe('RoadmapStore.correctValue (US-04)', () => {
  it('flips the old row to entered-in-error and appends a manual_correction row with correctsId', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;

    const result = store.correctValue(oldId, 3.2);
    expect(result).toBe('ok');
    await store.flush();

    const file = readCloudFile(cloud);
    const oldRow = file.measurements.find((m) => m.id === oldId)!;
    expect(oldRow.status).toBe('entered-in-error');

    const newRow = file.measurements.find((m) => m.id !== oldId && m.metricType === 'ldl')!;
    expect(newRow.source).toBe('manual_correction');
    expect(newRow.correctsId).toBe(oldId);
    expect(newRow.value).toBe(3.2);
    expect(newRow.status).toBe('active');
  });

  it('results/latest reads use only the active (corrected) row', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.correctValue(insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id, 3.2);

    // Both loadAllHistory() and loadLatestMeasurements() filter to status==='active'.
    const history = store.loadAllHistory();
    expect(history.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(history.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);

    const latest = store.loadLatestMeasurements();
    expect(latest.previousMeasurements.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(latest.previousMeasurements.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);
  });

  it('correcting a non-existent id answers changed and leaves the file untouched', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await store.flush();
    const before = readCloudFile(cloud);

    const result = store.correctValue('does-not-exist', 3.2);
    expect(result).toBe('changed');
    await store.flush();

    const after = readCloudFile(cloud);
    expect(after.measurements).toHaveLength(before.measurements.length);
    expect(after.measurements).toEqual(before.measurements);
  });

  it('correcting an already-corrected (entered-in-error) id also answers changed, without corrupting state', async () => {
    // Same documented failure shape as the unknown-id case — correctValue
    // only accepts oldId pointing at a currently-active row.
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;
    store.correctValue(oldId, 3.2); // first correction — oldId now entered-in-error

    const second = store.correctValue(oldId, 2.9); // re-correcting the now-dead row
    expect(second).toBe('changed');
    await store.flush();

    const file = readCloudFile(cloud);
    // Still exactly one active row for the slot — the second call added nothing.
    expect(
      file.measurements.filter((m) => m.metricType === 'ldl' && m.status === 'active'),
    ).toHaveLength(1);
    expect(file.measurements.filter((m) => m.metricType === 'ldl')).toHaveLength(2);
  });

  it('at most one active row per (metric, day) survives a correction, and the slot re-blocks a duplicate add', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const day = '2024-06-01T09:00:00.000Z';
    store.correctValue(insertedRow(store.addMeasurement('ldl', 4.5, day)).id, 3.2);

    const activeForSlot = store
      .loadAllHistory()
      .filter((m) => m.metricType === 'ldl');
    expect(activeForSlot).toHaveLength(1);

    // The slot guard (roadmap-store.ts addMeasurement) still sees one active
    // row for this (metric, day) — a fresh add for the same day is blocked.
    const dup = store.addMeasurement('ldl', 5.0, day);
    expect(dup.status).toBe('duplicate');
  });
});

// US-21 AC5 · a lab value is corrected like a core row, through the same door.
describe('RoadmapStore.correctValue on lab values (US-21 AC5)', () => {
  it('appends a correction on the same day, in the unit the row is stored in, and flips the old row', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const old = store.bulkSaveLabValues([
      { metricName: 'Feritin', value: 45, unit: 'ug/L', recordedAt: '2024-06-01T00:00:00.000Z', source: 'manual' },
    ]).saved[0];

    const result = store.correctValue(old.id, 54);
    expect(result).toBe('ok');
    await store.flush();

    const rows = readCloudFile(cloud).labValues;
    expect(rows.find((l) => l.id === old.id)!.status).toBe('entered-in-error');
    const fixed = rows.find((l) => l.id !== old.id)!;
    expect(fixed).toMatchObject({ value: 54, unit: 'ug/L', status: 'active', correctsId: old.id, recordedAt: old.recordedAt, source: 'manual_correction' });
    expect(store.loadLabValues().map((l) => l.value)).toEqual([54]);
  });
});

// US-04 AC2 · the record's own range decides, as it does for every other writer.
describe('RoadmapStore.correctValue refusals (US-04)', () => {
  it('a value outside the range the record takes is refused with its reason, and nothing changes', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const id = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01')).id;
    await store.flush();
    const before = readCloudFile(cloud).measurements;

    const result = store.correctValue(id, 12.93); // 500 mg/dL passes the mg/dL field, not the record
    expect(result).toBe('invalid');
    await store.flush();
    expect(readCloudFile(cloud).measurements).toEqual(before);
  });
});

// US-11 · Deleting my data — coverage priority #1
// (docs/user-stories.md: "deleteUserData store path untested").
describe('RoadmapStore.deleteUserData (US-11)', () => {
  it('bumps eraseEpoch and empties every collection', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    store.saveMedication('statin', 'atorvastatin', 20, 'mg');
    store.saveSupplement('omega3', 'Omega-3', 1000, 'mg');
    store.saveScreening('colorectal_method', 'fit');
    await store.flush();
    const beforeErase = readCloudFile(cloud);
    expect(beforeErase.meta.eraseEpoch ?? 0).toBe(0);

    const result = await store.deleteAllData();
    expect(result.success).toBe(true);

    const file = readCloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(file.medications).toEqual([]);
    expect(file.medicationHistory).toEqual([]);
    expect(file.supplements).toEqual([]);
    expect(file.labValues).toEqual([]);
    expect(file.documents).toEqual([]);
  });

  // Regression (fixed 2026-08-07): `migrateFile()` used to drop `meta.eraseEpoch`
  // on every read from storage, so mergeFiles()'s wholesale-win gate never fired
  // for a re-read file and a stale device's flush resurrected erased data — a
  // data-deletion/privacy defect. This test failed against the buggy migrate()
  // and pins the fixed behavior.
  it('a stale device flushing after an erase does NOT resurrect the erased data', async () => {
    const cloud = new MemoryCloud();
    const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
    deviceA.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    deviceA.saveMedication('statin', 'atorvastatin', 20, 'mg');
    await deviceA.flush();

    // Device B loads the same populated cloud copy, but never sees the erase —
    // it stays "stale" in memory (no reload) while device A deletes everything.
    const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(deviceB.loadAllHistory()).toHaveLength(1);

    await deviceA.deleteAllData();

    // Device B, still holding its stale populated in-memory copy, flushes.
    // mergeFiles' eraseEpoch gate wins wholesale — B's data must NOT come back.
    await deviceB.flush();

    const file = readCloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(deviceB.loadAllHistory()).toEqual([]);
  });

  it('US-09 AC20: stamps meta.erasedAt 1 ms past the moment of the erase', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'));
      const cloud = new MemoryCloud();
      const store = await RoadmapStore.create(new MemoryAdapter(cloud));
      vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
      await store.deleteAllData();
      expect(readCloudFile(cloud).meta).toMatchObject({ eraseEpoch: 1, erasedAt: '2026-06-01T10:00:00.001Z' });
      expect((store as unknown as { file: RoadmapFile }).file.meta.erasedAt).toBe('2026-06-01T10:00:00.001Z');
    } finally {
      vi.useRealTimers();
    }
  });

  // Review fix (adversary R4): the eraser's clock runs behind the device that
  // wrote the row it erased. erasedAt is floored past the last write it read,
  // so that row cannot come back when the stale device saves again.
  it('US-09 AC20: a slow eraser clock still drops a row the eraser had already seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z')); // device B, clock ahead
      const cloud = new MemoryCloud();
      const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
      deviceB.addMeasurement('weight', 95, '2026-06-01');
      await deviceB.flush();

      vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z')); // device A, clock an hour behind
      const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
      expect(deviceA.loadAllHistory().map((m) => m.value)).toEqual([95]); // A has seen the row
      await deviceA.deleteAllData();
      expect(Date.parse(readCloudFile(cloud).meta.erasedAt!)).toBeGreaterThan(Date.parse('2026-06-01T10:00:00.000Z'));

      vi.setSystemTime(new Date('2026-06-01T10:05:00.000Z')); // B, never reloaded, saves again
      deviceB.addMeasurement('weight', 80, '2026-06-02');
      await deviceB.flush();
      expect(readCloudFile(cloud).measurements.map((m) => m.value)).toEqual([80]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review fix (N2): a broken clock, not a slow one. A stored updatedAt years
  // ahead must not push erasedAt out past every row written after the erase.
  it('US-09 AC20: a stored updatedAt more than a day past now does not move erasedAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z')); // device B, clock broken
      const cloud = new MemoryCloud();
      const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
      deviceB.addMeasurement('weight', 95, '2026-06-01');
      await deviceB.flush();
      expect(readCloudFile(cloud).meta.updatedAt.startsWith('2099')).toBe(true);

      vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z')); // device A, right clock
      const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
      await deviceA.deleteAllData();
      expect(readCloudFile(cloud).meta.erasedAt).toBe('2026-06-01T10:00:00.001Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('US-09 AC20: a stale device that writes AFTER another device erased keeps that write, and only that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-06-01T09:00:00.000Z'));
      const cloud = new MemoryCloud();
      const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
      deviceA.addMeasurement('weight', 95, '2026-06-01');
      await deviceA.flush();
      const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud)); // never reloads

      vi.setSystemTime(new Date('2026-06-02T09:00:00.000Z'));
      await deviceA.deleteAllData();

      vi.setSystemTime(new Date('2026-06-03T09:00:00.000Z'));
      deviceB.addMeasurement('weight', 80, '2026-06-03');
      await deviceB.flush();

      const file = readCloudFile(cloud);
      expect(file.meta.eraseEpoch).toBe(1);
      expect(file.measurements.map((m) => m.value)).toEqual([80]);
      expect(deviceB.loadAllHistory().map((m) => m.value)).toEqual([80]);
    } finally {
      vi.useRealTimers();
    }
  });

  // US-17 AC4, found in adversarial review 2026-08-13 — BEFORE it shipped.
  // Under default-on reminders the empty post-erase file reads as "never
  // decided", so the next app load would enrol the user again. The erase would
  // then be the thing that silently re-consented them, and because a higher
  // eraseEpoch wins the merge WHOLESALE, the 'cancelled' record on their other
  // devices could not save them either.
  it('carries an explicit reminders opt-out THROUGH an erase (never re-consents)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.setReminderOptIn({ status: 'active', token: 'cap-token', email: 'user@example.com', provider: 'dropbox' });
    store.setReminderOptIn({ status: 'cancelled', token: 'cap-token', email: 'user@example.com', provider: 'dropbox' });

    await store.deleteAllData();

    const optIn = readCloudFile(cloud).reminderOptIn!;
    expect(optIn.status).toBe('cancelled');
    // The decision survives; the identity does NOT — an erase must not leave the
    // user's address or capability token behind in the name of remembering a no.
    expect(optIn.email).toBe('');
    expect(optIn.token).toBe('');
  });

  // M1 (2026-09-10): leaving an ENROLLED user with NO opt-in record made the
  // erase turn reminders back on. The empty file reads as "never decided", so
  // the next storefront load auto-enrolled them again through the address lane,
  // refilling the server row the pre-erase hook had just torn down, while the
  // widget held no token to cancel it with. An erase now records the decision
  // for anyone who HAD an opt-in, enrolled or not; the manual toggle still
  // re-enrols, because that is the user asking.
  it('turns reminders OFF for an enrolled user (the erase must not re-enrol them)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.setReminderOptIn({ status: 'active', token: 'cap-token', email: 'user@example.com', provider: 'dropbox' });

    await store.deleteAllData();

    const optIn = readCloudFile(cloud).reminderOptIn!;
    expect(optIn.status).toBe('cancelled');
    // The decision survives; the identity does not.
    expect(optIn.email).toBe('');
    expect(optIn.token).toBe('');
  });

  it('leaves a user who never decided about reminders with no opt-in record', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');

    await store.deleteAllData();

    expect(readCloudFile(cloud).reminderOptIn).toBeUndefined();
  });
});

// US-13 · Review before save — bulk-save dedup (coverage priority #1).
describe('RoadmapStore.bulkSaveMeasurements dedup (US-13)', () => {
  it('skips (metric, day) duplicates within a batch and reports skippedDuplicates', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const result = store.bulkSaveMeasurements([
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
      // Same metric+day, different time-of-day — still one slot.
      { metricType: 'ldl', value: 3.4, recordedAt: '2024-06-01T18:00:00.000Z', source: 'lab_import' as const },
      { metricType: 'hdl', value: 1.3, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
    ]);
    expect(result.saved).toHaveLength(2);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('re-running the identical batch against existing data is a no-op success, not an error', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const batch = [
      { metricType: 'ldl', value: 3.2, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
      { metricType: 'hdl', value: 1.3, recordedAt: '2024-06-01T09:00:00.000Z', source: 'lab_import' as const },
    ];
    const first = store.bulkSaveMeasurements(batch);
    expect(first.saved).toHaveLength(2);
    await store.flush();

    const second = store.bulkSaveMeasurements(batch);
    expect(second.saved).toHaveLength(0);
    expect(second.skippedDuplicates).toBe(2);
    expect(second.errorCount).toBe(0);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.measurements.filter((m) => m.status === 'active')).toHaveLength(2);
  });
});

// US-21 phase 3: a catalogued test is stored in the catalogue's SI unit, so a
// printed spelling the catalogue does not know for that test is REFUSED. The
// upload must SAY so — a silently dropped lab value is the failure this exists
// to prevent — while the rest of the batch still saves.
describe('RoadmapStore.bulkSaveLabValues unit refusals (US-21 phase 3)', () => {
  it('reports the refused row, stores nothing for it, and saves the accepted rows', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    const result = store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'mg/dL', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'sodium', value: 140, unit: 'mEq/L', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    await store.flush();

    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].metricName).toBe('sodium');
    expect(result.refused).toEqual([
      { key: 'ferritin', unit: 'mg/dL', message: expect.stringContaining('µg/L') },
    ]);
    const file = readCloudFile(cloud);
    expect(file.labValues.map((l) => l.metricName)).toEqual(['sodium']);
  });
});

describe('RoadmapStore.bulkSaveLabValues dedup (US-13)', () => {
  it('skips (metricName, day) duplicates and reports skippedDuplicates', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const result = store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'ferritin', value: 82, unit: 'ng/mL', recordedAt: '2024-06-01T20:00:00.000Z' },
      { metricName: 'sodium', value: 140, unit: 'mmol/L', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    expect(result.saved).toHaveLength(2);
    expect(result.skippedDuplicates).toBe(1);
  });

  it('re-uploading the same lab-value batch is a no-op success (all-duplicate ≠ error)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const batch = [
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
    ];
    store.bulkSaveLabValues(batch);
    await store.flush();

    const second = store.bulkSaveLabValues(batch);
    expect(second.saved).toEqual([]);
    expect(second.skippedDuplicates).toBe(1);
    expect(second.errorCount).toBe(0);
  });

  // US-21 phase 2 (adversarial review 2026-08-14): dedup slots must resolve
  // spelling variants to the stable catalogue key — an upload stores the
  // extractor's raw name ("Gamma GT") while manual add stores the key
  // ("ggt"); slotting on raw names let both live as active rows for the
  // same test on the same day.
  it('same test under a different spelling on the same day is a duplicate (catalogue-key slots)', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const first = store.bulkSaveLabValues([
      { metricName: 'Gamma GT', value: 30, unit: 'U/L', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    expect(first.saved).toHaveLength(1);
    const second = store.bulkSaveLabValues([
      { metricName: 'ggt', value: 32, unit: 'U/L', recordedAt: '2024-06-01T12:00:00.000Z', source: 'manual' },
    ]);
    expect(second.saved).toEqual([]);
    expect(second.skippedDuplicates).toBe(1);
    // Uncatalogued names still slot on their raw spelling.
    const third = store.bulkSaveLabValues([
      { metricName: 'reticulocytes', value: 60, unit: '×10⁹/L', recordedAt: '2024-06-01T09:00:00.000Z' },
      { metricName: 'reticulocytes', value: 61, unit: '×10⁹/L', recordedAt: '2024-06-01T10:00:00.000Z' },
    ]);
    expect(third.saved).toHaveLength(1);
    expect(third.skippedDuplicates).toBe(1);
  });
});

// US-14 · Document archive — bulkSaveDocuments / deleteDocument / readDocumentFile
// (docs/user-stories.md: "❌ store deleteDocument/readDocumentFile. Deferred.").
describe('RoadmapStore document archive (US-14)', () => {
  it('bulkSaveDocuments writes the blob + metadata; readDocumentFile reads the same bytes back', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const file = new Blob(['%PDF-1.4 fake lipid panel bytes'], { type: 'application/pdf' });

    const { saved: [saved] } = await store.bulkSaveDocuments([
      {
        documentType: 'pathology_report',
        title: 'Lipid panel',
        documentDate: '2024-05-10',
        contentMd: '# Lipid panel\nLDL 3.2 mmol/L',
        metadata: {},
        sourceFileName: 'results.pdf',
        file,
      },
    ]);
    await store.flush();

    expect(saved.contentMd).toBe('# Lipid panel\nLDL 3.2 mmol/L');
    expect(saved.fileRef).toBeTruthy();

    const cloudFile = readCloudFile(cloud);
    expect(cloudFile.documents).toHaveLength(1);
    expect(cloudFile.documents[0].fileRef).toBe(saved.fileRef);
    expect(cloudFile.documents[0].contentHash).toMatch(/^sha256-/);

    const readBack = await store.readDocumentFile(saved.fileRef!);
    expect(await readBack.text()).toBe('%PDF-1.4 fake lipid panel bytes');
  });

  it('re-saving the identical file bytes dedups by content hash — a no-op, not a second entry', async () => {
    // The store's dedup key is the SHA-256 of the uploaded blob (roadmap-store.ts
    // bulkSaveDocuments), not sourceFileName — filename-level dedup for the review
    // step happens upstream (ReviewTable/UploadModal, out of scope here). This test
    // pins the store-layer contract only.
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const payload = { documentType: 'pathology_report', title: 'Lipid panel', documentDate: '2024-05-10', contentMd: 'md', metadata: {}, sourceFileName: 'results.pdf', file: new Blob(['identical bytes'], { type: 'application/pdf' }) };

    const first = await store.bulkSaveDocuments([payload]);
    expect(first.saved).toHaveLength(1);
    await store.flush();

    const second = await store.bulkSaveDocuments([{ ...payload, title: 'Lipid panel (re-upload)' }]);
    expect(second).toEqual({ saved: [], errorCount: 0 });
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.documents.filter((d) => !d.deleted)).toHaveLength(1);
  });

  it.each(['pathology_report', 'clinic_letter'] as const)('archives the original behind a connector-imported %s row: same hash and no fileRef → blob written, old row tombstoned (US-35 AC6/AC8)', async (type) => {
    // `import_documents` lands a document metadata-only with the bytes' own
    // contentHash and fileRef ''. The user then uploads the same PDF here to
    // archive it: the hash must not read as "already archived".
    const blob = new Blob(['connector bytes'], { type: 'application/pdf' });
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const seeded = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
    seeded.documents.push({
      id: 'imported', title: 'Lipid panel', type, date: '2024-05-10', fileRef: '', contentHash: hash, mimeType: 'application/pdf',
      extractedText: '', addedAt: '2026-01-01T00:00:00.000Z', metadata: { importedVia: 'connector' }, sourceFileName: 'results.pdf',
    });
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seeded), version: 1 });
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const payload = { documentType: type, title: 'Lipid panel', documentDate: '2024-05-10', contentMd: 'md', metadata: {}, sourceFileName: 'results.pdf', file: blob };

    const { saved: [saved] } = await store.bulkSaveDocuments([payload]);
    expect(saved.fileRef).not.toBe('');
    await store.flush();
    const file = readCloudFile(cloud);
    expect(file.documents.find((d) => d.id === 'imported')!.deleted).toBe(true);
    const live = file.documents.filter((d) => !d.deleted);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ type, contentHash: hash, fileRef: saved.fileRef, extractedText: 'md' });

    // Now archived: the same bytes again are a no-op.
    expect((await store.bulkSaveDocuments([payload])).saved).toHaveLength(0);
  });

  it('a failed archive behind a connector row files NO second row: the connector row stays live and the failure is counted (US-13 AC1, US-35 AC8)', async () => {
    // Sentry 7715862604: the em dash in this title broke the Dropbox header, and
    // the old "degrade to metadata-only" branch then filed a plain row BESIDE the
    // connector's — the Documents list showed the letter twice, and every
    // re-upload offered "Save 1 Original" and added another.
    const blob = new Blob(['connector bytes'], { type: 'application/pdf' });
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const title = 'GP Consultation Letter — Dr A. Example';
    const seeded = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
    seeded.documents.push({
      id: 'imported', title, type: 'clinic_letter', date: '2026-08-25', fileRef: '', contentHash: hash, mimeType: 'application/pdf',
      extractedText: '', addedAt: '2026-01-01T00:00:00.000Z', metadata: { importedVia: 'connector' }, sourceFileName: 'clinic-letter.pdf',
    });
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seeded), version: 1 });
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new TypeError('String contains non ISO-8859-1 code point.'); };
    const store = await RoadmapStore.create(adapter);
    const payload = { documentType: 'clinic_letter', title, documentDate: '2026-08-25', contentMd: 'md', metadata: {}, sourceFileName: 'clinic-letter.pdf', file: blob };

    expect(await store.bulkSaveDocuments([payload])).toEqual({ saved: [], errorCount: 1 });
    await store.flush();
    const file = readCloudFile(cloud);
    const live = file.documents.filter((d) => !d.deleted);
    expect(live.map((d) => d.id)).toEqual(['imported']); // no duplicate, not tombstoned
    expect(live[0].contentHash).toBe(hash); // the hash key survives for the retry
  });

  it('without a connector row a failed blob write still degrades to metadata-only — the reviewed values are never lost with the file', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    adapter.writeDocument = async () => { throw new Error('quota'); };
    const store = await RoadmapStore.create(adapter);

    const result = await store.bulkSaveDocuments([{ documentType: 'pathology_report', title: 'Lipid panel', documentDate: '2024-05-10', contentMd: 'md', metadata: {}, sourceFileName: 'results.pdf', file: new Blob(['bytes'], { type: 'application/pdf' }) }]);
    expect(result.errorCount).toBe(0);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].fileRef).toBeNull();
  });

  it('deleteDocument tombstones (keeps the row, flips deleted) and hides it from reads', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const { saved: [saved] } = await store.bulkSaveDocuments([
      { documentType: 'scan_result', title: 'Chest X-ray', documentDate: '2024-05-10', contentMd: 'md', metadata: {}, sourceFileName: 'xray.jpg' },
    ]);
    await store.flush();

    const ok = store.deleteDocument(saved.id);
    expect(ok).toBe(true);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.documents).toHaveLength(1); // tombstoned, never spliced
    expect(file.documents[0].deleted).toBe(true);
    expect(store.loadLatestMeasurements().documents).toHaveLength(0);
  });

  it('deleting an unknown id, and re-deleting an already-deleted id, both return false without corrupting state', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const { saved: [saved] } = await store.bulkSaveDocuments([
      { documentType: 'scan_result', title: 'Chest X-ray', documentDate: '2024-05-10', contentMd: 'md', metadata: {}, sourceFileName: 'xray.jpg' },
    ]);
    await store.flush();

    expect(store.deleteDocument('does-not-exist')).toBe(false);
    expect(store.deleteDocument(saved.id)).toBe(true);
    expect(store.deleteDocument(saved.id)).toBe(false); // already deleted
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.documents).toHaveLength(1);
    expect(file.documents[0].deleted).toBe(true);
  });
});

// US-09 AC4 · A failed cloud save is never memory-only (Sentry JAVASCRIPT-REMIX-3X,
// 2026-08-14: a Drive session's token refresh failed mid-session; every persist
// threw "Google Drive needs to be reconnected", the edits lived ONLY in memory,
// and a tab close would have silently lost them while the UI still showed the
// connected checkmark).
describe('RoadmapStore cloud-persist failure mirror (US-09 AC4)', () => {
  /** A cloud adapter whose writes fail like an expired/unrefreshable token. */
  class TokenExpiredAdapter extends MemoryAdapter {
    async write(): Promise<never> {
      throw new StorageError('Google Drive needs to be reconnected.');
    }
  }

  // Real-shaped in-memory localStorage (same pattern as connect.test.ts) — the
  // mirror path writes through lib/storage's safe helpers, which no-op silently
  // when localStorage is missing, so these tests must provide one.
  beforeEach(() => {
    const backing = new Map<string, string>();
    const store = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  function readMirror(): RoadmapFile | null {
    const raw = localStorage.getItem('health_roadmap_file_v2');
    return raw == null ? null : (JSON.parse(raw) as RoadmapFile);
  }

  it('mirrors the working copy on-device when a cloud save fails, and sets the pending marker', async () => {
    const store = await RoadmapStore.create(new TokenExpiredAdapter());
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');

    await expect(store.flush()).rejects.toThrow(/still on this device/);

    const mirror = readMirror();
    expect(mirror).not.toBeNull();
    expect(mirror!.measurements.map((m) => [m.metricType, m.value])).toEqual([['weight', 80]]);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
  });

  it('the next cloud session merges the mirrored changes back up and clears the marker on success', async () => {
    // Session 1: cloud already has one row; a second row fails to save and mirrors.
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('ldl', 3.2, '2024-01-01T00:00:00.000Z');
    await seeded.flush();

    const failing = await RoadmapStore.create(new TokenExpiredAdapter(cloud));
    failing.addMeasurement('weight', 80, '2024-02-01T00:00:00.000Z');
    await expect(failing.flush()).rejects.toThrow();

    // Session 2 (e.g. next page load, token refresh works again).
    const recovered = await RoadmapStore.create(new MemoryAdapter(cloud));
    await recovered.flush();

    const file = readCloudFile(cloud);
    const rows = file.measurements.map((m) => [m.metricType, m.value]).sort();
    expect(rows).toEqual([['ldl', 3.2], ['weight', 80]]);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull();
  });

  it('a successful erase also wipes the on-device mirror + marker (no pre-erase copy outlives it)', async () => {
    // Session with an earlier failure's residue on-device, then a healthy erase.
    const cloud = new MemoryCloud();
    const failing = await RoadmapStore.create(new TokenExpiredAdapter(cloud));
    failing.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await expect(failing.flush()).rejects.toThrow();
    expect(readMirror()).not.toBeNull();

    const healthy = await RoadmapStore.create(new MemoryAdapter(cloud));
    const result = await healthy.deleteAllData();
    expect(result.success).toBe(true);

    expect(readMirror()).toBeNull();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull();
    expect(readCloudFile(cloud).meta.eraseEpoch).toBe(1);
  });

  it('an erase during a cloud outage mirrors the ERASED file, so the erase itself survives a tab close', async () => {
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await seeded.flush();

    const failing = await RoadmapStore.create(new TokenExpiredAdapter(cloud));
    const result = await failing.deleteAllData();
    expect(result.success).toBe(false);

    const mirror = readMirror();
    expect(mirror).not.toBeNull();
    expect(mirror!.meta.eraseEpoch).toBe(1);
    expect(mirror!.measurements).toEqual([]);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
  });

  it('an UNPARSEABLE mirror never bricks startup; its marker is cleared (nothing can ever lift it)', async () => {
    // Adversarial finding (2026-08-14): corrupt bytes can never be read OR
    // replaced (the mirror write reads before merging), so a kept marker would
    // show "waiting to sync" forever for unrecoverable data. The bytes stay.
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('ldl', 3.2, '2024-01-01T00:00:00.000Z');
    await seeded.flush();

    localStorage.setItem('health_roadmap_file_v2', '{not valid json');
    localStorage.setItem(PENDING_MIRROR_KEY, '2026-08-14T00:00:00.000Z');

    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.loadAllHistory()).toHaveLength(1);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull();
    expect(localStorage.getItem('health_roadmap_file_v2')).toBe('{not valid json');
  });

  it('a SCHEMA-TOO-NEW mirror never bricks startup; its marker survives later saves (retried once assets update)', async () => {
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    seeded.addMeasurement('ldl', 3.2, '2024-01-01T00:00:00.000Z');
    await seeded.flush();

    // A mirror written by a future bundle: valid JSON, schemaVersion far ahead.
    localStorage.setItem('health_roadmap_file_v2', JSON.stringify({ schemaVersion: 9999 }));
    localStorage.setItem(PENDING_MIRROR_KEY, '2026-08-14T00:00:00.000Z');

    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.loadAllHistory()).toHaveLength(1);
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();

    // A later successful save must NOT strand the skipped mirror: the marker
    // survives so the next load (with updated assets) retries it.
    store.addMeasurement('hdl', 1.3, '2024-03-01T00:00:00.000Z');
    await store.flush();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();
  });

  // Adversarial review (2026-09-01): mergeFiles is the ONLY writer of
  // meta.updatedAt, and migrate clamps every row clock to it. A copy that
  // reaches migrate with a stale clock has its offline edit rewound to that
  // anchor, and the edit loses a slot contest it genuinely won. The mirror
  // migrates its copy before merging it, so it stamps first; flushSync wrote
  // raw until it became a merge (US-10 AC5). Both stay pinned.
  it('the mirror keeps the clock of the edit it saves (no rewind to a stale anchor)', async () => {
    const cloud = new MemoryCloud();
    const seeded = await RoadmapStore.create(new MemoryAdapter(cloud));
    await seeded.flush();
    // Backdate the file's last write — the state of a device that has been
    // offline since January.
    const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
    const stale = JSON.parse(entry.json) as RoadmapFile;
    stale.meta.createdAt = '2024-01-01T00:00:00.000Z';
    stale.meta.updatedAt = '2024-01-01T00:00:00.000Z';
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(stale), version: entry.version });

    const failing = await RoadmapStore.create(new TokenExpiredAdapter(cloud));
    const row = insertedRow(failing.addMeasurement('weight', 80, '2024-06-01T00:00:00.000Z'));
    await expect(failing.flush()).rejects.toThrow();

    const mirrored = readMirror()!.measurements.find((m) => m.id === row.id)!;
    expect(mirrored.createdAt).toBe(row.createdAt);
  });

  it('flushSync keeps the clock of the edit it saves (tab close on the local tier)', async () => {
    const old = createEmptyFile({ deviceId: 'dev_old', now: '2024-01-01T00:00:00.000Z' });
    await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, old, null);

    const store = await RoadmapStore.create(new LocalStorageAdapter());
    const row = insertedRow(store.addMeasurement('weight', 80, '2024-06-01T00:00:00.000Z'));
    store.flushSync(); // the tab-close write

    const reloaded = await RoadmapStore.create(new LocalStorageAdapter());
    const saved = reloaded.loadAllHistory().find((m) => m.id === row.id)!;
    expect(saved.createdAt).toBe(row.createdAt);
  });

  // US-10 AC5: a hide saves only what is unsaved. A save that FAILED is still
  // unsaved, though nothing sits on the debounce, so the next hide retries it.
  it('a cloud tab with nothing unsaved reads and writes nothing on hide', async () => {
    const adapter = new MemoryAdapter(new MemoryCloud());
    const store = await RoadmapStore.create(adapter);
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await store.flush();
    const read = vi.spyOn(adapter, 'read');
    const write = vi.spyOn(adapter, 'write');

    store.flushSync(); // the tab hides
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('a hide retries a cloud save that failed, though nothing sits on the debounce', async () => {
    const cloud = new MemoryCloud();
    let offline = true;
    class FlakyAdapter extends MemoryAdapter {
      async write(...args: Parameters<MemoryAdapter['write']>) {
        if (offline) throw new StorageError('The network is down.');
        return super.write(...args);
      }
    }
    const store = await RoadmapStore.create(new FlakyAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await expect(store.flush()).rejects.toThrow();
    expect(localStorage.getItem(PENDING_MIRROR_KEY)).not.toBeNull();

    offline = false;
    store.flushSync(); // the tab hides
    await vi.waitFor(() => expect(localStorage.getItem(PENDING_MIRROR_KEY)).toBeNull());
    expect(readCloudFile(cloud).measurements.map((m) => m.value)).toEqual([80]);
  });

  it('without the pending marker, a stale on-device copy is NOT merged into a cloud session', async () => {
    // A leftover local file (pre-connect residue) must not be re-lifted on every
    // load — only a marker left by a failed cloud save opens the merge gate.
    await new LocalStorageAdapter().write(ROADMAP_FILE_NAME, { stale: true }, null);

    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await store.flush();

    expect(readCloudFile(cloud).measurements).toHaveLength(1);
  });
});

// US-06 · Medications, supplements & screenings — store-level screening round-trip
// (docs/user-stories.md US-06: "screening round-trip tests exist in mappings.test.ts"
// — this pins the RoadmapStore.saveScreening layer itself, which sits underneath).
describe('RoadmapStore.saveScreening (US-06)', () => {
  it('round-trips a screening key/value into the file, snake_case -> camelCase', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveScreening('colorectal_method', 'fit_annual');
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.screenings.colorectalMethod).toBe('fit_annual');
  });

  it('parses NUMERIC_SCREENING_KEYS (lung_pack_years, prostate_psa_value) to a number, not a string', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveScreening('lung_pack_years', '15');
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.screenings.lungPackYears).toBe(15);
    expect(typeof file.screenings.lungPackYears).toBe('number');
  });

  // US-12 AC8: parseFloat stored a decimal-comma PSA "4,5" as 4. A blank
  // answer still writes null, the way a field is cleared (US-10 AC6).
  it('US-12 AC8: stores a decimal-comma PSA as a decimal, and a blank answer as null', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveScreening('prostate_psa_value', '4,5');
    store.saveScreening('lung_pack_years', '');
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.screenings.prostatePsaValue).toBe(4.5);
    expect(file.screenings.lungPackYears).toBeNull();
    expect(store.loadLatestMeasurements().screenings.map((s) => s.screeningKey)).not.toContain('lung_pack_years');
  });

  it('is a singleton merge, not a replace: setting a second key preserves the first', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveScreening('colorectal_method', 'fit_annual');
    store.saveScreening('breast_frequency', 'annual');
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.screenings.colorectalMethod).toBe('fit_annual');
    expect(file.screenings.breastFrequency).toBe('annual');
  });

  it('bumps the sync clock (lamport/updatedAt) on every write, so it wins last-write-wins on merge', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    store.saveScreening('colorectal_method', 'fit_annual');
    const afterFirst = store.loadLatestMeasurements().screenings.find((s) => s.screeningKey === 'colorectal_method');
    expect(afterFirst?.value).toBe('fit_annual');

    store.saveScreening('colorectal_method', 'colonoscopy_10yr');
    const afterSecond = store.loadLatestMeasurements().screenings.find((s) => s.screeningKey === 'colorectal_method');
    expect(afterSecond?.value).toBe('colonoscopy_10yr');
  });
});

// US-03 · Blood-test matrix entry & backfill — date-defaulting semantics
// (feedback 2026-03-22: a value appeared under a wrong date; root cause never
// found, so this pins the exact current defaulting behavior as a regression anchor).
describe('RoadmapStore.addMeasurement date semantics (US-03)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stores the exact recordedAt when one is provided', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const explicit = '2020-01-15T03:00:00.000Z';
    expect(insertedRow(store.addMeasurement('weight', 80, explicit)).recordedAt).toBe(explicit);
  });

  // US-29 AC4a: the reader drops a row whose recordedAt is not a real day, so
  // storing one made every later save in the session fail its readback.
  it.each(['2026-02-30T00:00:00.000Z', 'T00:00:00.000Z', ' 2026-10-18', '+002026-10-18'])(
    'US-29 AC4a — refuses recordedAt %s, and the next save still lands', async (bad) => {
      const store = await RoadmapStore.create(new MemoryAdapter());
      expect(store.addMeasurement('weight', 80, bad)).toEqual({ status: 'error' });
      expect(store.loadAllHistory()).toEqual([]);
      expect(store.addMeasurement('weight', 80, '2026-10-18T08:00:00+1300').status).toBe('inserted');
    });

  it('defaults recordedAt to the LOCAL calendar day at midnight when omitted', async () => {
    vi.setSystemTime(new Date('2026-08-07T12:34:56.000Z'));
    const store = await RoadmapStore.create(new MemoryAdapter());
    // roadmap-store.ts widens the local day through `ensureIsoDatetime` — the
    // same day-granularity shape the picked-date path stores, so the two paths
    // cannot land the same day in two slots. WHICH day is local is proved by
    // the dedicated TZ-pinned roadmap-store-local-day.test.ts.
    expect(insertedRow(store.addMeasurement('weight', 80)).recordedAt).toMatch(/T00:00:00\.000Z$/);
  });

  it('a second value for the same (metric, day) is blocked as a duplicate, never silently overwritten or double-stored', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const day = '2024-06-01T09:00:00.000Z';
    const first = store.addMeasurement('weight', 80, day);
    expect(first.status).toBe('inserted');

    // Same day, different time-of-day and a different value — still one slot.
    const second = store.addMeasurement('weight', 81, '2024-06-01T20:00:00.000Z');
    expect(second.status).toBe('duplicate');

    const active = store.loadAllHistory().filter((m) => m.metricType === 'weight');
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe(80); // the original — a same-day re-entry must route through correctValue (US-04), not addMeasurement.
  });
});

// US-11 AC1 (2026-09-10) — off-file health data must not outlive an erase.
// Before this, deleteUserData() cleared document blobs only when a CLOUD was
// connected (the localStorage-only branch skipped disconnect() so as not to
// delete the erased file it had just written), and the blood-test matrix's
// typed-but-unsaved draft survived an erase in every mode. The vitals matrix
// keeps its draft on the device too since 2026-09-24 (US-03 AC5).
describe('RoadmapStore.deleteUserData clears off-file health data (US-11 AC1)', () => {
  const DRAFT_KEY = 'health_roadmap_bt_timeline_draft';
  const VITALS_DRAFT_KEY = 'health_roadmap_vitals_draft';
  const DOC_KEY = 'health_roadmap_doc_v2:scan-123';
  const DOC_KEY_2 = 'health_roadmap_doc_v2:scan-456';

  // Stored keys are own ENUMERABLE props so Object.keys(localStorage) lists
  // them (the erase enumerates the document-blob family that way); the Storage
  // methods stay non-enumerable, as in connect.test.ts.
  function makeStorage(): Storage {
    const s = {} as Record<string, string>;
    Object.defineProperties(s, {
      length: { get() { return Object.keys(this).length; } },
      getItem: { value(k: string) { return k in this ? this[k] : null; } },
      setItem: { value(k: string, v: string) { this[k] = String(v); } },
      removeItem: { value(k: string) { delete this[k]; } },
      clear: { value() { for (const k of Object.keys(this)) delete this[k]; } },
      key: { value(i: number) { return Object.keys(this)[i] ?? null; } },
    });
    return s as unknown as Storage;
  }

  /** The keys an erase must NOT touch: a wipe by prefix would log the user out
   *  and reset consent decisions they had already made. */
  const KEEP: Record<string, string> = {
    health_roadmap_gdrive_tokens: '{"access_token":"secret"}',
    health_roadmap_dropbox_tokens: '{"access_token":"secret"}',
    health_roadmap_backend: 'dropbox',
    health_roadmap_device_id: 'device-1',
    hr_reminders_autoenrol_blocked: '1',
    hr_ab: '{"variant":"b"}',
    hr_vid: 'visitor-1',
    hr_anthropic_key: 'sk-ant-typed-by-the-user',
  };

  beforeEach(() => {
    const store = makeStorage();
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });
    store.setItem(DRAFT_KEY, '{"draft":{"date":"2026-09-01","values":{"ldl":"3.2"}}}');
    store.setItem(VITALS_DRAFT_KEY, '{"draft":{"date":"2026-09-01","values":{"weight":"82"}}}');
    store.setItem(DOC_KEY, 'data:application/pdf;base64,AAAA');
    store.setItem(DOC_KEY_2, 'data:application/pdf;base64,BBBB');
    for (const [k, v] of Object.entries(KEEP)) store.setItem(k, v);
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('clears both matrices\' unsaved drafts and every document blob for a localStorage-only user', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');

    const result = await store.deleteAllData();
    expect(result.success).toBe(true);

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
    expect(localStorage.getItem(DOC_KEY_2)).toBeNull();
    // The erased file itself is still there (local mode has no other copy) and
    // holds no data — disconnect() must NOT run here, or the erase would delete
    // the very file that carries eraseEpoch.
    const file = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!) as RoadmapFile;
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
  });

  // US-11 AC1 / US-05 AC3: the Lp(a) check's "keep as saved" answers name
  // rows of the record on this device, so an erase takes them too, in both modes.
  it('clears the Lp(a) check\'s kept answers, for a localStorage-only and a cloud user', async () => {
    const KEPT_KEY = 'health_roadmap_lpa_check_kept';
    for (const adapter of [new LocalStorageAdapter(), new MemoryAdapter(new MemoryCloud())]) {
      localStorage.setItem(KEPT_KEY, '["row-1"]');
      const store = await RoadmapStore.create(adapter);
      store.addMeasurement('lpa', 120, '2026-09-18T00:00:00.000Z');
      expect((await store.deleteAllData()).success).toBe(true);
      expect(localStorage.getItem(KEPT_KEY), adapter.id).toBeNull();
      for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k), k).toBe(v);
    }
  });

  it('clears the same keys for a cloud user', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');

    expect((await store.deleteAllData()).success).toBe(true);

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(DOC_KEY)).toBeNull();
    expect(localStorage.getItem(DOC_KEY_2)).toBeNull();
  });

  // E2 (2026-09-10): chat-history.json is stored under the local adapter's
  // NAMED_FILE_PREFIX, and only disconnect() clears that prefix — which local
  // mode skips, so a localStorage-only user's chat history outlived the erase.
  it('removes the named record files (chat history) but keeps the erased record file', async () => {
    const CHAT_KEY = 'health_roadmap_file_v2:chat-history.json';
    localStorage.setItem(CHAT_KEY, '{"conversations":[{"id":"c1","title":"my ldl is 3.2","messages":[]}]}');
    localStorage.setItem(`${CHAT_KEY}_rev`, '3');

    const store = await RoadmapStore.create(new LocalStorageAdapter());
    expect((await store.deleteAllData()).success).toBe(true);

    expect(localStorage.getItem(CHAT_KEY)).toBeNull();
    expect(localStorage.getItem(`${CHAT_KEY}_rev`)).toBeNull();
    // The erased record file must stay: local mode has no other copy of it.
    expect(localStorage.getItem('health_roadmap_file_v2')).not.toBeNull();
  });

  it('leaves connection tokens, consent flags and the typed API key alone (named keys, never a prefix wipe)', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    expect((await store.deleteAllData()).success).toBe(true);

    // hr_anthropic_key is a credential the user typed, not health data: an
    // erase leaves it, so a self-host user does not have to re-enter it.
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v);
  });

  // Review of 2026-09-24, round 3: an erase made on ANOTHER device reached
  // this one by a re-read or a save, and the drafts typed here outlived it:
  // the matrix restored them, and a leave committed them into the new record.
  it('clears both drafts when an erase made on another device arrives, by a re-read or by a save', async () => {
    const drafts = [DRAFT_KEY, VITALS_DRAFT_KEY].map((k) => [k, localStorage.getItem(k)!] as const);
    // jsdom has one localStorage for every device: this device's drafts go back.
    const putBack = () => { for (const [k, v] of drafts) localStorage.setItem(k, v); };
    // What a matrix on screen hears, so it drops its own copy (round 4).
    const heard = vi.fn();
    vi.stubGlobal('window', new EventTarget());
    window.addEventListener(DRAFTS_CLEARED_EVENT, heard);
    // Each step a minute apart: US-09 AC20 keeps a row by its time against the erase.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    const cloud = new MemoryCloud();
    const page = await RoadmapStore.create(new MemoryAdapter(cloud));
    page.addMeasurement('weight', 80, '2024-01-01T00:00:00.000Z');
    await page.flush();
    const otherPage = await RoadmapStore.create(new MemoryAdapter(cloud));

    vi.setSystemTime(new Date('2026-09-01T10:01:00.000Z'));
    await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteAllData(); // the other device
    heard.mockClear();
    putBack();
    expect(await page.refreshFromRemote()).toBe(true);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);

    putBack();
    vi.setSystemTime(new Date('2026-09-01T10:02:00.000Z'));
    otherPage.addMeasurement('weight', 81, '2024-02-01T00:00:00.000Z'); // made before it heard of the erase
    await otherPage.flush();
    // Typed after the erase, so it survives it (US-09 AC20); the pre-erase row does not.
    expect(otherPage.loadAllHistory().map((m) => m.value)).toEqual([81]);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(localStorage.getItem(VITALS_DRAFT_KEY)).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v);
  });

  // US-11 AC1 / US-05 AC3 (Codex R2, adversary R7): the Lp(a) check's kept
  // answers name rows of the erased record, so an erase made on another
  // device takes them here too, by a re-read or by a save.
  it('clears the Lp(a) check\'s kept answers when an erase made on another device arrives, by a re-read or by a save', async () => {
    const KEPT_KEY = 'health_roadmap_lpa_check_kept';
    vi.stubGlobal('window', new EventTarget());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const cloud = new MemoryCloud();
    const page = await RoadmapStore.create(new MemoryAdapter(cloud));
    page.addMeasurement('lpa', 37.44, '2026-09-18T00:00:00.000Z');
    await page.flush();
    const otherPage = await RoadmapStore.create(new MemoryAdapter(cloud));

    vi.setSystemTime(new Date('2026-09-18T10:01:00.000Z'));
    await (await RoadmapStore.create(new MemoryAdapter(cloud))).deleteAllData(); // the other device
    localStorage.setItem(KEPT_KEY, '["row-1"]'); // jsdom has one localStorage for every device: this device's goes back
    expect(await page.refreshFromRemote()).toBe(true);
    expect(localStorage.getItem(KEPT_KEY)).toBeNull();

    localStorage.setItem(KEPT_KEY, '["row-1"]');
    vi.setSystemTime(new Date('2026-09-18T10:02:00.000Z'));
    otherPage.addMeasurement('weight', 81, '2024-02-01T00:00:00.000Z'); // made before it heard of the erase
    await otherPage.flush();
    // Typed after the erase, so it survives it (US-09 AC20); the Lp(a) row does not.
    expect(otherPage.loadAllHistory().map((m) => m.value)).toEqual([81]);
    expect(localStorage.getItem(KEPT_KEY)).toBeNull();
    for (const [k, v] of Object.entries(KEEP)) expect(localStorage.getItem(k)).toBe(v);
  });
});

// US-09 AC23 · an erase records WHICH rows it removed, read from the whole
// stored record before anything irreversible, and refuses when it cannot read.
describe('RoadmapStore.deleteUserData lists the rows it removes (US-09 AC23)', () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    const store = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    Object.defineProperty(globalThis, 'localStorage', { value: store, writable: true, configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    vi.restoreAllMocks();
  });

  class SaveFails extends MemoryAdapter {
    async write(): Promise<never> {
      throw new StorageError('cloud down');
    }
  }
  const fileOf = (store: RoadmapStore) => (store as unknown as { file: RoadmapFile }).file;
  const idOf = (store: RoadmapStore, metric: string) => fileOf(store).measurements.find((m) => m.metricType === metric)!.id;

  it('lists the stored record\'s rows, its own copy\'s and the device file\'s, ids only', async () => {
    const cloud = new MemoryCloud();
    const other = await RoadmapStore.create(new MemoryAdapter(cloud));
    other.addMeasurement('weight', 80, '2026-06-01');
    other.saveMedication('statin', 'atorvastatin', 20, 'mg');
    await other.flush(); // in the stored record
    const eraser = await RoadmapStore.create(new MemoryAdapter(cloud));
    other.addMeasurement('ldl', 3.1, '2026-06-02');
    await other.flush(); // stored after the eraser loaded: only the read at erase time sees it
    eraser.addMeasurement('hdl', 1.4, '2026-06-03'); // its own copy, still on the debounce
    const tab = await RoadmapStore.create(new SaveFails(cloud));
    tab.addMeasurement('waist', 90, '2026-06-04');
    await expect(tab.flush()).rejects.toThrow(); // another tab's failed save, mirrored on this device
    const { medications, medicationHistory } = fileOf(other);
    const expected = [
      idOf(other, 'weight'), idOf(other, 'ldl'), idOf(eraser, 'hdl'), idOf(tab, 'waist'), medications[0].id, medicationHistory[0].id,
    ].sort();

    expect((await eraser.deleteAllData()).success).toBe(true);

    const file = readCloudFile(cloud);
    expect(file.erasedRows).toEqual({ fromEpoch: 1, ids: expected });
    expect(file.schemaVersion).toBe(2);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.meta.erasedAt).toBeTypeOf('string'); // still stamped, for the legacy rule
    // Ids only: no value, metric, date or name rides in the list.
    expect(JSON.stringify(file.erasedRows)).not.toMatch(/weight|ldl|hdl|waist|statin|atorvastatin|2026/);
  });

  it('a failed cloud read refuses before the caller\'s irreversible step, and changes nothing', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const store = await RoadmapStore.create(adapter);
    store.addMeasurement('weight', 80, '2026-06-01');
    await store.flush();
    store.addMeasurement('ldl', 3.1, '2026-06-02'); // on the debounce
    const before = cloud.files.get(ROADMAP_FILE_NAME)!.json;
    vi.spyOn(adapter, 'read').mockRejectedValueOnce(new StorageError('Dropbox did not answer'));
    const beforeErase = vi.fn(async () => {});

    expect(await store.deleteAllData({ teardown: beforeErase })).toEqual({ success: false, error: ERASE_UNREACHABLE, chatErased: false });

    expect(beforeErase).not.toHaveBeenCalled();
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(before);
    expect(store.loadAllHistory().map((m) => m.value).sort()).toEqual([3.1, 80]);
    await store.flush(); // the edit the erase held back still saves
    expect(readCloudFile(cloud).measurements).toHaveLength(2);
  });

  it('a session on-device because its cloud could not be read refuses, and its device file is untouched', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter(), true);
    store.addMeasurement('weight', 80, '2026-06-01');
    await store.flush();
    const before = localStorage.getItem('health_roadmap_file_v2');
    const beforeErase = vi.fn(async () => {});

    expect(await store.deleteAllData({ teardown: beforeErase })).toEqual({ success: false, error: ERASE_UNREACHABLE, chatErased: false });
    expect(beforeErase).not.toHaveBeenCalled();
    expect(localStorage.getItem('health_roadmap_file_v2')).toBe(before);
  });

  it('a guest whose device record cannot be read still erases its own copy, and lists it', async () => {
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 80, '2026-06-01');
    await store.flush();
    const id = idOf(store, 'weight');
    localStorage.setItem('health_roadmap_file_v2', '{not valid json');
    const beforeErase = vi.fn(async () => {});

    // The write reads the same bytes, so it fails as before; the erase went ahead.
    expect((await store.deleteAllData({ teardown: beforeErase })).success).toBe(false);
    expect(beforeErase).toHaveBeenCalledTimes(1);
    expect(fileOf(store).erasedRows).toEqual({ fromEpoch: 1, ids: [id] });
  });

  it('a device file of valid JSON in a shape migrate refuses lists nothing, and the erase still succeeds (Codex R1)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2026-06-01');
    await store.flush();
    const id = idOf(store, 'weight');
    const bad = { ...createEmptyFile({ deviceId: 'tab', now: '2026-06-01T00:00:00.000Z' }), measurements: 'not an array' };
    localStorage.setItem('health_roadmap_file_v2', JSON.stringify(bad));

    expect(await store.deleteAllData()).toEqual({ success: true, chatErased: true });
    expect(readCloudFile(cloud).erasedRows).toEqual({ fromEpoch: 1, ids: [id] });
  });

  it('over a stored erase at its own epoch that listed nothing, the list claims only this erase (adversary R1)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2026-06-01');
    expect((await store.deleteAllData()).success).toBe(true); // this copy: epoch 1, listed from 1
    // Meanwhile an old bundle erased the cloud at epoch 1 too, listing nothing.
    const legacy = createEmptyFile({ deviceId: 'old-app', now: '2026-06-02T00:00:00.000Z' });
    legacy.meta.eraseEpoch = 1;
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(legacy), version: cloud.files.get(ROADMAP_FILE_NAME)!.version + 1 });

    expect((await store.deleteAllData()).success).toBe(true);
    expect(readCloudFile(cloud).meta.eraseEpoch).toBe(2);
    expect(readCloudFile(cloud).erasedRows?.fromEpoch).toBe(2);
  });

  it('the pending marker is a far-future instant, so an older bundle that reads it as a keep-newer-than time keeps nothing extra (adversary R5)', () => {
    markSyncPending();
    expect(isSyncPending()).toBe(true);
    const value = localStorage.getItem(PENDING_MIRROR_KEY)!;
    expect(Date.parse(value)).toBe(Date.parse('9999-12-31T23:59:59.999Z'));
  });

  it('a second erase keeps the first list and its fromEpoch; one over an erase that listed nothing claims from its own epoch', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('weight', 80, '2026-06-01');
    const first = idOf(store, 'weight');
    expect((await store.deleteAllData()).success).toBe(true);
    store.addMeasurement('ldl', 3.1, '2026-06-02');
    const second = idOf(store, 'ldl');
    expect((await store.deleteAllData()).success).toBe(true);
    expect(readCloudFile(cloud).erasedRows).toEqual({ fromEpoch: 1, ids: [first, second].sort() });
    expect(readCloudFile(cloud).meta.eraseEpoch).toBe(2);

    // A record erased before the list existed: epoch 3, nothing listed.
    const legacyCloud = new MemoryCloud();
    const legacy = createEmptyFile({ deviceId: 'old-app', now: '2026-06-01T00:00:00.000Z' });
    legacy.meta.eraseEpoch = 3;
    await new MemoryAdapter(legacyCloud).write(ROADMAP_FILE_NAME, legacy, null);
    const later = await RoadmapStore.create(new MemoryAdapter(legacyCloud));
    later.addMeasurement('weight', 81, '2026-06-03');
    const third = idOf(later, 'weight');
    expect((await later.deleteAllData()).success).toBe(true);
    expect(readCloudFile(legacyCloud).erasedRows).toEqual({ fromEpoch: 4, ids: [third] });
    expect(readCloudFile(legacyCloud).meta.eraseEpoch).toBe(4);
  });
});
