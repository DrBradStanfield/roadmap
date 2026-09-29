/**
 * Batch acceptance checks for the knowledge refresh (plan 2026-09-29, Phase 0
 * step 5; story US-42 in docs/user-stories.md: AC1-AC4, AC6, AC7, AC9, AC11). No model calls. Raw third-party text is read from
 * the paths named in the diff reports and never written anywhere: the markdown
 * batch report holds counts and hashes only.
 *
 *   npx tsx tools/knowledge-batch-check.ts --batch <name> --handles <file> \
 *     [--reports <dir>] [--base <git ref>] [--out <file>]
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
export interface Report {
  handle: string;
  type: "pathway" | "reference" | "video" | "guideline";
  raw_path: string;
  raw_sha256: string;
  old_raw_path: string | null;
  changed_tokens: { token: string; body_line: string; raw_quote: string }[];
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
        type: "object", additionalProperties: false, required: ["token", "body_line", "raw_quote"],
        properties: { token: { type: "string" }, body_line: { type: "string" }, raw_quote: { type: "string" } },
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
    changed_tokens: [{ token: "200 mg", body_line: "Trials used 200 mg per day [3].", raw_quote: "participants took 200 mg daily" }],
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
  objArr("changed_tokens", ["token", "body_line", "raw_quote"]);
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

/** Raw text uses no-break spaces and Unicode hyphens; writers type plain ones. */
export const normChars = (s: string) => s.replace(/\u00a0/g, " ").replace(/[\u2010\u2011\u2012\u2013]/g, "-");

/** Normal form for substring matching of raw quotes. */
export const normQuote = (s: string) => unescapeMd(normChars(s)).replace(/\s+/g, " ").trim().toLowerCase();

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
// Compound units come first so "2 mg/kg" is not "2 mg".
const UNIT = "mL/min/1\\.73m2|mmol/mol|mmol/L|mg/mmol|mg/dL|mg/kg|mL/min|pmol/L|[µμ]mol/L|umol/L|micromol/L|micromole/L|nanogram/L|ng/L|mmHg|x/day|times daily|percent|%|mcg|[µμ]g|mg|IU|mL|kg|cm|g|hours?|days?|weeks?|months?|years?";
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?|\\.\\d+";
const CMP_PRE = "(?:(≥|≤|>=|<=|>|<|\\bat least|\\bmore than|\\bless than)\\s*)?";
const CMP_POST = "or more|or less";
// Groups: 1 leading comparator, 2 and 3 numbers, 4 trailing comparator, 5 unit, 6 unit suffix (/day, per dose ...), 7 trailing comparator.
const TOKEN_RE = () => new RegExp(
  `${CMP_PRE}(?<![A-Za-z0-9.,]|[A-Za-z]-)(${NUM})(?:\\s*[–-]\\s*(${NUM}))?(?:\\s+(${CMP_POST})\\b)?(?:[\\s-]*(${UNIT})(?![A-Za-z])(?:(?:\\s*/\\s*|\\s+per\\s+)(day|dose|week|kg)(?![A-Za-z]))?)?(?:\\s+(${CMP_POST})\\b)?`, "gi");

const CMP_CANON: Record<string, string> = { ">=": "≥", "≥": "≥", "at least": "≥", "or more": "≥", "<=": "≤", "≤": "≤", "or less": "≤",
  ">": ">", "more than": ">", "<": "<", "less than": "<" };
const canonCmp = (c: string | undefined) => (c ? CMP_CANON[c.toLowerCase()] ?? "" : "");

const COMPOUND_UNITS: Record<string, string> = { "mmol/l": "mmol/L", "mg/dl": "mg/dL", "ml/min": "mL/min", "ng/l": "ng/L", "pmol/l": "pmol/L",
  "µmol/l": "umol/L", "μmol/l": "umol/L", "umol/l": "umol/L", "micromol/l": "umol/L", "micromole/l": "umol/L", "nanogram/l": "ng/L",
  "ml/min/1.73m2": "mL/min/1.73m2", "mmol/mol": "mmol/mol", "mg/mmol": "mg/mmol", "mg/kg": "mg/kg" };

