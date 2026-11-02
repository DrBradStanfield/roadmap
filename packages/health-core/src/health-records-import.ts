/**
 * Lab results a clinic sent to Apple Health Records, taken into the record
 * (US-66; plan: docs/drafts/apple-health-blood-tests.md §6). The app hands
 * over each clinical record's FHIR JSON as it came; this reads it once and
 * decides what lands.
 *
 * Device-import's rule (a later reading the same day replaces) would block
 * every amendment, which keeps its draw time, so this one keys on two things:
 *  - identity: the HealthKit source, the resource type and the FHIR id (AC5).
 *    Apple: the id is unique only within one type and source;
 *  - version: `meta.versionId`, else `meta.lastUpdated`, else the status,
 *    value and unit. The row's `externalId` is `identity#version`.
 * The rules, in the order they are asked:
 *  - a version any row carries, entered-in-error included, never lands again;
 *  - `entered-in-error` withdraws: the identity's active row is flipped, and
 *    nothing is appended (AC7);
 *  - only `final`, `amended` and `corrected` land; anything else is not read;
 *  - an identity whose rows are all entered-in-error never lands again (AC8);
 *  - a newer version of an identity with an active row from Health Records
 *    replaces it as a FHIR correction only when the value or unit changed (AC6);
 *  - a new identity fills an empty (metric, day) slot only: a typed, uploaded,
 *    corrected or other-source value is never replaced (AC9);
 *  - a result drawn before the record's erase does not land (AC10, D6).
 * A result the app cannot read (AC4) is counted, never guessed.
 */
