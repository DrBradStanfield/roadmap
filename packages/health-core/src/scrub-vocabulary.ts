/**
 * The word lists and regex vocabulary both Sentry scrubbers share: the
 * browser's (sentry-scrub.ts) and the server's (sentry-scrub-server.ts).
 *
 * Its only DIRECT import is ./lab-catalog (which pulls in its own graph:
 * mappings, units and more). That keeps one place to swap in step 2 (PR 2),
 * where an esbuild plugin replaces this module with generated literal lists,
 * so the generated server file does not carry the catalogue's graph (audit
 * A2-6/A3-1). A test holds the direct-import list to that.
 */

import { CATALOG_UNITS, LAB_CATALOG, metricNameWords } from './lab-catalog';

export const REDACTED = '[Filtered]';

/**
 * Exact-match sensitive keys (compared lowercase).
 * Covers both camelCase (widget/API) and snake_case (database) variants.
 */
export const SENSITIVE_EXACT_KEYS: ReadonlySet<string> = new Set([
  // Health measurements
  'weightkg', 'weight_kg', 'weight',
  'waistcm', 'waist_cm', 'waist',
  'heightcm', 'height_cm', 'height',
  'hba1c',
  'ldlc', 'ldl_c', 'ldl',
  'totalcholesterol', 'total_cholesterol',
  'hdlc', 'hdl_c', 'hdl',
  'triglycerides',
  'apob', 'apo_b',
  'creatinine',
  'psa',
  'lpa',
  'systolicbp', 'systolic_bp',
  'diastolicbp', 'diastolic_bp',
  // Metric type identifier (reveals what someone tracks)
  'metrictype', 'metric_type',
  // Calculated results
  'idealbodyweight', 'ideal_body_weight',
  'proteintarget', 'protein_target',
  'bmi',
  'waisttoheightratio', 'waist_to_height_ratio',
  'nonhdlcholesterol', 'non_hdl_cholesterol',
  'egfr',
  // A lab result printed as a limit (US-12 AC20): its bound, its code, and the plan's limits.
  'labegfr', 'labegfrlimit', 'limits', 'limit', 'bound', 'comparator',
  // Medications
  'drugname', 'drug_name',
  'dosevalue', 'dose_value',
  'doseunit', 'dose_unit',
  // Demographics
  'firstname', 'first_name',
  'lastname', 'last_name',
  'email',
  'birthyear', 'birth_year',
  'birthmonth', 'birth_month',
  'sex', 'gender',
  'dob', 'dateofbirth', 'date_of_birth', 'birthdate',
  'patientname', 'patient_name',
  // Identifiers
  'shopify_customer_id', 'customerid',
  'userid', 'user_id',
  // Patient identifiers a lab report or an import carries
  'nhi', 'mrn',
  // Generic carriers: whatever a row, a lab result or an extraction is called,
  // this is the field its number or its text sits in.
  'value', 'values', 'result', 'results',
  'title', 'note', 'notes', 'summary',
  'displayvalue', 'display_value',
  'valuesi', 'value_si',
  'contentmarkdown', 'content_markdown',
  // An extracted row or document, field by field (US-09 AC7c). `metric` is
  // the health-specific name of `metricType`. `name` is NOT here: the SDK
  // names the OS and runtime by it in `contexts`.
  'metric', 'metricname', 'metric_name', 'printedname',
  'referencelow', 'reference_low', 'referencehigh', 'reference_high',
  'unrecognized', 'question', 'extractedtext', 'content_md', 'document_type',
  'recordedat', 'recorded_at', 'documentdate', 'document_date',
  'classification', 'supplementname', 'supplement_name', 'metadata',
  'reportdate', 'report_date', 'collectedon', 'collected_on',
  'existingvalue', 'documenttype', 'documentcontent',
  // Screening-specific
  'prostatepsavalue', 'prostate_psa_value',
  'lungpackyears', 'lung_pack_years',
]);

/**
 * If a key contains any of these substrings (lowercase), scrub it.
 * Catches compound fields like "colorectal_last_date", "statinDrug", etc.
 */
export const SENSITIVE_SUBSTRINGS = [
  'password', 'secret', 'credential',
  // Every credential family, by the word it is named after: `token` covers
  // unsubscribe_token, refreshToken and access_token in one rule.
  'token', 'auth', 'bearer', 'apikey', 'api_key',
  // A cookie is a session: the SDK copies each one into span data by name.
  'cookie',
  // A clinical document is named by its file: "Brad Stanfield lipids Mar 2026.pdf".
  'filename', 'sourcefilename',
  'screening', 'followup',
  'medication', 'statin', 'ezetimibe', 'pcsk9', 'glp1', 'sglt2', 'metformin',
];

