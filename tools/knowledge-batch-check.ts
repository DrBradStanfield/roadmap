/**
 * Batch acceptance checks for the knowledge refresh (plan 2026-09-29, Phase 0
 * step 5; story US-42 in docs/user-stories.md: AC1-AC4, AC6, AC7, AC9, AC11). No model calls. Raw third-party text is read from
 * the paths named in the diff reports and never written anywhere: the markdown
 * batch report holds counts and hashes only.
 *
 *   npx tsx tools/knowledge-batch-check.ts --batch <name> --handles <file> \
 *     [--reports <dir>] [--base <git ref>] [--out <file>]
 * A report entry is {body_line, raw_quote, notes?}: an exact body line and verbatim source text. The checker
 * derives the numbers itself (a legacy `token` field is ignored). Each new number needs one entry whose line and
 * quote both carry it; each entry must share a number between its line and quote. "call 111" is exempt.
 * Decisions reviewers have disputed and Brad kept (do not "fix" them):
 *  - A number that RELOCATED into a restructured sentence (whole-body count equal, token already in the base,
 *    the sentence wording around it changed) is a WARN. A number changed IN PLACE (same wording, a different
 *    value: a dose swap between two sentences) is a FAIL without a changed_tokens entry.
 *  - The hedge count may fall only by the hedges inside sentences the report lists in deleted_sentences with a
 *    justification (US-42 AC3): each such loss is a WARN, anything else is a FAIL, in every article type. A
 *    hedge lost from a sentence that SURVIVES (not declared deleted, its other words still present) is a FAIL.
 *  - Comparator words are matched longest-first ("no more than" is <=, never ">" from "more than").
 *  - An unchanged (frozen) summary passes even with a proposed correction: the orchestrator applies
 *    corrections later under the paired-arm rule. A summary that changed must equal the proposal.
 *  - AC6 allows the --out report path inside the repo: the batch report commits with the batch.
 *
 *   npx tsx tools/knowledge-batch-check.ts --print-schema
 *   npx tsx tools/knowledge-batch-check.ts --example <handle>
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Status = "PASS" | "FAIL" | "WARN";
export interface Exception { check: string; handle: string; match: string; reason: string; by: string; date: string }
export interface Result { id: string; title: string; status: Status; evidence: string[]; excepted?: Exception[] }
export interface Entry { body_line: string; raw_quote: string; notes?: string }
export interface Report {
  handle: string;
  type: "pathway" | "reference" | "video" | "guideline";
  raw_path: string;
  raw_sha256: string;
  old_raw_path: string | null;
  /** One entry per body line and its verbatim source quote; the checker derives the numbers. A `token` field is ignored. */
  changed_tokens: Entry[];
  deleted_sentences: { sentence: string; justification: string; pattern?: boolean }[];
  headings_before: string[];
  headings_after: string[];
  proposed_summary_correction: string | null;
  product_mentions_before: number;
  product_mentions_after: number;
  notes: string;
  /** True when the handle is not in docs/blog/index.json yet; the type then comes from the frontmatter. */
  new?: boolean;
  /** Optional further raw sources; a raw_quote prefixed "NIH: " or "EXTRA: " is matched in these. */
  extra_raw?: { path: string; sha256: string }[];
}

export const REPORT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "knowledge-batch diff report (one <handle>.json per article)",
  type: "object",
  additionalProperties: true, // extra keys (grokipedia_claims, needs_pubmed, ...) are ignored
  required: ["handle", "type", "raw_path", "raw_sha256", "old_raw_path", "changed_tokens", "deleted_sentences",
    "headings_before", "headings_after", "proposed_summary_correction", "product_mentions_before",
    "product_mentions_after", "notes"],
  properties: {
    handle: { type: "string" },
    type: { enum: ["pathway", "reference", "video", "guideline"] },
    raw_path: { type: "string", description: "absolute path to the NEW raw file" },
    raw_sha256: { type: "string", description: "sha256 hex of that file" },
    old_raw_path: { type: ["string", "null"] },
    changed_tokens: {
      type: "array",
      items: {
        type: "object", additionalProperties: true, required: ["body_line", "raw_quote"], // a legacy `token` is ignored
        properties: {
          body_line: { type: "string", description: "an exact current line of the body" },
          raw_quote: { type: "string", description: "verbatim source text (6 words or 30 characters) sharing a number with body_line" },
          notes: { type: "string" },
        },
      },
    },
    deleted_sentences: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["sentence", "justification"],
        properties: {
          sentence: { type: "string", description: "verbatim removed sentence, or a regex when pattern is true" },
          justification: { type: "string" },
          pattern: { type: "boolean", description: "true: `sentence` is a regex; every removed base sentence it matches counts as justified" },
        },
      },
    },
    headings_before: { type: "array", items: { type: "string" } },
    headings_after: { type: "array", items: { type: "string" } },
    proposed_summary_correction: { type: ["string", "null"] },
    product_mentions_before: { type: "number" },
    product_mentions_after: { type: "number" },
    notes: { type: "string" },
    new: { type: "boolean", description: "true for a handle absent from docs/blog/index.json" },
    extra_raw: {
      type: "array",
      items: { type: "object", required: ["path", "sha256"], properties: { path: { type: "string" }, sha256: { type: "string" } } },
    },
  },
};

export function exampleReport(handle: string): Report {
  return {
    handle, type: "reference",
    raw_path: `/abs/path/to/knowledge-map-raw/refresh-2026-09-29/${handle}.md`,
    raw_sha256: "0".repeat(64),
    old_raw_path: null,
    changed_tokens: [{ body_line: "Trials used 200 mg per day [3].", raw_quote: "participants took 200 mg daily" }],
    deleted_sentences: [{ sentence: "The old sentence, verbatim from the previous body.", justification: "Absent from the new raw; the source dropped it." }],
    headings_before: ["## Dosing"], headings_after: ["## Dosing"],
    proposed_summary_correction: null,
    product_mentions_before: 1, product_mentions_after: 1,
    notes: "",
  };
}

export function validateReport(o: unknown): string[] {
  const e: string[] = [];
  if (!o || typeof o !== "object" || Array.isArray(o)) return ["not an object"];
  const r = o as Record<string, unknown>;
  const str = (k: string) => { if (typeof r[k] !== "string") e.push(`${k}: string expected`); };
  const strOrNull = (k: string) => { if (r[k] !== null && typeof r[k] !== "string") e.push(`${k}: string or null expected`); };
  const num = (k: string) => { if (typeof r[k] !== "number") e.push(`${k}: number expected`); };
  const strArr = (k: string) => { if (!Array.isArray(r[k]) || (r[k] as unknown[]).some((x) => typeof x !== "string")) e.push(`${k}: string[] expected`); };
  const objArr = (k: string, keys: string[]) => {
    if (!Array.isArray(r[k])) { e.push(`${k}: array expected`); return; }
    (r[k] as unknown[]).forEach((x, i) => {
      for (const key of keys) {
        if (x && typeof (x as Record<string, unknown>)[key] === "string") continue;
        e.push(`${k}[${i}].${key}: ${key === "body_line" ? "body_line must be the body line's text, not a number" : "string expected"}`);
      }
    });
  };
  str("handle"); str("raw_path"); str("raw_sha256"); str("notes");
  strOrNull("old_raw_path"); strOrNull("proposed_summary_correction");
  num("product_mentions_before"); num("product_mentions_after");
  strArr("headings_before"); strArr("headings_after");
  objArr("changed_tokens", ["body_line", "raw_quote"]);
  objArr("deleted_sentences", ["sentence", "justification"]);
  if (Array.isArray(r.deleted_sentences)) (r.deleted_sentences as { pattern?: unknown }[]).forEach((x, i) => {
    if (x && x.pattern !== undefined && typeof x.pattern !== "boolean") e.push(`deleted_sentences[${i}].pattern: boolean expected`);
  });
  if (r.new !== undefined && typeof r.new !== "boolean") e.push("new: boolean expected");
  if (r.extra_raw !== undefined) {
    if (!Array.isArray(r.extra_raw)) e.push("extra_raw: array expected");
    else (r.extra_raw as unknown[]).forEach((x, i) => {
      for (const key of ["path", "sha256"]) if (!x || typeof (x as Record<string, unknown>)[key] !== "string") e.push(`extra_raw[${i}].${key}: string expected`);
    });
  }
  if (!["pathway", "reference", "video", "guideline"].includes(r.type as string)) e.push("type: pathway|reference|video|guideline expected");
  return e;
}

// ---------- text helpers ----------

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function splitFrontmatter(text: string): { front: string; body: string } {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

/** Undo turndown's backslash escapes. */
export const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, "$1");

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", minus: "-", micro: "µ", plusmn: "±", deg: "°", ge: "≥", le: "≤" };
const codePoint = (n: number) => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
/** PubMed abstract files carry HTML entities ("5&#xa0;grams", "&amp;", "&#8211;"). */
const decodeEntities = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
/** Raw text uses HTML entities, no-break spaces and Unicode hyphens; writers type plain ones. */
export const normChars = (s: string) => decodeEntities(s).replace(/\u00a0/g, " ").replace(/[\u2010\u2011\u2012\u2013]/g, "-");

/** Normal form for substring matching of raw quotes. */
export const normQuote = (s: string) => unescapeMd(normChars(s)).replace(/\s+/g, " ").trim().toLowerCase();

const squash = (t: string) => t.replace(/\s+/g, " ").trim();
const REFS_HEADING = /^#{1,4}\s*(?:\d+[.)]?\s*)?(?:references|sources|citations|bibliography)\b/i;
const REF_LINE = /^\s*\[(\d+)\]\s+\S/;

