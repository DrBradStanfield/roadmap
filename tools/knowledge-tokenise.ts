/** The US-42 checker's number tokeniser, split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23):
 *  number and unit normalisation, tokenCounts and tokenise. */


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

const REFS_HEADING = /^#{1,6}\s*(?:\d+[.)]?\s*)?(?:references|sources|citations|bibliography)\b/i;
export const REF_LINE = /^\s*\[(\d+)\]\s+\S/;

/** Lines of a body with their reference-section status. */
export function classifyLines(body: string): { line: string; ref: boolean }[] {
  let refLevel = 0; // level of the open References heading; a heading at that level or higher closes it
  return body.split(/\r?\n/).map((line) => {
    const level = /^(#{1,6})\s/.exec(line)?.[1].length ?? 0;
    if (level && (!refLevel || level <= refLevel)) refLevel = REFS_HEADING.test(line) ? level : 0;
    return { line, ref: (refLevel > 0 && !level) || REF_LINE.test(line) };
  });
}


/** A month name, short or long, in a "15 Oct 2026" date. */
export const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}";

// Tokeniser: units, longest first; the lookahead stops "mg" matching inside "mgs" etc.
// Compound units come first so "2 mg/kg" is not "2 mg", and "90 g/L" is not "90 g/dL".
export const UNIT = [
  "mL/min/1\\.73m2", "mmol/mol", "mmol/L", "nmol/L", "pmol/L", "[µμ]mol/L", "umol/L", "micromol/L", "micromole/L", "mg/mmol", "mg/dL", "mg/kg", "mg/L",
  "mL/min", "L/min", "breaths/min", "IU/L", "U/L", "g/dL", "g/L", "ng/mL", "ng/dL", "ng/L", "nanogram/L", "[µμ]g/dL", "mcg/dL", "[µμ]g/L", "mcg/L",
  "mmHg", "bpm", "x/day", "times daily", "percent", "%",
  "kilograms?", "milligrams?", "micrograms?", "microg", "nanograms?", "millilitres?", "milliliters?", "litres?", "liters?", "grams?",
  "mcg", "[µμ]g", "mg", "IU", "mL", "kg", "cm", "g", "hours?", "hrs?", "h", "days?", "d", "weeks?", "wks?", "months?", "years?", "minutes?", "mins?", "seconds?", "secs?",
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
const SUFFIX = "(?:\\s*/\\s*|\\s+per\\s+)(?:day|dose|week|kg|d)|\\s+(?:a|each)\\s+(?:day|week)|\\s+(?:daily|weekly)";
const suffixOf = (raw: string | undefined) => (!raw ? "" : /week/i.test(raw) ? "/week" : /dose/i.test(raw) ? "/dose" : /kg/i.test(raw) ? "/kg" : "/day");
// Groups: 1 leading comparator, 2 and 3 numbers, 4 trailing comparator, 5 unit, 6 unit suffix (/day, per dose ...),
// 7 any other attached "/x/y" (kept: "5 mg/m2" is not "5 mg"), 8 trailing comparator. A range may read "X-Y", "X to Y" or "X and Y".
const GENERIC = "/[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*(?:/[A-Za-z0-9][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)*)*";
export const TOKEN_RE = () => new RegExp(
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
const RANGE_TAIL = new RegExp(`^\\s+(?:to|and)\\s+(?:${NUM})\\s*(?:${UNIT})(?![A-Za-z])`, "i");
const DAILY_NEAR = /^\s+(?:daily|per\s+day|a\s+day|\/\s*day)\b/i;
export const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
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
  if (/^(µg|μg|mcg|microg|micrograms?)$/.test(l)) return "mcg";
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
  if (/^wks?$/.test(l)) return "week";
  if (/^(h|hrs?)$/.test(l)) return "hour";
  if (l === "d") return "day";
  return l.replace(/s$/, "");
}

function normNumber(n: string, unit: string): { value: string; unit: string } {
  let v = parseFloat(n.replace(/,/g, ""));
  if (unit === "g") { v = Number((v * 1000).toFixed(6)); unit = "mg"; }
  else if (unit === "mcg" && v >= 1000) { v = Number((v / 1000).toFixed(6)); unit = "mg"; } // "1,000 micrograms" is "1 mg"
  return { value: String(v), unit };
}

/** Topic-master dates (US-50): the view heading, a "([Brad, 15 Oct 2026](" or "(Brad's current guidance, 15 Oct 2026)" citation, and a "- 15 Oct 2026, [" video line. */
const MASTER_DATES = new RegExp(`^(?:(?:##\\s+)?Current view \\(reviewed \\d{1,2} ${MONTH} \\d{4}\\)\\s*$|\\s*(?:[-*]\\s+)?\\d{1,2} ${MONTH} \\d{4}(?=, \\[))|(?<=\\(\\[Brad, )\\d{1,2} ${MONTH} \\d{4}(?=\\]\\()|(?<=\\(Brad['’]s current guidance, )\\d{1,2} ${MONTH} \\d{4}(?=\\))`, "g");

/** Strip everything the tokeniser must ignore, line by line. */
export function stripNoise(line: string): string {
  return unescapeMd(line)
    .replace(MASTER_DATES, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b10\.\d{4,9}\/\S+/g, " ")
    .replace(/\bPMIDs?:?\s*\d+(?:\s*[,;]\s*\d+)*/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, " ")
    .replace(/\b(?:type\s+[12](?:\s*(?:and|or|\/|-)\s*[12])?|stage\s+[1-5])\b/gi, " ") // disease and category names, not values
    .replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, " ")
    .replace(/\b(micrograms?|microg|[µμ]g|mcg|milligrams?|mg|nanograms?|ng|grams?|g|IU|U)((?:\s+[A-Za-z-]+){0,4})\s+per\s+(?:liters?|litres?|L)\b/gi, "$1/L$2")
    .replace(/([A-Za-z])\s*[∙·⋅]\s*([A-Za-z]+)\s*(?:[-−]|⁻)[1¹]\b/g, "$1/$2") // "g∙kg-1" is g/kg
    .replace(/(\d)\s*-\s*(month|week|hour|year)ly\b/gi, "$1 $2")
    .replace(/\baged\s+(\d+(?:\.\d+)?)(?![\d.])(?!\s*(?:years?|y\b|months?|weeks?|days?|(?:[-–]|to\s|and\s)\s*\d))/gi, "aged $1 years")
    .replace(NUMWORD_UNIT, (m, w: string, sp: string) => { const v = wordValue(w); return v === null ? m : `${v}${sp}`; })
    .replace(NUMWORD_OPEN, (m, lead: string, w: string, noun: string) => {
      const v = wordValue(w);
      return v !== null && /^[A-Za-z]+s$/.test(noun) && !/(?:ss|us|is)$|^(?:was|has|does|as|this|thus)$/i.test(noun) ? `${lead}${v}` : m;
    });
}

