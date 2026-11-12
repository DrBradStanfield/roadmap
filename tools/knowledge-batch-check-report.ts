/** The diff report split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23): its schema and addenda
 *  (US-42 AC2), the Check result, and loading each handle's report and files into a Ctx. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, splitFrontmatter } from "./knowledge-batch-check-text";

export type Status = "PASS" | "FAIL" | "WARN";
export interface Exception { check: string; handle: string; match: string; reason: string; by: string; date: string }
export interface Result { id: string; title: string; status: Status; evidence: string[]; excepted?: Exception[] }
export interface Entry { body_line: string; raw_quote: string; notes?: string; void?: boolean; void_reason?: string }
export interface Report {
  handle: string;
  type: "reference" | "video" | "guideline";
  raw_path: string;
  raw_sha256: string;
  old_raw_path: string | null;
  /** One entry per body line and its verbatim source quote; the checker derives the numbers. A `token` field is ignored. */
  changed_tokens: Entry[];
  deleted_sentences: { sentence: string; justification: string; pattern?: boolean; void?: boolean }[];
  headings_before: string[];
  headings_after: string[];
  proposed_summary_correction: string | null;
  product_mentions_before: number;
  product_mentions_after: number;
  notes: string;
  /** True when the handle is not in docs/blog/index.json yet; the type then comes from the frontmatter. */
  new?: boolean;
  /** Optional further raw sources; a raw_quote prefixed "NIH: " or "EXTRA: " is matched in these. */
  extra_raw?: { path: string; sha256: string; void?: boolean }[];
  /** Topic masters (US-50): one entry per Current view sentence, its quote prefixed POST:<handle>: or POSITION:<path>:. */
  current_view_basis?: { sentence: string; source?: string; quote: string; void?: boolean }[];
}

const ADDENDUM_APPEND = ["extra_raw", "changed_tokens", "current_view_basis", "deleted_sentences", "ask_brad", "needs_pubmed", "positions_drift", "grokipedia_claims"];
// grokipedia_claims and positions_drift are informational: no check reads them. needs_pubmed is not voidable: it carries safety work items.
export const ADDENDUM_VOID = ["changed_tokens", "current_view_basis", "deleted_sentences", "extra_raw", "ask_brad", "grokipedia_claims", "positions_drift"];

/**
 * Reports are append-only (US-42 AC2): a correction is a <handle>.addendum-<N>.json beside the report, applied in
 * numeric order. {append: {<section>: [...], notes: "..."}, void: [{section, index, reason}], set: {proposed_summary_correction}}.
 * A void's index counts the array merged before its addendum. A void may give a reason to a base void that has none (the
 * repair path for a base report that fails validation). Returns a merged copy; the input is never changed.
 */
