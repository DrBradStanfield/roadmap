/**
 * Name and unit resolution: which core metric or catalogue test a printed name is, and which unit a printed value is in.
 * Moved out of lab-extraction.ts unchanged (US-64, lead A2-8); that file
 * re-exports it, so old import paths keep working.
 */
import { getDisplayLabel, getDisplayRange, LPA_UNITS, rangeFault, reportedToCanonical, toCanonicalValue, type MetricType, type UnitSystem } from './units';
import { acceptedLabUnits, foldName, isLooseCatalogueName, LAB_CATALOG, looseFold, normalizeLabUnit, resolveLabCatalogEntry, type LabCatalogEntry } from './lab-catalog';
import { comparatorOf, type Comparator } from './lab-limits';
import { BLOOD_TEST_METRICS, METRIC_LABELS } from './mappings';
import type { ExtractedValue } from './lab-extraction-contract';

// ---------------------------------------------------------------------------
// Unit resolution
// ---------------------------------------------------------------------------

export const VALID_METRICS: MetricType[] = [
  'hba1c', 'ldl', 'total_cholesterol', 'hdl', 'triglycerides',
  'apob', 'creatinine', 'psa', 'lpa', 'systolic_bp', 'diastolic_bp',
];

/**
 * Every spelling of a core metric a report prints, as the extractor's prompt
 * lists them and as `file_results` resolves a printed name (US-36 AC3). One
 * table: the prompt's TARGET METRICS block is rendered from it. Matching is
 * exact after `foldName` (case, whitespace, underscores — the lab catalogue's
 * own fold), never a substring — "Non-HDL Cholesterol" and "Chol/HDL ratio"
 * must resolve to nothing, not to `hdl`.
 */
export const CORE_METRIC_ALIASES: Record<MetricType, string[]> = {
  ldl: ['LDL', 'LDL-C', 'LDL Cholesterol', 'LDL Cholesterol (calc)', 'LDL Cholesterol (calculated)', 'LDL Chol Calc', 'Low Density Lipoprotein'],
  hdl: ['HDL', 'HDL-C', 'HDL Cholesterol', 'High Density Lipoprotein'],
  total_cholesterol: ['Total Cholesterol', 'TC', 'Cholesterol Total', 'Cholesterol', 'Cholesterol, Total', 'Total Chol'],
  triglycerides: ['Triglycerides', 'TG', 'Trigs', 'Triglyceride'],
  hba1c: ['HbA1c', 'Hemoglobin A1c', 'Glycated Hemoglobin', 'A1C', 'Glycated Haemoglobin', 'Haemoglobin A1c'],
  creatinine: ['Creatinine', 'Creat', 'Cr', 'Serum Creatinine'],
  apob: ['ApoB', 'Apolipoprotein B', 'Apo B'],
  psa: ['PSA', 'Prostate Specific Antigen', 'Prostate-Specific Antigen'],
  lpa: ['Lp(a)', 'Lipoprotein(a)', 'Lipoprotein little a', 'Lipoprotein (a)'],
  systolic_bp: ['Systolic Blood Pressure', 'Systolic BP', 'SBP'],
  diastolic_bp: ['Diastolic Blood Pressure', 'Diastolic BP', 'DBP'],
  weight: ['Weight', 'Body Weight'],
  waist: ['Waist', 'Waist Circumference'],
  height: ['Height'],
};

/** Printed names the resolver knows but the prompt does not list yet: a
 *  prompt change waits for the #166 benchmark (US-21 AC20). */
const RESOLVER_ONLY_ALIASES: Partial<Record<MetricType, string[]>> = {
  ldl: ['LDL-Cholesterol', 'LDL Chol Calc (NIH)', 'Cholesterol (LDL) (calculated)'],
  hdl: ['HDL-Cholesterol', 'Cholesterol (HDL)'],
  hba1c: ['Glycated haemoglobin (HbA1c)'],
  psa: ['PSA, Total', 'Prostate Specific Ag'],
};

const CORE_NAME_INDEX = new Map<string, MetricType>();
for (const metric of Object.keys(CORE_METRIC_ALIASES) as MetricType[]) {
  CORE_NAME_INDEX.set(foldName(metric), metric);
  for (const alias of [...CORE_METRIC_ALIASES[metric], ...(RESOLVER_ONLY_ALIASES[metric] ?? [])]) CORE_NAME_INDEX.set(foldName(alias), metric);
}

