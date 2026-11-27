/**
 * Response parsing: the model's JSON read into the result the client receives.
 * Moved out of lab-extraction.ts unchanged (US-64, lead A2-8); that file
 * re-exports it, so old import paths keep working.
 */
import * as z from './zod';
import { reportedToCanonical, type MetricType } from './units';
import { foldName, labNameForUnit, normalizeLabUnit } from './lab-catalog';
import { cutText } from './chat-history';
import { parseLocalisedNumber } from './parseNumber';
import { isCalendarDay } from './measurement-history';
import { COMPARATORS, comparatorOf, limitAtItsBound, recoveredConfidence, withPrintedLimit } from './lab-limits';
import { type AdditionalLabValue, DOCUMENT_CLASSIFICATIONS, type DocumentPromptMode, type PageContent, type RefusedLabValue, UNDATED_PREVIOUS, type UnifiedExtractionResult, type UnreadLabValue } from './lab-extraction-contract';
import { cleanedCreatinineUnit, creatinineRefusal, isUrineOrRatioUnit, readPrintedUnit, resolveCoreMetricName, resolveLabValues, resolveName, SALIVA_MARKER, URINE_MARKER, VALID_METRICS, VALUE_FLAG } from './lab-extraction-units';
import { fileNameLine } from './lab-extraction-files';

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const NUMBER_TOKEN = /^\s*([+-]?[\d.,]+)/;

/**
 * Lab values frequently encode non-numeric results as strings:
 *   "<5"       (below detection limit)
 *   ">2000"    (above range)
 *   "trace", "POS", "Not detected"
 *   "5,2"      (European decimal comma)
 *   "5.2 H"    (a flag or unit after the number)
 *
 * The LLM sometimes mirrors those strings into the `value` field even
 * though the prompt asks for numbers. Read the leading number as the form
 * does (a comma is the decimal point, US-12 AC8) only when no digit follows
 * it, outside one closing bracket ("6.5 % (48 mmol/mol)"). Fail closed: a
 * range ("0-2", "5 to 7"), a ratio ("1:160"), an exponent ("1e3", "7 x 10^3"),
 * Swiss thousands ("250'000") or a second decimal ("5·2") each says a
 * different number, and listing them one by one always missed the next.
 * A minus sign printed as U+2212 ("−2.5") is a minus. 1-3 digits, a comma
 * and exactly 3 digits ("250,000", "1,050") is refused too: US thousands and
 * a European decimal read 1000x apart, and both pass the count guard. That
 * rule is `parseLocalisedNumber`'s (US-02 AC7), given no range here, which
 * refuses grouped thousands ("1,234,567") as well.
 * Anything unreadable becomes null: the row drops, and a reference bound is
 * unknown. A dot in that place, or any text but a flag, is refused on a
 * count row only (see `refusedCountRow`).
 */
function readModelNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.replace(/−/g, '-');
  const m = NUMBER_TOKEN.exec(s);
  const rest = s.slice(m?.[0].length).replace(/\s\([^()x×*^]*\)\s*$/u, '');
  if (!m || /\p{N}/u.test(rest)) return null;
  return parseLocalisedNumber(m[1]) ?? null;
}

/** 1-3 digits, a dot and exactly 3 digits: "250.000", dot thousands on a count
 *  row. One pattern for the count guard and the JSON quoting, so they cannot drift. */
const DOT_THOUSANDS = String.raw`[1-9]\d{0,2}\.\d{3}`;
const DOT_THOUSANDS_TOKEN = new RegExp(`^[+-]?${DOT_THOUSANDS}$`);

const COUNT_STRING = new RegExp(String.raw`^\s*[+-]?[\d.,]+\s*(?:${VALUE_FLAG})?\s*$`, 'i');