function normUnit(u: string): string {
  const l = u.toLowerCase();
  if (COMPOUND_UNITS[l]) return COMPOUND_UNITS[l];
  if (l === "percent" || l === "%") return "%";
  if (l === "µg" || l === "μg" || l === "mcg") return "mcg";
  if (l === "times daily" || l === "x/day") return "x/day";
  if (l === "iu") return "IU";
  if (l === "ml") return "mL";
  if (l === "mmol/l") return "mmol/L";
  if (l === "mg/dl") return "mg/dL";
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
  for (const { line, ref } of lines) {
    if (ref) continue;
    // "> " is a blockquote marker only on body lines; a token or quote may start with a ">" comparator.
    const s = stripNoise(opts.keepRefs ? line : line.replace(/^\s*>+ /, ""));
    for (const m of s.matchAll(TOKEN_RE())) {
      const unit = m[5] ? normUnit(m[5]) : "";
      const cmp = canonCmp(m[1] ?? m[4] ?? m[7]);
      for (const n of [m[2], m[3]].filter(Boolean) as string[]) {
        if (!unit && !cmp && !n.includes(",") && !n.includes(".") && /^(19|20)\d\d$/.test(n)) continue;
        const { value, unit: u } = normNumber(n, unit);
        const key = `${cmp}${u ? `${value} ${u}${m[6] ? `/${m[6].toLowerCase()}` : ""}` : value}`;
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
  body.split(/\r?\n/).filter((l) => /^#{1,4}\s/.test(l)).map((l) => l.trim());

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
  const corrections = new Set(ctxs.filter((c) => c.rep?.proposed_summary_correction != null).map((c) => c.handle));
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
        if (ok) ac1.infos.push(`allowed summary correction: ${h}`);
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
      const squash = (t: string) => t.replace(/\s+/g, " ").trim();
      if (squash(summaryOf(nf)) !== squash(c.rep!.proposed_summary_correction!)) ac1.fails.push(`${c.rel}: summary line differs from proposed_summary_correction`);
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
  main: { norm: string; rel: string } | null; extras: { path: string; norm: string }[];
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
  const extras: { path: string; norm: string }[] = [];
  const abstracts: { pmid: string; norm: string }[] = [];
  if (main?.pmid) abstracts.push({ pmid: main.pmid, norm: main.norm });
  for (const x of rep.extra_raw ?? []) {
    const e = open(x.path, x.sha256, "extra_raw");
    if (!e) continue;
    extras.push({ path: x.path, norm: e.norm });
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

/** Body lines where the checker finds `tok`, for the writer to locate. */
function linesWith(body: string, tok: string): string {
  const hits = body.split(/\r?\n/).filter((l) => tokenCounts(l).has(tok)).slice(0, 3).map((l) => `"${clip(l, 120)}"`);
  return hits.length ? `; found in: ${hits.join(" | ")}` : "";
}

/** Number tokens that grew between each new sentence and its nearest base sentence: a dose swap between sentences shows here even when the whole-body counts are equal. */
function pairTokenChanges(c: Ctx): Map<string, string[]> {
  const bs = new Set(sentences(ac4Body(c.baseBody, c.type))), ns = new Set(sentences(ac4Body(c.newBody, c.type)));
  const baseOnly = [...bs].filter((x) => !ns.has(x));
  const out = new Map<string, string[]>();
  for (const n of [...ns].filter((x) => !bs.has(x))) {
    const b = nearest(n, baseOnly);
    if (!b) continue;
    const before = tokenCounts(b, { keepRefs: true });
    for (const [tok, cnt] of tokenCounts(n, { keepRefs: true })) {
      if (cnt > (before.get(tok) ?? 0)) out.set(tok, [...(out.get(tok) ?? []), n]);
    }
  }
  return out;
}

const relates = (bodyLine: string, sentence: string) => {
  const b = cleanSentence(bodyLine);
  return b.length > 0 && (b.includes(sentence) || sentence.includes(b));
};

function checkAc2(c: Ctx, added: string[], ac2: Check, raw: RawSet, pairs: Map<string, string[]>): number {
  const rep = c.rep!, tag = `${c.handle}:`;
  let quoted = 0;
  for (const tok of new Set([...added, ...pairs.keys()])) {
    const sents = pairs.get(tok) ?? [];
    const named = rep.changed_tokens.filter((e) => tokenise(e.token, { keepRefs: true }).has(tok));
    if (!named.length) {
      ac2.fails.push(added.includes(tok)
        ? `${tag} token "${tok}" is new in the body and has no changed_tokens entry${linesWith(c.newBody, tok)}`
        : `${tag} token "${tok}" changed between paired sentences and has no changed_tokens entry: ${clip(sents[0], 120)}`);
      continue;
    }
    const holding = named.filter((e) => tokenise(e.body_line, { keepRefs: true }).has(tok));
    if (!holding.length) { ac2.fails.push(`${tag} token "${tok}": body_line does not contain it${linesWith(c.newBody, tok)}`); continue; }
    const missing = sents.filter((sn) => !holding.some((e) => relates(e.body_line, sn)));
    if (missing.length) { for (const sn of missing) ac2.fails.push(`${tag} token "${tok}" changed between paired sentences: no changed_tokens entry has this sentence as its body_line: ${clip(sn, 120)}`); continue; }
    const entry = (sents.length && holding.find((e) => relates(e.body_line, sents[0]))) || holding[0];
    if (!entry.raw_quote.trim()) { ac2.fails.push(`${tag} token "${tok}" has an empty raw_quote`); continue; }
    const prefixed = /^\s*(?:NIH|EXTRA):\s*/.exec(entry.raw_quote);
    const quote = prefixed ? entry.raw_quote.slice(prefixed[0].length) : entry.raw_quote;
    if (!tokenise(quote, { keepRefs: true }).has(tok)) { ac2.fails.push(`${tag} token "${tok}" does not occur in its raw_quote`); continue; }
    const q = normQuote(quote);
    if (q.length < 30 && q.split(" ").length < 6) { ac2.fails.push(`${tag} raw_quote too short for "${tok}" (need 6 words or 30 characters)`); continue; }
    let where = "";
    let res: "ok" | "partial" | "absent";
    if (prefixed) {
      const hits = raw.extras.map((x) => ({ x, r: findWhole(x.norm, q, tok) }));
      const hit = hits.find((h) => h.r === "ok") ?? hits.find((h) => h.r === "partial");
      res = hit ? hit.r : "absent";
      where = hit?.r === "ok" ? hit.x.path : "";
    } else {
      if (raw.main === null) continue;
      res = findWhole(raw.main.norm, q, tok);
    }
    if (res === "absent") { ac2.fails.push(`${tag} raw_quote for "${tok}" is not in the raw file`); continue; }
    if (res === "partial") { ac2.fails.push(`${tag} raw_quote for "${tok}": the token is not a whole token in the raw`); continue; }
    if (where) ac2.infos.push(`${tag} "${tok}" matched in extra_raw ${where}`);
    quoted++;
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
  if (hedgeAfter < hedgeBefore) {
    // A shrinking reference may lose hedges with the text that carried them; pathways keep the hard FAIL.
    const soft = c.type !== "pathway" && c.type !== "guideline" && c.newBody.length < c.baseBody.length;
    (soft ? ac3.warns : ac3.fails).push(`${tag} hedge tokens fell ${hedgeBefore} -> ${hedgeAfter}${soft ? " (body shrank)" : ""}`);
  }
  const bs = sentences(c.baseBody), ns = sentences(c.newBody);
  const bset = new Set(bs), nset = new Set(ns);
  const baseOnly = [...bset].filter((x) => !nset.has(x)), newOnly = [...nset].filter((x) => !bset.has(x));
  for (const b of baseOnly) {
    const n = nearest(b, newOnly);
    for (const p of HEDGES) if (countIn(b, p) > (n ? countIn(n, p) : 0))
      ac3.warns.push(`${tag} lost hedge "${p}" base: ${clip(b, 160)} -> new: ${n ? clip(n, 160) : "(no matching sentence)"}`);
  }
  for (const n of newOnly) {
    const b = nearest(n, baseOnly);
    for (const p of HARDENERS) if (countIn(n, p) > (b ? countIn(b, p) : 0))
      ac3.warns.push(`${tag} gained hardening "${p}" new: ${clip(n, 160)} <- base: ${b ? clip(b, 160) : "(no matching sentence)"}`);
  }
}

/** Body text for AC4: for references and videos the reference list and bare link lines belong to AC7. */
function ac4Body(body: string, type: string | null): string {
  if (type === "pathway" || type === "guideline") return body;
  return classifyLines(body).filter(({ line, ref }) => !ref && !/^\s*\[[^\]]+\]\([^)]*\)\s*$/.test(line)).map((x) => x.line).join("\n");
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
  for (const m of line.matchAll(/\b(10\.\d{4,9}\/[^\s)\]>,;"]+)/g)) {
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
    productSectionCheck(c.newBody, c.baseBody, tag, ac7);
    const baseLines = new Set(refLines(c.baseBody));
    for (const line of refLines(c.newBody).filter((l) => !baseLines.has(l))) {
      const ids = primaryIds(line);
      for (const x of ids) idsOut.set(`${x.kind}:${x.id.toLowerCase()}`, { ...x, handle: c.handle });
      const verified = (x: PrimaryId) => (x.kind === "pmid" ? abstracts.some((a) => a.pmid === x.id) : abstracts.some((a) => a.norm.includes(x.id.toLowerCase())));
      if (ids.some((x) => !verified(x))) ac7.warns.push(`${tag} unverified primary: ${clip(line, 140)}`);
    }
  }
  if (c.type === "pathway") {
    if (!/^\*Source: Auckland Region HealthPathways/m.test(normChars(c.newBody))) pw.fails.push(`${tag} missing "*Source: Auckland Region HealthPathways" line`);
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
      if (c.rep && raw) quoted = checkAc2(c, added, ac2, raw, c.baseText !== null ? pairTokenChanges(c) : new Map());
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