import * as z from './zod';
import { recordedAtOf } from './device-import';
import { normalizeLabUnit, resolveLabCatalogEntry } from './lab-catalog';
import { isClinicalDay } from './measurement-history';
import { comparatorOf, isComparator, type Comparator } from './lab-limits';
import { latestDayOnEarth } from './merge';
import { measurementValueFault, newId, slotKey, slotIndex, stampUpdatedAt, toStoredLab } from './record-edits';
import { createLabValue, createMeasurement, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { reportedToCanonical, type MetricType } from './units';
import { METRIC_TYPES } from './validation';

export interface ClinicalRecordInput { sourceId: string; resourceType: string; fhirVersion: string; json: string }
export interface HealthRecordsCounts { added: number; corrected: number; withdrawn: number; alreadyInRecord: number; notRead: number }

/**
 * LOINC code → a core metric (`METRIC_TYPES`) or a lab catalogue key. Many
 * codes to one test; the printed unit, not the code, chooses the conversion
 * (HL7's own lipid example files HDL under the mass code 2085-9 in mmol/L).
 *
 * Every code checked 2026-11-02 against LOINC 2.83 through the NLM Clinical
 * Tables LOINC API (clinicaltables.nlm.nih.gov/api/loinc_items/v3, LONG_COMMON_NAME
 * and PROPERTY) and tx.fhir.org `CodeSystem/$lookup`; loinc.org itself refused
 * the scripted fetch (403). All on the starting list matched; none dropped.
 *  4548-4 HbA1c/Hb.total in Blood (MFr, %) · 17856-6 the same by HPLC (MFr) ·
 *  59261-8 HbA1c/Hb.total standardized per IFCC-RMP (SFr, mmol/mol) ·
 *  13457-7 LDL by calculation (MCnc) · 18262-6 LDL by direct assay (MCnc) ·
 *  2089-1 LDL (MCnc) · 2093-3 cholesterol (MCnc) · 2085-9 HDL (MCnc) ·
 *  2571-8 triglyceride (MCnc) · 1884-6 ApoB (MCnc) · 2160-0 creatinine (MCnc) ·
 *  14682-9 creatinine (SCnc) · 2857-1 PSA (MCnc) · 10835-7 Lp(a) (MCnc) ·
 *  43583-4 Lp(a) (SCnc) · 2276-4 ferritin (MCnc) · 3016-3 TSH (ACnc).
 * No glucose: a plain serum glucose code does not say fasting (plan §6).
 * Brad checks this list before merge (US-66 gate check).
 */
export const HEALTH_RECORDS_LOINC: Readonly<Record<string, string>> = {
  '4548-4': 'hba1c', '17856-6': 'hba1c', '59261-8': 'hba1c',
  '13457-7': 'ldl', '18262-6': 'ldl', '2089-1': 'ldl', '39469-2': 'ldl', '22748-8': 'ldl',
  '2093-3': 'total_cholesterol', '14647-2': 'total_cholesterol', '35200-5': 'total_cholesterol',
  '2085-9': 'hdl', '14646-4': 'hdl',
  '2571-8': 'triglycerides', '14927-8': 'triglycerides', '35217-9': 'triglycerides', '3043-7': 'triglycerides',
  '1884-6': 'apob',
  '2160-0': 'creatinine', '14682-9': 'creatinine',
  '2857-1': 'psa',
  '10835-7': 'lpa', '43583-4': 'lpa',
  '2276-4': 'ferritin',
  '3016-3': 'tsh',
  // eGFR the lab printed (US-07 AC7), CKD-EPI 2021 and CKD-EPI only (NLM Clinical Tables, 2026-11-02); MDRD (33914-3) left out.
  '98979-8': 'egfr', '62238-1': 'egfr',
};

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const LANDS = new Set(['final', 'amended', 'corrected']);
/** DSTU2 (1.0.x) and R4 (4.0.x): the two `HKFHIRVersion`s Apple sends. */
const FHIR_VERSIONS = /^(1\.0|4\.0)\.\d+$/;
/** FHIR's id type: no `#`, so the first `#` in an `externalId` ends the identity. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
/** A provider's JSON is external text: bounded before it is parsed. */
const MAX_JSON = 1_000_000;

const input = z.object({
  sourceId: z.string().min(1).max(512).refine((s) => !s.includes('#')),
  resourceType: z.literal('Observation'),
  fhirVersion: z.string().regex(FHIR_VERSIONS),
  json: z.string().max(MAX_JSON),
});

/** The parts of a Quantity this reads; DSTU2 and R4 spell it the same way. */
const quantity = z.object({
  value: z.number().finite().optional(),
  unit: z.string().max(100).optional(),
  code: z.string().max(100).optional(),
  system: z.string().max(500).optional(),
  // DSTU2: < <= >= >. R4 adds 'ad' (sufficient to achieve), which is no bound.
  comparator: z.string().max(4).optional(),
});

/**
 * An Observation, DSTU2 or R4: the two differ in fields this does not read
 * (R4's `interpretation` is a list, DSTU2's one concept; R4 adds the status
 * `corrected` and the comparator `ad`), so one shape reads both. Every field
 * not listed is dropped; a reference range in a shape this cannot read is
 * dropped too, never the result.
 */
const observation = z.object({
  resourceType: z.literal('Observation'),
  id: z.string().regex(FHIR_ID),
  meta: z.object({ versionId: z.string().max(64).optional(), lastUpdated: z.string().max(64).optional() }).optional().catch(undefined),
  status: z.string().max(32),
  code: z.object({ coding: z.array(z.object({ system: z.string().optional(), code: z.string().optional() })).optional() }),
  valueQuantity: quantity.optional(),
  effectiveDateTime: z.string().max(64).optional(),
  // effective[x] as a period: its start is the draw (the collection began then).
  effectivePeriod: z.object({ start: z.string().max(64).optional() }).optional().catch(undefined),
  referenceRange: z.array(z.object({ low: quantity.optional(), high: quantity.optional() })).optional().catch(undefined),
});
type Observation = z.infer<typeof observation>;


/** The unit a Quantity states: its UCUM code when it has one, else the printed unit. */
function unitOf(q: z.infer<typeof quantity> | undefined): string | undefined {
  return q?.system === UCUM && q.code ? q.code : q?.unit;
}

/** The one metric the Observation's LOINC codings name, or null for none or two. */
function metricOf(obs: Observation): string | null {
  const metrics = new Set((obs.code.coding ?? []).flatMap((c) =>
    c.system === LOINC && c.code && Object.prototype.hasOwnProperty.call(HEALTH_RECORDS_LOINC, c.code) ? [HEALTH_RECORDS_LOINC[c.code]] : []));
  return metrics.size === 1 ? [...metrics][0] : null;
}

/**
 * The row's `recordedAt` (AC3): the draw (`effectiveDateTime`, else
 * `effectivePeriod.start`), never the download. A day alone is
 * that day at `T00:00:00.000Z`, and is "not yet" only past the latest day on
 * earth, so a UK result dated today is not held back an hour; a time keeps
 * its own offset, as device-import keeps a reading's. Null when absent,
 * unreadable or not yet happened.
 */
function drawnAt(effective: string | undefined, now: string): string | null {
  if (effective === undefined) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
    return isClinicalDay(effective) && effective <= latestDayOnEarth(now) ? `${effective}T00:00:00.000Z` : null;
  }
  const at = recordedAtOf(effective, now);
  return at && isClinicalDay(at) ? at : null;
}

