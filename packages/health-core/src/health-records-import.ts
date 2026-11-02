/**
 * Lab results a clinic sent to Apple Health Records, taken into the record
 * (US-72; plan: docs/drafts/apple-health-blood-tests.md §6). The app hands
 * over each clinical record's FHIR JSON as it came; this reads it once and
 * decides what lands.
 *
 * Device-import's rule (a later reading the same day replaces) would block
 * every amendment, which keeps its draw time, so this one keys on two things:
 *  - identity: the HealthKit source, the resource type and the FHIR id (AC5).
 *    Apple: the id is unique only within one type and source;
 *  - version: `meta.lastUpdated`, `meta.versionId`, the status, value,
 *    comparator and unit together, so a changed result is a new version even
 *    when the server keeps its meta. The row's `externalId` is `identity#version`;
 *    a version marker's is `identity#version|m`, so a marker is known by its id, never by its content.
 * The rules, in the order they are asked:
 *  - a version any row carries, entered-in-error and markers included, never lands again
 *    (a withdrawal still flips an active copy a merge brought back, unless that copy is newer);
 *  - a version not later than any of the identity's rows, markers included (by
 *    lastUpdated, else by whole-number versionId) is stale: it neither replaces nor withdraws;
 *  - `entered-in-error` withdraws: the identity's active row is flipped, and a
 *    version marker carries the withdrawal's version (AC7);
 *  - only `final`, `amended` and `corrected` land; anything else is not read;
 *  - a version dated by `issued` alone keeps the day the result already holds:
 *    `issued` is when that version was released, so an amendment moves it (AC3);
 *  - a version that moves the result to another test or day than its row holds,
 *    active or not, is not read (AC6);
 *  - a newer version with the value, unit and comparator of the identity's
 *    current row lands only a version marker: the record remembers the version,
 *    and the person's rejection or hand edit stands (AC5, AC8). After the lab's
 *    own withdrawal, its newer version lands whatever its value (AC8);
 *  - an identity whose rows are all entered-in-error lands again only in a new
 *    version with another value, or any new version after the lab's own withdrawal
 *    (AC8: the stale rule above holds back an older one);
 *  - a newer version of an identity with an active row and another value replaces
 *    it as a FHIR correction (AC6);
 *  - the import is the source of truth: a result corrects a typed, uploaded or
 *    other-source row holding its (metric, day) when the value, unit or limit
 *    differs, and appends nothing when they match (AC9, Brad 2026-11-02); a
 *    result whose day another row won in a merge, a row that does not correct
 *    its newest landed version, is such a conflict, not the person's call (AC9, R2, R1);
 *  - a result drawn before the record's erase does not land (AC10, D6).
 * A result the app cannot read (AC4) is counted, never guessed.
 */
import * as z from './zod';
import { recordedAtOf } from './device-import';
import { normalizeLabUnit, resolveLabCatalogEntry } from './lab-catalog';
import { isClinicalDay } from './measurement-history';
import { comparatorOf, isComparator, type Comparator } from './lab-limits';
import { dayOf, latestDayOnEarth } from './merge';
import { coreStored, createCoreRow, isBloodTestKey, labRowSlot } from './blood-tests';
import { measurementValueFault, newId, sameValue, slotOfRow, stampUpdatedAt, toStoredLab } from './record-edits';
import { createLabValue, type FileLabValue, type RoadmapFile } from './roadmap-file';

export interface ClinicalRecordInput { sourceId: string; resourceType: string; fhirVersion: string; json: string }
export interface HealthRecordsCounts { added: number; corrected: number; withdrawn: number; alreadyInRecord: number; notRead: number }

/**
 * LOINC code → a core blood test (`CORE_BLOOD_UNITS`) or a lab catalogue key. Many
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
 * Brad checks this list before merge (US-72 gate check).
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
  // eGFR the lab printed (US-07 AC7): CKD-EPI 2021, CKD-EPI (NLM Clinical Tables, 2026-11-02) and MDRD
  // (33914-3; Brad 2026-11-02). The race-specific MDRD codes (48642-3, 48643-1) are left out.
  '98979-8': 'egfr', '62238-1': 'egfr', '33914-3': 'egfr',
};

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const LANDS = new Set(['final', 'amended', 'corrected']);
/** A version marker's `externalId` is `identity#version|m` (AC5): a 7th part no version holds. */
const MARKER = 'm';
/** Codes read in one unit only: the IFCC-standardized HbA1c is a substance fraction, so a % under it is mislabelled (AC4). */
const ONLY_UNIT: Readonly<Record<string, string>> = { '59261-8': 'mmol/mol' };
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
  // The release, close to the draw: Apple's sample DSTU2 results carry only this (AC3).
  issued: z.string().max(64).optional(),
  referenceRange: z.array(z.object({ low: quantity.optional(), high: quantity.optional() })).optional().catch(undefined),
});
type Observation = z.infer<typeof observation>;