/**
 * A count row: a per-µL or per-mm³ denominator, whatever comes before it
 * ("cells/uL", "células/µL", "/mm3", "cells/cumm", and every cubic
 * millimetre `normalizeLabUnit` folds to µL: "cmm", "cu mm", "cu.mm",
 * "c.mm"), unless a multiplier already carries the thousands: a power of ten
 * ("×10³/µL", "10 ^ 3/uL") or a word before the slash ("K/uL", "M/µL",
 * "Mio/µl", "tys/µl"). On it a string value or bound is a readable bare number
 * and at most one flag (H, L, HH, LL, *, ↑, ↓, bracketed or not); anything
 * else refuses the row, bounds included: a bound that reads as nothing
 * ("150,000") leaves no range for the count guard to check the scale with. "7 (X10³)", "7 (E3)", "250 K" or "7 thousand" read as 7 or 250,
 * a range printed the same way scales with it, the count guard passes, and
 * the record holds 0.007 ×10⁹/L. So does "250.000": 250 thousand platelets
 * in Brazil or Germany, 250 elsewhere, refused here and nowhere else (under
 * "1.020" urine SG or "2.345" TSH the dot is a decimal point).
 */
function refusedCountRow(row: unknown): boolean {
  const { value, unit, referenceLow, referenceHigh } = (row ?? {}) as Record<string, unknown>;
  if (typeof unit !== 'string') return false;
  const folded = normalizeLabUnit(unit);
  return (/(?:^|\/)\s*(?:[µμu]l|mcl|mm[3³])\s*$|cumm/i.test(unit) || /(?:^|\/)\s*µl\s*$/i.test(folded))
    && !/×10|10[\^*eE⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(folded) && !/(?:^|[\s(])(?:k|m|thou|thousand|tsd|tys|mio|mln|mil|million)\s*\//i.test(unit)
    && [value, referenceLow, referenceHigh].some(v => typeof v === 'string'
      && (!COUNT_STRING.test(v) || readModelNumber(v) === null || DOT_THOUSANDS_TOKEN.test(NUMBER_TOKEN.exec(v)?.[1] ?? '')));
}

const labValue = z.preprocess(readModelNumber, z.number());
/** A value's own day, from a dated previous-results column (US-12 AC12): blank
 *  is none, a datetime is cut to its day. Whether the day is usable is
 *  `toUnifiedResult`'s call, so a bad one never costs the row a count. */
const labDay = z.preprocess(d => {
  if (d === undefined || d === null) return undefined;
  // Any other non-string (20250902, {}, []) is no day: a value that is not a
  // calendar day, which `toUnifiedResult` leaves out. Never the primary column.
  if (typeof d !== 'string') return 'unusable';
  return toDay(d) || undefined;
}, z.string().optional());

/** A printed date trimmed, and a datetime cut to its day. */
function toDay(text: string): string {
  const trimmed = text.trim();
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
}
const labBound = z.preprocess(readModelNumber, z.number().nullable()).optional();
/**
 * Longest test name or unit a tool will take, and longest row id. Neither is a
 * clinical limit — a real test name is a few words and an id is a UUID (~45
 * chars with a duplicate suffix). They exist because nothing else bounds the
 * bytes one call can put in the user's file: without them a single call can
 * write megabytes of a string into a record that has to be read back whole.
 */
export const MAX_NAME_LENGTH = 120;
/** The test's name as the report printed it (US-07 AC10): one line, control codes gone, bounded. */
const printedNameField = z.unknown().transform(n => {
  const line = typeof n === 'string' ? fileNameLine(n.replace(/\s+/g, ' ')).trim() : '';
  return line ? cutText(line, MAX_NAME_LENGTH) : undefined;
}).optional();

/** Set only by `readableRows` from the printed value, never taken from the model (US-12 AC20). */
const labComparator = z.enum(COMPARATORS).optional();

const coreValueRow = z.object({
  metric: z.string(),
  value: labValue,
  comparator: labComparator,
  // Null, missing or blank is "no unit printed", as on an additional row.
  unit: z.string().nullish().transform(u => u?.trim() ?? ''),
  confidence: z.enum(['high', 'medium', 'low']),
  question: z.string().nullish().transform(q => q ?? undefined).optional(),
  recordedAt: labDay,
  printedMonth: z.unknown().transform(m => (typeof m === 'string' ? m.trim() : undefined)).optional(),
  printedName: printedNameField,
});

const additionalValueRow = z.object({
  name: z.string().trim().min(1),
  value: labValue,
  comparator: labComparator,
  unit: z.string().nullish().transform(u => u?.trim() ?? ''),
  referenceLow: labBound,
  referenceHigh: labBound,
  recordedAt: labDay,
  printedMonth: z.unknown().transform(m => (typeof m === 'string' ? m.trim() : undefined)).optional(),
  printedName: printedNameField,
});

const unifiedResultSchema = z.object({
  classification: z.enum(DOCUMENT_CLASSIFICATIONS),
  reportDate: z.string().nullable(),
  values: z.array(z.unknown()).default([]),
  additionalValues: z.array(z.unknown()).default([]),
  unrecognized: z.array(z.string()).optional(),
  document: z.object({
    title: z.string(),
    documentDate: z.string().nullable(),
    contentMarkdown: z.string().default(''),
    summary: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }).nullable().default(null),
});

/** A dropped row by its test's name ("" for none), why and day (US-12 AC19):
 *  an unnamed one keeps its day too, so it leaves the count with its column. */
function unreadValue(row: unknown): UnreadLabValue {
  const { metric, name, recordedAt } = (row ?? {}) as Record<string, unknown>;
  const test = typeof metric === 'string' ? metric.trim() : typeof name === 'string' ? name.trim() : '';
  const day = labDay.safeParse(recordedAt);
  return {
    name: cutText(test, 80),
    reason: 'unreadable',
    ...(day.success && day.data ? { recordedAt: day.data } : null),
  };
}

/** The rows of `rows` that `schema` reads; the rest are dropped, each to
 *  `unread`. */
function readableRows<T extends z.ZodType<object>>(schema: T, rows: unknown[], unread: UnreadLabValue[]): Array<z.output<T>> {
  return rows.flatMap(raw => {
    const row = withPrintedLimit(raw);
    const r = schema.safeParse(row);
    if (r.success && !refusedCountRow(row)) return [Object.assign(r.data, recoveredConfidence(raw, r.data))];
    unread.push(unreadValue(raw));
    return [];
  });
}

/** Parses the file's shape, then each value row on its own (US-12 AC8): a row
 *  whose value isn't a readable number, or that is otherwise malformed, is
 *  dropped rather than failing the whole file, and counted in
 *  `droppedValueCount`. Exposed for testing. */
export function parseUnifiedResult(raw: unknown) {
  const parsed = unifiedResultSchema.parse(raw);
  const unreadValues: UnreadLabValue[] = [];
  const values = readableRows(coreValueRow, parsed.values, unreadValues);
  const additionalValues = readableRows(additionalValueRow, parsed.additionalValues, unreadValues);
  const droppedValueCount = parsed.values.length + parsed.additionalValues.length - values.length - additionalValues.length;
  return { ...parsed, values, additionalValues, droppedValueCount, unreadValues };
}

const BARE_DOT_THOUSANDS = new RegExp(String.raw`([{,]\s*"(?:value|referenceLow|referenceHigh)"\s*:\s*)(-?${DOT_THOUSANDS})(?=\s*[,}\]])`, 'g');

/**
 * Parse the model's extraction JSON: the outermost object (`extractJsonObject`),
 * with each `value`, `referenceLow` or `referenceHigh` written as a bare number
 * with exactly three decimals quoted first (US-12 AC8). "250.000" platelets per
 * µL copied as a JSON number parsed to 250, and the count guard reads strings,
 * so 0.25 ×10⁹/L was stored. As a string a count row refuses it, and any other
 * row reads "1.020" as 1.02, as before. Only a key that follows `{` or `,` is
 * matched, so a JSON string (where a quote is escaped) is never touched.
 */
export function parseExtractionJson(text: string): unknown {
  return JSON.parse(extractJsonObject(text).replace(BARE_DOT_THOUSANDS, '$1"$2"'));
}

/** The core metrics an additional value can be promoted into (US-12 AC11).
 *  Not creatinine by its name alone: a urine creatinine prints in mg/dL too,
 *  and serum creatinine drives eGFR. One the report printed as serum
 *  creatinine is promoted in `toUnifiedResult` (US-07 AC10). */
const PROMOTABLE = new Set<string>(VALID_METRICS.filter(m => m !== 'creatinine'));

/** Build a UnifiedExtractionResult from a parsed-and-filtered unified response.
 *  `mode` is the prompt the answer came from: only `full` asks for an undated
 *  previous column (US-12 AC14), so any other mode leaves one out. */
export function toUnifiedResult(parsed: ReturnType<typeof parseUnifiedResult>, mode: DocumentPromptMode): UnifiedExtractionResult {
  const isLab = parsed.classification === 'lab_report';
  // A core test the model filed as an additional value ("systolic_bp",
  // "apolipoprotein_b") is that core value (US-12 AC11): saved as a lab row,
  // the plan never sees it. Only into a free slot, and only in a unit the
  // test is measured in: a name alone can be another test, or carry no unit
  // to convert. Anything else stays a lab row, never dropped.
  // A value's own day (US-12 AC12): the report's is the primary column; one
  // that is a calendar day before it is a previous column's. Anything else (a
  // month only, a DD/MM swap, a future day, no report date to order it by) is
  // left out on its own, never counted and never moved onto the report date.
  // The undated marker (AC14) is matched first and needs no report date.
  const reportDay = parsed.reportDate === null ? null : toDay(parsed.reportDate);
  // A printed month rides only on an undated value: a real month, not after
  // the report's (a full day or a month only). Anything else is dropped; the
  // value stays.
  const realMonth = (m?: string | null): m is string => !!m && /^\d{4}-\d{2}$/.test(m) && isCalendarDay(`${m}-01`);
  const reportMonth = reportDay && isCalendarDay(reportDay) ? reportDay.slice(0, 7) : realMonth(reportDay) ? reportDay : null;
  const printedMonth = (m?: string) => realMonth(m) && !(reportMonth && m > reportMonth) ? m : undefined;
  const ownDay = <T extends { recordedAt?: string; printedMonth?: string }>(row: T): T[] => {
    const v = { ...row, printedMonth: row.recordedAt === UNDATED_PREVIOUS ? printedMonth(row.printedMonth) : undefined };
    return !v.recordedAt ? [v]
      : v.recordedAt === UNDATED_PREVIOUS ? (mode === 'full' ? [v] : [])
      : v.recordedAt === reportDay ? [{ ...v, recordedAt: undefined }]
        : reportDay && isCalendarDay(reportDay) && isCalendarDay(v.recordedAt) && v.recordedAt < reportDay ? [v] : [];
  };
  // A creatinine whose unit is blank or unknown, even cleaned, is never
  // guessed and never saved, as a core value or as a lab row named creatinine
  // ("Cr" alone may be chromium): it is listed with why (US-12 AC15). A urine
  // ratio guessed as mg/dL became a low eGFR (issue #166).
  const refusedValues: RefusedLabValue[] = [];
  // The connector (`metadata`, its prompt alone) refuses only a urine or ratio
  // unit; a blank or unknown one is inferred and stored in SI, as before (D7a,
  // Brad 2026-10-20: "save it as SI unit"; US-12 AC15).
  const creatinineUnitRefused = (v: { value: number; unit: string }) =>
    !readPrintedUnit('creatinine', v.value, v.unit) && !(mode === 'metadata' && !isUrineOrRatioUnit(v.unit));
  const refusesCreatinine = (v: { value: number; unit: string; recordedAt?: string; printedMonth?: string }) => {
    if (!creatinineUnitRefused(v)) return false;
    refusedValues.push({
      metric: 'creatinine', value: v.value, unit: v.unit, reason: creatinineRefusal(v.unit),
      ...(v.recordedAt ? { recordedAt: v.recordedAt } : null), ...(v.printedMonth ? { printedMonth: v.printedMonth } : null),
    });
    return true;
  };
  // mmol/L is a real creatinine unit the table leaves out (website: refused
  // above); on the connector it converts exactly, never by `resolveUnit`'s
  // guess, which would read a urine ACR's 3.2 as mg/dL (D7a, adversary R1).
  const exactMmol = <T extends { metric: string; value: number; unit: string }>(v: T): T =>
    mode === 'metadata' && v.metric === 'creatinine' && /^mmol\/l$/i.test(cleanedCreatinineUnit(v.unit).replace(/\s+/g, ''))
      ? { ...v, value: Math.round(v.value * 1e6) / 1e3, unit: 'µmol/L' } : v;
  // The name the report printed files the row whenever it resolves exactly to a
  // core metric or a catalogued test; the model's pick stands only when it does
  // not (US-07 AC10, Brad 2026-11-02). So "Cortisol" is a morning cortisol
  // whatever key the model chose, and a printed urine creatinine is filed as a
  // lab row, never as serum creatinine. Website and BYOK only (the `full`
  // prompt asks for the name); a row without one is filed as before.
  // Specimen (Brad 2026-11-02): when one name says urine or saliva and the
  // other does not, the one that says it wins, for every test (a plain
  // "Sodium" under a URINE heading stays urine sodium); the unit check below
  // still refuses urine-only units on a creatinine. A printed "Cr" never
  // overrides: it is chromium as often as creatinine, so the model's pick and
  // its checks stand (US-12 AC15).
  const printedOf = (v: { printedName?: string }) => (mode === 'full' ? v.printedName : undefined);
  const saysSpecimen = (name: string) => URINE_MARKER.test(foldName(name)) || SALIVA_MARKER.test(foldName(name));
  const intoCreatinine = (name: string) => resolveCoreMetricName(name) === 'creatinine';
  // A printed serum creatinine name: never "Cr" (chromium as often), no urine or saliva word.
  const printedSerum = (printed?: string) => !!printed && foldName(printed) !== 'cr' && intoCreatinine(printed) && !saysSpecimen(printed);
  const filingName = (model: string, printed: string): string =>
    foldName(printed) === 'cr' ? model
      : saysSpecimen(model) && !saysSpecimen(printed) ? model
        : saysSpecimen(printed) && !saysSpecimen(model) ? printed
          : resolveName(printed) ? printed : model;
  // A core slot the model already filled on that day is never taken by another
  // row's printed name: that row keeps the model's pick.
  // Each row's destination first; then a row re-filed into another core metric
  // takes that slot only if no row that kept its own metric holds it that day,
  // and only the first such row does.
  // A model metric that is no core key ("LDL-Cholesterol", "tsh") is filed by
  // its name the same way, never dropped (US-12 AC11a, Brad 2026-11-03): a core
  // value keeps the model's confidence and question, and creatinine is reached
  // only through a printed name, never the model's alone (AC11). A row with no
  // name at all is dropped and counted.
  const reportDayOf = (d?: string) => (!d || d === reportDay ? '' : d);
  const blank: typeof parsed.values = [];
  const planned = parsed.values.flatMap(v => {
    const printedName = printedOf(v);
    const coreKey = VALID_METRICS.includes(v.metric as MetricType);
    if (!printedName && coreKey) return [{ v, printedName, name: v.metric, to: v.metric, lab: false }];
    const model = v.metric.trim();
    const name = (printedName ? filingName(model, printedName) : model) || printedName;
    if (!name) { blank.push(v); return []; }
    const filed = resolveName(name);
    // Only the 11 the review takes: a weight, waist or height is a lab row.
    const core = filed?.kind === 'core' && VALID_METRICS.includes(filed.metric) ? filed.metric : null;
    return core && (core !== 'creatinine' || (name === printedName && printedSerum(printedName))) ? [{ v, printedName, name, to: core, lab: false }]
      : [{ v, printedName, name, to: name, lab: name !== v.metric || !coreKey }];
  });
  // A dropped row is named only from a column whose values are offered (AC19):
  // one left out with its column is left out of the count too, as its read
  // neighbours are never counted.
  const unread = [...parsed.unreadValues, ...blank.map(unreadValue)];
  const unreadValues = isLab ? unread.flatMap(ownDay).map(({ name, reason, recordedAt }) => ({ name, reason, ...(recordedAt ? { recordedAt } : null) })) : [];
  // A model creatinine its unit check will refuse holds no slot.
  const held = new Set(planned.filter(p => !p.lab && p.to === p.v.metric && !(p.to === 'creatinine' && creatinineUnitRefused(p.v))).map(p => `${p.to}@${reportDayOf(p.v.recordedAt)}`));
  const coreIn: typeof parsed.values = [];
  type LabIn = (typeof parsed.additionalValues)[number] & Pick<AdditionalLabValue, 'confidence' | 'question'>;
  const labIn: LabIn[] = [];
  for (const { v, printedName, name, to, lab } of planned) {
    const isHeld = held.has(`${to}@${reportDayOf(v.recordedAt)}`);
    // A held slot leaves a row the model named by no core key a lab row.
    if (lab || (isHeld && !VALID_METRICS.includes(v.metric as MetricType))) {
      labIn.push({ name, value: v.value, unit: v.unit, referenceLow: null, referenceHigh: null, recordedAt: v.recordedAt, printedMonth: v.printedMonth, printedName, ...comparatorOf(v), confidence: v.confidence, ...(v.question ? { question: v.question } : null) });
    } else if (to === v.metric || isHeld) {
      coreIn.push({ ...v, printedName });
    } else {
      // A creatinine its unit check will refuse takes no slot here either.
      if (!(to === 'creatinine' && creatinineUnitRefused(v))) held.add(`${to}@${reportDayOf(v.recordedAt)}`);
      coreIn.push({ ...v, metric: to, printedName });
    }
  }
  for (const v of parsed.additionalValues) {
    const printedName = printedOf(v);
    labIn.push(printedName ? { ...v, name: filingName(v.name, printedName), printedName } : { ...v, printedName });
  }
  const coreRows = isLab ? coreIn.flatMap(ownDay).filter(v => v.metric !== 'creatinine' || !refusesCreatinine(v)).map(exactMmol) : [];
  const slot = (metric: string, day?: string) => `${metric}@${day ?? ''}`;
  const taken = new Set(coreRows.map(v => slot(v.metric, v.recordedAt)));
  const additionalValues: LabIn[] = [];
  for (const v of isLab ? labIn.flatMap(ownDay) : []) {
    const metric = resolveCoreMetricName(v.name);
    const free = !!metric && !taken.has(slot(metric, v.recordedAt));
    const promote = () => {
      taken.add(slot(metric!, v.recordedAt));
      coreRows.push({ metric: metric!, value: v.value, unit: v.unit, confidence: v.confidence ?? 'high', question: v.question, recordedAt: v.recordedAt, printedMonth: v.printedMonth, printedName: v.printedName, ...comparatorOf(v) });
    };
    // A creatinine the report itself printed as serum creatinine, with no urine
    // word, is promoted like any core value, its unit checked as a core
    // creatinine's (US-07 AC10, Brad 2026-11-02: "sounds fine").
    const printed = printedOf(v);
    const serumByPrint = metric === 'creatinine' && printedSerum(printed);
    if (free && serumByPrint) {
      if (!refusesCreatinine(v)) promote();
    } else if (free && PROMOTABLE.has(metric!) && reportedToCanonical(metric!, v.value, v.unit)) {
      promote();
    } else if (metric !== 'creatinine' || foldName(v.name) === 'cr' || !refusesCreatinine(v)) {
      additionalValues.push({ ...v, name: labNameForUnit(v.name, v.unit), ...limitAtItsBound(v) }); // a count's name in % is its share's (US-21 AC28)
    }
  }
  return {
    classification: parsed.classification,
    reportDate: parsed.reportDate,
    values: isLab ? resolveLabValues(coreRows) : [],
    additionalValues,
    unrecognized: parsed.unrecognized || [],
    document: parsed.document ? {
      classification: parsed.classification,
      title: parsed.document.title,
      documentDate: parsed.document.documentDate,
      contentMarkdown: parsed.document.contentMarkdown,
      ...(parsed.document.summary !== undefined ? { summary: parsed.document.summary } : null),
      metadata: parsed.document.metadata as Record<string, unknown>,
    } : null,
    droppedValueCount: isLab ? parsed.droppedValueCount + blank.length - (unread.length - unreadValues.length) : 0,
    ...(unreadValues.length ? { unreadValues } : null),
    ...(refusedValues.length ? { refusedValues } : null),
  };
}

/** Strip markdown code fences (```json ... ```) from LLM response text */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return trimmed;
}

/**
 * Extract the outermost JSON object from LLM text. Tolerant of code fences,
 * leading/trailing prose, and post-output commentary (some models — notably
 * Haiku on emergent medical queries — still append explanation even after
 * being told "JSON only"). Callers that need strict JSON should prefer this
 * over stripCodeFences.
 */
export function extractJsonObject(text: string): string {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) return text;
  return text.slice(first, last + 1);
}

/** Convert PageContent[] into Anthropic message content blocks. */
export function pagesToContentBlocks(pages: PageContent[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const page of pages) {
    if (page.type === 'text') {
      content.push({ type: 'text', text: page.content });
    } else if (page.type === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: page.content } });
    } else {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: page.mimeType || 'image/jpeg',
          data: page.content,
        },
      });
    }
  }
  return content;
}

