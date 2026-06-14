import { describe, it, expect } from 'vitest';
import type { RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from './roadmap-store';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_FILE_NAME } from './adapter';

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
