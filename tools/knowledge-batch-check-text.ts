/** Text rules split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23), shared with knowledge-lint.ts:
 *  frontmatter and master keys (US-50 AC1), key safety points (US-50 AC12), condition guides (US-70 AC1), sentences,
 *  hedges and product mentions. */
import { createHash } from "node:crypto";
import { parseFrontmatter } from "../app/lib/frontmatter";
import { MONTH, classifyLines, normChars, unescapeMd } from "./knowledge-tokenise";

// ---------- text helpers ----------

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function splitFrontmatter(text: string): { front: string; body: string } {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: "", body: text };
}

/** The value after `key:` on its own frontmatter line, or null when the key has no line. */
export const fmValue = (front: string, key: string) => new RegExp(`^${key}:[ \t]*(.*)$`, "m").exec(front)?.[1].trim() ?? null;

export function validDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const SOURCE_KEYS = ["name", "url", "checked", "fingerprint"];
export const SOURCE_NAMES = ["nih-ods", "brad-video", "pubmed"];
// The licensed supplement-testing site, built from parts so this public repo never spells it (Brad 2026-11-09).
export const TESTER = ["Consumer", "Lab"].join("");
export const jsonOf = (v: string): unknown => { try { return JSON.parse(v); } catch { return undefined; } };

/** Shape errors of one master frontmatter value (US-50 AC1), or null. `value` is the text after `key:` on its line. */
export function masterKeyError(key: string, value: string, names = SOURCE_NAMES): string | null {
  if (!value) return "needs its value on the same line";
  if (key === "router") return value === "hidden" ? null : 'must be exactly "hidden"';
  if (key === "reviewed") {
    const d = /^"(\d{4}-\d{2}-\d{2})"$/.exec(value)?.[1];
    return d && validDate(d) ? null : 'must be a quoted valid date, "YYYY-MM-DD"';
  }
  const j = jsonOf(value);
  if (!Array.isArray(j) || !j.length) return "must be a single-line, non-empty JSON array";
  if (key === "topics") return j.every((t) => typeof t === "string" && t) ? null : "must be an array of non-empty strings";
  for (const [i, it] of j.entries()) {
    const o = it as Record<string, unknown> | null;
    const miss = SOURCE_KEYS.find((k) => typeof o?.[k] !== "string" || !o[k]);
    if (miss) return `item ${i} is missing ${miss}`;
    if (!names.includes(o!.name as string)) return `item ${i} name must be one of ${names.join(", ")}`;
    if (!validDate(o!.checked as string)) return `item ${i} has an invalid checked date`;
  }
  return null;
}

/** The repo file a POST:<handle>: or POSITION:<path>: quote names, and the quote after the prefix (US-50 AC1). */
export const quoteSource = (q: string) => {
  const m = /^\s*(POST|POSITION):([^:\s]+):\s*/.exec(q);
  return m ? { kind: m[1], rel: m[1] === "POST" ? `docs/blog/${m[2]}.md` : m[2], text: q.slice(m[0].length) } : null;
};
/** The master's view heading (US-50 AC1), shared with knowledge-lint.ts; group 1 is set for a Current view. */
export const VIEW_HEADING = /^##\s+(?:(Current view \(reviewed [^)]+\))|Current evidence position)\s*$/;
/** The contract's first sentence of a Current evidence position (claude_business docs/roadmap-chat/knowledge-refresh/master-writer-contract.md). */
/** Frontmatter keys that appear more than once. */
export const duplicateKeys = (front: string) => {
  const keys = front.split(/\r?\n/).map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter((k): k is string => !!k);
  return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
};

/** Normal form for substring matching of raw quotes. */
export const normQuote = (s: string) => unescapeMd(normChars(s)).replace(/\s+/g, " ").trim().toLowerCase();

export const squash = (t: string) => t.replace(/\s+/g, " ").trim();
/** The writer contract's cap on a master's "## Key safety points" section, heading and body (US-50 AC12). */
export const MAX_KEY_POINTS_CHARS = 1_500;
/** A bullet line, kept identical to app/lib/youtube-context.ts. */
export const BULLET_LINE = /^[ \t]*(?:[-*]|\d+\.)[ \t]+\S/;
/**
 * What is wrong with a master's "## Key safety points" section (US-50 AC12), shared with knowledge-lint.ts: a body with
 * a view section needs one directly after it, of 3 to 8 bullets and at most MAX_KEY_POINTS_CHARS, every bullet citing
 * [n] markers that all resolve to reference lines. Empty when it is sound or the body has no view.
 */