// ---------------------------------------------------------------------------
// Free-text scrub (added 2026-09-10 after a ChatGPT audit of the server hook)
// ---------------------------------------------------------------------------
// Key-based redaction cannot see a value written in a sentence: "My LDL is 3.2
// mmol/L" survived in `exception.values[].value`, in an `extra.message` string
// and in console breadcrumbs. These rules run over every free-text field of an
// event, on top of the key scrub. Stack frames, filenames and error class names
// are never touched.
//
// The vocabularies are READ OFF the catalogue here, so a test added tomorrow
// scrubs a report about it. instrument-scrub.mjs cannot import anything — it
// loads before the bundle, outside any workspace resolution — so it carries
// the same lists as literals, and `instrument-scrub-parity.test.ts` compares
// the two arrays and prints the literal to paste when the catalogue moves.

/** The first spelling of each unit, whatever its case (the scrub ignores case). */
const caselessUnique = (units: string[]): string[] =>
  units.filter((unit, i) => units.findIndex((u) => u.toLowerCase() === unit.toLowerCase()) === i);

/**
 * Unit spellings that make a bare number a health value: every unit the record
 * prints or the catalogue accepts, plus the ASCII and dose spellings a sentence
 * uses ("metformin 500mg").
 */
export const SCRUB_UNITS: readonly string[] = caselessUnique([
  // Every unit the record can print, read off UNIT_DEFS and the lab catalogue,
  // then every spelling the catalogue reads as one (US-09 AC7e). An alias that
  // is only letters ("ratio", "fraction") is English first, so it is left out.
  // The other spellings normalizeLabUnit folds into these are matched by
  // unitPattern below.
  ...CATALOG_UNITS,
  ...LAB_CATALOG.flatMap((entry) => [...(entry.unitAliases ?? []), ...Object.keys(entry.conversions ?? {})])
    .filter((spelling) => !/^[a-z]+$/i.test(spelling)),
  // Spellings no catalogue list holds.
  'mm Hg', 'micromol/L', 'lb',
  // Dose units — "metformin 500mg" is a health value with no metric name in it.
  'mcg', 'µg', 'mg', 'g', 'IU', 'mL', 'ml', 'units',
  // Inches: matched by a stricter rule (see INCH_UNIT) — "5 in the morning"
  // is English, not a height.
  '"',
]);

/**
 * What no name in either list spells: the phrases a person writes, and the
 * metrics that live in the calculator rather than the catalogue. "vit" is the
 * typed short form of vitamin ("Vit D 45", US-09 AC7g). The feedback guard
 * reads the same list (US-32 AC9a).
 */
export const EXTRA_METRIC_NAMES: readonly string[] = ['blood pressure', 'apo b', 'lp(a)', 'a1c', 'bp', 'bmi', 'height', 'vit'];

/** Metric and lab names that make an adjacent number a health value. */
export const SCRUB_METRIC_WORDS: readonly string[] = [...new Set([
  // Every word a metric or catalogued test is known by. 3 is the floor for a
  // word split out of a name: "mg" and "na" are a unit and a word long before
  // they are magnesium and sodium.
  ...metricNameWords(3),
  // Every name a catalogued test is known by, whole: a whole name is that test
  // however short ("Na 140", "Ca 2.4"), and a name ending in a digit keeps the
  // digit while the value goes ("IGF 1 200", "Free T4 15").
  ...LAB_CATALOG.flatMap((entry) => [entry.key, entry.label, ...entry.aliases]).map((name) => name.toLowerCase()),
  ...EXTRA_METRIC_NAMES,
])];

/** A number, or a blood-pressure pair ("140/90"). */
const NUMBER = '\\d+(?:[.,]\\d+)?(?:/\\d+(?:[.,]\\d+)?)?';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest pattern first so "mmol/L" wins over "mol", "ldl cholesterol" over
 *  "ldl", and "Units/L" (a U/L) over the dose word "units". */
const alternation = (words: readonly string[], pattern = escapeRe) =>
  words.map(pattern).sort((a, b) => b.length - a.length).join('|');

/**
 * Every spelling normalizeLabUnit (lab-catalog.ts) folds into a part of a
 * listed unit, as regex (US-09 AC7e): any cell-count exponent ("10^9", "x 10e9",
 * "x10(3)", "10³"), a micro written u, μ or mc, a microlitre written uL, mcL,
 * mm3 or cmm, a squared metre written m2 or m^2, gm/dL, and Unit(s) for U.
 */