/** Lines of a body with their reference-section status. */
function classifyLines(body: string): { line: string; ref: boolean }[] {
  let inRefs = false;
  return body.split(/\r?\n/).map((line) => {
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) inRefs = REFS_HEADING.test(line);
    return { line, ref: (inRefs && !isHeading) || REF_LINE.test(line) };
  });
}

// Tokeniser: units, longest first; the lookahead stops "mg" matching inside "mgs" etc.
// Compound units come first so "2 mg/kg" is not "2 mg", and "90 g/L" is not "90 g/dL".
const UNIT = [
  "mL/min/1\\.73m2", "mmol/mol", "mmol/L", "nmol/L", "pmol/L", "[µμ]mol/L", "umol/L", "micromol/L", "micromole/L", "mg/mmol", "mg/dL", "mg/kg", "mg/L",
  "mL/min", "L/min", "breaths/min", "IU/L", "U/L", "g/dL", "g/L", "ng/mL", "ng/dL", "ng/L", "nanogram/L", "[µμ]g/dL", "mcg/dL", "[µμ]g/L", "mcg/L",
  "mmHg", "bpm", "x/day", "times daily", "percent", "%",
  "kilograms?", "milligrams?", "micrograms?", "nanograms?", "millilitres?", "milliliters?", "litres?", "liters?", "grams?",
  "mcg", "[µμ]g", "mg", "IU", "mL", "kg", "cm", "g", "hours?", "days?", "weeks?", "months?", "years?", "minutes?", "mins?", "seconds?", "secs?",
  "(?<=[\\s-])s", // "30-s chair stand", "5 s", but not the "s" of "1990s"
].join("|");
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|\\.\\d+";
// Comparator words, longest first, so "no more than" never falls through to "more than".
const CMP_WORDS = [...["no more than", "not more than", "no less than", "not less than", "up to", "at least", "more than",
  "greater than", "less than", "lower than", "over", "above", "below", "under"].map((w) => w.replace(/ /g, "\\s+")),
  "maximum(?:\\s+[A-Za-z]+)?"].join("|"); // "maximum 4 mg", "maximum of 1 week", "maximum duration 1 week"
const CMP_PRE = `(?:(≥|≤|>=|<=|>|<|\\b(?:${CMP_WORDS}))\\s*)?`;
const CMP_POST = "or more|or higher|or above|or less";
// "/day", "per dose", "a day", "each week", "daily", "weekly" straight after a unit.
const SUFFIX = "(?:\\s*/\\s*|\\s+per\\s+)(?:day|dose|week|kg)|\\s+(?:a|each)\\s+(?:day|week)|\\s+(?:daily|weekly)";
const suffixOf = (raw: string | undefined) => (!raw ? "" : /week/i.test(raw) ? "/week" : /dose/i.test(raw) ? "/dose" : /kg/i.test(raw) ? "/kg" : "/day");
// Groups: 1 leading comparator, 2 and 3 numbers, 4 trailing comparator, 5 unit, 6 unit suffix (/day, per dose ...),
// 7 any other attached "/x/y" (kept: "5 mg/m2" is not "5 mg"), 8 trailing comparator. A range may read "X-Y", "X to Y" or "X and Y".
const GENERIC = "/[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*(?:/[A-Za-z0-9][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*)*";
const TOKEN_RE = () => new RegExp(
  `${CMP_PRE}(?<![A-Za-z0-9.,]|[A-Za-z]-)(${NUM})(?:(?:\\s*[–-]\\s*|\\s+to\\s+|\\s+and\\s+)(${NUM}))?(?:\\s+(${CMP_POST})\\b)?(?:[\\s-]*(${UNIT})(?![A-Za-z])(?:(${SUFFIX})(?![A-Za-z]))?(?:(${GENERIC})(?![A-Za-z0-9]))?)?(?:\\s+(${CMP_POST})\\b)?`, "gi");

const CMP_CANON: Record<string, string> = {
  "<=": "≤", "≤": "≤", "no more than": "≤", "not more than": "≤", "up to": "≤", "maximum": "≤", "maximum of": "≤", "or less": "≤",
  ">=": "≥", "≥": "≥", "no less than": "≥", "not less than": "≥", "at least": "≥", "or more": "≥", "or higher": "≥", "or above": "≥",
  ">": ">", "more than": ">", "greater than": ">", "over": ">", "above": ">",
  "<": "<", "less than": "<", "lower than": "<", "below": "<", "under": "<",
};
const genericOf = (raw: string | undefined) => (!raw ? "" : raw.toLowerCase().split("/").filter(Boolean)
  .map((seg) => (/^minutes?$/.test(seg) ? "min" : /^seconds?$/.test(seg) ? "sec" : seg)).map((seg) => `/${seg}`).join(""));
const canonCmp = (c: string | undefined) => (!c ? "" : /^maximum\b/i.test(c) ? "≤" : CMP_CANON[c.toLowerCase().replace(/\s+/g, " ")] ?? "");

// "150 mg enteric coated, daily": "daily" or "per day" up to three words after a dose unit still means /day.
const FAR_DAILY = /^(?:\s+(?!and\b|or\b|to\b)[A-Za-z][A-Za-z-]*,?){1,3}\s+(?:daily|per\s+day)\b/i;
const FAR_DAILY_UNITS = new Set(["mg", "mcg", "g", "IU", "mL", "kg"]);
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LEAD_CMP = new RegExp(`\\b(${CMP_WORDS})\\b[^:.]*:\\s*$`, "i");
const COMPOUND_UNITS: Record<string, string> = { "mmol/l": "mmol/L", "mg/dl": "mg/dL", "ml/min": "mL/min", "ng/l": "ng/L", "pmol/l": "pmol/L", "nmol/l": "nmol/L",
  "µmol/l": "umol/L", "μmol/l": "umol/L", "umol/l": "umol/L", "micromol/l": "umol/L", "micromole/l": "umol/L", "nanogram/l": "ng/L",
  "ml/min/1.73m2": "mL/min/1.73m2", "mmol/mol": "mmol/mol", "mg/mmol": "mg/mmol", "mg/kg": "mg/kg", "mg/l": "mg/L", "l/min": "L/min",
  "breaths/min": "breaths/min", "g/dl": "g/dL", "g/l": "g/L", "ng/ml": "ng/mL", "ng/dl": "ng/dL", "iu/l": "IU/L", "u/l": "U/L",
  "µg/l": "mcg/L", "μg/l": "mcg/L", "mcg/l": "mcg/L", "µg/dl": "mcg/dL", "μg/dl": "mcg/dL", "mcg/dl": "mcg/dL" };

function normUnit(u: string): string {
  const l = u.toLowerCase();
  if (COMPOUND_UNITS[l]) return COMPOUND_UNITS[l];
  if (l === "percent" || l === "%") return "%";
  if (/^(µg|μg|mcg|micrograms?)$/.test(l)) return "mcg";
  if (/^milligrams?$/.test(l)) return "mg";
  if (/^nanograms?$/.test(l)) return "ng";
  if (/^kilograms?$/.test(l)) return "kg";
  if (/^grams?$/.test(l)) return "g";
  if (/^(litres?|liters?)$/.test(l)) return "L";
  if (/^(millilitres?|milliliters?|ml)$/.test(l)) return "mL";
  if (l === "s") return "sec";
  if (/^(minutes?|mins?)$/.test(l)) return "min";
  if (/^(seconds?|secs?)$/.test(l)) return "sec";
  if (l === "times daily" || l === "x/day") return "x/day";
  if (l === "iu") return "IU";
  if (l === "mmhg") return "mmHg";
  return l.replace(/s$/, "");
}

function normNumber(n: string, unit: string): { value: string; unit: string } {
  let v = parseFloat(n.replace(/,/g, ""));
  if (unit === "g") { v = Number((v * 1000).toFixed(6)); unit = "mg"; }
  return { value: String(v), unit };
}

/** Strip everything the tokeniser must ignore, line by line. */
function stripNoise(line: string): string {
  return unescapeMd(line)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/\bPMIDs?:?\s*\d+(?:\s*[,;]\s*\d+)*/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, " ")
    .replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, " ");
}