/** The unit a Quantity states, as printed: its UCUM code when it has one, else the printed unit.
 *  The version key reads it so, so a stored `externalId` never changes. */
function statedUnit(q: z.infer<typeof quantity> | undefined): string | undefined {
  return q?.system === UCUM && q.code ? q.code : q?.unit;
}

/** The unit a Quantity states, in the spelling the record reads (AC2). */
function unitOf(q: z.infer<typeof quantity> | undefined): string | undefined {
  const u = statedUnit(q);
  return u === undefined ? u : fromUcum(u);
}

/**
 * UCUM, as Health Records feeds print it (AC2). No accepted spelling holds a
 * brace or a square bracket, so these can only turn a refusal into a match.
 * Per body surface area is a term of its own; any other {annotation} is a
 * label UCUM gives no value to ("%{HbA1c}" is %); a bracketed unit keeps its
 * letters ("m[IU]/L" is mIU/L, "mm[Hg]" is mmHg). A brace after a space is
 * not UCUM ("mmol/L {H}" is a flag) and is left to be refused.
 */
function fromUcum(unit: string): string {
  return unit.trim()
    .replace(/\{1\.73_?m2\}/gi, '1.73m2')
    .replace(/(^|[^\s{}])\{[^{}\s]*\}/g, '$1')
    .replace(/\[([^[\]\s]+)\]/g, '$1');
}

/** The one metric the Observation's LOINC codings name, or null for none, two, or a unit a code refuses. */
function metricOf(obs: Observation, unit: string): string | null {
  const codes = (obs.code.coding ?? []).flatMap((c) =>
    c.system === LOINC && c.code && Object.prototype.hasOwnProperty.call(HEALTH_RECORDS_LOINC, c.code) ? [c.code] : []);
  if (codes.some((c) => c in ONLY_UNIT && normalizeLabUnit(unit) !== normalizeLabUnit(ONLY_UNIT[c]))) return null;
  const metrics = new Set(codes.map((c) => HEALTH_RECORDS_LOINC[c]));
  return metrics.size === 1 ? [...metrics][0] : null;
}

/** A result's version (AC5): lastUpdated, versionId, status, value, comparator and
 *  stated unit, `|`-joined, with every `#` and `|` taken out so the parts split back. */