export function applyAddenda(base: Record<string, unknown>, addenda: { name: string; data: unknown }[]): { report: Record<string, unknown>; errors: string[]; infos: string[]; sources: Record<string, string> } {
  if (!addenda.length) return { report: base, errors: [], infos: [], sources: {} };
  const r: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  const errors: string[] = [], infos: string[] = [], sources: Record<string, string> = {}; // "<section> <i>" -> the addendum that voided it
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const unknown = (o: Record<string, unknown>, allowed: string[], at: string, err: (m: string) => void) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${at}${k}: unknown key`);
  };
  for (const { name, data } of addenda) {
    const errs: string[] = [], err = (m: string) => errs.push(`${name}: ${m}`);
    if (!isObj(data)) { errors.push(`${name}: not an object`); continue; }
    unknown(data, ["append", "void", "set"], "", err);
    const { append = {}, void: vs = [], set = {} } = data as { append?: Record<string, unknown>; void?: unknown; set?: Record<string, unknown> };
    if (!isObj(append)) err("append: object expected");
    else {
      unknown(append, [...ADDENDUM_APPEND, "notes"], "append.", err);
      for (const k of ADDENDUM_APPEND) if (append[k] !== undefined && !Array.isArray(append[k])) err(`append.${k}: array expected`);
      if (append.notes !== undefined && typeof append.notes !== "string") err("append.notes: string expected");
    }
    if (!isObj(set)) err("set: object expected");
    else {
      unknown(set, ["proposed_summary_correction"], "set.", err);
      const p = set.proposed_summary_correction;
      if (p !== undefined && (typeof p !== "string" || !p.trim())) err("set.proposed_summary_correction: non-empty string expected");
    }
    const seen = new Set<string>();
    if (!Array.isArray(vs)) err("void: array expected");
    else vs.forEach((v: unknown, i) => {
      if (!isObj(v)) return err(`void[${i}]: object expected`);
      unknown(v, ["section", "index", "reason"], `void[${i}].`, err);
      if (typeof v.reason !== "string" || !v.reason.trim()) err(`void[${i}].reason: non-empty string expected`);
      if (!ADDENDUM_VOID.includes(v.section as string)) return err(`void[${i}].section: one of ${ADDENDUM_VOID.join("|")} expected`);
      const arr = r[v.section as string], e = Array.isArray(arr) && Number.isInteger(v.index) ? arr[v.index as number] : undefined;
      if (!isObj(e)) err(`void[${i}].index: no ${v.section} entry ${String(v.index)}`);
      else if (seen.has(`${v.section} ${v.index}`)) err(`void[${i}]: ${v.section} entry ${v.index} is voided twice`);
      else if (e.void === true && typeof e.void_reason === "string" && e.void_reason.trim()) err(`void[${i}]: ${v.section} entry ${v.index} is already void`);
      seen.add(`${v.section} ${v.index}`);
    });
    if (errs.length) { errors.push(...errs); continue; }
    const short = /(addendum-\d+)\.json$/.exec(name)?.[1] ?? name;
    for (const v of vs as { section: string; index: number; reason: string }[]) {
      Object.assign((r[v.section] as Record<string, unknown>[])[v.index], { void: true, void_reason: v.reason });
      sources[`${v.section} ${v.index}`] = short;
    }
    for (const k of ADDENDUM_APPEND) if (Array.isArray(append[k])) {
      const old = Array.isArray(r[k]) ? r[k] as unknown[] : [];
      (append[k] as unknown[]).forEach((x, i) => { if (isObj(x) && x.void === true) sources[`${k} ${old.length + i}`] = short; });
      r[k] = [...old, ...(append[k] as unknown[])];
    }
    if (typeof append.notes === "string") r.notes = r.notes ? `${r.notes}\n${append.notes}` : append.notes;
    if (typeof set.proposed_summary_correction === "string") { r.proposed_summary_correction = set.proposed_summary_correction; infos.push(`proposed_summary_correction set by ${short}`); }
  }
  return { report: r, errors, infos, sources };
}

/** void and void_reason, allowed on every voidable section (ADDENDUM_VOID). */
const VOID_PROPS = {
  void: { type: "boolean", description: "true: the entry is retired: it counts in no check and is listed as a VOID line (reports are append-only); false is the same as absent" },
  void_reason: { type: "string", description: "required, non-empty, when void is true" },
};

export const REPORT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "knowledge-batch diff report (one <handle>.json per article)",
  type: "object",
  additionalProperties: true, // other extra keys are ignored
  required: ["handle", "type", "raw_path", "raw_sha256", "old_raw_path", "changed_tokens", "deleted_sentences",
    "headings_before", "headings_after", "proposed_summary_correction", "product_mentions_before",
    "product_mentions_after", "notes"],
  properties: {
    handle: { type: "string" },
    type: { enum: ["reference", "video", "guideline"] },
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
          ...VOID_PROPS,
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
          ...VOID_PROPS,
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
      items: { type: "object", required: ["path", "sha256"], properties: { path: { type: "string" }, sha256: { type: "string" }, ...VOID_PROPS } },
    },
    current_view_basis: {
      type: "array",
      items: { type: "object", required: ["sentence", "quote"], properties: { sentence: { type: "string" }, source: { type: "string" }, quote: { type: "string" }, ...VOID_PROPS } },
    },
    ask_brad: { type: "array", items: { type: "object", required: ["item", "why"], properties: { item: { type: "string" }, why: { type: "string" }, ...VOID_PROPS } } },
    // Read by no check. Entries are strings or objects; only an object entry can be voided.
    grokipedia_claims: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true, properties: { claim: { type: "string" }, outcome: { type: "string" }, ...VOID_PROPS } }] } },
    needs_pubmed: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true, properties: { claim: { type: "string" }, study_as_named: { type: "string" } } }] } },
    positions_drift: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true, properties: { file: { type: "string" }, line_text: { type: "string" }, master_says: { type: "string" }, ...VOID_PROPS } }] } },
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
  for (const k of ["grokipedia_claims", "needs_pubmed", "positions_drift"]) {
    if (r[k] === undefined) continue;
    if (!Array.isArray(r[k])) e.push(`${k} must be an array`);
    else (r[k] as unknown[]).forEach((x, i) => { if (typeof x !== "string" && (!x || typeof x !== "object" || Array.isArray(x))) e.push(`${k}[${i}]: string or object expected`); });
  }
  for (const k of ADDENDUM_VOID) if (Array.isArray(r[k])) (r[k] as { void?: unknown; void_reason?: unknown }[]).forEach((x, i) => {
    if (!x || x.void === undefined || x.void === false) return; // false is the same as absent
    if (x.void !== true) e.push(`${k}[${i}].void: boolean expected`);
    else if (typeof x.void_reason !== "string" || !x.void_reason.trim()) e.push(`${k}[${i}].void_reason: void entry without void_reason`);
  });
  if (r.new !== undefined && typeof r.new !== "boolean") e.push("new: boolean expected");
  if (r.extra_raw !== undefined) {
    if (!Array.isArray(r.extra_raw)) e.push("extra_raw: array expected");
    else (r.extra_raw as unknown[]).forEach((x, i) => {
      for (const key of ["path", "sha256"]) if (!x || typeof (x as Record<string, unknown>)[key] !== "string") e.push(`extra_raw[${i}].${key}: string expected`);
    });
  }
  if (!["reference", "video", "guideline"].includes(r.type as string)) e.push("type: reference|video|guideline expected");
  return e;
}

// ---------- git helpers ----------

export function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
}
export function gitShow(root: string, base: string, rel: string): string | null {
  try { return git(root, ["show", `${base}:${rel}`]); } catch { return null; }
}
export const readOpt = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// ---------- the checks ----------

export interface Options {
  root: string; batch: string; handles: string[]; reportsDir: string; base: string; outRel?: string;
  /** Allowed raw roots (default: the knowledge-map-raw roots of tools/codex-review-includes.json). */
  rawRoots?: string[];
  exceptions?: Exception[];
  /** Topic-master batch (US-50 AC1): the master frontmatter keys are allowed and the MASTER body check runs. */
  masters?: boolean;
  /** With masters: each master with a view must carry sound key safety points (US-50 AC12, keySafetyErrors). */
  keySafetyPoints?: boolean;
  /** Condition-guide batch (US-70 AC1): guide index entries may be added or changed and the GUIDE check runs. */
  guides?: boolean;
  checkIds?: boolean; headStatus?: (url: string) => number; delayMs?: number; idCap?: number;
}
export interface Row {
  handle: string; type: string; file: string; rawRel: string; rawSha: string; bodySha: string; tokensNew: number; quoted: number;
  deleted: number; hedgeBefore: number; hedgeAfter: number; productsBefore: number; productsAfter: number;
  /** The diff report, then each addendum applied to it, in order, with the sha256 of each file. */
  reportFiles?: { name: string; sha256: string }[];
}

export const DIR_FOR: Record<string, string> = { guideline: "guideline", reference: "blog", video: "blog" };

export class Check {
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

export interface Ctx {
  handle: string; rep: Report | null; rel: string; newText: string | null; baseText: string | null;
  newBody: string; baseBody: string; type: string | null; reportFiles: { name: string; sha256: string }[];
}

const fmType = (text: string | null) => (text && /^type:\s*"?([A-Za-z]+)"?\s*$/m.exec(splitFrontmatter(text).front)?.[1]) || "video";

export function loadCtx(o: Options, base: string, handle: string, ac2: Check, index: Map<string, { type?: string }>): Ctx {
  const rp = join(o.reportsDir, `${handle}.json`);
  let rep: Report | null = null;
  // Addenda: <handle>.addendum-<N>.json, N = 1, 2, 3 ... with no gap. The report and its addenda are only ever read.
  const prefix = `${handle}.addendum`, files: { name: string; sha256: string }[] = [];
  const addenda: { name: string; n: number }[] = [];
  for (const f of existsSync(o.reportsDir) ? readdirSync(o.reportsDir) : []) {
    if (!f.startsWith(prefix)) continue;
    const n = /^-([1-9]\d*)\.json$/.exec(f.slice(prefix.length))?.[1];
    if (n) addenda.push({ name: f, n: Number(n) }); else ac2.warns.push(`${handle}: ${f} is not <handle>.addendum-<N>.json; ignored`);
  }
  addenda.sort((x, y) => x.n - y.n);
  const gap = addenda.findIndex((x, i) => x.n !== i + 1);
  if (gap >= 0) ac2.fails.push(`${handle}: addendum numbering gap: ${prefix}-${gap + 1}.json missing`);
  if (!existsSync(rp)) ac2.fails.push(`${handle}: diff report missing at ${rp}`);
  else {
    try {
      const read = (name: string) => { const buf = readFileSync(join(o.reportsDir, name)); files.push({ name, sha256: sha256(buf) }); return buf.toString("utf8"); };
      const base = JSON.parse(read(`${handle}.json`));
      const loaded: { name: string; data: unknown }[] = [];
      for (const { name } of addenda) {
        const text = read(name);
        try { loaded.push({ name, data: JSON.parse(text) }); } catch (e) { ac2.fails.push(`${handle}: ${name}: not JSON: ${(e as Error).message}`); }
      }
      // Addenda apply even to an invalid base report: a void may supply a missing void_reason (the repair path).
      // Addenda repair a base report only when its every error is a void with no reason; any other error needs a fresh report.
      const baseErrs = validateReport(base), repairable = baseErrs.every((x) => /\.void_reason: void entry without void_reason$/.test(x));
      const merged = repairable ? applyAddenda(base, loaded) : { report: base, errors: [], infos: [], sources: {} as Record<string, string> };
      const parsed = merged.report, errs = [...merged.errors, ...validateReport(parsed)];
      if (errs.length) ac2.fails.push(`${handle}: report invalid: ${errs.join("; ")}`);
      else if (loaded.length < addenda.length) { /* an unreadable addendum already failed */ }
      else if (parsed.handle !== handle) ac2.fails.push(`${handle}: report handle is "${parsed.handle}"`);
      else {
        rep = parsed as unknown as Report;
        ac2.infos.push(...merged.infos.map((v) => `${handle}: ${v}`));
        // Every void, inline or from an addendum; --out renders it without the reason text.
        for (const k of ADDENDUM_VOID) ((parsed[k] ?? []) as { void?: boolean; void_reason?: string }[]).forEach((x, i) => { if (x.void) ac2.infos.push(`${handle}: VOID ${k} ${i} [${merged.sources[`${k} ${i}`] ?? "base"}]: ${x.void_reason}`); });
      }
    } catch (e) { ac2.fails.push(`${handle}: report is not JSON: ${(e as Error).message}`); }
  }
  // The type comes from the index, never from the report; a handle absent from the index must say "new".
  const entry = index.get(handle);
  let type: string | null = entry ? entry.type ?? "video" : null;
  const dirs = type ? [DIR_FOR[type]] : ["blog", "guideline"];
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
  return { handle, rep, rel, newText, baseText, type, reportFiles: files,
    newBody: splitFrontmatter(newText ?? "").body, baseBody: splitFrontmatter(baseText ?? "").body };
}

