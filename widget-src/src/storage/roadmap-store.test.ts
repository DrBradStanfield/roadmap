import { describe, it, expect } from 'vitest';
import { localDay, measurementsToInputs, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core';

/** The file as it landed in the (simulated) cloud after a flush. */
function readCloudFile(cloud: MemoryCloud): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

describe('RoadmapStore — reportEmailCaptured lead flag', () => {
  it('defaults false, sets true, and persists across a reload (returning user)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(store.getReportEmailCaptured()).toBe(false);

    store.markReportEmailCaptured();
    expect(store.getReportEmailCaptured()).toBe(true);
    await store.flush();

    // A fresh store over the SAME cloud = the user returning / a second device.
    // The flag must survive the persist → reload → migrate round-trip.
    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(reloaded.getReportEmailCaptured()).toBe(true);
  });

  it('is idempotent — marking twice stays true and does not throw', async () => {
    const store = await RoadmapStore.create(new MemoryAdapter());
    store.markReportEmailCaptured();
    store.markReportEmailCaptured();
    expect(store.getReportEmailCaptured()).toBe(true);
  });
});

describe('RoadmapStore — medication history (append-only change log)', () => {
  it('records started → dose_changed → switched → stopped, skipping identical re-saves', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveMedication('statin', 'atorvastatin', 20, 'mg'); // started
    store.saveMedication('statin', 'atorvastatin', 20, 'mg'); // identical → no row
    store.saveMedication('statin', 'atorvastatin', 40, 'mg'); // dose_changed
    store.saveMedication('statin', 'rosuvastatin', 10, 'mg'); // switched
    store.saveMedication('statin', 'none', null, null);       // stopped
    await store.flush();

    const file = readCloudFile(cloud);
    const history = file.medicationHistory.filter((h) => h.medicationKey === 'statin');
    // The merge unions history by id (uuid sort), so assert content, not order.
    expect(history.map((h) => h.changeType).sort()).toEqual([
      'dose_changed',
      'started',
      'stopped',
      'switched',
    ]);

    const started = history.find((h) => h.changeType === 'started')!;
    expect(started.id).toBeTruthy();
    expect(started.drugName).toBe('atorvastatin');
    expect(started.doseValue).toBe(20);
    expect(started.doseUnit).toBe('mg');
    expect(started.updatedAt).toBeTruthy(); // effective timestamp

    // Current state reflects the last save; history kept every step.
    const current = file.medications.find((m) => m.medicationKey === 'statin');
    expect(current?.drugName).toBe('none');
  });

  it('does not record transitions between non-taking statuses (not_yet ↔ not_tolerated)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveMedication('ezetimibe', 'not_yet', null, null);
    store.saveMedication('ezetimibe', 'not_tolerated', null, null);
    store.saveMedication('ezetimibe', 'none', null, null);
    await store.flush();

    expect(readCloudFile(cloud).medicationHistory).toEqual([]);
  });

  it('history survives a reload (rides the sync loop, merged by id union)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.saveMedication('statin', 'atorvastatin', 20, 'mg');
    await store.flush();

    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    reloaded.saveMedication('statin', 'atorvastatin', 40, 'mg');
    await reloaded.flush();

    const history = readCloudFile(cloud).medicationHistory;
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.changeType).sort()).toEqual(['dose_changed', 'started']);
  });
});

describe('RoadmapStore — supplement history (append-only change log)', () => {
  it('records started on add and stopped on soft-delete; history rows are never removed', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveSupplement('microvitamin', 'MicroVitamin', 1, 'tablet'); // started
    store.saveSupplement('microvitamin', 'MicroVitamin', 1, 'tablet'); // identical → no row
    store.deleteSupplementApi('microvitamin');                          // stopped (soft)
    store.deleteSupplementApi('microvitamin');                          // already stopped → no row
    await store.flush();

    const file = readCloudFile(cloud);
    const history = file.supplementHistory.filter((h) => h.supplementKey === 'microvitamin');
    expect(history.map((h) => h.changeType).sort()).toEqual(['started', 'stopped']);
    expect(history.find((h) => h.changeType === 'stopped')?.status).toBe('stopped');

    // Soft-delete: the current-state row stays, flipped to stopped.
    const current = file.supplements.find((s) => s.supplementKey === 'microvitamin');
    expect(current?.status).toBe('stopped');
  });

  it('records dose_changed and restart (started) transitions', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveSupplement('omega3', 'Omega-3', 1000, 'mg');  // started
    store.saveSupplement('omega3', 'Omega-3', 2000, 'mg');  // dose_changed
    store.deleteSupplementApi('omega3');                     // stopped
    store.saveSupplement('omega3', 'Omega-3', 2000, 'mg');  // restart → started
    await store.flush();

    const history = readCloudFile(cloud).supplementHistory;
    expect(history.map((h) => h.changeType).sort()).toEqual([
      'dose_changed',
      'started',
      'started',
      'stopped',
    ]);
  });
});

