/**
 * Batch acceptance checks for the knowledge refresh (plan 2026-09-29, Phase 0
 * step 5, AC1-AC4, AC6, AC7). No model calls. Raw third-party text is read from
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  deleted_sentences: { sentence: string; justification: string }[];
  headings_before: string[];
  headings_after: string[];
  proposed_summary_correction: string | null;
  product_mentions_before: number;
  product_mentions_after: number;
  notes: string;
}

export const REPORT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "knowledge-batch diff report (one <handle>.json per article)",
  type: "object",
  additionalProperties: false,
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
        properties: { sentence: { type: "string" }, justification: { type: "string" } },
      },
    },
    headings_before: { type: "array", items: { type: "string" } },
    headings_after: { type: "array", items: { type: "string" } },
    proposed_summary_correction: { type: ["string", "null"] },
    product_mentions_before: { type: "number" },
    product_mentions_after: { type: "number" },
    notes: { type: "string" },
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

const REFS_HEADING = /^#{1,4}\s*(?:references|sources|citations|bibliography)\b/i;
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
const UNIT = "mmol/L|mg/dL|mmHg|x/day|times daily|percent|%|mcg|[µμ]g|mg|IU|mL|kg|cm|g|hours?|days?|weeks?|months?|years?";
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const TOKEN_RE = () => new RegExp(
  `(?<![A-Za-z0-9.,]|[A-Za-z]-)(${NUM})(?:\\s*[–-]\\s*(${NUM}))?(?:[\\s-]*(${UNIT})(?![A-Za-z]))?`, "gi");

function normUnit(u: string): string {
  const l = u.toLowerCase();
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
export function tokenise(text: string, opts: { keepRefs?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  text = normChars(text);
  const lines = opts.keepRefs ? text.split(/\r?\n/).map((line) => ({ line, ref: false })) : classifyLines(text);
  for (const { line, ref } of lines) {
    if (ref) continue;
    const s = stripNoise(line);
    for (const m of s.matchAll(TOKEN_RE())) {
      const unit = m[3] ? normUnit(m[3]) : "";
      for (const n of [m[1], m[2]].filter(Boolean) as string[]) {
        if (!unit && !n.includes(",") && !n.includes(".") && /^(19|20)\d\d$/.test(n)) continue;
        const { value, unit: u } = normNumber(n, unit);
        out.add(u ? `${value} ${u}` : value);
      }
    }
  }
  return out;
}

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

export const PRODUCT_NAMES = ["MicroVitamin+", "MicroVitamin", "Sleep by Dr Brad", "Omega-3", "Potassium Fiber"];
const PRODUCT_RE = new RegExp(PRODUCT_NAMES.map((n) => n.replace(/[+]/g, "\\+")).join("|"), "gi");
// Generic omega-3 (fatty acids, fish oil, leaflets, link text) is not the product.
const OMEGA = "omega[- ]?3";
const OMEGA_GENERIC = new RegExp(`${OMEGA}(?=[\\s\\S]{0,30}?(?:fatty acid|fish oil|leaflet|and cardiovascular))`, "gi");
const OMEGA_IN_LINK = /\[[^\]]*\](?=\()/g;
export const productMentions = (body: string) =>
  (body
    .replace(OMEGA_IN_LINK, (m) => m.replace(new RegExp(OMEGA, "gi"), ""))
    .replace(OMEGA_GENERIC, "")
    .match(PRODUCT_RE) ?? []).length;

const BANNED = ["Top Pick", "What CL Found", "ConsumerLab approved", "CL Approved", "Approved Quality"];
const BRAND_RANKING = /\b(?:best|top|#1|number one|top[- ]rated|highest[- ]rated)\s+brands?\b|\bbrand rankings?\b|\bbrands?,? ranked\b|\branked (?:the )?brands?\b/i;
const PATHWAY_FORBIDDEN: [string, RegExp][] = [
  ["Awanui", /awanui/i], ["0508", /0508/], ["0800", /0800/], ["eReferral", /\be-?referral\b/i],
  ["POAC", /\bPOAC\b/], ["DHB", /\bDHB\b/], ["Te Whatu Ora", /te whatu ora/i],
];

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
  root: string; batch: string; handles: string[]; reportsDir: string; base?: string; outRel?: string;
  exclusionsPath?: string; exceptions?: Exception[];
}
export interface Row {
  handle: string; type: string; file: string; rawSha: string; bodySha: string; tokensNew: number; quoted: number;
  deleted: number; hedgeBefore: number; hedgeAfter: number; productsBefore: number; productsAfter: number;
}

const DIR_FOR: Record<string, string> = { pathway: "pathway", guideline: "guideline", reference: "blog", video: "blog" };
const clip = (l: string, n = 120) => { const t = l.trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

class Check {
  fails: string[] = []; warns: string[] = []; infos: string[] = [];
  constructor(readonly id: string, readonly title: string) {}
  result(exceptions: Exception[] = []): Result {
    const excepted: Exception[] = [], notes: string[] = [];
    const fails = this.fails.filter((f) => {
      const ex = exceptions.find((x) => x.check === this.id && f.startsWith(`${x.handle}:`) && f.includes(x.match));
      if (!ex) return true;
      excepted.push(ex); notes.push(`EXCEPTION (${ex.by}, ${ex.date}): ${ex.reason}: ${f}`);
      return false;
    });
    const status: Status = fails.length ? "FAIL" : this.warns.length || notes.length ? "WARN" : "PASS";
    return { id: this.id, title: this.title, status, excepted,
      evidence: [...fails.map((s) => `FAIL ${s}`), ...this.warns.map((s) => `WARN ${s}`), ...notes, ...this.infos] };
  }
}

interface Ctx {
  handle: string; rep: Report | null; rel: string; newText: string | null; baseText: string | null;
  newBody: string; baseBody: string;
}

function loadCtx(o: Options, base: string, handle: string, ac2: Check): Ctx {
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
  const dirs = rep ? [DIR_FOR[rep.type]] : ["pathway", "blog", "guideline"];
  let rel = `docs/${dirs[0]}/${handle}.md`;
  for (const d of dirs) {
    const cand = `docs/${d}/${handle}.md`;
    if (existsSync(join(o.root, cand)) || gitShow(o.root, base, cand) !== null) { rel = cand; break; }
  }
  const newText = readOpt(join(o.root, rel));
  const baseText = gitShow(o.root, base, rel);
  if (newText === null) ac2.fails.push(`${handle}: body file missing (${rel})`);
  return { handle, rep, rel, newText, baseText,
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
    if (c.baseText === null || c.newText === null || corrections.has(c.handle)) continue;
    if (splitFrontmatter(c.baseText).front !== splitFrontmatter(c.newText).front)
      ac1.fails.push(`${c.rel}: frontmatter changed and no proposed_summary_correction`);
  }
}

function checkAc2(c: Ctx, added: string[], ac2: Check): number {
  const { rep, handle: tag } = { rep: c.rep!, handle: `${c.handle}:` };
  let rawNorm: string | null = null;
  if (!existsSync(rep.raw_path)) ac2.fails.push(`${tag} raw file not found: ${rep.raw_path}`);
  else {
    const buf = readFileSync(rep.raw_path);
    if (sha256(buf) !== rep.raw_sha256) ac2.fails.push(`${tag} raw sha256 mismatch (file ${sha256(buf)}, report ${rep.raw_sha256})`);
    else rawNorm = normQuote(buf.toString("utf8"));
  }
  let quoted = 0;
  for (const tok of added) {
    const entry = rep.changed_tokens.find((e) => tokenise(e.token, { keepRefs: true }).has(tok));
    if (!entry) { ac2.fails.push(`${tag} token "${tok}" is new in the body and has no changed_tokens entry`); continue; }
    if (!entry.raw_quote.trim()) { ac2.fails.push(`${tag} token "${tok}" has an empty raw_quote`); continue; }
    if (!tokenise(entry.raw_quote, { keepRefs: true }).has(tok)) { ac2.fails.push(`${tag} token "${tok}" does not occur in its raw_quote`); continue; }
    if (rawNorm === null) continue;
    if (!rawNorm.includes(normQuote(entry.raw_quote))) { ac2.fails.push(`${tag} raw_quote for "${tok}" is not in the raw file`); continue; }
    quoted++;
  }
  ac2.infos.push(`${tag} ${added.length} new tokens, ${quoted} verified against raw`);
  return quoted;
}

function checkAc3(c: Ctx, hedgeBefore: number, hedgeAfter: number, ac3: Check) {
  const tag = `${c.handle}:`;
  if (hedgeAfter < hedgeBefore) ac3.fails.push(`${tag} hedge tokens fell ${hedgeBefore} -> ${hedgeAfter}`);
  const bl = c.baseBody.split(/\r?\n/), nl = c.newBody.split(/\r?\n/);
  const nset = new Set(nl.map((l) => l.trim())), bset = new Set(bl.map((l) => l.trim()));
  const baseOnly = bl.filter((l) => l.trim() && !nset.has(l.trim()));
  const newOnly = nl.filter((l) => l.trim() && !bset.has(l.trim()));
  const sum = (ls: string[], p: string) => ls.reduce((n, l) => n + countIn(l, p), 0);
  for (const p of HEDGES) {
    if (sum(baseOnly, p) > sum(newOnly, p)) for (const l of baseOnly.filter((l) => countIn(l, p))) ac3.warns.push(`${tag} lost hedge "${p}": ${clip(l, 160)}`);
  }
  for (const p of HARDENERS) {
    if (sum(newOnly, p) > sum(baseOnly, p)) for (const l of newOnly.filter((l) => countIn(l, p))) ac3.warns.push(`${tag} gained hardening "${p}": ${clip(l, 160)}`);
  }
}

function checkAc4(c: Ctx, ac4: Check): number {
  const tag = `${c.handle}:`;
  const nowS = new Set(sentences(c.newBody));
  const declared = new Map((c.rep?.deleted_sentences ?? []).map((d) => [cleanSentence(d.sentence), d.justification]));
  let deleted = 0;
  for (const s of new Set(sentences(c.baseBody))) {
    if (nowS.has(s)) continue;
    deleted++;
    const j = declared.get(s);
    if (j === undefined) ac4.fails.push(`${tag} sentence removed and not in deleted_sentences: ${clip(s)}`);
    else if (!j.trim()) ac4.fails.push(`${tag} deleted sentence has an empty justification: ${clip(s, 80)}`);
  }
  const nowH = new Set(headings(c.newBody));
  for (const h of headings(c.baseBody)) if (!nowH.has(h)) ac4.fails.push(`${tag} heading missing from new body: ${h}`);
  ac4.infos.push(`${tag} ${deleted} sentences removed, ${headings(c.baseBody).length} base headings`);
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

function checkAc7(c: Ctx, ac7: Check, pw: Check) {
  const tag = `${c.handle}:`, rep = c.rep;
  for (const l of c.newBody.split(/\r?\n/)) {
    if (/grokipedia/i.test(l)) ac7.fails.push(`${tag} "grokipedia" in body: ${clip(l, 100)}`);
    for (const b of BANNED) if (l.toLowerCase().includes(b.toLowerCase())) ac7.fails.push(`${tag} banned phrase "${b}": ${clip(l, 100)}`);
    if (BRAND_RANKING.test(l)) ac7.fails.push(`${tag} brand ranking phrase: ${clip(l, 100)}`);
  }
  const pb = productMentions(c.baseBody), pa = productMentions(c.newBody);
  if (pa > pb) ac7.fails.push(`${tag} product mentions rose ${pb} -> ${pa}`);
  if (rep && (rep.product_mentions_before !== pb || rep.product_mentions_after !== pa))
    ac7.fails.push(`${tag} report says product mentions ${rep.product_mentions_before} -> ${rep.product_mentions_after}, recomputed ${pb} -> ${pa}`);
  if (rep?.type === "reference") referenceCheck(c.newBody, tag, ac7);
  if (rep?.type === "pathway") {
    const lines = c.newBody.split(/\r?\n/);
    if (!/^\*Source: Auckland Region HealthPathways/m.test(c.newBody)) pw.fails.push(`${tag} missing "*Source: Auckland Region HealthPathways" line`);
    if (!lines.some((l) => /^>/.test(l) && /doctor|healthcare provider|general practitioner|\bGP\b/i.test(l)))
      pw.fails.push(`${tag} missing doctor-deferral blockquote`);
    for (const l of lines) for (const [name, re] of PATHWAY_FORBIDDEN) if (re.test(l)) pw.fails.push(`${tag} forbidden term "${name}": ${clip(l, 100)}`);
  }
}

const EXCLUSIONS_PATH = "/Users/bradstanfield/Library/CloudStorage/Dropbox/YouTube/multivitamin & others/claude_business/tools/healthpathways-exclusions.json";

export function runBatch(o: Options): { results: Result[]; rows: Row[]; baseSha: string } {
  const base = o.base ?? "HEAD";
  const baseSha = git(o.root, ["rev-parse", base]).trim();
  const ac1 = new Check("AC1", "index.json and categories.json unchanged (except approved summary corrections)");
  const ac2 = new Check("AC2", "raw fidelity of every new number token");
  const ac3 = new Check("AC3", "hedging held; hardening words listed");
  const ac4 = new Check("AC4", "deleted sentences justified; headings kept");
  const ac6 = new Check("AC6", "diff touches only batch files");
  const ac7 = new Check("AC7", "grokipedia, products, references, banned phrases, exclusions");
  const pw = new Check("PATHWAY", "source line, deferral blockquote, no NZ logistics");
  const rows: Row[] = [];
  const ctxs = o.handles.map((h) => loadCtx(o, base, h, ac2));

  checkAc1(o, base, ctxs, ac1);
  for (const c of ctxs) {
    const newTokens = tokenise(c.newBody), baseTokens = tokenise(c.baseBody);
    const added = [...newTokens].filter((t) => !baseTokens.has(t));
    const hedgeBefore = totalIn(c.baseBody, HEDGES), hedgeAfter = totalIn(c.newBody, HEDGES);
    let quoted = 0, deleted = 0;
    if (c.newText !== null) {
      if (c.rep) quoted = checkAc2(c, added, ac2);
      checkAc3(c, hedgeBefore, hedgeAfter, ac3);
      if (c.baseText !== null) deleted = checkAc4(c, ac4);
      checkAc7(c, ac7, pw);
    }
    rows.push({ handle: c.handle, type: c.rep?.type ?? "?", file: c.rel, rawSha: c.rep?.raw_sha256 ?? "-",
      bodySha: sha256(c.newBody), tokensNew: added.length, quoted, deleted, hedgeBefore, hedgeAfter,
      productsBefore: productMentions(c.baseBody), productsAfter: productMentions(c.newBody) });
  }

  // Exclusions (claude_business list; slugs are handles).
  let excluded = new Set<string>();
  const exPath = o.exclusionsPath ?? EXCLUSIONS_PATH;
  if (existsSync(exPath)) {
    const ex = JSON.parse(readFileSync(exPath, "utf8")) as { excluded?: string[]; excludedReasons?: Record<string, { slug?: string }> };
    excluded = new Set([...(ex.excluded ?? []), ...Object.values(ex.excludedReasons ?? {}).map((r) => r.slug).filter((s): s is string => !!s)]);
  } else ac7.warns.push(`exclusions file not found; excluded-handle check skipped (${exPath})`);
  for (const h of o.handles) if (excluded.has(h)) ac7.fails.push(`${h}: handle is on the HealthPathways exclusion list`);

  // AC6, and new files against the exclusion list.
  const changed = new Set([
    ...git(o.root, ["diff", "--name-only", "--no-renames", base]).split("\n"),
    ...git(o.root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean));
  const allowed = new Set<string>(o.outRel ? [o.outRel] : []);
  for (const h of o.handles) for (const d of ["pathway", "blog", "guideline"]) allowed.add(`docs/${d}/${h}.md`);
  for (const f of changed) {
    if (!allowed.has(f)) ac6.fails.push(`unexpected change: ${f}`);
    const m = f.match(/^docs\/(?:pathway|blog|guideline)\/(.+)\.md$/);
    if (m && excluded.has(m[1]) && gitShow(o.root, base, f) === null) ac7.fails.push(`${m[1]}: excluded handle gained a file (${f})`);
  }
  ac6.infos.push(`${changed.size} changed paths versus ${base}`);
  ac6.infos.push("Shopify updated_at snapshot: separate tool, NOT checked here");

  return { results: [ac1, ac2, ac3, ac4, ac6, ac7, pw].map((c) => c.result(o.exceptions)), rows, baseSha };
}

/** Markdown batch report: counts and hashes only, under 150 lines. */
export function renderReport(batch: string, base: string, baseSha: string, results: Result[], rows: Row[]): string {
  const L: string[] = [`# Knowledge batch report: ${batch}`, "", `Base: ${base} (${baseSha})`, `Handles: ${rows.length}`, "",
    "Counts and hashes only. Raw text never enters this repo.", "", "## Checks", "", "| Check | Status | FAIL | WARN |", "|---|---|---|---|"];
  for (const r of results) {
    const n = (p: string) => r.evidence.filter((e) => e.startsWith(p)).length;
    L.push(`| ${r.id} ${r.title} | ${r.status} | ${n("FAIL ")} | ${n("WARN ")} |`);
  }
  const cap = 100;
  L.push("", "## Handles", "",
    "| handle | type | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products |",
    "|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.slice(0, cap)) {
    L.push(`| ${r.handle} | ${r.type} | ${r.rawSha.slice(0, 16)} | ${r.bodySha.slice(0, 16)} | ${r.tokensNew} | ${r.quoted} | ${r.deleted} | ${r.hedgeBefore}>${r.hedgeAfter} | ${r.productsBefore}>${r.productsAfter} |`);
  }
  if (rows.length > cap) L.push("", `${rows.length - cap} more handles omitted to stay under the line cap.`);
  const ex = results.flatMap((r) => r.excepted ?? []);
  if (ex.length) {
    L.push("", "## Accepted exceptions", "", "| check | handle | by | date | reason | match sha256 |", "|---|---|---|---|---|---|");
    for (const x of ex) L.push(`| ${x.check} | ${x.handle} | ${x.by} | ${x.date} | ${x.reason.replace(/\|/g, "/")} | ${sha256(x.match).slice(0, 16)} |`);
  }
  L.push("", "Hashes are the first 16 hex characters of sha256.", "",
    "AC5 (answer quality) and the Shopify updated_at snapshot: not covered here.", "", "AC8 sign-off (Brad): PENDING");
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

export function main(argv: string[]): number {
  const a = parseArgs(argv);
  if (a["print-schema"]) { console.log(JSON.stringify(REPORT_SCHEMA, null, 2)); return 0; }
  if (typeof a.example === "string") { console.log(JSON.stringify(exampleReport(a.example), null, 2)); return 0; }
  if (typeof a.batch !== "string" || typeof a.handles !== "string") {
    console.error("usage: knowledge-batch-check.ts --batch <name> --handles <file> [--reports <dir>] [--base <ref>] [--out <file>] [--exceptions <file>]");
    return 2;
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const handles = readFileSync(a.handles, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const reportsDir = typeof a.reports === "string" ? resolve(a.reports) : join(homedir(), ".codex-review", "diff-reports", a.batch);
  const out = typeof a.out === "string" ? resolve(a.out) : undefined;
  const base = typeof a.base === "string" ? a.base : "HEAD";
  const rel = out ? relative(root, out) : "";
  const outRel = out && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
  const exceptions: Exception[] = typeof a.exceptions === "string" && existsSync(a.exceptions)
    ? JSON.parse(readFileSync(a.exceptions, "utf8")) : [];
  const { results, rows, baseSha } = runBatch({ root, batch: a.batch, handles, reportsDir, base, outRel, exceptions });
  for (const r of results) {
    console.log(`${r.status} ${r.id} ${r.title}`);
    for (const e of r.evidence) console.log(`    ${e}`);
  }
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, renderReport(a.batch, base, baseSha, results, rows)); }
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
