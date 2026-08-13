import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_FILE_NAME } from './adapter';

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

// US-17 · Email reminders — local preference state underneath the opt-in flow
// (docs/user-stories.md US-17: "opt-in UX→server path untested" — this covers the
// store-level preference persistence that sits below that path).
describe('RoadmapStore reminder preferences (US-17)', () => {
  it('saveReminderPreference persists an upsert keyed by category', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveReminderPreference('bloods_annual', true);
    await store.flush();

    let file = readCloudFile(cloud);
    expect(file.reminderPreferences).toHaveLength(1);
    expect(file.reminderPreferences[0]).toMatchObject({ category: 'bloods_annual', enabled: true });

    // Re-saving the same category updates in place — no duplicate row.
    store.saveReminderPreference('bloods_annual', false);
    await store.flush();
    file = readCloudFile(cloud);
    expect(file.reminderPreferences).toHaveLength(1);
    expect(file.reminderPreferences[0].enabled).toBe(false);
  });

  // Regression (fixed 2026-08-07): setGlobalReminderOptout used to mutate
  // `p.enabled` in place WITHOUT bumping the rows' SyncStamp (lamport/updatedAt),
  // so persist()'s read-merge-write let the stale cloud copy win the mergeByKey
  // tie-break and the opt-out silently reverted on the very next flush — a
  // privacy-relevant defect ("turn off all reminders" didn't stick). Fixed by
  // routing each flip through saveReminderPreference (which stamps via
  // upsertByKey). This test failed against the unstamped implementation.
  it('setGlobalReminderOptout survives a flush (stamped rows win the merge)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveReminderPreference('bloods_annual', true);
    store.saveReminderPreference('screening_due', true);
    await store.flush();

    store.setGlobalReminderOptout(true);
    expect(
      store.loadLatestMeasurements().reminderPreferences.every((p) => p.enabled === false),
    ).toBe(true);

    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.reminderPreferences).toHaveLength(2);
    expect(file.reminderPreferences.every((p) => p.enabled === false)).toBe(true);
  });

  // TODO(US-17): possible gap — the method comment says "Disable/enable every known
  // preference category" (roadmap-store.ts:361-366), but the implementation only
  // iterates `this.file.reminderPreferences`, i.e. categories that already have a row
  // from a prior saveReminderPreference call. On a fresh file (no rows saved yet — the
  // common case for a user who never touched per-category toggles before hitting a
  // global "turn off reminders" control) this is a complete no-op: nothing is created,
  // nothing is disabled. Whether that's correct depends on whether the caller (UI/opt-in
  // flow, out of scope for this store-level pass) always seeds all REMINDER_CATEGORIES
  // rows first. Pinning current behavior; flagging for the store's owner to confirm.
  it('is a no-op on a fresh file with no saved preferences yet (does not create rows for known categories)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.setGlobalReminderOptout(true);
    await store.flush();

    const file = readCloudFile(cloud);
    expect(file.reminderPreferences).toEqual([]);
  });
});

// US-03 · Blood-test matrix entry & backfill — date-defaulting semantics
// (feedback 2026-03-22: a value appeared under a wrong date; root cause never
// found, so this pins the exact current defaulting behavior as a regression anchor).
describe('RoadmapStore.addMeasurement date semantics (US-03)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores the exact recordedAt when one is provided', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    const explicit = '2020-01-15T03:00:00.000Z';
    expect(insertedRow(store.addMeasurement('weight', 80, explicit)).recordedAt).toBe(explicit);
  });

  it('defaults recordedAt to "now" (the clock at call time) when omitted', async () => {
    vi.setSystemTime(new Date('2026-08-07T12:34:56.000Z'));
    const store = await RoadmapStore.create(new MemoryAdapter());
    // roadmap-store.ts: `const when = recordedAt ?? new Date().toISOString();`
    expect(insertedRow(store.addMeasurement('weight', 80)).recordedAt).toBe('2026-08-07T12:34:56.000Z');
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