const NORMALISER_SPELLINGS: Record<string, string> = {
  '×10': '(?:[x×]\\s*)?10\\s*(?:(?:e|\\^|\\*{1,2})\\s*\\d+|(?:\\^|\\*{1,2})?\\(\\s*\\d+\\s*\\)|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)',
  '/µl': '/(?:(?:[µμu]|mc)l|mm[3³]|cmm|cumm|cu[ .]mm|c\\.mm)',
  'µ': '(?:[µμu]|mc)',
  'm²': 'm(?:²|\\^?2)',
  u: '(?:u|units?)',
  g: 'gm?',
};
const unitPattern = (unit: string) => escapeRe(unit.toLowerCase())
  .replace(/×10[⁰¹²³⁴⁵⁶⁷⁸⁹]+|\/µl|µ|m²|^u(?=\/)|^g(?=\/dl)/g,
    (part) => NORMALISER_SPELLINGS[part.startsWith('×') ? '×10' : part]);

/** Inches only at the end of a phrase — never "in" leading a word. */
const INCH_UNIT = '(?:in(?=\\s*(?:[^A-Za-z0-9\\s]|$))|")';
const PLAIN_UNITS = SCRUB_UNITS.filter(u => u !== 'in' && u !== '"');
/** Every listed unit in every spelling the normaliser folds into it, as one
 *  regex alternation (the chat-question archive check uses it too, US-15 AC44a). */
export const SCRUB_UNIT_PATTERN = alternation(PLAIN_UNITS, unitPattern);

// Bounded parts keep it linear on a long run; a lookbehind would refuse the
// second of two adjacent addresses (US-09 AC7f). The feedback guard builds its
// own regex from this source, so both read one rule (US-32 AC58).
export const EMAIL_SOURCE = String.raw`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}`;
export const EMAIL_RE = new RegExp(EMAIL_SOURCE, 'g');
export const UNIT_VALUE_RE = new RegExp(
  `\\b${NUMBER}\\s*(?:(?:${SCRUB_UNIT_PATTERN})(?![A-Za-z])|${INCH_UNIT})`, 'gi');
// A name starts where no letter or digit runs into it ("γ-GT" starts with no
// word character, so not a word boundary) and ends where no letter does: digits straight
// after a name are its value ("ldl140"), never part of it. A number inside a
// word, with a letter on both sides (the 1 of "A1c"), is never the value, so
// "Hb" cannot take it in "Hb A1c 7.2"; "a1c" scrubs the 7.2 itself.
// A name is never a value (US-09 AC7g): the gap stops where another name
// starts, so "Ferritin pending, B12 300" leaves the 300 to "B12". And a number
// glued to a letter with another number after it, across the same gap a name
// takes ("T4 15", "T4 <15", "CA-125, 30"), ends a name the list does not hold,
// so the number after it goes too.
const METRIC_NAME = `(?<![a-z0-9])(?:${alternation(SCRUB_METRIC_WORDS)})(?![a-z])`;
/** What may stand between a name and its value: up to 20 characters, no digit, no other name. */
const NAME_GAP = `(?:(?!${METRIC_NAME})[^\\d\\n]){0,20}?`;
export const METRIC_THEN_VALUE_RE = new RegExp(
  `(?<![a-z0-9])(${alternation(SCRUB_METRIC_WORDS)})(?![a-z])(${NAME_GAP})(?!(?<=[a-z])\\d+(?:[.,]\\d+)?[a-z]|${METRIC_NAME})((?<=[a-z]-?)${NUMBER}(?:[ \\t:=]+|${NAME_GAP})(?!${METRIC_NAME})${NUMBER}|${NUMBER})`, 'gi');
// Name edges, not \b: "Lp(a)" ends and "γ-GT" starts with no word character,
// so \b never matched there. A name starts where no letter or digit runs into
// it, or at its own first character when that is a symbol ("xγ-GT"), and ends
// the same way ("lp(a)s"), so nothing \b scrubbed is lost. A value starts at
// the head of its digit run, never inside it: same matches, linear on a long
// run (US-09 AC7f).
export const VALUE_THEN_METRIC_RE = new RegExp(
  `(?<!\\d)(${NUMBER})([^\\d\\n]{0,20}?)(?:(?<![a-z0-9])|(?![a-z0-9]))(${alternation(SCRUB_METRIC_WORDS)})(?:(?<![a-z0-9])|(?![a-z0-9]))`, 'gi');
