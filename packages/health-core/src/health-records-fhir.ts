/**
 * US-72: what a Health Records lab record says, read from the provider's FHIR JSON
 * (DSTU2 or R4) before health-records-import decides what lands. A record is a
 * top-level Observation, or a DiagnosticReport whose results are contained
 * Observations (AC15); each comes out as an identity and the Observation fields
 * the import reads, or null when it is not one this reads.
 */
import * as z from './zod';
import type { ClinicalRecordInput } from './health-records-import';

/** DSTU2 (1.0.x) and R4 (4.0.x): the two `HKFHIRVersion`s Apple sends. */
const FHIR_VERSIONS = /^(1\.0|4\.0)\.\d+$/;
/** FHIR's id type: no `#`, so the first `#` in an `externalId` ends the identity. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
/** A provider's JSON is external text: bounded before it is parsed. */
const MAX_JSON = 1_000_000;

const input = z.object({
  sourceId: z.string().min(1).max(512).refine((s) => !s.includes('#')),
  // A US lab can file a panel as one DiagnosticReport whose results are contained Observations.
  resourceType: z.enum(['Observation', 'DiagnosticReport']),
  fhirVersion: z.string().regex(FHIR_VERSIONS),
  json: z.string().max(MAX_JSON),
});

/** The parts of a Quantity this reads; DSTU2 and R4 spell it the same way. */
export const quantity = z.object({
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
const meta = z.object({ versionId: z.string().max(64).optional(), lastUpdated: z.string().max(64).optional() });
// effective[x] as a period: its start is the draw (the collection began then).
const period = z.object({ start: z.string().max(64).optional() });

const observation = z.object({
  resourceType: z.literal('Observation'),
  id: z.string().regex(FHIR_ID),
  meta: meta.optional().catch(undefined),
  status: z.string().max(32),
  code: z.object({ coding: z.array(z.object({ system: z.string().optional(), code: z.string().optional() })).optional() }),
  valueQuantity: quantity.optional(),
  effectiveDateTime: z.string().max(64).optional(),
  effectivePeriod: period.optional().catch(undefined),
  // The release, close to the draw: Apple's sample DSTU2 results carry only this (AC3).
  issued: z.string().max(64).optional(),
  referenceRange: z.array(z.object({ low: quantity.optional(), high: quantity.optional() })).optional().catch(undefined),
});
export type Observation = z.infer<typeof observation>;

/**
 * A DiagnosticReport, DSTU2 or R4, read only for the results it carries inside: each
 * `result` reference `#id` names a contained Observation (Argonaut DSTU2, as a US lab
 * sends a panel). A reference outside the report is not followed. Contained resources
 * are read through `observation` one by one, so one unreadable result never hides the rest.
 */
const report = z.object({
  resourceType: z.literal('DiagnosticReport'),
  id: z.string().regex(FHIR_ID),
  // Strict, no `.catch`: a result takes these from its report, so a malformed one dropped
  // would date it by the report's release or lose its version. The whole report is not read.
  meta: meta.optional(),
  status: z.string().max(32),
  effectiveDateTime: z.string().max(64).optional(),
  effectivePeriod: period.optional(),
  issued: z.string().max(64).optional(),
  contained: z.array(z.unknown()).max(10_000).optional().catch(undefined),
  result: z.array(z.object({ reference: z.string().max(200).optional() }).catch({})).max(10_000).optional().catch(undefined),
});
type Report = z.infer<typeof report>;

/**
 * A contained result read as the report's: what it does not say for itself, it takes from
 * the report. Its day (`reportDay`); its version stamp, always the report's `meta` (FHIR
 * dom-4: a contained resource carries no `meta.versionId` or `meta.lastUpdated`, so the
 * report's is what changes when the lab amends); a withdrawal: a report the lab withdrew
 * withdraws each of its results (AC7); and a cancelled or registered report's results are
 * not read (`OVERRIDES`), as a cancelled Observation is not. Otherwise the result's own status governs.
 */
/** Report statuses that govern every result inside: a withdrawal withdraws them (AC7); a
 *  cancelled report, or a registered one with nothing yet available, lands none (AC15). */
const OVERRIDES = new Set(['entered-in-error', 'cancelled', 'registered']);

function asReported(obs: Observation, rep: Report): Observation {
  return {
    ...obs,
    ...reportDay(obs, rep),
    meta: rep.meta,
    status: OVERRIDES.has(rep.status) ? rep.status : obs.status,
  };
}

/** A result with no draw of its own (AC3) takes the report's draw, and the report's
 *  release when it has none of its own either; a result with its own draw keeps its day. */
function reportDay(obs: Observation, rep: Report): Partial<Observation> {
  if (obs.effectiveDateTime ?? obs.effectivePeriod?.start) return {};
  return { effectiveDateTime: rep.effectiveDateTime, effectivePeriod: rep.effectivePeriod, issued: obs.issued ?? rep.issued };
}

/** A report's contained resources by id; of two with one id, the first. */
function containedById(contained: readonly unknown[]): Map<string, unknown> {
  const inside = new Map<string, unknown>();
  for (const c of contained) {
    const id = (c as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && !inside.has(id)) inside.set(id, c);
  }
  return inside;
}

/**
 * A DiagnosticReport's results, in its `result` order: one null when it carries no
 * result, and one per reference that names no readable contained Observation. A
 * contained result's identity is the source, `DiagnosticReport`, the report's id and
 * its own id: a contained id is unique only inside its report.
 */
function reportResults(sourceId: string, json: unknown): Array<{ identity: string; obs: Observation } | { identity: null; obs: null }> {
  const unread = { identity: null, obs: null } as const;
  const rep = report.safeParse(json);
  if (!rep.success || !rep.data.result?.length) return [unread];
  const inside = containedById(rep.data.contained ?? []);
  return rep.data.result.map(({ reference }) => {
    const obs = reference?.startsWith('#') ? observation.safeParse(inside.get(reference.slice(1))) : undefined;
    if (!obs?.success) return unread;
    return { identity: `${sourceId}|DiagnosticReport|${rep.data.id}|${obs.data.id}`, obs: asReported(obs.data, rep.data) };
  });
}

/** One record's results: an Observation is one, a DiagnosticReport its contained ones
 *  (`reportResults`); a record this cannot read is one null. */
export function recordResults(raw: ClinicalRecordInput): Array<{ identity: string; obs: Observation } | { identity: null; obs: null }> {
  const unread = { identity: null, obs: null } as const;
  const record = input.safeParse(raw);
  if (!record.success) return [unread];
  let json: unknown;
  try { json = JSON.parse(record.data.json); } catch { return [unread]; }
  const { sourceId, resourceType } = record.data;
  if (resourceType === 'DiagnosticReport') return reportResults(sourceId, json);
  const obs = observation.safeParse(json);
  return obs.success ? [{ identity: `${sourceId}|Observation|${obs.data.id}`, obs: obs.data }] : [unread];
}