/** What a readable result would write: a core row in SI, or a catalogue row in the catalogue's unit. */
type Reading =
  | { kind: 'measurement'; metric: string; value: number; recordedAt: string; comparator?: Comparator }
  | { kind: 'lab'; metric: string; value: number; unit: string; referenceLow: number | null; referenceHigh: number | null; recordedAt: string; comparator?: Comparator };

/** The row a result would write, or null when the app cannot read it (AC2, AC4). */
function readingOf(obs: Observation, now: string): Reading | null {
  const metric = metricOf(obs);
  const q = obs.valueQuantity;
  const unit = unitOf(q);
  const recordedAt = drawnAt(obs.effectiveDateTime ?? obs.effectivePeriod?.start, now);
  if (!metric || typeof q?.value !== 'number' || !unit || !recordedAt) return null;
  // US-12 AC20: a result printed as a limit keeps its comparator; `value` is the bound. FHIR's `ad` is not read.
  if (q.comparator !== undefined && !isComparator(q.comparator)) return null;
  const comparator = q.comparator;
  if ((METRIC_TYPES as readonly string[]).includes(metric)) {
    const si = reportedToCanonical(metric as MetricType, q.value, normalizeLabUnit(unit));
    if (!si || measurementValueFault(metric, si.valueSI)) return null;
    return { kind: 'measurement', metric, value: si.valueSI, recordedAt, comparator };
  }
  const entry = resolveLabCatalogEntry(metric);
  if (!entry) return null;
  // A bound in another unit than the result's is not read with the result's factor.
  const sameUnit = (b: z.infer<typeof quantity> | undefined) => {
    const bu = unitOf(b);
    return typeof b?.value === 'number' && (bu === undefined || normalizeLabUnit(bu) === normalizeLabUnit(unit)) ? b.value : null;
  };
  const range = obs.referenceRange?.[0];
  const stored = toStoredLab(entry, q.value, unit, sameUnit(range?.low), sameUnit(range?.high));
  if ('ok' in stored) return null;
  return { kind: 'lab', metric: entry.key, ...stored, recordedAt, comparator };
}

/** Two numbers equal past the float noise of a unit conversion. */
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

type Row = FileMeasurement | FileLabValue;