/** Number tokens of a text, unit-normalised ("1 g" -> "1000 mg"). Reference lines are skipped unless keepRefs. */
export function tokenCounts(text: string, opts: { keepRefs?: boolean } = {}): Map<string, number> {
  const out = new Map<string, number>();
  text = normChars(text);
  const lines = opts.keepRefs ? text.split(/\r?\n/).map((line) => ({ line, ref: false })) : classifyLines(text);
  let listCmp = ""; // a comparator word that ends a line with ":" governs the list items below it
  for (const { line, ref } of lines) {
    if (ref) continue;
    const isItem = LIST_ITEM.test(line);
    if (!isItem && line.trim()) listCmp = canonCmp(LEAD_CMP.exec(line.trim())?.[1]);
    const itemCmp = isItem ? listCmp : "";
    // "> " is a blockquote marker only on body lines; a token or quote may start with a ">" comparator.
    const s = stripNoise(opts.keepRefs ? line : line.replace(/^\s*>+ /, ""));
    for (const m of s.matchAll(TOKEN_RE())) {
      const unit = m[5] ? normUnit(m[5]) : "";
      // "over 12 to 72 hours" is a time span, not a comparator; "over 12 hours" is > 12.
      const lead = m[1]?.toLowerCase();
      const cmp = m[3] && (lead === "over" || lead === "above") ? "" : canonCmp(m[1] ?? m[4] ?? m[8]) || itemCmp;
      // A digit glued to a hyphen and letters ("5-ASA", "6-MP", "5-HT3") is a name, not a number.
      if (!m[5] && !m[3] && /^-[A-Za-z]/.test(s.slice(m.index! + m[0].length))) continue;
      const gen = genericOf(m[7]);
      // "micrograms/L" is "mcg/L": a spelled unit plus its /denominator, matched case-insensitively.
      const comp = unit && gen ? COMPOUND_UNITS[`${unit}${gen}`.toLowerCase()] : undefined;
      const per = m[6] ?? (unit && FAR_DAILY_UNITS.has(unit) && !gen && FAR_DAILY.test(s.slice(m.index! + m[0].length)) ? "daily" : undefined);
      for (const n of [m[2], m[3]].filter(Boolean) as string[]) {
        if (!unit && !cmp && !n.includes(",") && !n.includes(".") && /^(19|20)\d\d$/.test(n)) continue;
        const { value, unit: u } = normNumber(n, comp ?? unit);
        const key = `${cmp}${u ? `${value} ${u}${suffixOf(per)}${comp ? "" : gen}` : value}`;
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    }
  }
  return out;
}

export const tokenise = (text: string, opts: { keepRefs?: boolean } = {}): Set<string> => new Set(tokenCounts(text, opts).keys());

const ABBREV = /\b(e\.g|i\.e|vs|Dr|mg|etc|approx|Mr|Mrs|Ms|Prof|al|Fig)\./gi;
export const cleanSentence = (s: string) =>
  s.replace(/[*_]/g, "").replace(/^\s*(?:[>#-]+|\d+[.)]|\|)\s+/, "").replace(/\s+/g, " ").trim();

export function sentences(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line) || /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("|") || !line.trim()) continue;
    const masked = line.replace(ABBREV, (m) => `${m.slice(0, -1)}\u0000`);
    for (const part of masked.split(/(?<=[.?!][)"'\]*]*)\s+/)) {
      const s = cleanSentence(part.replace(/\u0000/g, "."));
      if (s) out.push(s);
    }
  }
  return out;
}

export const headings = (body: string) =>
  body.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());

const HEDGES = ["may", "might", "can", "could", "likely", "possibly", "appears", "suggests", "associated with",
  "linked to", "observational", "limited", "preliminary", "modest", "some evidence", "no evidence", "unclear",
  "insufficient", "mixed", "not established"];
const HARDENERS = ["causes", "prevents", "treats", "cures", "reduces risk", "proven", "should", "must", "safe",
  "will", "effective", "improves", "lowers", "no side effects", "recommended", "not been observed"];
const phraseRe = (p: string) => new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`, "gi");
const countIn = (text: string, p: string) => (text.match(phraseRe(p)) ?? []).length;
const totalIn = (text: string, list: string[]) => list.reduce((n, p) => n + countIn(text, p), 0);

export const PRODUCT_NAMES = ["MicroVitamin+", "MicroVitamin", "Sleep by Dr. Brad", "Sleep by Dr Brad", "Omega-3", "Potassium Fibre", "Potassium Fiber"];
const PRODUCT_RE = new RegExp(PRODUCT_NAMES.map((n) => n.replace(/[+.]/g, "\\$&")).join("|"), "gi");
// Generic omega-3 (fatty acids, fish oil, leaflets, link text) is not the product, unless the brand is within 40 characters.
const OMEGA = "omega[- ]?3";
const OMEGA_GENERIC = new RegExp(`${OMEGA}(?=[\\s\\S]{0,30}?(?:fatty acid|fish oil|leaflet|and cardiovascular))`, "gi");
const OMEGA_IN_LINK = /\[[^\]]*\](?=\()/g;
const BRAND_NEAR = /dr\.? brad|microvitamin/i;
const brandNear = (str: string, at: number, len: number) => BRAND_NEAR.test(str.slice(Math.max(0, at - 40), at + len + 40));
export const productMentions = (body: string) =>
  (body
    .replace(OMEGA_IN_LINK, (m, at: number, str: string) => (brandNear(str, at, m.length) ? m : m.replace(new RegExp(OMEGA, "gi"), "")))
    .replace(OMEGA_GENERIC, (m, at: number, str: string) => (brandNear(str, at, m.length) ? m : ""))
    .match(PRODUCT_RE) ?? []).length;

const BANNED = ["Top Pick", "What CL Found", "ConsumerLab approved", "CL Approved", "Approved Quality"];
const BRAND_RANKING = /\b(?:best|top|#1|number one|top[- ]rated|highest[- ]rated)\s+brands?\b|\bbrand rankings?\b|\bbrands?,? ranked\b|\branked (?:the )?brands?\b/i;
const PATHWAY_FORBIDDEN: [string, RegExp][] = [
  ["Awanui", /awanui/i], ["0508", /0508/], ["0800", /0800/], ["eReferral", /\be-?referral/i],
  ["POAC", /\bPOAC/], ["DHB", /\bDHB/], ["Te Whatu Ora", /te\s+whatu\s+ora/i],
  // Funding criteria are logistics; a bare "funded" or "fully funded" (a one-word status) is allowed.
  ["Special Authority", /special authority/i], ["funding criteria", /funding criteria/i],
  ["eligibility for funding", /eligib\w+ for (?:public )?funding/i], ["funded only/if/when", /funded (?:only|if|when|for|provided)/i],
  ["subsidised only/if/when", /subsidi[sz]ed (?:only|if|when)/i], ["PHARMAC", /\bPHARMAC\b/],
];
const PHONE = /\b0[3-9]\d{2}[- ]?\d{3}[- ]?\d{3,4}\b|\b0[3-9][- ]?\d{3}[- ]?\d{4}\b/;
const stripUrls = (l: string) => l.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, " ");

// ---------- git helpers ----------

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
}
function gitShow(root: string, base: string, rel: string): string | null {
  try { return git(root, ["show", `${base}:${rel}`]); } catch { return null; }
}
const readOpt = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// ---------- the checks ----------

export interface Options {
  root: string; batch: string; handles: string[]; reportsDir: string; base: string; outRel?: string;
  /** Allowed raw roots (default: the knowledge-map-raw roots of tools/codex-review-includes.json). */
  rawRoots?: string[];
  exclusionsPath?: string; exceptions?: Exception[]; noExclusions?: boolean;
  checkIds?: boolean; headStatus?: (url: string) => number; delayMs?: number;
}
export interface Row {
  handle: string; type: string; file: string; rawRel: string; rawSha: string; bodySha: string; tokensNew: number; quoted: number;
  deleted: number; hedgeBefore: number; hedgeAfter: number; productsBefore: number; productsAfter: number;
}

const DIR_FOR: Record<string, string> = { pathway: "pathway", guideline: "guideline", reference: "blog", video: "blog" };
const clip = (l: string, n = 120) => { const t = l.trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

class Check {
  fails: string[] = []; warns: string[] = []; infos: string[] = [];
  constructor(readonly id: string, readonly title: string) {}
  /** An exception matches only the FAIL's full text after "<handle>: " (or that text's sha256). */
  result(exceptions: Exception[] = [], used: Set<Exception> = new Set()): Result {
    const excepted: Exception[] = [], notes: string[] = [];
    const fails = this.fails.filter((f) => {
      const ex = exceptions.find((x) => {
        if (x.check !== this.id || !f.startsWith(`${x.handle}: `)) return false;
        const rest = f.slice(x.handle.length + 2);
        return rest === x.match || sha256(rest) === x.match;
      });
      if (!ex) return true;
      used.add(ex); excepted.push(ex); notes.push(`EXCEPTION (${ex.by}, ${ex.date}): ${ex.reason}: ${f}`);
      return false;
    });
    const status: Status = fails.length ? "FAIL" : this.warns.length || notes.length ? "WARN" : "PASS";
    return { id: this.id, title: this.title, status, excepted,
      evidence: [...fails.map((s) => `FAIL ${s}`), ...this.warns.map((s) => `WARN ${s}`), ...notes, ...this.infos] };
  }
}

interface Ctx {
  handle: string; rep: Report | null; rel: string; newText: string | null; baseText: string | null;
  newBody: string; baseBody: string; type: string | null;
}

const fmType = (text: string | null) => (text && /^type:\s*"?([A-Za-z]+)"?\s*$/m.exec(splitFrontmatter(text).front)?.[1]) || "video";

function loadCtx(o: Options, base: string, handle: string, ac2: Check, index: Map<string, { type?: string }>): Ctx {
  const rp = join(o.reportsDir, `${handle}.json`);
  let rep: Report | null = null;
  if (!existsSync(rp)) ac2.fails.push(`${handle}: diff report missing at ${rp}`);
  else {
    try {
      const parsed = JSON.parse(readFileSync(rp, "utf8"));
      const errs = validateReport(parsed);
      if (errs.length) ac2.fails.push(`${handle}: report invalid: ${errs.join("; ")}`);
      else if (parsed.handle !== handle) ac2.fails.push(`${handle}: report handle is "${parsed.handle}"`);
      else rep = parsed as Report;
    } catch (e) { ac2.fails.push(`${handle}: report is not JSON: ${(e as Error).message}`); }
  }
  // The type comes from the index, never from the report; a handle absent from the index must say "new".
  const entry = index.get(handle);
  let type: string | null = entry ? entry.type ?? "video" : null;
  const dirs = type ? [DIR_FOR[type]] : ["pathway", "blog", "guideline"];
  let rel = `docs/${dirs[0]}/${handle}.md`;
  for (const d of dirs) {
    const cand = `docs/${d}/${handle}.md`;
    if (existsSync(join(o.root, cand)) || gitShow(o.root, base, cand) !== null) { rel = cand; break; }
  }
  const newText = readOpt(join(o.root, rel));
  const baseText = gitShow(o.root, base, rel);
  if (newText === null) ac2.fails.push(`${handle}: body file missing (${rel})`);
  let source = "index";
  if (!entry) {
    if (rep?.new === true && newText !== null) { type = fmType(newText); source = "frontmatter"; }
    else ac2.fails.push(`${handle}: not in docs/blog/index.json; declare "new": true in the report`);
  }
  if (rep && type && rep.type !== type) ac2.fails.push(`${handle}: report type "${rep.type}" does not match ${source} type "${type}"`);
  return { handle, rep, rel, newText, baseText, type,
    newBody: splitFrontmatter(newText ?? "").body, baseBody: splitFrontmatter(baseText ?? "").body };
}

function checkAc1(o: Options, base: string, ctxs: Ctx[], ac1: Check) {
  const batch = new Set(o.handles);
  const corrections = new Map(ctxs.filter((c) => c.rep?.proposed_summary_correction != null).map((c) => [c.handle, c.rep!.proposed_summary_correction!]));
  const idxRel = "docs/blog/index.json";
  const idxBase = gitShow(o.root, base, idxRel), idxNew = readOpt(join(o.root, idxRel));
  if (idxBase === idxNew) ac1.infos.push(`${idxRel} byte-identical to ${base}`);
  else {
    try {
      const key = (t: string | null) => new Map((JSON.parse(t ?? "[]") as Record<string, unknown>[]).map((e) => [e.handle as string, e]));
      const a = key(idxBase), b = key(idxNew);
      for (const h of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(h), y = b.get(h);
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        const ok = batch.has(h) && corrections.has(h) && x && y &&
          Object.keys({ ...x, ...y }).every((k) => k === "summary" || JSON.stringify(x[k]) === JSON.stringify(y[k]));
        if (ok && squash(String(y.summary ?? "")) !== squash(corrections.get(h)!)) ac1.fails.push(`${idxRel}: index.json summary for "${h}" differs from proposed_summary_correction`);
        else if (ok) ac1.infos.push(`allowed summary correction: ${h}`);
        else ac1.fails.push(`${idxRel}: ${!x ? "entry added" : !y ? "entry removed" : "entry changed"} for "${h}"${batch.has(h) ? " (no proposed_summary_correction, or fields beyond summary changed)" : " (not in batch)"}`);
      }
      if (!ac1.fails.length && !ac1.infos.length) ac1.warns.push(`${idxRel} bytes differ but every entry is equal (formatting only)`);
    } catch (e) { ac1.fails.push(`${idxRel}: cannot parse: ${(e as Error).message}`); }
  }
  const catRel = "docs/blog/categories.json";
  const catBase = gitShow(o.root, base, catRel), catNew = readOpt(join(o.root, catRel));
  if (catBase !== null || catNew !== null) {
    if (catBase !== catNew) ac1.fails.push(`${catRel} differs from ${base}`);
    else ac1.infos.push(`${catRel} byte-identical`);
  }
  for (const c of ctxs) {
    if (c.baseText === null || c.newText === null) continue;
    const bf = splitFrontmatter(c.baseText).front, nf = splitFrontmatter(c.newText).front;
    const noSummary = (f: string) => f.split(/\r?\n/).filter((l) => !/^summary:/.test(l)).join("\n");
    if (corrections.has(c.handle)) {
      if (noSummary(bf) !== noSummary(nf)) ac1.fails.push(`${c.rel}: frontmatter differs beyond the summary line`);
      const summaryOf = (f: string) => {
        const v = /^summary:\s*(.*)$/m.exec(f)?.[1]?.trim() ?? "";
        try { return v.startsWith('"') ? (JSON.parse(v) as string) : v.replace(/^'|'$/g, ""); } catch { return v; }
      };
      // A frozen summary is fine: the orchestrator applies the correction later. A changed one must be the correction.
      if (squash(summaryOf(nf)) !== squash(summaryOf(bf)) && squash(summaryOf(nf)) !== squash(c.rep!.proposed_summary_correction!)) ac1.fails.push(`${c.rel}: summary line differs from proposed_summary_correction`);
    } else if (bf !== nf) ac1.fails.push(`${c.rel}: frontmatter changed and no proposed_summary_correction`);
  }
}

function rootRegexes(roots: string[]): RegExp[] {
  return roots.map((r) => {
    const p = r.startsWith("~/") ? join(homedir(), r.slice(2)) : r;
    const segs = p.replace(/\/+$/, "").split("/");
    const star = segs.findIndex((x) => x.includes("*"));
    const prefix = segs.slice(0, star < 0 ? segs.length : star).join("/") || "/";
    let real = prefix;
    try { real = realpathSync(prefix); } catch { /* a missing root matches nothing real */ }
    const full = [real === "/" ? "" : real, ...(star < 0 ? [] : segs.slice(star))].join("/");
    return new RegExp(`^${full.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}/`);
  });
}

function defaultRawRoots(): string[] {
  const j = JSON.parse(readFileSync(new URL("./codex-review-includes.json", import.meta.url), "utf8")) as { roots: string[] };
  return j.roots.filter((r) => r.includes("knowledge-map-raw"));
}

interface RawSet {
  main: { norm: string; rel: string; pmid: string | null } | null; extras: { path: string; norm: string; pmid: string | null }[];
  /** Files under a pubmed/ folder headed "# PubMed <pmid>": the only raw that verifies a primary reference. */
  abstracts: { pmid: string; norm: string }[];
}

/** Open a report's raw files: each must resolve (realpath) under an allowed raw root, never inside the repo, with the sha256 the report gives. */
function loadRaw(rep: Report, o: Options, tag: string, ac2: Check): RawSet {
  const roots = rootRegexes(o.rawRoots ?? defaultRawRoots());
  const repoReal = realpathSync(o.root);
  const open = (path: string, sha: string, label: string) => {
    if (!existsSync(path)) { ac2.fails.push(`${tag} ${label} file not found: ${path}`); return null; }
    const real = realpathSync(path);
    if (real === repoReal || real.startsWith(`${repoReal}/`)) { ac2.fails.push(`${tag} ${label} is inside the repo: ${path}`); return null; }
    const hit = roots.map((r) => r.exec(real)).find((m) => m);
    if (!hit) { ac2.fails.push(`${tag} ${label} is outside the allowed raw roots: ${path}`); return null; }
    const buf = readFileSync(real);
    if (sha256(buf) !== sha) { ac2.fails.push(`${tag} ${label} sha256 mismatch for ${path} (file ${sha256(buf)}, report ${sha})`); return null; }
    const text = buf.toString("utf8");
    const pmid = /\/pubmed\//.test(real) ? /^\s*#\s*PubMed\s+(\d+)/i.exec(text)?.[1] ?? null : null;
    return { norm: normQuote(text), rel: real.slice(hit[0].replace(/[^/]+\/$/, "").length), pmid };
  };
  const main = open(rep.raw_path, rep.raw_sha256, "raw");
  const extras: { path: string; norm: string; pmid: string | null }[] = [];
  const abstracts: { pmid: string; norm: string }[] = [];
  if (main?.pmid) abstracts.push({ pmid: main.pmid, norm: main.norm });
  for (const x of rep.extra_raw ?? []) {
    const e = open(x.path, x.sha256, "extra_raw");
    if (!e) continue;
    extras.push({ path: x.path, norm: e.norm, pmid: e.pmid });
    if (e.pmid) abstracts.push({ pmid: e.pmid, norm: e.norm });
  }
  return { main, extras, abstracts };
}

/** Find `q` in `hay`, then re-tokenise the whole words around each hit: the token must be a whole token there ("7 mmol/L" is not "1.7 mmol/L"). */
function findWhole(hay: string, q: string, tok: string): "ok" | "partial" | "absent" {
  let found = false;
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
    found = true;
    let a = i, b = i + q.length;
    while (a > 0 && !/\s/.test(hay[a - 1])) a--;
    while (b < hay.length && !/\s/.test(hay[b])) b++;
    if (tokenise(hay.slice(a, b), { keepRefs: true }).has(tok)) return "ok";
  }
  return found ? "partial" : "absent";
}

/** PMIDs of the PubMed-record references a body line cites ([n] markers), or null when it cites none. */
function citedPubmedIds(body: string, bodyLine: string): Set<string> | null {
  const byNumber = new Map<number, string>();
  for (const line of refLines(body)) {
    const m = /^\s*(?:[-*]\s*)?(?:\[(\d+)\]|(\d+)[.)])\s/.exec(line);
    if (m) byNumber.set(Number(m[1] ?? m[2]), line);
  }
  const pmids = new Set<string>();
  let any = false;
  for (const m of bodyLine.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\](?!\()/g)) {
    for (const part of m[1].split(",")) {
      const r = part.split(/[–-]/).map((x) => Number(x.trim()));
      for (let n = r[0]; n <= (r[1] ?? r[0]); n++) {
        const line = byNumber.get(n);
        if (!line || !/pubmed\.ncbi\.nlm\.nih\.gov|PMID/i.test(line)) continue;
        any = true;
        for (const x of primaryIds(line)) if (x.kind === "pmid") pmids.add(x.id);
      }
    }
  }
  return any ? pmids : null;
}

/** PMIDs of the PubMed records cited by the sentences of `bodyLine` that hold `tok`, or null when they cite none. */
function citedForEntry(bodyLine: string, tok: string, body: string): Set<string> | null {
  let out: Set<string> | null = null;
  for (const sn of sentences(bodyLine).filter((x) => tokenCounts(x, { keepRefs: true }).has(tok))) {
    const ids = citedPubmedIds(body, sn);
    if (ids) { out = out ?? new Set(); ids.forEach((i) => out!.add(i)); }
  }
  return out;
}

/** Body lines where the checker finds `tok`, for the writer to locate. */
function linesWith(body: string, tok: string): string {
  const hits = body.split(/\r?\n/).filter((l) => tokenCounts(l).has(tok)).slice(0, 3).map((l) => `"${clip(l, 120)}"`);
  return hits.length ? `; found in: ${hits.join(" | ")}` : "";
}

/** Number tokens that grew between each new sentence and its nearest base sentence: a dose swap between sentences shows here even when the whole-body counts are equal. */
type PairSentence = { sentence: string; inPlace: boolean };
type PairInfo = { pairs: Map<string, PairSentence[]>; orphans: { sentence: string; tokens: string[] }[] };
/** The sentence with its numbers masked: two sentences with the same frame differ only in their values. */
const frame = (t: string) => t.toLowerCase().replace(TOKEN_RE(), "#").replace(/\s+/g, " ").trim();
// Bare one- or two-digit integers ("type 2", "1 in 36") are identifiers or counts; AC4 covers their sentences.
const carriesValue = (tok: string) => /^[≥≤><]/.test(tok) || tok.includes(" ") || tok.includes(".") || /^\d{3,}/.test(tok);

function pairTokenChanges(c: Ctx): PairInfo {
  const bs = new Set(sentences(ac4Body(c.baseBody, c.type))), ns = new Set(sentences(ac4Body(c.newBody, c.type)));
  const baseOnly = [...bs].filter((x) => !ns.has(x));
  const pairs = new Map<string, PairSentence[]>();
  const orphans: PairInfo["orphans"] = [];
  for (const n of [...ns].filter((x) => !bs.has(x))) {
    const now = tokenCounts(n, { keepRefs: true });
    const b = nearest(n, baseOnly);
    if (!b) {
      const valued = [...now.keys()].filter(carriesValue);
      if (valued.length) orphans.push({ sentence: n, tokens: valued });
      continue;
    }
    const before = tokenCounts(b, { keepRefs: true });
    const inPlace = frame(b) === frame(n);
    for (const [tok, cnt] of now) {
      if (carriesValue(tok) && cnt > (before.get(tok) ?? 0)) pairs.set(tok, [...(pairs.get(tok) ?? []), { sentence: n, inPlace }]);
    }
  }
  return { pairs, orphans };
}

const relates = (bodyLine: string, sentence: string) => {
  const b = cleanSentence(bodyLine);
  return b.length > 0 && (b.includes(sentence) || sentence.includes(b));
};

/** New Zealand's emergency number is not a clinical value: "111" in sentences that all read "call 111". */
const emergencyOnly = (body: string, tok: string) => {
  const holding = sentences(body).filter((sn) => tokenCounts(sn, { keepRefs: true }).has(tok));
  return tok === "111" && holding.length > 0 && holding.every((sn) => /call 111/i.test(sn));
};

function checkAc2(c: Ctx, added: string[], ac2: Check, raw: RawSet, info: PairInfo): number {
  const rep = c.rep!, tag = `${c.handle}:`;
  const bodyLines = new Set(c.newBody.split(/\r?\n/).map(cleanSentence).filter(Boolean));
  const sources = (prefixed: boolean) => (prefixed ? raw.extras : raw.main ? [{ ...raw.main, path: "" }] : []);
  /** Validate one entry on its own; returns the numbers it supports (body_line and verbatim quote share them), or null after a FAIL. */
  const verifyEntry = (entry: Entry, n: number): Set<string> | null => {
    const label = `${tag} changed_tokens[${n}]`;
    const fail = (msg: string) => { ac2.fails.push(`${label} ${msg}`); return null; };
    const line = clip(entry.body_line, 100);
    if (!bodyLines.has(cleanSentence(entry.body_line))) {
      const hint = [...tokenise(entry.raw_quote, { keepRefs: true })].map((t) => linesWith(c.newBody, t)).find(Boolean) ?? "";
      return fail(`body_line is not a current body line: ${line}${hint}`);
    }
    if (!entry.raw_quote.trim()) return fail(`has an empty raw_quote: ${line}`);
    if (/\.\.\.|\u2026/.test(entry.raw_quote)) return fail("raw_quote contains an ellipsis (a paraphrase marker); quote the raw verbatim");
    const prefixed = /^\s*(?:NIH|EXTRA):\s*/.exec(entry.raw_quote);
    const quote = prefixed ? entry.raw_quote.slice(prefixed[0].length) : entry.raw_quote;
    const q = normQuote(quote);
    if (q.length < 30 && q.split(" ").length < 6) return fail(`raw_quote too short (need 6 words or 30 characters): ${line}`);
    const inQuote = tokenise(quote, { keepRefs: true });
    const shared = [...tokenise(entry.body_line, { keepRefs: true })].filter((t) => inQuote.has(t));
    if (!shared.length) return fail(`entry supports no number in its body_line: ${line}`);
    const hits = new Map<string, { pmid: string | null; path: string }[]>();
    let partial = false;
    for (const x of sources(!!prefixed)) {
      for (const tok of shared) {
        const r = findWhole(x.norm, q, tok);
        if (r === "ok") hits.set(tok, [...(hits.get(tok) ?? []), { pmid: x.pmid, path: "path" in x ? x.path : "" }]); else if (r === "partial") partial = true;
      }
    }
    if (!hits.size) return fail(partial ? `raw_quote: its numbers are not whole tokens in the raw: ${line}` : `raw_quote is not in the raw file: ${line}`);
    // A number whose own sentence cites a PubMed record must be quoted from that record's abstract, not ConsumerLab or NIH text.
    const ok = new Set<string>();
    for (const [tok, ms] of hits) {
      const cited = c.type === "reference" ? citedForEntry(entry.body_line, tok, c.newBody) : null;
      if (!cited || ms.some((m) => m.pmid !== null && cited.has(m.pmid))) ok.add(tok);
    }
    if (!ok.size) return fail(`number cited to a primary study without its abstract in reach: ${line}`);
    const where = [...hits.values()].flat().find((m) => m.path);
    if (where) ac2.infos.push(`${label} matched in extra_raw ${where.path}`);
    return ok;
  };
  const entries = rep.changed_tokens.map((e, i) => ({ e, ok: verifyEntry(e, i) }));
  const valid = entries.filter((x) => x.ok).map((x) => ({ ...x.e, ok: x.ok! }));
  let quoted = 0;
  const needed = new Set<string>(), failed = new Set<string>();
  const pairs = new Map([...info.pairs].filter(([t]) => !emergencyOnly(c.newBody, t)));
  for (const tok of new Set([...added, ...pairs.keys()].filter((t) => !emergencyOnly(c.newBody, t)))) {
    const pl = pairs.get(tok) ?? [];
    // A token new to the body, or changed in place in a paired sentence (same wording, another value), needs an entry.
    // One that only relocated into a restructured sentence (count unchanged, already in the base) is a WARN.
    const isNew = added.includes(tok);
    const sents = (isNew ? pl : pl.filter((x) => x.inPlace)).map((x) => x.sentence);
    const moved = !isNew && sents.length === 0;
    for (const x of pl) if (!sents.includes(x.sentence)) ac2.warns.push(`${tag} number moved between sentences: "${tok}" in: ${clip(x.sentence, 120)}`);
    if (moved) continue;
    const holding = valid.filter((e) => e.ok.has(tok));
    needed.add(tok);
    if (!holding.length) {
      const attempted = rep.changed_tokens.some((e) => tokenise(e.body_line, { keepRefs: true }).has(tok) && tokenise(e.raw_quote, { keepRefs: true }).has(tok));
      failed.add(tok);
      if (!attempted) ac2.fails.push(isNew
        ? `${tag} token "${tok}" is new in the body and no entry has a body line and a source quote that both carry it${linesWith(c.newBody, tok)}`
        : `${tag} token "${tok}" changed between paired sentences and no entry covers it: ${clip(sents[0], 120)}`);
      continue;
    }
    quoted++;
  }
  // Each new or changed body line holding a needed number has entries whose quotes together carry all of that line's needed numbers.
  const baseLines = new Set(c.baseBody.split(/\r?\n/).map(cleanSentence));
  for (const line of bodyLines) {
    if (baseLines.has(line)) continue;
    const want = [...tokenCounts(line, { keepRefs: true }).keys()].filter((t) => needed.has(t) && !failed.has(t));
    const have = new Set(valid.filter((e) => cleanSentence(e.body_line) === line).flatMap((e) => [...e.ok]));
    const lack = want.filter((t) => !have.has(t));
    if (lack.length) ac2.fails.push(`${tag} body line has no entry quoting ${lack.map((t) => `"${t}"`).join(", ")}: ${clip(line, 120)}`);
  }
  // A new sentence with no base match that carries a number needs an entry on that sentence.
  for (const o of info.orphans) {
    const toks = o.tokens.filter((t) => !emergencyOnly(c.newBody, t));
    if (!toks.length || toks.some((tk) => added.includes(tk))) continue; // none, or already reported as a new token
    if (!valid.some((e) => relates(e.body_line, o.sentence) && toks.some((t) => e.ok.has(t)))) ac2.fails.push(`${tag} new numeric sentence has no entry: ${clip(o.sentence, 120)}`);
  }
  ac2.infos.push(`${tag} ${added.length} new tokens, ${quoted} verified against raw`);
  return quoted;
}

const wordSet = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
/** The candidate sharing the most words with `sent` (Jaccard), or null when none shares a word. */
function nearest(sent: string, cands: string[]): string | null {
  const a = wordSet(sent);
  let best: string | null = null, score = 0;
  for (const c of cands) {
    const b = wordSet(c);
    const inter = [...a].filter((w) => b.has(w)).length;
    const j = inter / (a.size + b.size - inter || 1);
    if (inter > 0 && j > score) { best = c; score = j; }
  }
  return best;
}

function checkAc3(c: Ctx, hedgeBefore: number, hedgeAfter: number, ac3: Check) {
  const tag = `${c.handle}:`;
  const bs = sentences(c.baseBody), ns = sentences(c.newBody);
  const bset = new Set(bs), nset = new Set(ns);
  const baseOnly = [...bset].filter((x) => !nset.has(x)), newOnly = [...nset].filter((x) => !bset.has(x));
  const entries = c.rep?.deleted_sentences ?? [];
  const declared = (b: string) => entries.some((d) => {
    if (!d.pattern) return cleanSentence(d.sentence) === b;
    try { return new RegExp(d.sentence, "i").test(b); } catch { return false; }
  });
  // The hedge count may fall only by the hedges inside sentences the report lists as deleted, with a justification.
  if (hedgeAfter < hedgeBefore) {
    const excused = baseOnly.filter(declared).reduce((n, b) => n + totalIn(b, HEDGES), 0);
    if (hedgeAfter < hedgeBefore - excused) ac3.fails.push(`${tag} hedge tokens fell ${hedgeBefore} -> ${hedgeAfter}`);
    else ac3.warns.push(`${tag} hedge tokens fell ${hedgeBefore} -> ${hedgeAfter}, all inside declared deleted sentences`);
  }
  const hedgeWords = new Set(HEDGES.flatMap((h) => h.split(" ")));
  const wordsOf = (t: string) => new Set(t.toLowerCase().match(/[a-z]+/g) ?? []);
  for (const b of baseOnly) {
    const n = nearest(b, newOnly);
    // The sentence lives on (not declared deleted, its other words still there): losing a hedge from it is a FAIL.
    const survives = !!n && !declared(b) && [...wordsOf(b)].filter((w) => !hedgeWords.has(w)).every((w) => wordsOf(n).has(w));
    for (const p of HEDGES) {
      if (countIn(b, p) <= (n ? countIn(n, p) : 0)) continue;
      if (survives) ac3.fails.push(`${tag} hedge lost from a surviving sentence "${p}" base: ${clip(b, 160)} -> new: ${clip(n!, 160)}`);
      else ac3.warns.push(`${tag} lost hedge "${p}" base: ${clip(b, 160)} -> new: ${n ? clip(n, 160) : "(no matching sentence)"}`);
    }
  }
  for (const n of newOnly) {
    const b = nearest(n, baseOnly);
    for (const p of HARDENERS) if (countIn(n, p) > (b ? countIn(b, p) : 0))
      ac3.warns.push(`${tag} gained hardening "${p}" new: ${clip(n, 160)} <- base: ${b ? clip(b, 160) : "(no matching sentence)"}`);
  }
}

/** Body text for AC4: for references and videos the reference list (a "## References" section and "[n] ..." lines) belongs to AC7. A whole-line hyperlink in the body is a sentence. */
function ac4Body(body: string, type: string | null): string {
  if (type === "pathway" || type === "guideline") return body;
  return classifyLines(body).filter(({ ref }) => !ref).map((x) => x.line).join("\n");
}

function checkAc4(c: Ctx, ac4: Check): number {
  const tag = `${c.handle}:`;
  const nowS = new Set(sentences(ac4Body(c.newBody, c.type)));
  const entries = c.rep?.deleted_sentences ?? [];
  const declared = new Map(entries.filter((d) => !d.pattern).map((d) => [cleanSentence(d.sentence), d.justification]));
  const patterns: { re: RegExp; justification: string }[] = [];
  for (const d of entries.filter((x) => x.pattern)) {
    try { patterns.push({ re: new RegExp(d.sentence, "i"), justification: d.justification }); }
    catch { ac4.fails.push(`${tag} deleted_sentences pattern is not a valid regex: ${clip(d.sentence, 80)}`); }
  }
  const allNow = new Set(sentences(c.newBody));
  for (const d of entries) {
    if (!d.pattern && allNow.has(cleanSentence(d.sentence))) ac4.fails.push(`${tag} claimed deletion still in body: ${clip(cleanSentence(d.sentence))}`);
  }
  let deleted = 0, byPattern = 0;
  for (const s of new Set(sentences(ac4Body(c.baseBody, c.type)))) {
    if (nowS.has(s)) continue;
    deleted++;
    const p = patterns.find((x) => x.re.test(s));
    if (p) {
      if (!p.justification.trim()) ac4.fails.push(`${tag} deleted sentence pattern has an empty justification: ${clip(s, 80)}`);
      else byPattern++;
      continue;
    }
    const j = declared.get(s);
    if (j === undefined) ac4.fails.push(`${tag} sentence removed and not in deleted_sentences: ${clip(s)}`);
    else if (!j.trim()) ac4.fails.push(`${tag} deleted sentence has an empty justification: ${clip(s, 80)}`);
  }
  const baseSet = new Set(sentences(ac4Body(c.baseBody, c.type)));
  const newOnly = [...nowS].filter((x) => !baseSet.has(x));
  const cite = /\[\d+(?:\s*[,–-]\s*\d+)*\]/;
  for (const b of baseSet) {
    if (nowS.has(b) || !cite.test(b)) continue;
    const nums = tokenCounts(b, { keepRefs: true });
    const n = nearest(b, newOnly);
    if (n && !cite.test(n) && nums.size && [...nums.keys()].some((k) => tokenCounts(n, { keepRefs: true }).has(k)))
      ac4.warns.push(`${tag} claim lost its citation base: ${clip(b, 160)} -> new: ${clip(n, 160)}`);
  }
  const nowH = new Set(headings(c.newBody));
  for (const h of headings(c.baseBody)) if (!nowH.has(h)) ac4.fails.push(`${tag} heading missing from new body: ${h}`);
  ac4.infos.push(`${tag} ${deleted} sentences removed (${byPattern} justified by pattern), ${headings(c.baseBody).length} base headings`);
  return deleted;
}

function referenceCheck(body: string, tag: string, ac7: Check) {
  const cl = classifyLines(body);
  const defs = new Set<number>(), cited = new Set<number>();
  for (const { line, ref } of cl) {
    const m = line.match(REF_LINE) ?? (ref ? line.match(/^\s*(?:[-*]\s*)?(\d+)[.)]\s+\S/) : null);
    if (m) defs.add(Number(m[1]));
  }
  for (const { line, ref } of cl) {
    if (ref) continue;
    for (const m of line.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\](?!\()/g)) {
      for (const part of m[1].split(",")) {
        const r = part.split(/[–-]/).map((x) => Number(x.trim()));
        for (let n = r[0]; n <= (r[1] ?? r[0]); n++) cited.add(n);
      }
    }
  }
  const missing = [...cited].filter((n) => !defs.has(n)), uncited = [...defs].filter((n) => !cited.has(n));
  if (missing.length) ac7.fails.push(`${tag} citations with no reference line: ${missing.join(", ")}`);
  if (uncited.length) ac7.fails.push(`${tag} reference lines never cited: ${uncited.join(", ")}`);
  ac7.infos.push(`${tag} ${defs.size} references, ${cited.size} cited`);
}

const ALLOWED_HOSTS = ["consumerlab.com", "ods.od.nih.gov", "pubmed.ncbi.nlm.nih.gov", "doi.org"];
const URL_RE = /https?:\/\/[^\s)\]>]+/g;
const hostOf = (u: string) => { try { return new URL(u.replace(/[.,;]+$/, "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

function refLines(body: string): string[] {
  return classifyLines(body).filter(({ line, ref }) => ref && (REF_LINE.test(line) || /^\s*(?:[-*]\s*)?\d+[.)]\s+\S/.test(line))).map((x) => x.line);
}

function referenceSourceCheck(newBody: string, baseBody: string, tag: string, ac7: Check) {
  const known = new Set(refLines(baseBody).flatMap((l) => (l.match(URL_RE) ?? []).map(hostOf)));
  for (const line of refLines(newBody)) {
    const urls = line.match(URL_RE) ?? [];
    const title = line.replace(/\[([^\]]*)\]\([^)]*\)/g, (_, t: string) => (/^https?:/i.test(t) ? "" : t)).replace(URL_RE, "").replace(/^\s*(?:[-*]\s*)?(?:\[\d+\]|\d+[.)])/, "");
    if (urls.length && !/[A-Za-z]{2}/.test(title)) ac7.fails.push(`${tag} reference line is a bare URL without a title: ${clip(line, 100)}`);
    for (const u of urls) {
      const h = hostOf(u);
      if (!h) { ac7.fails.push(`${tag} reference line has an unparseable URL ${clip(u, 60)}: ${clip(line, 100)}`); continue; }
      if (ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`)) || known.has(h)) continue;
      ac7.fails.push(`${tag} reference line has unknown host ${h}: ${clip(line, 100)}`);
    }
  }
}