describe('RoadmapStore — deleted measurements stay deleted (no resurrection)', () => {
  // Regression: the BP-resurrection bug. The v1 guest→cloud resync in
  // HealthTool re-inserted the stale `health_roadmap_data` mirror's longitudinal
  // values via addMeasurement at TODAY's date whenever loadLatestMeasurements()
  // came back empty. Because the resurrected value lands on a DIFFERENT day than
  // the original (today vs the deletion's past date), it slips past the
  // one-active-per-(metric, day) slot guard and reappears as a phantom reading.
  // The fix gates that resync out of the local-first build (the store is the
  // single source of truth there). These tests pin the store-level invariants
  // the fix relies on.

  // Faithful model of the resync loop the fix removes from local-first:
  // re-insert each non-undefined longitudinal value from the legacy cache.
  function legacyResync(store: RoadmapStore, cachedInputs: Record<string, number | undefined>) {
    const FIELD_TO_METRIC: Record<string, string> = {
      weightKg: 'weight', waistCm: 'waist', systolicBp: 'systolic_bp', diastolicBp: 'diastolic_bp',
    };
    for (const [field, metric] of Object.entries(FIELD_TO_METRIC)) {
      const v = cachedInputs[field];
      if (v !== undefined) store.addMeasurement(metric, v); // no recordedAt ⇒ today
    }
  }

  it('a corrected (deleted) BP value is not the active value, and only one active per slot survives', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    const past = '2024-03-01T09:00:00.000Z';
    const sys = store.addMeasurement('systolic_bp', 128, past);
    const dia = store.addMeasurement('diastolic_bp', 82, past);
    expect(sys.status).toBe('inserted');
    expect(dia.status).toBe('inserted');

    // User corrects the systolic reading → the original flips to entered-in-error.
    if (sys.status === 'inserted') store.correctMeasurement(sys.row.id, 130);
    await store.flush();

    const file = readCloudFile(cloud);
    const activeSys = file.measurements.filter((m) => m.metricType === 'systolic_bp' && m.status === 'active');
    expect(activeSys).toHaveLength(1);
    expect(activeSys[0].value).toBe(130); // the correction, not the original 128
  });

  it('legacy resync of a stale cache WOULD resurrect a deleted value at today (proves the mechanism)', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    // BP was entered on a past date then deleted (corrected away to the point the
    // user expects it gone). Here we model a clean store with NO BP at all.
    // The stale legacy cache still holds the mirrored latest inputs.
    const staleCache = { systolicBp: 199, diastolicBp: 111 };

    // This is the path the fix REMOVES for local-first. Running it re-adds BP.
    legacyResync(store, staleCache);
    await store.flush();

    const resurrected = readCloudFile(cloud).measurements.filter(
      (m) => m.metricType === 'systolic_bp' && m.status === 'active',
    );
    const today = localDay(new Date());
    expect(resurrected).toHaveLength(1);
    expect(resurrected[0].value).toBe(199);
    expect(resurrected[0].recordedAt.slice(0, 10)).toBe(today); // landed at today — the bug
  });

  it('a deletion (entered-in-error) survives a merge against a stale copy that still has it active', async () => {
    // The merge-engine guarantee the fix leans on: status is monotonic, so a
    // delete seen by one copy is never undone by a stale copy that still shows
    // the row active. This holds for BP AND a second metric (weight).
    const cloud = new MemoryCloud();
    const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));

    const past = '2024-03-01T09:00:00.000Z';
    const bp = deviceA.addMeasurement('systolic_bp', 140, past);
    const wt = deviceA.addMeasurement('weight', 90, past);
    await deviceA.flush();

    // Device B loads the same cloud (now both rows are active on B too).
    const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));

    // Device A deletes both (correction flips the originals to entered-in-error).
    if (bp.status === 'inserted') deviceA.correctMeasurement(bp.row.id, 138);
    if (wt.status === 'inserted') deviceA.correctMeasurement(wt.row.id, 88);
    await deviceA.flush();

    // Device B (which still had them active) now flushes → read-merge-write.
    // The monotonic entered-in-error must win: the deleted originals stay dead.
    await deviceB.flush();

    const file = readCloudFile(cloud);
    const origBp = file.measurements.find((m) => bp.status === 'inserted' && m.id === bp.row.id);
    const origWt = file.measurements.find((m) => wt.status === 'inserted' && m.id === wt.row.id);
    expect(origBp?.status).toBe('entered-in-error');
    expect(origWt?.status).toBe('entered-in-error');
    // And exactly one active row remains per slot (the corrected value).
    expect(file.measurements.filter((m) => m.metricType === 'systolic_bp' && m.status === 'active')).toHaveLength(1);
    expect(file.measurements.filter((m) => m.metricType === 'weight' && m.status === 'active')).toHaveLength(1);
  });
});