function versionOf(obs: Observation): string {
  const q = obs.valueQuantity;
  return [obs.meta?.lastUpdated, obs.meta?.versionId, obs.status, q?.value, q?.comparator, statedUnit(q)]
    .map((part) => String(part ?? '').replace(/[#|]/g, '')).join('|');
}

/**
 * A version against the one a row of its identity carries (AC5, AC8): by
 * lastUpdated when both carry one, else by versionId when both are whole
 * numbers (any length, compared as digits): -1 older, 0 equal, 1 newer, null unordered.
 */
function versionOrder(version: string, rowExternalId: string): number | null {
  const old = versionPartsOf(rowExternalId);
  if (!old) return null;
  const [at, id] = version.split('|');
  const [oldAt, oldId] = old;
  const t = Date.parse(at);
  const oldT = Date.parse(oldAt);
  return at && oldAt && !Number.isNaN(t) && !Number.isNaN(oldT) ? Math.sign(t - oldT)
    : /^\d+$/.test(id) && /^\d+$/.test(oldId) ? compareDigits(id, oldId) : null;
}

/**
 * Whether a version is older than a row's (AC5, AC8). Unordered is not stale.
 * An equal stamp is stale for a new value (an old copy must not undo a newer
 * one) but not for a withdrawal: a lab's withdrawal is honoured (AC7, re-check R1).
 */
function isStale(version: string, rowExternalId: string, withdrawal: boolean): boolean {
  const order = versionOrder(version, rowExternalId);
  return order !== null && (order < 0 || (order === 0 && !withdrawal));
}

/** The six parts of the version an `externalId` carries, a marker's included, or null. */
function versionPartsOf(externalId: string): string[] | null {
  const parts = externalId.slice(externalId.indexOf('#') + 1).split('|');
  return parts.length === 6 || (parts.length === 7 && parts[6] === MARKER) ? parts.slice(0, 6) : null;
}

/** Whether an `externalId` is a version marker's: identity, `#`, six version parts and `|m`. */
const isMarkerId = (externalId: string) =>
  externalId.includes('#') && externalId.slice(externalId.indexOf('#') + 1).split('|').length === 7 && externalId.endsWith(`|${MARKER}`);

/** The version an `externalId` names, a marker's suffix taken off: the key `known` holds (AC5). */
const versionKeyOf = (externalId: string) => (isMarkerId(externalId) ? externalId.slice(0, -MARKER.length - 1) : externalId);

/** Two whole numbers written in digits, compared without Number's precision limit. */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The row's `recordedAt` (AC3): the draw (`effectiveDateTime`, else
 * `effectivePeriod.start`), else the release (`issued`), never the download. A day alone is
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

/** What a readable result would write, a lab row either way (US-66, one blood-test table):
 *  a core row (`core: true`) in its SI unit, or a catalogue row in the catalogue's unit. */
interface Reading {
  core: boolean; metric: string; value: number; unit: string; referenceLow: number | null; referenceHigh: number | null;
  recordedAt: string; comparator?: Comparator;
}

/** A reading's slot on a day: `core:<key>` or `lab:<key>`, as `slotOfRow` spells a row's. */
const slotAt = (reading: Reading, recordedAt: string) => `${labRowSlot({ metricName: reading.metric, core: reading.core })}@${dayOf(recordedAt)}`;

/** The row a result would write, or null when the app cannot read it (AC2, AC4). */
function readingOf(obs: Observation, now: string): Reading | null {
  const q = obs.valueQuantity;
  const unit = unitOf(q);
  const metric = unit ? metricOf(obs, unit) : null;
  const recordedAt = drawnAt(obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued, now);
  if (!metric || typeof q?.value !== 'number' || !unit || !recordedAt) return null;
  // US-12 AC20: a result printed as a limit keeps its comparator; `value` is the bound. FHIR's `ad` is not read.
  if (q.comparator !== undefined && !isComparator(q.comparator)) return null;
  // A bound in another unit than the result's is not read with the result's factor.
  const sameUnit = (b: z.infer<typeof quantity> | undefined) => {
    const bu = unitOf(b);
    return typeof b?.value === 'number' && (bu === undefined || normalizeLabUnit(bu) === normalizeLabUnit(unit)) ? b.value : null;
  };
  const range = obs.referenceRange?.[0];
  if (isBloodTestKey(metric)) {
    const stored = coreStored(metric, q.value, normalizeLabUnit(unit), sameUnit(range?.low), sameUnit(range?.high));
    if (!stored || measurementValueFault(metric, stored.value)) return null;
    return { core: true, metric, ...stored, recordedAt, comparator: q.comparator };
  }
  const entry = resolveLabCatalogEntry(metric);
  if (!entry) return null;
  const stored = toStoredLab(entry, q.value, unit, sameUnit(range?.low), sameUnit(range?.high));
  if ('ok' in stored) return null;
  return { core: false, metric: entry.key, ...stored, recordedAt, comparator: q.comparator };
}

type Row = FileLabValue;

/** Whether a row was written before another: by createdAt, then, in one batch, by version. */
function writtenBefore(a: Row, b: Row): boolean {
  const order = Math.sign(Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return order < 0 || (order === 0 && versionOrder(String(b.externalId).slice(String(b.externalId).indexOf('#') + 1), String(a.externalId)) === 1);
}

/** Whether two rows, or a row and a reading, hold the same value, unit and comparator (AC5, AC9). */
function sameContent(a: Row, b: Pick<Row, 'value' | 'unit' | 'comparator'>): boolean {
  return sameValue(a.value, b.value) && a.unit === b.unit && comparatorOf(a).comparator === b.comparator;
}

/**
 * A version marker (AC5): a `health_records` row born entered-in-error whose
 * `externalId` ends in the marker's suffix. It only carries a version the
 * record has seen, so a history leaves it out. The suffix says so; content is
 * never guessed from, so a withdrawn, corrected or rejected result is always shown.
 */
export function isVersionMarker(row: Pick<Row, 'source' | 'status' | 'externalId'>): boolean {
  return row.source === 'health_records' && row.status === 'entered-in-error' && typeof row.externalId === 'string' && isMarkerId(row.externalId);
}

export function importHealthRecords(
  file: RoadmapFile, records: ClinicalRecordInput[], opts: { now: string },
): { file: RoadmapFile; counts: HealthRecordsCounts } {
  const { now } = opts;
  const counts: HealthRecordsCounts = { added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 };
  const erasedAt = file.meta.erasedAt ? Date.parse(file.meta.erasedAt) : null;
  // Every result is a lab row (US-66, one blood-test table): copied once and edited in
  // place, since a first import can carry years of results.
  const rows = [...file.labValues];
  const known = new Set<string>();
  /** Each identity's Health Records rows, by index. */
  const byIdentity = new Map<string, number[]>();
  const remember = (at: number) => {
    const { externalId } = rows[at];
    if (typeof externalId !== 'string') return;
    // AC5: a marker's version is a version the record has seen.
    known.add(versionKeyOf(externalId));
    if (rows[at].source !== 'health_records' || !externalId.includes('#')) return;
    const identity = externalId.slice(0, externalId.indexOf('#'));
    const held = byIdentity.get(identity);
    if (held) held.push(at);
    else byIdentity.set(identity, [at]);
  };
  /** Each (test, day) slot's active row, by index. */
  const taken = new Map<string, number>();
  rows.forEach((row, at) => {
    remember(at);
    if (row.status === 'active') taken.set(slotOfRow(row), at);
  });
  let changed = false;

  for (const { identity, obs } of parsedInOrder(records)) {
    if (!obs) { counts.notRead++; continue; }
    const version = versionOf(obs);
    const externalId = `${identity}#${version}`;
    const withdrawal = obs.status === 'entered-in-error';
    const mine = byIdentity.get(identity) ?? [];
    const active = mine.find((at) => rows[at].status === 'active');
    const withdraw = (at: number) => {
      rows[at] = { ...rows[at], status: 'entered-in-error' };
      taken.delete(slotOfRow(rows[at]));
      counts.withdrawn++;
      changed = true;
    };
    // AC5: a version already in the record never lands again, after a reinstall too.
    // AC7: a withdrawal still withdraws an active copy another device's merge brought back,
    // unless that copy is a newer version: a replayed withdrawal never undoes a later result.
    if (known.has(externalId)) {
      if (withdrawal && active !== undefined && versionOrder(version, rows[active].externalId as string) !== -1) withdraw(active);
      else counts.alreadyInRecord++;
      continue;
    }
    // AC5, AC8: a replayed older version neither replaces nor withdraws a newer one.
    if (mine.some((at) => isStale(version, rows[at].externalId as string, withdrawal))) { counts.alreadyInRecord++; continue; }
    const newest = (of: number[]) => of.reduce<number | undefined>((a, b) => (a === undefined || writtenBefore(rows[a], rows[b]) ? b : a), undefined);
    // The result as the record holds it now: its active row, else its newest.
    const current = active ?? newest(mine);
    /** AC5: a version marker, so the record remembers a version that changes nothing it shows.
     *  It carries the content of the version it records: the reading's, when there is one. */
    const mark = (reading?: Reading) => {
      const { comparator: _old, ...base } = rows[current!];
      const content = reading
        ? { value: reading.value, unit: reading.unit, referenceLow: reading.referenceLow, referenceHigh: reading.referenceHigh, ...comparatorOf(reading) }
        : comparatorOf(rows[current!]);
      rows.push({ ...base, ...content, id: newId(), status: 'entered-in-error', createdAt: now, source: 'health_records', correctsId: null, externalId: `${externalId}|${MARKER}` });
      remember(rows.length - 1);
      changed = true;
    };

    // AC7: the lab withdrew it. The active row goes; a marker carries the withdrawal's version.
    if (withdrawal) {
      if (current === undefined) { counts.notRead++; continue; }
      if (active !== undefined) withdraw(active);
      else counts.alreadyInRecord++;
      mark();
      continue;
    }
    if (!LANDS.has(obs.status)) { counts.notRead++; continue; }

    const reading = readingOf(obs, now);
    if (!reading) { counts.notRead++; continue; }
    // AC10 (D6): the erase removed the rows that would have deduplicated it.
    if (erasedAt !== null && Date.parse(reading.recordedAt) < erasedAt) { counts.notRead++; continue; }

    let slot = slotAt(reading, reading.recordedAt);
    // AC3: `issued` is this version's release, so a version dated by it alone keeps the
    // day its result already holds; an amendment's later release is not a move.
    const established = current === undefined ? undefined : rows[current];
    if (established && !obs.effectiveDateTime && !obs.effectivePeriod?.start
      && slotAt(reading, established.recordedAt) === slotOfRow(established)) slot = slotOfRow(established);
    // A version that moves the result to another test or day is not read: a correction keeps
    // its slot (agent-access rule 2). Judged against the result's row, active or not (AC6).
    if (established && slotOfRow(established) !== slot) { counts.notRead++; continue; }
    // AC8: the lab withdrew the result last (its marker carries an entered-in-error version):
    // the lab's newer version reinstates it, the same value included (Brad 2026-11-02).
    const labWithdrew = active === undefined && established !== undefined && isMarkerId(String(established.externalId))
      && versionPartsOf(String(established.externalId))?.[2] === 'entered-in-error';
    const held = active ?? taken.get(slot);
    const old = held === undefined ? undefined : rows[held];
    // AC9: the day's active row does not correct the result's newest landed version, through
    // any chain of corrections: the result lost a merge, not the person's call (adversary R2).
    // A correction of an older version that a merge put over the lab's amendment lost one too (R1).
    // Two devices can each land that version under its own row id (AC5): any copy counts (Codex).
    const landed = newest(mine.filter((at) => !isMarkerId(String(rows[at].externalId))));
    const copies = new Set(mine.filter((at) => landed !== undefined && rows[at].externalId === rows[landed].externalId).map((at) => rows[at].id));
    const lostMerge = established !== undefined && active === undefined && old !== undefined && !correctsRow(rows, old, copies);
    // AC5, AC8: the same value, unit and comparator as the result holds now: a
    // marker only; the person's rejection or hand edit stands.
    if (established && !labWithdrew && !lostMerge && sameContent(established, reading)) { mark(reading); counts.alreadyInRecord++; continue; }
    // AC9: another institution's result holds the day.
    if (old && active === undefined && old.source === 'health_records') { counts.alreadyInRecord++; continue; }
    // AC9: the same value typed or uploaded on the day: nothing to correct (a marker
    // when the result lost the day in a merge, so the record remembers the version).
    if (old && sameContent(old, reading)) { if (lostMerge) mark(reading); counts.alreadyInRecord++; continue; }
    let correctsId: string | null = null;
    let recordedAt = slot === slotAt(reading, reading.recordedAt) ? reading.recordedAt : established!.recordedAt;
    if (held !== undefined && old) {
      // AC6, AC9: a FHIR correction on the slot's day.
      rows[held] = { ...old, status: 'entered-in-error' };
      correctsId = old.id;
      recordedAt = old.recordedAt;
    }

    const { core, metric, unit, value, referenceLow, referenceHigh } = reading;
    const row = { id: newId(), value, referenceLow, referenceHigh, recordedAt, createdAt: now, source: 'health_records' as const, correctsId, ...comparatorOf(reading) };
    // US-66 (one table): a core result is a core row, so `stampUpdatedAt` stamps the record version 3.
    rows.push(core ? { ...createCoreRow({ ...row, metric }), externalId } : createLabValue({ ...row, metricName: metric, unit, externalId }));
    remember(rows.length - 1);
    taken.set(slot, rows.length - 1);
    if (correctsId) counts.corrected++;
    else counts.added++;
    changed = true;
  }

  return { file: changed ? stampUpdatedAt({ ...file, labValues: rows }, now) : file, counts };
}

/** Whether `row`, or a row it corrects through `correctsId`, corrects one of the rows `ids` (AC8, AC9). */
function correctsRow(rows: readonly Row[], row: Row, ids: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  for (let at: Row | undefined = row; at?.correctsId && !seen.has(at.id);) {
    if (ids.has(at.correctsId)) return true;
    seen.add(at.id);
    const next: string = at.correctsId;
    at = rows.find((r) => r.id === next);
  }
  return false;
}

/**
 * Each record read once (null when it is not an Observation this reads), in
 * the order the app gave, except that two versions of one result in one batch
 * are taken oldest first by `meta.lastUpdated` when both carry it, so the
 * newer one ends up active.
 */
function parsedInOrder(records: ClinicalRecordInput[]): Array<{ identity: string; obs: Observation } | { identity: null; obs: null }> {
  const parsed = records.map((raw) => {
    const unread = { identity: null, obs: null } as const;
    const record = input.safeParse(raw);
    if (!record.success) return unread;
    let json: unknown;
    try { json = JSON.parse(record.data.json); } catch { return unread; }
    const obs = observation.safeParse(json);
    if (!obs.success) return unread;
    return { identity: `${record.data.sourceId}|${record.data.resourceType}|${obs.data.id}`, obs: obs.data };
  });
  const groups = new Map<string, number[]>();
  parsed.forEach(({ identity }, i) => {
    if (!identity) return;
    const positions = groups.get(identity);
    if (positions) positions.push(i);
    else groups.set(identity, [i]);
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