export function importHealthRecords(
  file: RoadmapFile, records: ClinicalRecordInput[], opts: { now: string },
): { file: RoadmapFile; counts: HealthRecordsCounts } {
  const { now } = opts;
  const counts: HealthRecordsCounts = { added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 };
  const erasedAt = file.meta.erasedAt ? Date.parse(file.meta.erasedAt) : null;
  // Copied once and edited in place: a first import can carry years of results.
  const measurements = [...file.measurements];
  const labValues = [...file.labValues];
  const listOf = (kind: Reading['kind']): Row[] => (kind === 'measurement' ? measurements : labValues);
  const known = new Set<string>();
  /** Each identity's Health Records rows, by list and index. */
  const byIdentity = new Map<string, Array<{ list: Row[]; at: number }>>();
  const remember = (list: Row[], at: number) => {
    const { externalId } = list[at];
    if (typeof externalId !== 'string') return;
    known.add(externalId);
    if (list[at].source !== 'health_records' || !externalId.includes('#')) return;
    const identity = externalId.slice(0, externalId.indexOf('#'));
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), { list, at }]);
  };
  measurements.forEach((_, i) => remember(measurements, i));
  labValues.forEach((_, i) => remember(labValues, i));
  const taken = new Set(slotIndex(file).keys());
  let changed = false;

  for (const { record, obs } of parsedInOrder(records)) {
    if (!obs) { counts.notRead++; continue; }
    const identity = `${record.sourceId}|${record.resourceType}|${obs.id}`;
    const version = obs.meta?.versionId ?? obs.meta?.lastUpdated
      ?? `${obs.status}:${obs.valueQuantity?.value ?? ''}:${unitOf(obs.valueQuantity) ?? ''}`;
    const externalId = `${identity}#${version}`;
    // AC5: a version already in the record never lands again, after a reinstall too.
    if (known.has(externalId)) { counts.alreadyInRecord++; continue; }
    const rows = byIdentity.get(identity) ?? [];
    const active = rows.find(({ list, at }) => list[at].status === 'active');

    // AC7: the lab withdrew it. The active row goes; nothing is appended.
    if (obs.status === 'entered-in-error') {
      if (active) {
        active.list[active.at] = { ...active.list[active.at], status: 'entered-in-error' };
        taken.delete(slotOf(active.list[active.at]));
        counts.withdrawn++;
        changed = true;
      } else if (rows.length) counts.alreadyInRecord++;
      else counts.notRead++;
      continue;
    }
    if (!LANDS.has(obs.status)) { counts.notRead++; continue; }
    // AC8: the person or the lab withdrew this result; their call stands.
    if (rows.length && !active) { counts.alreadyInRecord++; continue; }

    const reading = readingOf(obs, now);
    if (!reading) { counts.notRead++; continue; }
    // AC10 (D6): the erase removed the rows that would have deduplicated it.
    if (erasedAt !== null && Date.parse(reading.recordedAt) < erasedAt) { counts.notRead++; continue; }

    const slot = slotKey(reading.kind, reading.metric, reading.recordedAt);
    const list = listOf(reading.kind);
    let correctsId: string | null = null;
    let recordedAt = reading.recordedAt;
    if (active) {
      const old = active.list[active.at];
      // A version that moves the result to another test or day is not read:
      // a correction keeps its slot (agent-access rule 2).
      if (active.list !== list || slotOf(old) !== slot) { counts.notRead++; continue; }
      const oldUnit = 'unit' in old ? old.unit : undefined;
      const newUnit = reading.kind === 'lab' ? reading.unit : undefined;
      // AC6: a version bump with the same value (and the same limit) appends nothing.
      if (sameNumber(old.value, reading.value) && oldUnit === newUnit && comparatorOf(old).comparator === reading.comparator) { counts.alreadyInRecord++; continue; }
      list[active.at] = { ...old, status: 'entered-in-error' };
      correctsId = old.id;
      recordedAt = old.recordedAt;
    } else if (taken.has(slot)) {
      // AC9: a typed, uploaded or other result holds the day.
      counts.alreadyInRecord++;
      continue;
    }

    const row: Row = reading.kind === 'measurement'
      ? createMeasurement({
        id: newId(), metricType: reading.metric, value: reading.value, recordedAt, createdAt: now,
        source: 'health_records', correctsId, externalId, ...comparatorOf(reading),
      })
      : createLabValue({
        id: newId(), metricName: reading.metric, value: reading.value, unit: reading.unit,
        referenceLow: reading.referenceLow, referenceHigh: reading.referenceHigh,
        recordedAt, createdAt: now, source: 'health_records', correctsId, externalId, ...comparatorOf(reading),
      });
    list.push(row);
    remember(list, list.length - 1);
    taken.add(slot);
    if (correctsId) counts.corrected++;
    else counts.added++;
    changed = true;
  }

  return { file: changed ? stampUpdatedAt({ ...file, measurements, labValues }, now) : file, counts };
}

function slotOf(row: Row): string {
  return 'metricType' in row ? slotKey('measurement', row.metricType, row.recordedAt) : slotKey('lab', row.metricName, row.recordedAt);
}

/**
 * Each record read once (null when it is not an Observation this reads), in
 * the order the app gave, except that two versions of one result in one batch
 * are taken oldest first by `meta.lastUpdated` when both carry it, so the
 * newer one ends up active.
 */
function parsedInOrder(records: ClinicalRecordInput[]): Array<{ record: ClinicalRecordInput; obs: Observation | null }> {
  const parsed = records.map((raw) => {
    const record = input.safeParse(raw);
    if (!record.success) return { record: raw, obs: null };
    let json: unknown;
    try { json = JSON.parse(record.data.json); } catch { return { record: record.data, obs: null }; }
    const obs = observation.safeParse(json);
    return { record: record.data, obs: obs.success ? obs.data : null };
  });
  const identityOf = (p: (typeof parsed)[number]) => (p.obs ? `${p.record.sourceId}|${p.record.resourceType}|${p.obs.id}` : null);
  const groups = new Map<string, number[]>();
  parsed.forEach((p, i) => {
    const id = identityOf(p);
    if (id) groups.set(id, [...(groups.get(id) ?? []), i]);
  });
  const order = parsed.map((_, i) => i);
  for (const positions of groups.values()) {
    const stamps = positions.map((i) => Date.parse(parsed[i].obs?.meta?.lastUpdated ?? ''));
    if (positions.length < 2 || stamps.some(Number.isNaN)) continue;
    const sorted = positions.map((p, k) => ({ p, t: stamps[k] })).sort((a, b) => a.t - b.t).map(({ p }) => p);
    positions.forEach((slot, k) => { order[slot] = sorted[k]; });
  }
  return order.map((i) => parsed[i]);
}