// "six weeks" = "6 weeks"; a bare number word counts only when it opens a sentence before a plural noun ("Forty-five adults").
// A number-word expression is parsed whole ("one hundred twenty" = 120). One that does not parse yields no token, never its tail.
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export const W = `${Object.keys(WORDS).join("|")}|hundred|thousand`;
const NW = `(?:a(?=\\s+(?:hundred|thousand)\\b)|${W})(?:(?:(?<=hundred|thousand)\\s+and\\s+|[\\s-]+)(?:${W}))*`;
/** Value of a whole number-word expression, or null when it is not one. */
function wordValue(expr: string): number | null {
  const ws = expr.toLowerCase().split(/[\s-]+/).filter((w, i, a) => w !== "and" || /^(?:hundred|thousand)$/.test(a[i - 1] ?? ""));
  const under = (p: string[]): number | null => {
    let h = 0, i = 0;
    if (p[1] === "hundred" && (p[0] === "a" || (WORDS[p[0]] ?? 99) < 10)) { h = (p[0] === "a" ? 1 : WORDS[p[0]]) * 100; i = 2; }
    const r = p.slice(i).filter((w) => w !== "and");
    if (!r.length) return h || null;
    const v = r.map((w) => WORDS[w]);
    if (v.some((x) => x === undefined)) return null;
    if (r.length === 1) return h + v[0];
    return r.length === 2 && v[0] >= 20 && v[0] % 10 === 0 && v[1] < 10 ? h + v[0] + v[1] : null;
  };
  const t = ws.indexOf("thousand");
  if (t < 0) return under(ws);
  if (ws.indexOf("thousand", t + 1) >= 0) return null;
  const hi = ws.slice(0, t).join() === "a" ? 1 : under(ws.slice(0, t)), lo = t + 1 < ws.length ? under(ws.slice(t + 1)) : 0;
  return hi === null || lo === null ? null : hi * 1000 + lo;
}
const NUMWORD_UNIT = new RegExp(`(?<!\\b(?:${W})[\\s-]+)(?<!(?:hundred|thousand)\\s+and\\s+)\\b(${NW})([\\s-]+)(?=(?:${UNIT})(?![A-Za-z]))`, "gi");
const NUMWORD_OPEN = new RegExp(`(^[\\s>*_-]*|(?<=[.?!][)"'\\]*]*\\s+))(${NW})(?=\\s+([A-Za-z]+)\\b)`, "gi");

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
      const rest = s.slice(m.index! + m[0].length);
      // "2 mg to 20 mg of the compound daily": the suffix after the second value covers the first too.
      const tail = unit && !m[3] && !gen ? RANGE_TAIL.exec(rest) : null;
      const after = tail ? rest.slice(tail[0].length) : rest;
      const per = m[6] ?? (unit && FAR_DAILY_UNITS.has(unit) && !gen && (FAR_DAILY.test(after) || (tail && DAILY_NEAR.test(after))) ? "daily" : undefined);
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