/** A renumbering script can change the visible id and leave the URL right: link text and printed ids must match their URLs. */
function linkTextCheck(body: string, tag: string, ac7: Check) {
  const trim = (d: string) => d.replace(/[.,;:]+$/, "").toLowerCase();
  for (const line of refLines(body)) {
    const pmidUrls = [...line.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/gi)].map((m) => m[1]);
    for (const m of line.matchAll(/\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g)) {
      const [, text, url] = m;
      const pm = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/i.exec(url);
      if (pm) for (const t of text.match(/\b\d{5,9}\b/g) ?? []) if (t !== pm[1]) ac7.fails.push(`${tag} reference line: PMID link text ${t} differs from its URL id ${pm[1]}: ${clip(line, 100)}`);
      const dm = /doi\.org\/(10\.\d{4,9}\/.+)$/i.exec(url);
      const dt = /\b(10\.\d{4,9}\/[^\s\]]+)/.exec(text);
      if (dm && dt && trim(dt[1]) !== trim(dm[1])) ac7.fails.push(`${tag} reference line: DOI link text ${trim(dt[1])} differs from its URL DOI ${trim(dm[1])}: ${clip(line, 100)}`);
    }
    if (pmidUrls.length) for (const m of line.matchAll(/PMID:?\s*(\d{5,9})/gi)) {
      if (!pmidUrls.includes(m[1])) ac7.fails.push(`${tag} reference line: PMID ${m[1]} differs from the pubmed URL id ${pmidUrls.join(", ")}: ${clip(line, 100)}`);
    }
  }
}