/**
 * Every core name's loose fold → its metric (US-66 AC4). A loose form two
 * metrics share, or any catalogue name has, resolves to nothing, so no name
 * resolves to both a core test and a catalogue entry.
 */
const CORE_LOOSE_INDEX: ReadonlyMap<string, MetricType | null> = (() => {
  const byLoose = new Map<string, MetricType | null>();
  for (const [folded, metric] of CORE_NAME_INDEX) {
    const loose = looseFold(folded);
    const seen = byLoose.get(loose);
    byLoose.set(loose, isLooseCatalogueName(loose) || (seen !== undefined && seen !== metric) ? null : metric);
  }
  return byLoose;
})();

/**
 * A name the loose pass never reads: a ratio ("Chol/HDL", "Cholesterol: HDL";
 * a colon only ends a label like "HbA1c:"), or "Cr" however punctuated, which
 * may be chromium and keeps its own guard (US-12 AC15).
 */
function notLoose(name: string): boolean {
  return name.includes('/') || /:\s*\S/.test(name.trim()) || looseFold(name) === 'cr';
}

/**
 * The core metric a printed name is, or null: exact after folding, never a
 * substring. A name the exact fold and the catalogue both miss is tried once
 * more without its punctuation ("LDL - Cholesterol"), unless `notLoose`
 * keeps it apart (US-66 AC4).
 */
export function resolveCoreMetricName(name: string): MetricType | null {
  const exact = CORE_NAME_INDEX.get(foldName(name));
  if (exact || notLoose(name) || resolveLabCatalogEntry(name)) return exact ?? null;
  return CORE_LOOSE_INDEX.get(looseFold(name)) ?? null;
}

/** What a printed name resolves to: a core metric, a catalogued test, or nothing. */
export type ResolvedName = { kind: 'core'; metric: MetricType } | { kind: 'lab'; key: string; entry: LabCatalogEntry } | null;

export function resolveName(name: string): ResolvedName {
  const core = resolveCoreMetricName(name);
  if (core) return { kind: 'core', metric: core };
  const entry = resolveLabCatalogEntry(name);
  return entry ? { kind: 'lab', key: entry.key, entry } : null;
}

/** A test an add sheet offers for a typed name (US-73 AC8): its label, its key, and every unit it
 *  takes, the one it is stored in first (a core test's two, Lp(a)'s three; a catalogue test's spellings). */
export interface LabSearchMatch { name: string; key: string; kind: 'core' | 'catalogue'; units: string[] }

/** Every blood test the record knows by name, with its label and the names it answers to, loosely folded. */
const SEARCHABLE: ReadonlyArray<LabSearchMatch & { names: string[]; folded: string }> = [
  ...BLOOD_TEST_METRICS.map((key) => {
    const metric = key as MetricType;
    const units = metric === 'lpa' ? [...LPA_UNITS] : [...new Set([getDisplayLabel(metric, 'si'), getDisplayLabel(metric, 'conventional')])];
    return { name: METRIC_LABELS[key], key, kind: 'core' as const, units, names: [key, METRIC_LABELS[key], ...CORE_METRIC_ALIASES[metric]] };
  }),
  ...LAB_CATALOG.map((entry) => ({
    name: entry.label, key: entry.key, kind: 'catalogue' as const, units: [...new Set(acceptedLabUnits(entry).map((unit) => normalizeLabUnit(unit)))], names: [entry.key, entry.label, ...entry.aliases],
  })),
].map((test) => ({ ...test, names: [...new Set(test.names.map(looseFold))], folded: looseFold(test.name) }));

/**
 * The core and catalogue tests a typed name finds, best first (US-73 AC8): the
 * test `resolveName` reads it as, then those with a name or alias it is, starts,
 * starts a word of, or, from four letters, sits inside ("test" finds
 * Testosterone, "hba" HbA1c; "tes" never Monocytes); within that, the label's
 * own match, then the shorter label. Nothing for blank text; at most `limit`.
 */