describe('RoadmapStore — screening current state (LWW singleton)', () => {
  it('persists a screening across a flush → reload round-trip', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveScreening('colorectal_method', 'colonoscopy');
    store.saveScreening('prostate_psa_value', '1.2'); // numeric key → parsed to a number
    await store.flush();

    // A fresh store over the SAME cloud = the user returning / a second device.
    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    const rows = reloaded.loadLatestMeasurements().screenings;
    const byKey = Object.fromEntries(rows.map((r) => [r.screeningKey, r.value]));
    expect(byKey.colorectal_method).toBe('colonoscopy');
    expect(byKey.prostate_psa_value).toBe('1.2');
  });

  it('stamps the sync clock so the change wins merge against an empty remote', async () => {
    // The data-loss bug: saveScreening mutated file.screenings but never bumped
    // lamport/updatedAt, so it stayed lamport:0 like the fresh remote and
    // pickNewer could discard it on the next merge. Two devices, one cloud:
    // device A's screening must NOT be lost when it syncs against device B's
    // empty (but already-flushed, so version-ahead) copy.
    const cloud = new MemoryCloud();

    // Device B initialises the cloud file first (empty screenings, lamport:0).
    const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
    await deviceB.flush();

    // Device A picks a screening, then syncs into the existing cloud file.
    const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
    deviceA.saveScreening('colorectal_method', 'fit');
    await deviceA.flush();

    const cloudFile = readCloudFile(cloud);
    expect((cloudFile.screenings as unknown as Record<string, unknown>).colorectalMethod).toBe('fit');
    expect(cloudFile.screenings.lamport).toBeGreaterThan(0);

    // Device B re-reads the cloud — it must see device A's pick, not its own empty copy.
    const deviceBReloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    const rows = deviceBReloaded.loadLatestMeasurements().screenings;
    expect(rows.find((r) => r.screeningKey === 'colorectal_method')?.value).toBe('fit');
  });

  it('last write wins for repeated edits to the same screening key', async () => {
    const cloud = new MemoryCloud();
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));

    store.saveScreening('colorectal_method', 'fit');
    store.saveScreening('colorectal_method', 'colonoscopy');
    await store.flush();

    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    const rows = reloaded.loadLatestMeasurements().screenings;
    const matches = rows.filter((r) => r.screeningKey === 'colorectal_method');
    expect(matches).toHaveLength(1); // singleton — no duplicate rows
    expect(matches[0].value).toBe('colonoscopy');
  });
});

describe('RoadmapStore — latest value per metric drives the plan (US-07 AC4)', () => {
  // Regression: loadLatestMeasurements() returned EVERY active row, so the
  // consumers that reduce to one row per metric (effectiveInputs, the
  // "Previous:" labels, the chat's guest context) read whichever row happened
  // to come first — insertion order on one device, uuid order after a merge.
  // A backfilled 2024 LDL then drove the plan over the 2026 one.
  const OLD = '2024-01-10T00:00:00.000Z';
  const NEW = '2026-08-10T00:00:00.000Z';

  function ldlRows(store: RoadmapStore) {
    return store.loadLatestMeasurements().previousMeasurements.filter((m) => m.metricType === 'ldl');
  }

  /** The backfilled 2024 row inserted FIRST, the 2026 one second. */
  async function storeWithBackfilledLdl(cloud = new MemoryCloud()) {
    const store = await RoadmapStore.create(new MemoryAdapter(cloud));
    store.addMeasurement('ldl', 3.5, OLD);
    store.addMeasurement('ldl', 1.8, NEW);
    return store;
  }

  it('single device: a backfilled older LDL never outranks the newest one', async () => {
    const cloud = new MemoryCloud();
    const store = await storeWithBackfilledLdl(cloud);

    // Before any flush the file is in insertion order, so the backfilled row
    // came first — the deterministic form of the bug.
    expect(ldlRows(store)).toEqual([expect.objectContaining({ value: 1.8 })]);

    await store.flush();
    const reloaded = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(ldlRows(reloaded)).toEqual([expect.objectContaining({ value: 1.8 })]);
  });

  it('after a two-device merge the newest LDL still wins (uuid order is arbitrary)', async () => {
    const cloud = new MemoryCloud();
    const deviceA = await RoadmapStore.create(new MemoryAdapter(cloud));
    deviceA.addMeasurement('ldl', 3.5, OLD);
    await deviceA.flush();

    const deviceB = await RoadmapStore.create(new MemoryAdapter(cloud));
    deviceB.addMeasurement('ldl', 1.8, NEW);
    await deviceB.flush();

    // Both rows are now in the cloud, ordered by the merge's uuid sort.
    const merged = await RoadmapStore.create(new MemoryAdapter(cloud));
    expect(readCloudFile(cloud).measurements.filter((m) => m.metricType === 'ldl')).toHaveLength(2);
    const rows = ldlRows(merged);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1.8);
  });

  it('feeds the byok chat snapshot the newest value (measurementsToInputs building block)', async () => {
    const store = await storeWithBackfilledLdl();

    const inputs = measurementsToInputs(store.loadLatestMeasurements().previousMeasurements);
    expect(inputs.ldlC).toBe(1.8);
  });
});
