/**
 * Lead TA-2: a written record whose last-write-wins stamp is later than its
 * own `meta.updatedAt` is clamped back to it by `migrateFile` (sanitizeStamp),
 * and can then lose a tie it should have won. Every writer's test reads the
 * RAW bytes it wrote (never the migrated copy, which hides the clamp) and asks
 * this for the stamps past the file's clock.
 *
 * Generic on purpose: every `updatedAt` at any depth outside `meta` counts, so
 * a field or row added later is covered without touching this. Immutable row
 * clocks (`createdAt`, `addedAt`) are not clamped, so they are not walked.
 */
import { createCoreRow } from './blood-tests';
import { stampInstant } from './merge';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import { setReminderOptIn, setScreening, stampProfile, upsertMedication, upsertSupplement } from './state-edits';

/**
 * A record built by the real writers at `at`, so every stamp equals
 * `meta.updatedAt`, the tightest case: profile and screening fields, a
 * medication, a supplement, the reminders opt-in, and one reminder preference
 * (no writer makes one today; it is set as an older app wrote it). Plus a
 * weight `w1` and a core LDL `l1`, both on 2026-08-20.
 */
export function stampedRecord(at: string): RoadmapFile {
  let file = createEmptyFile({ deviceId: 'synthetic', now: at });
  file = stampProfile(file, { sex: 'male', birthYear: 1971, birthMonth: 4, heightCm: 178, unitSystem: 'si' }, at);
  file = setScreening(file, 'colorectal_method', 'fit_annual', at);
  file = upsertMedication(file, { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }, at).file;
  file = upsertSupplement(file, { supplementKey: 'vitamin_d', supplementName: 'Vitamin D', doseValue: 1000, doseUnit: 'IU', status: 'active' }, at).file;
  file = setReminderOptIn(file, { status: 'active', token: 'test-token-good', email: 'a@example.com', provider: 'dropbox' }, at);
  file.reminderPreferences.push({ category: 'blood_test', enabled: false, updatedAt: at, lamport: 0 });
  file.measurements.push(createMeasurement({ id: 'w1', metricType: 'weight', value: 82, recordedAt: '2026-08-20', createdAt: at }));
  file.labValues.push(createCoreRow({ id: 'l1', metric: 'ldl', value: 3.4, recordedAt: '2026-08-20', createdAt: at, source: 'lab_import' }));
  return file;
}

/** The paths of every `updatedAt` later than `meta.updatedAt`, as instants. An
 *  unreadable `meta.updatedAt` is itself reported: no stamp can be checked. */
export function stampsAheadOfMeta(record: unknown): string[] {
  const meta = (record as { meta?: { updatedAt?: unknown } } | null)?.meta;
  const anchor = stampInstant(meta?.updatedAt);
  if (Number.isNaN(anchor)) return ['meta.updatedAt'];
  const ahead: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${path}[${i}]`));
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (at === 'meta') continue;
      if (key === 'updatedAt' && stampInstant(child) > anchor) ahead.push(at);
      walk(child, at);
    }
  };
  walk(record, '');
  return ahead;
}

/** How many `updatedAt` stamps the record holds outside `meta`: a test asserts
 *  it is not zero, so a writer that wrote no stamp cannot pass by holding none. */
export function stampCount(record: unknown): number {
  let count = 0;
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => walk(item, path));
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (path === '' && key === 'meta') continue;
      if (key === 'updatedAt') count += 1;
      walk(child, `${path}.${key}`);
    }
  };
  walk(record, '');
  return count;
}