export function labSearch(text: string, limit = 20): LabSearchMatch[] {
  // "vit" is typed for "vitamin" ("vit d"), read so for search only: never an alias, so no stored row moves slot.
  const typed = looseFold(text).replace(/\bvit\b\.?/g, 'vitamin');
  if (!typed) return [];
  const resolved = resolveName(text);
  const exactKey = resolved?.kind === 'core' ? resolved.metric : resolved?.key;
  const inside = typed.length >= 4;
  const rank = (name: string) => (name === typed ? 0 : name.startsWith(typed) ? 1 : name.split(' ').some((w) => w.startsWith(typed)) ? 2 : inside && name.includes(typed) ? 3 : 4);
  return SEARCHABLE
    .map(({ names, folded, ...test }) => ({ test, rank: test.key === exactKey ? -1 : Math.min(...names.map(rank)), label: rank(folded) }))
    .filter((m) => m.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.label - b.label || a.test.name.length - b.test.name.length || a.test.name.localeCompare(b.test.name))
    .slice(0, limit)
    .map(({ test }) => test);
}

/** A flag printed beside a value or its unit (H, L, HH, LL, *, ↑, ↓, any case):
 *  one grammar for a count row's value (US-12 AC8) and a creatinine's unit
 *  (AC15), so the two cannot drift. */
const FLAG = String.raw`(?:HH|LL|H|L|\*|↑|↓)`;
export const VALUE_FLAG = String.raw`[(\[]?\s*${FLAG}\s*[)\]]?`;
/** A flag ending a unit: after a space, bracketed, or a symbol. A bare letter
 *  needs the space, or "mmol/L" would lose its own L. */
const TRAILING_UNIT_FLAG = new RegExp(String.raw`(?:\s+${VALUE_FLAG}|\s*[(\[]\s*${FLAG}\s*[)\]]|\s*[*↑↓])$`, 'i');

/**
 * A creatinine unit as a report garbles it, read once more (US-12 AC15): a
 * trailing flag dropped ("µmol/L H", "µmol/L (H)", "µmol/L*"), "µmol/I" read
 * as "µmol/L", "mg%" as "mg/dL", "mcmol/L" as "µmol/L". The extractor's step
 * only: `lookupUnit` stays exact for every other caller. A bracketed word is
 * never stripped, so "mg/dL (urine)" stays unknown.
 */