const PRODUCT_HEADING = /product|microvitamin|sleep by dr brad/i;
function sectionsMatching(body: string): Map<string, string> {
  const lines = body.split(/(?<=\n)/), out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (!m || !PRODUCT_HEADING.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !(/^#{1,6}\s/.test(lines[j]) && lines[j].match(/^(#+)/)![1].length <= m[1].length)) j++;
    out.set(lines[i].trim(), lines.slice(i, j).join(""));
  }
  return out;
}

function productSectionCheck(newBody: string, baseBody: string, tag: string, ac7: Check) {
  const a = sectionsMatching(baseBody), b = sectionsMatching(newBody);
  for (const [h, text] of a) {
    if (!b.has(h)) ac7.fails.push(`${tag} product section missing: ${h}`);
    else if (b.get(h) !== text) ac7.fails.push(`${tag} product section changed: ${h}`);
  }
  for (const h of b.keys()) if (!a.has(h)) ac7.fails.push(`${tag} product section added: ${h}`);
}

interface PrimaryId { kind: "pmid" | "doi"; id: string }
function primaryIds(line: string): PrimaryId[] {
  const out = new Map<string, PrimaryId>();
  for (const m of line.matchAll(/PMID:?\s*(\d{5,9})|pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/gi)) out.set(`pmid:${m[1] ?? m[2]}`, { kind: "pmid", id: (m[1] ?? m[2]) });
  for (const m of line.matchAll(/\b(10\.\d{4,9}\/(?:[^\s()\]>,;"]|\([^\s()]*\))+)/g)) {
    const id = m[1].replace(/[.,;:]+$/, "");
    out.set(`doi:${id.toLowerCase()}`, { kind: "doi", id });
  }
  return [...out.values()];
}

function checkAc7(c: Ctx, ac7: Check, pw: Check, abstracts: RawSet["abstracts"], idsOut: Map<string, PrimaryId & { handle: string }>) {
  const tag = `${c.handle}:`, rep = c.rep;
  const lines = normChars(c.newBody).split(/\r?\n/);
  for (const l of lines) {
    if (/grokipedia/i.test(l)) ac7.fails.push(`${tag} "grokipedia" in body: ${clip(l, 100)}`);
    for (const b of BANNED) if (l.toLowerCase().includes(b.toLowerCase())) ac7.fails.push(`${tag} banned phrase "${b}": ${clip(l, 100)}`);
    if (BRAND_RANKING.test(l)) ac7.fails.push(`${tag} brand ranking phrase: ${clip(l, 100)}`);
  }
  const pb = productMentions(c.baseBody), pa = productMentions(c.newBody);
  if (pa > pb) ac7.fails.push(`${tag} product mentions rose ${pb} -> ${pa}`);
  if (rep && (rep.product_mentions_before !== pb || rep.product_mentions_after !== pa)) {
    // No rise is the invariant; a report that counted differently but saw no change either way is a note.
    const flat = pb === pa && rep.product_mentions_before === rep.product_mentions_after;
    (flat ? ac7.warns : ac7.fails).push(`${tag} ${flat ? "count differs from report: " : ""}report says product mentions ${rep.product_mentions_before} -> ${rep.product_mentions_after}, recomputed ${pb} -> ${pa}`);
  }
  if (c.type === "reference") {
    referenceCheck(c.newBody, tag, ac7);
    referenceSourceCheck(c.newBody, c.baseBody, tag, ac7);
    linkTextCheck(c.newBody, tag, ac7);
    productSectionCheck(c.newBody, c.baseBody, tag, ac7);
    // "New" ignores the leading number, so a renumbered reference is not new.
    const unnumbered = (l: string) => l.replace(/^\s*(?:[-*]\s*)?(?:\[\d+\]|\d+[.)])\s*/, "").trim();
    const baseLines = new Set(refLines(c.baseBody).map(unnumbered));
    for (const line of refLines(c.newBody).filter((l) => !baseLines.has(unnumbered(l)))) {
      const ids = primaryIds(line);
      for (const x of ids) idsOut.set(`${x.kind}:${x.id.toLowerCase()}`, { ...x, handle: c.handle });
      const verified = (x: PrimaryId) => (x.kind === "pmid" ? abstracts.some((a) => a.pmid === x.id) : abstracts.some((a) => a.norm.includes(x.id.toLowerCase())));
      if (/pubmed\.ncbi\.nlm\.nih\.gov|PMID/i.test(line)) {
        // A new PubMed record must arrive with its abstract file: extra_raw, on disk, sha-checked, headed "# PubMed <pmid>".
        const pm = ids.filter((x) => x.kind === "pmid");
        if (!pm.length || pm.some((x) => !verified(x))) ac7.fails.push(`${tag} new PubMed reference has no abstract file in extra_raw: ${clip(line, 120)}`);
      } else if (ids.some((x) => !verified(x))) ac7.warns.push(`${tag} unverified primary: ${clip(line, 140)}`);
    }
  }
  if (c.type === "pathway") {
    const nb = normChars(c.newBody);
    if (!/^\*Source: Auckland Region HealthPathways/m.test(nb)) pw.fails.push(`${tag} missing "*Source: Auckland Region HealthPathways" line`);
    else if (!/^\*Source: Auckland Region HealthPathways[^\n]*Last reviewed:\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/im.test(nb))
      pw.fails.push(`${tag} source line lacks "Last reviewed: <month> <year>"`);
    if (!lines.some((l) => /^>/.test(l) && /doctor|healthcare provider|general practitioner|\bGP\b/i.test(l)))
      pw.fails.push(`${tag} missing doctor-deferral blockquote`);
    for (const l of lines) {
      for (const [name, re] of PATHWAY_FORBIDDEN) if (re.test(l)) pw.fails.push(`${tag} forbidden term "${name}": ${clip(l, 100)}`);
      if (PHONE.test(stripUrls(l))) pw.fails.push(`${tag} forbidden phone number: ${clip(l, 100)}`);
    }
  }
}

function curlHead(url: string): number {
  try {
    return parseInt(execFileSync("curl", ["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), 10) || 0;
  } catch { return 0; }
}
const sleepMs = (ms: number) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const ID_CAP = 60;

function verifyIds(ids: Map<string, PrimaryId & { handle: string }>, o: Options, ac7: Check) {
  const head = o.headStatus ?? curlHead;
  const list = [...ids.values()];
  list.slice(0, ID_CAP).forEach((x, i) => {
    if (i) sleepMs(o.delayMs ?? 1000);
    const url = x.kind === "doi" ? `https://doi.org/${x.id}` : `https://pubmed.ncbi.nlm.nih.gov/${x.id}/`;
    const st = head(url);
    if (st === 404) ac7.fails.push(`${x.handle}: ${x.kind} ${x.id} returned 404`);
    else if (st === 0 || st >= 400) ac7.warns.push(`${x.handle}: ${x.kind} ${x.id} returned ${st || "no response"} (not verified)`);
  });
  if (list.length > ID_CAP) ac7.warns.push(`${list.length - ID_CAP} identifiers not checked (cap ${ID_CAP})`);
}

const EXCLUSIONS_PATH = "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/tools/healthpathways-exclusions.json";

export function runBatch(o: Options): { results: Result[]; rows: Row[]; baseSha: string } {
  const base = o.base;
  const baseSha = git(o.root, ["rev-parse", base]).trim();
  const ac1 = new Check("AC1", "index.json and categories.json unchanged (except approved summary corrections)");
  const ac2 = new Check("AC2", "raw fidelity of every new number token");
  const ac3 = new Check("AC3", "hedging held; hardening words listed");
  const ac4 = new Check("AC4", "deleted sentences justified; headings kept");
  const ac6 = new Check("AC6", "diff touches only batch files");
  const ac7 = new Check("AC7", "grokipedia, products, references, banned phrases, exclusions");
  const pw = new Check("PATHWAY", "source line, deferral blockquote, no NZ logistics");
  const rows: Row[] = [];
  let index = new Map<string, { type?: string }>();
  try {
    index = new Map((JSON.parse(readOpt(join(o.root, "docs/blog/index.json")) ?? "[]") as { handle: string; type?: string }[]).map((e) => [e.handle, e]));
  } catch { /* AC1 reports an unparseable index */ }
  const ctxs = o.handles.map((h) => loadCtx(o, base, h, ac2, index));
  const ids = new Map<string, PrimaryId & { handle: string }>();

  checkAc1(o, base, ctxs, ac1);
  for (const c of ctxs) {
    const newTokens = tokenCounts(c.newBody), baseTokens = tokenCounts(c.baseBody);
    const added = [...newTokens].filter(([t, n]) => n > (baseTokens.get(t) ?? 0)).map(([t]) => t);
    const hedgeBefore = totalIn(c.baseBody, HEDGES), hedgeAfter = totalIn(c.newBody, HEDGES);
    let quoted = 0, deleted = 0;
    const raw = c.rep ? loadRaw(c.rep, o, `${c.handle}:`, ac2) : null;
    if (c.newText !== null) {
      if (c.rep && raw) quoted = checkAc2(c, added, ac2, raw, c.baseText !== null ? pairTokenChanges(c) : { pairs: new Map(), orphans: [] });
      checkAc3(c, hedgeBefore, hedgeAfter, ac3);
      if (c.baseText !== null) deleted = checkAc4(c, ac4);
      checkAc7(c, ac7, pw, raw ? raw.abstracts : [], ids);
    }
    rows.push({ handle: c.handle, type: c.type ?? "?", file: c.rel, rawRel: raw?.main?.rel ?? "-", rawSha: c.rep?.raw_sha256 ?? "-",
      bodySha: sha256(c.newBody), tokensNew: added.length, quoted, deleted, hedgeBefore, hedgeAfter,
      productsBefore: productMentions(c.baseBody), productsAfter: productMentions(c.newBody) });
  }

  if (o.checkIds) verifyIds(ids, o, ac7);

  // Exclusions (claude_business list; slugs are handles).
  let excluded = new Set<string>();
  const exPath = o.exclusionsPath ?? EXCLUSIONS_PATH;
  if (o.noExclusions) ac7.infos.push("exclusions check skipped (--no-exclusions)");
  else if (existsSync(exPath)) {
    const ex = JSON.parse(readFileSync(exPath, "utf8")) as { excluded?: string[]; excludedReasons?: Record<string, { slug?: string }> };
    excluded = new Set([...(ex.excluded ?? []), ...Object.values(ex.excludedReasons ?? {}).map((r) => r.slug).filter((s): s is string => !!s)]);
  } else ac7.fails.push(`exclusions file not found (${exPath}); pass --no-exclusions to skip the excluded-handle check`);
  for (const h of o.handles) if (excluded.has(h)) ac7.fails.push(`${h}: handle is on the HealthPathways exclusion list`);

  // AC6 (only the directory of each entry's type), nothing-to-check, and new files against the exclusion list.
  const changed = new Set([
    ...git(o.root, ["diff", "--name-only", "--no-renames", base]).split("\n"),
    ...git(o.root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean));
  const allowed = new Set<string>(o.outRel ? [o.outRel] : []);
  if (!ac1.fails.length) { allowed.add("docs/blog/index.json"); allowed.add("docs/blog/categories.json"); } // AC1 accepted them
  for (const c of ctxs) {
    const mine = (c.type ? [DIR_FOR[c.type]] : ["pathway", "blog", "guideline"]).map((d) => `docs/${d}/${c.handle}.md`);
    mine.forEach((f) => allowed.add(f));
    if (!mine.some((f) => changed.has(f))) ac6.fails.push(`nothing to check for ${c.handle}: the diff against ${base} touches none of its files`);
  }
  for (const f of changed) {
    if (!allowed.has(f)) ac6.fails.push(`unexpected change: ${f}`);
    const m = f.match(/^docs\/(?:pathway|blog|guideline)\/(.+)\.md$/);
    if (m && excluded.has(m[1]) && gitShow(o.root, base, f) === null) ac7.fails.push(`${m[1]}: excluded handle gained a file (${f})`);
  }
  ac6.infos.push(`${changed.size} changed paths versus ${base}`);
  ac6.infos.push("Shopify updated_at snapshot: separate tool, NOT checked here");

  const used = new Set<Exception>();
  const results = [ac1, ac2, ac3, ac4, ac6, ac7, pw].map((c) => c.result(o.exceptions, used));
  for (const x of o.exceptions ?? []) {
    if (used.has(x)) continue;
    const r = results.find((y) => y.id === x.check) ?? results[results.length - 1];
    r.evidence.unshift(`FAIL unused exception (${x.check}, ${x.handle}): ${clip(x.match, 80)}`);
    r.status = "FAIL";
  }
  return { results, rows, baseSha };
}

const EXCEPTION_CHECKS = ["AC2", "AC4", "AC7", "PATHWAY"];
export function validateExceptions(x: unknown): string[] {
  if (!Array.isArray(x)) return ["exceptions file must be a JSON array"];
  const e: string[] = [];
  x.forEach((v, i) => {
    const r = (v ?? {}) as Record<string, unknown>;
    if (!EXCEPTION_CHECKS.includes(r.check as string)) e.push(`[${i}].check must be one of ${EXCEPTION_CHECKS.join("|")}`);
    for (const k of ["handle", "match", "reason", "date"]) if (typeof r[k] !== "string" || !(r[k] as string).trim()) e.push(`[${i}].${k} must be a non-empty string`);
    if (r.by !== "orchestrator" && r.by !== "Brad") e.push(`[${i}].by must be "orchestrator" or "Brad"`);
  });
  return e;
}

/** A batch report must not sit under docs/blog or on any file the batch checks. */
export function validateOut(outRel: string, handles: string[]): string | null {
  if (outRel.startsWith("docs/blog/")) return `--out ${outRel} is under docs/blog`;
  const checked = handles.flatMap((h) => ["pathway", "blog", "guideline"].map((d) => `docs/${d}/${h}.md`));
  return checked.includes(outRel) ? `--out ${outRel} is a checked file` : null;
}

/** Markdown batch report: counts and hashes only, under 150 lines. */
export function renderReport(batch: string, base: string, baseSha: string, results: Result[], rows: Row[], checkIds: boolean): string {
  const L: string[] = [`# Knowledge batch report: ${batch}`, "", `Base: ${base} (${baseSha})`, `Handles: ${rows.length}`, "",
    "Counts and hashes only. Raw text never enters this repo.", "", "## Checks", "", "| Check | Status | FAIL | WARN |", "|---|---|---|---|"];
  for (const r of results) {
    const n = (p: string) => r.evidence.filter((e) => e.startsWith(p)).length;
    L.push(`| ${r.id} ${r.title} | ${r.status} | ${n("FAIL ")} | ${n("WARN ")} |`);
  }
  const cap = 100;
  L.push("", "## Handles", "",
    "| handle | type | raw (relative) | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products |",
    "|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.slice(0, cap)) {
    L.push(`| ${r.handle} | ${r.type} | ${r.rawRel} | ${r.rawSha} | ${r.bodySha.slice(0, 16)} | ${r.tokensNew} | ${r.quoted} | ${r.deleted} | ${r.hedgeBefore}>${r.hedgeAfter} | ${r.productsBefore}>${r.productsAfter} |`);
  }
  if (rows.length > cap) L.push("", `${rows.length - cap} more handles omitted to stay under the line cap.`);
  const ex = results.flatMap((r) => r.excepted ?? []);
  if (ex.length) {
    L.push("", "## Accepted exceptions", "", "| check | handle | by | date | reason | match sha256 |", "|---|---|---|---|---|---|");
    for (const x of ex) L.push(`| ${x.check} | ${x.handle} | ${x.by} | ${x.date} | ${x.reason.replace(/\|/g, "/")} | ${sha256(x.match).slice(0, 16)} |`);
  }
  L.push("", "Body hashes are the first 16 hex characters of sha256; raw hashes are in full.", "", "## Not covered by this script", "",
    "- AC5 answer checks (harness)",
    "- AC6 Shopify updated_at snapshot (separate tool)",
    checkIds ? "- DOI/PMID resolution: checked with --check-ids (cap 60; see the run output)" : "- DOI/PMID resolution: NOT checked (run with --check-ids)",
    "- section placement of edits (R8)",
    "- primary-study abstract presence (only the WARN \"unverified primary\" lines)",
    "", "AC8 sign-off (Brad): PENDING");
  return `${L.join("\n")}\n`;
}

// ---------- CLI ----------

function parseArgs(argv: string[]): Record<string, string | true> {
  const a: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) a[k] = true; else { a[k] = v; i++; }
  }
  return a;
}

/** realpath of the nearest existing ancestor plus the rest, so it compares equal to the repo's real top level. */
function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  while (!existsSync(cur) && dirname(cur) !== cur) { rest.unshift(basename(cur)); cur = dirname(cur); }
  return join(realpathSync(cur), ...rest);
}

/** `overrides` lets tests point the raw roots elsewhere; there is no flag for it. */
export function main(argv: string[], overrides: Partial<Options> = {}): number {
  const a = parseArgs(argv);
  if (a["print-schema"]) { console.log(JSON.stringify(REPORT_SCHEMA, null, 2)); return 0; }
  if (typeof a.example === "string") { console.log(JSON.stringify(exampleReport(a.example), null, 2)); return 0; }
  const usage = (msg: string) => { console.error(`${msg}\nusage: knowledge-batch-check.ts --batch <name> --handles <file> --base <git ref> [--reports <dir>] [--out <file>] [--exceptions <file>] [--no-exclusions] [--check-ids]`); return 2; };
  if (typeof a.batch !== "string" || typeof a.handles !== "string") return usage("--batch and --handles are required");
  if (typeof a.base !== "string") return usage("--base is required (no default)");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const handles = readFileSync(a.handles, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const reportsDir = typeof a.reports === "string" ? resolve(a.reports) : join(homedir(), ".codex-review", "diff-reports", a.batch);
  const out = typeof a.out === "string" ? realPath(resolve(a.out)) : undefined;
  const rel = out ? relative(root, out) : "";
  const outRel = out && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
  if (outRel) { const bad = validateOut(outRel, handles); if (bad) return usage(bad); }
  let exceptions: Exception[] = [];
  if (a.exceptions !== undefined) {
    if (typeof a.exceptions !== "string" || !existsSync(a.exceptions)) return usage(`--exceptions file not found: ${String(a.exceptions)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(a.exceptions, "utf8")); } catch (e) { return usage(`--exceptions is not JSON: ${(e as Error).message}`); }
    const errs = validateExceptions(parsed);
    if (errs.length) return usage(`--exceptions invalid: ${errs.join("; ")}`);
    exceptions = parsed as Exception[];
  }
  const checkIds = a["check-ids"] === true;
  const { results, rows, baseSha } = runBatch({ root, batch: a.batch, handles, reportsDir, base: a.base, outRel, exceptions,
    noExclusions: a["no-exclusions"] === true, checkIds, ...overrides });
  for (const r of results) {
    console.log(`${r.status} ${r.id} ${r.title}`);
    for (const e of r.evidence) console.log(`    ${e}`);
  }
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, renderReport(a.batch, a.base, baseSha, results, rows, checkIds)); }
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
