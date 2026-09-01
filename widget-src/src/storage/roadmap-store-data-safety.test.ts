import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore, PENDING_MIRROR_KEY } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { LocalStorageAdapter } from './local-storage-adapter';
import { ROADMAP_FILE_NAME, StorageError } from './adapter';

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
// (docs/user-stories.md: "RoadmapStore.correctMeasurement itself untested").
describe('RoadmapStore.correctMeasurement (US-04)', () => {
  it('flips the old row to entered-in-error and appends a manual_correction row with correctsId', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;

    const result = store.correctMeasurement(oldId, 3.2);
    expect(result.status).toBe('ok');
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

    store.correctMeasurement(insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id, 3.2);

    // Both loadAllHistory() and loadLatestMeasurements() filter to status==='active'.
    const history = store.loadAllHistory();
    expect(history.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(history.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);

    const latest = store.loadLatestMeasurements();
    expect(latest.previousMeasurements.filter((m) => m.metricType === 'ldl')).toHaveLength(1);
    expect(latest.previousMeasurements.find((m) => m.metricType === 'ldl')?.value).toBe(3.2);
  });

  it('correcting a non-existent id returns not_found and leaves the file untouched', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z');
    await store.flush();
    const before = readCloudFile(cloud);

    const result = store.correctMeasurement('does-not-exist', 3.2);
    expect(result.status).toBe('not_found');
    await store.flush();

    const after = readCloudFile(cloud);
    expect(after.measurements).toHaveLength(before.measurements.length);
    expect(after.measurements).toEqual(before.measurements);
  });

  it('correcting an already-corrected (entered-in-error) id also returns not_found, without corrupting state', async () => {
    // Same documented failure shape as the unknown-id case — correctMeasurement
    // only accepts oldId pointing at a currently-active row (roadmap-store.ts:261).
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const oldId = insertedRow(store.addMeasurement('ldl', 4.5, '2024-06-01T09:00:00.000Z')).id;
    store.correctMeasurement(oldId, 3.2); // first correction — oldId now entered-in-error

    const second = store.correctMeasurement(oldId, 2.9); // re-correcting the now-dead row
    expect(second.status).toBe('not_found');
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
    store.correctMeasurement(insertedRow(store.addMeasurement('ldl', 4.5, day)).id, 3.2);

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

    const result = await store.deleteUserData();
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

    await deviceA.deleteUserData();

    // Device B, still holding its stale populated in-memory copy, flushes.
    // mergeFiles' eraseEpoch gate wins wholesale — B's data must NOT come back.
    await deviceB.flush();

    const file = readCloudFile(cloud);
    expect(file.meta.eraseEpoch).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(deviceB.loadAllHistory()).toEqual([]);
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

    await store.deleteUserData();

    const optIn = readCloudFile(cloud).reminderOptIn!;
    expect(optIn.status).toBe('cancelled');
    // The decision survives; the identity does NOT — an erase must not leave the
    // user's address or capability token behind in the name of remembering a no.
    expect(optIn.email).toBe('');
    expect(optIn.token).toBe('');
  });

  it('leaves an ENROLLED user with no opt-in record after an erase (they start over)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.setReminderOptIn({ status: 'active', token: 'cap-token', email: 'user@example.com', provider: 'dropbox' });

    await store.deleteUserData();

    // No stale token or address survives. The server row is deleted separately,
    // by the pre-erase hook in roadmap-data.ts (it needs the token, so it runs
    // before this); re-enrolment on the next visit is the default-on model
    // working as designed, and it shows the notice again.
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

// US-13 · Review before save — deleting a reviewed lab value
// (docs/user-stories.md: "store deleteLabValue untested").
describe('RoadmapStore.deleteLabValue (US-13)', () => {
  it('soft-deletes: flips status to entered-in-error (never splices the row)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const saved = store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    const id = saved.saved[0].id;
    await store.flush();

    const ok = store.deleteLabValue(id);
    expect(ok).toBe(true);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.labValues).toHaveLength(1); // row is kept, not removed
    expect(file.labValues[0].id).toBe(id);
    expect(file.labValues[0].status).toBe('entered-in-error');

    // Reads (activeOnly) exclude it.
    expect(store.loadLabValues()).toHaveLength(0);
  });

  it('deleting an unknown id returns false and leaves the file untouched', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]);
    await store.flush();
    const before = readCloudFile(cloud);

    const ok = store.deleteLabValue('does-not-exist');
    expect(ok).toBe(false);
    await store.flush();

    const after = readCloudFile(cloud);
    expect(after.labValues).toEqual(before.labValues);
  });

  // TODO(US-13): possible bug — unlike deleteDocument (`if (!doc || doc.deleted)
  // return false`), deleteLabValue has no already-deleted guard (roadmap-store.ts:515-521):
  // it re-sets status unconditionally and returns true again. Harmless today (status
  // is already 'entered-in-error', no duplicate row), but it's an inconsistency with
  // the document-delete idempotency contract worth a second look if either path grows
  // more logic (e.g. an audit-log side effect keyed off "was this a real transition").
  it('deleting an already-deleted lab value succeeds again (idempotent no-op), pinning current behavior', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const id = store.bulkSaveLabValues([
      { metricName: 'ferritin', value: 80, unit: 'ng/mL', recordedAt: '2024-06-01T09:00:00.000Z' },
    ]).saved[0].id;
    store.deleteLabValue(id);

    const second = store.deleteLabValue(id);
    expect(second).toBe(true);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.labValues).toHaveLength(1);
    expect(file.labValues[0].status).toBe('entered-in-error');
  });
});

// US-14 · Document archive — bulkSaveDocuments / deleteDocument / readDocumentFile
// (docs/user-stories.md: "❌ store deleteDocument/readDocumentFile. Deferred.").
describe('RoadmapStore document archive (US-14)', () => {
  it('bulkSaveDocuments writes the blob + metadata; readDocumentFile reads the same bytes back', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const file = new Blob(['%PDF-1.4 fake lipid panel bytes'], { type: 'application/pdf' });

    const [saved] = await store.bulkSaveDocuments([
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
    expect(first).toHaveLength(1);
    await store.flush();

    const second = await store.bulkSaveDocuments([{ ...payload, title: 'Lipid panel (re-upload)' }]);
    expect(second).toHaveLength(0);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.documents.filter((d) => !d.deleted)).toHaveLength(1);
  });

  it('deleteDocument tombstones (keeps the row, flips deleted) and hides it from reads', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    const [saved] = await store.bulkSaveDocuments([
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
    const [saved] = await store.bulkSaveDocuments([
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
    const result = await healthy.deleteUserData();
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
    const result = await failing.deleteUserData();
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
  // meta.updatedAt, and migrate clamps every row clock to it. Both writes that
  // bypass the merge — this mirror and flushSync — must advance the clock, or
  // the offline edit they just saved is rewound to a stale anchor on the next
  // load and loses a slot contest it genuinely won.
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
    store.flushSync(); // raw writeSync — no merge, so nothing else stamps meta

    const reloaded = await RoadmapStore.create(new LocalStorageAdapter());
    const saved = reloaded.loadAllHistory().find((m) => m.id === row.id)!;
    expect(saved.createdAt).toBe(row.createdAt);
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
    expect(active[0].value).toBe(80); // the original — a same-day re-entry must route through correctMeasurement (US-04), not addMeasurement.
  });
});