export function cleanedCreatinineUnit(unit: string): string {
  return unit.trim().replace(TRAILING_UNIT_FLAG, '').replace(/mol\/I$/, 'mol/L').replace(/^mg\s*%$/i, 'mg/dL').replace(/^mcmol\//i, 'µmol/');
}

/** The printed number as the record stores it: the raw unit first, then, for creatinine only, the cleaned one. */
export function readPrintedUnit(metric: MetricType, value: number, unit: string) {
  return reportedToCanonical(metric, value, unit)
    ?? (metric === 'creatinine' ? reportedToCanonical(metric, value, cleanedCreatinineUnit(unit)) : null);
}

/** Units a creatinine ratio or a timed urine result prints in, folded (case,
 *  spaces). Not mmol/L: a serum creatinine can print in it too. */
const URINE_OR_RATIO_UNITS = new Set(['mg/mmol', 'g/mol', 'mg/g', 'mg/mg', 'g/g', 'mg/24h', 'mmol/24h', 'ml/min']);
/** A ratio whose denominator names creatinine, in any spelling the catalogue's
 *  ACR and PCR rows print ("mg/g creat", "mg/g creatinine", "mg/mmol Cr").
 *  A mass or amount denominator only: "µmol/L creatinine" is not a ratio. */
const PER_CREATININE = /\/\s*[mµu]?(?:g|mol)\s*(?:creat(?:inine)?|cr)(?![a-z])/i;

/** A urine marker between letter edges ("urine,", "/urine", "(urinary)", "urina",
 *  "orina", "Harn", "moczu"), "U-Creat", a trailing " U" or ",U", or "(U)".
 *  Never "U/L", "IU", "mU/L", "(uric)" or "(uncorrected)". No lookbehind:
 *  this runs in the BYOK browser bundle too. */
export const URINE_MARKER = /(?:^|[^a-z])(?:urin(?:e|a|ary)?|orina|harn|moczu)(?![a-z])|(?:^|[^a-z])u-(?:creat|cr)|[\s,]u$|[(\[]\s*u\s*[)\]]/i;
/** A name that says saliva, a specimen as urine is (US-07 AC10), in the urine
 *  marker's languages (Brad 2026-11-02): English saliva/salivary, Spanish and
 *  Portuguese salival, Italian salivare, French salive/salivaire, German
 *  Speichel (also as a compound's start, "Speichelcortisol"), Polish ślina
 *  (and its forms). */
export const SALIVA_MARKER = /(?:^|[^a-zà-ž])(?:(?:saliva(?:ry|l|re)?|salive|salivaire|ślin(?:a|y|ie|owy|owa|owe|owego))(?![a-zà-ž])|speichel)/i;
export const isUrineOrRatioUnit = (unit: string) => URINE_MARKER.test(unit.trim()) || PER_CREATININE.test(unit) || URINE_OR_RATIO_UNITS.has(cleanedCreatinineUnit(unit).toLowerCase().replace(/\s+/g, ''));

/** Why a creatinine was refused, in the user's words (US-12 AC15). */
export function creatinineRefusal(unit: string): string {
  if (!unit) return 'No unit was printed.';
  return isUrineOrRatioUnit(unit)
    ? 'This unit is usually a urine result.'
    : 'This unit could not be read as a blood creatinine.';
}

/** Above this a creatinine (µmol/L) asks "Was this a blood test?" (US-13 AC11).
 *  D6, Brad's proposal: a display question, not a clinical threshold, so the
 *  three clinical files carry no line for it. */
const CREATININE_ASK_ABOVE = 500;

/** Exported for testing */
export function resolveUnit(metric: MetricType, unitStr: string, value: number): {
  valueSI: number;
  system: UnitSystem;
  confident: boolean;
  /** The number fits both scales, so no guess is safe (US-21 AC18). */
  fitsBoth?: true;
} {
  const reported = readPrintedUnit(metric, value, unitStr);
  if (reported) return { ...reported, confident: true };

  // Fallback: check which validation range the value fits
  const siRange = getDisplayRange(metric, 'si');
  // The US range the record can hold, not the hand-written table (US-05 AC2b).
  const convRange = getDisplayRange(metric, 'conventional');
  const fitsInSI = rangeFault(siRange, value) === null;
  const fitsInConv = rangeFault(convRange, value) === null;

  if (fitsInSI && !fitsInConv) {
    return { valueSI: value, system: 'si', confident: false };
  }
  if (fitsInConv && !fitsInSI) {
    return { valueSI: toCanonicalValue(metric, value, 'conventional'), system: 'conventional', confident: false };
  }
  // Fits both or neither — assume SI, flag low confidence
  return { valueSI: value, system: 'si', confident: false, ...(fitsInSI && fitsInConv ? { fitsBoth: true as const } : null) };
}

/** Resolve units for an array of LLM-extracted lab values. Shared by all extraction paths. */
export function resolveLabValues(rawValues: Array<{ metric: string; value: number; unit: string; confidence: 'high' | 'medium' | 'low'; question?: string; recordedAt?: string; printedMonth?: string; printedName?: string; comparator?: Comparator }>): ExtractedValue[] {
  const values: ExtractedValue[] = [];
  for (const v of rawValues) {
    if (!VALID_METRICS.includes(v.metric as MetricType)) continue;
    const metric = v.metric as MetricType;
    const { valueSI, system, confident, fitsBoth } = resolveUnit(metric, v.unit, v.value);
    const asks = [
      !confident && `${v.unit ? `Unit "${v.unit}" was inferred` : 'No unit was printed, so the unit was inferred'} — please verify this value`,
      metric === 'creatinine' && valueSI > CREATININE_ASK_ABOVE && 'Was this a blood test?',
    ].filter(Boolean);
    const question = asks.length ? [v.question?.trim().replace(/[^.?!]$/, '$&.'), ...asks].filter(Boolean).join(' ') : v.question;
    values.push({
      metric: v.metric,
      valueSI,
      displayValue: v.value,
      displayUnit: v.unit,
      displaySystem: system,
      // A number that fits both scales (Lp(a) 50) is low; any question (a
      // guessed unit, the model's doubt, a creatinine too high for blood) or a
      // limit (it may be the lab's target, US-12 AC20b) is at most medium, so the
      // review flags it and it never saves unnoticed (US-21 AC18, US-13 AC11).
      confidence: fitsBoth ? 'low' : (question || v.comparator) && v.confidence === 'high' ? 'medium' : v.confidence,
      question,
      ...(v.recordedAt ? { recordedAt: v.recordedAt } : null),
      ...(v.printedMonth ? { printedMonth: v.printedMonth } : null),
      ...(v.printedName ? { printedName: v.printedName } : null),
      ...(!confident ? { unitGuessed: true as const } : null),
      ...comparatorOf(v),
    });
  }
  return values;
}