export function keySafetyErrors(body: string): string[] {
  const lines = body.split(/\r?\n/);
  let fence = false;
  const heads = lines.flatMap((l, i) => { if (/^\s*```/.test(l)) fence = !fence; return !fence && /^#{1,2}\s/.test(l) ? [i] : []; });
  const v = heads.findIndex((i) => VIEW_HEADING.test(lines[i]));
  if (v < 0) return [];
  const k = heads.filter((i) => /^##\s+Key safety points\s*$/.test(lines[i]));
  if (k.length !== 1) return [`needs one "## Key safety points" section after the view (found ${k.length})`];
  if (heads[v + 1] !== k[0]) return ['"## Key safety points" must come directly after the view section'];
  const rule = lines.findIndex((l, i) => i > k[0] && /^---\s*$/.test(l)); // the runtime also ends the section at a rule
  const end = Math.min(heads.find((i) => i > k[0]) ?? lines.length, rule < 0 ? lines.length : rule);
  const errors: string[] = [];
  const size = lines.slice(k[0], end).join("\n").trim().length;
  if (size > MAX_KEY_POINTS_CHARS) errors.push(`"Key safety points" runs ${size} characters (at most ${MAX_KEY_POINTS_CHARS})`);
  const bullets: string[] = []; // a bullet with its continuation lines
  for (const l of lines.slice(k[0] + 1, end)) {
    if (BULLET_LINE.test(l)) bullets.push(l.trim());
    else if (l.trim() && bullets.length) bullets[bullets.length - 1] += ` ${l.trim()}`;
  }
  if (bullets.length < 3 || bullets.length > 8) errors.push(`"Key safety points" has ${bullets.length} bullets (3 to 8)`);
  const refs = new Set(classifyLines(body).flatMap(({ line, ref }) => {
    const m = ref ? /^\s*(?:\[(\d+)\]|(\d+)\.)\s+\S/.exec(line) : null;
    return m ? [Number(m[1] ?? m[2])] : [];
  }));
  for (const b of bullets) {
    const cited = [...b.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)].flatMap(([, list]) => list.split(",").flatMap((part) => {
      const [from, to = from] = part.split(/[–-]/).map(Number);
      return Array.from({ length: Math.max(0, Math.min(to - from, 50)) + 1 }, (_, j) => from + j);
    }));
    if (!cited.length) errors.push(`a key safety point cites no [n] marker: ${clip(b, 100)}`);
    const missing = cited.filter((n) => !refs.has(n));
    if (missing.length) errors.push(`a key safety point cites [${missing.join(", ")}] with no reference line: ${clip(b, 100)}`);
  }
  return errors;
}

/** Condition guides (US-70 AC1): public sources only, so no licensed name in `sources:`. */
export const GUIDE_SOURCE_NAMES = ["guideline", "label", "pubmed", "nih-ods", "brad-video"];
export const MAX_GUIDE_CHARS = 35_000;
/** The emergency line every red flag carries, copied exactly (plan section 3, "ruling 17"). */
export const EMERGENCY_LINE = "(111 in NZ, 000 in Australia, 911 in the US, 999 in the UK)";
/** The template's level-2 headings, in order (plan section 3). */
export const GUIDE_SECTIONS: [string, RegExp][] = [
  ["In short", /^## In short$/], ["Get help now", /^## Get help now$/], ["What it is", /^## What it is$/],
  ["Your numbers", /^## Your numbers$/], ["What helps", /^## What helps$/], ["Medicines", /^## Medicines$/],
  ["Brad's view (reviewed D Mon YYYY) or Current evidence position", new RegExp(`^## (?:Brad['’]s view \\(reviewed \\d{1,2} ${MONTH} \\d{4}\\)|Current evidence position)$`)],
  ["Who needs extra care", /^## Who needs extra care$/], ["When to see your doctor", /^## When to see your doctor$/],
  ["Where guidelines differ", /^## Where guidelines differ$/], ["Common questions", /^## Common questions$/], ["References", /^## References$/],
];
/** True for a file marked `kind: condition`, by the one definition the index uses (parseFrontmatter: any quotes). */
export const isGuideText = (text: string) => parseFrontmatter(text)?.kind === "condition";

/**
 * What is wrong with a condition guide (US-70 AC1), shared with knowledge-lint.ts: its keys, the 35,000-character
 * cap on the whole file, the twelve template sections once each and in order, "## Get help now" holding only
 * one-line red-flag bullets, each with the exact emergency line, and no other emergency-number list anywhere (any
 * "111 in NZ", "000 in Australia", "911 in the US" or "999 in the UK" outside an exact line). Empty when it is sound.
 */
export function guideErrors(text: string): string[] {
  const { front, body } = splitFrontmatter(text);
  const errors: string[] = [];
  if (parseFrontmatter(text)?.type !== "guideline") errors.push("type must be guideline");
  if (!isGuideText(text)) errors.push("kind must be condition");
  for (const k of ["reviewed", "sources"]) {
    const v = fmValue(front, k), err = v === null ? "missing" : masterKeyError(k, v, GUIDE_SOURCE_NAMES);
    if (err) errors.push(`${k}: ${err}`);
  }
  const t = jsonOf(fmValue(front, "thresholds") ?? "");
  if (!Array.isArray(t) || !t.length) errors.push("thresholds: must be a single-line, non-empty JSON array");
  else t.forEach((x, i) => {
    const o = x as Record<string, unknown> | null;
    if (typeof o?.ref !== "string" || !/^[A-Z][A-Z0-9_]*(?:\.\w+)+$/.test(o.ref) || typeof o.value !== "number") errors.push(`thresholds: item ${i} needs {"ref": "CONSTANT.key", "value": <number>}`);
  });
  for (const k of duplicateKeys(front)) errors.push(`frontmatter key ${k} appears more than once`);
  if (text.length > MAX_GUIDE_CHARS) errors.push(`runs ${text.length} characters (at most ${MAX_GUIDE_CHARS})`);
  const lines = body.split(/\r?\n/);
  let fence = false;
  const heads = lines.flatMap((l, i) => { if (/^\s*```/.test(l)) fence = !fence; return !fence && /^##\s/.test(l) ? [i] : []; });
  let last = -1;
  for (const [name, re] of GUIDE_SECTIONS) {
    const at = heads.filter((i) => re.test(lines[i].trim()));
    if (at.length !== 1) errors.push(`needs one "## ${name}" section (found ${at.length})`);
    else if (at[0] < last) errors.push(`"## ${name}" is out of the template order`);
    else last = at[0];
  }
  const help = heads.find((i) => /^## Get help now$/.test(lines[i].trim()));
  if (help !== undefined) {
    const bullets: string[] = [];
    for (const l of lines.slice(help + 1, heads.find((i) => i > help) ?? lines.length)) {
      if (BULLET_LINE.test(l)) bullets.push(l.trim());
      else if (l.trim()) errors.push(`"## Get help now" has a line that is not a red-flag bullet: ${clip(l.trim(), 100)}`);
    }
    if (!bullets.length) errors.push('"## Get help now" has no red-flag bullets');
    for (const b of bullets) if (!b.includes(EMERGENCY_LINE)) errors.push(`a red flag lacks the exact emergency line ${EMERGENCY_LINE}: ${clip(b, 100)}`);
  }
  // Any emergency-number list counts, whatever comes first: each country's number must sit inside an exact line.
  const variants = Math.max(...EMERGENCY_LINE.slice(1, -1).split(", ").map((n) => text.split(n).length)) - text.split(EMERGENCY_LINE).length;
  if (variants > 0) errors.push(`${variants} other version(s) of the emergency line; copy ${EMERGENCY_LINE} exactly`);
  return errors;
}

/** A "(Brad's current guidance, 15 Oct 2026)" citation (US-50). */
export const GUIDANCE = new RegExp(`\\(Brad['’]s current guidance, \\d{1,2} ${MONTH} \\d{4}\\)`);


const ABBREV = /\b(e\.g|i\.e|vs|Dr|Jr|Sr|mg|etc|approx|Mr|Mrs|Ms|Prof|al|Fig)\./gi;
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

export const HEDGES = ["may", "might", "can", "could", "likely", "possibly", "appears", "suggests", "associated with",
  "linked to", "observational", "limited", "preliminary", "modest", "some evidence", "no evidence", "unclear",
  "insufficient", "mixed", "not established"];
export const HARDENERS = ["causes", "prevents", "treats", "cures", "reduces risk", "proven", "should", "must", "safe",
  "will", "effective", "improves", "lowers", "no side effects", "recommended", "not been observed"];
const phraseRe = (p: string) => new RegExp(`\\b${p.replace(/ /g, "\\s+")}\\b`, "gi");
export const countIn = (text: string, p: string) => (text.match(phraseRe(p)) ?? []).length;
export const totalIn = (text: string, list: string[]) => list.reduce((n, p) => n + countIn(text, p), 0);

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

export const BANNED = ["Top Pick", "What CL Found", `${TESTER} approved`, "CL Approved", "Approved Quality"];
export const BRAND_RANKING = /\b(?:best|top|#1|number one|top[- ]rated|highest[- ]rated)\s+brands?\b|\bbrand rankings?\b|\bbrands?,? ranked\b|\branked (?:the )?brands?\b/i;

export const clip = (l: string, n = 120) => { const t = l.trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
