/** Body checks split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23): number fidelity against the
 *  raw (US-42 AC2), hedging (AC3) and deleted sentences and headings (AC4). */
import { LIST_ITEM, TOKEN_RE, W, classifyLines, normChars, stripNoise, tokenCounts, tokenise } from "./knowledge-tokenise";
import { HARDENERS, HEDGES, cleanSentence, clip, countIn, headings, normQuote, quoteSource, sentences, totalIn } from "./knowledge-batch-check-text";
import type { Ctx, Entry } from "./knowledge-batch-check-report";
import { Check } from "./knowledge-batch-check-report";
import type { RawSet } from "./knowledge-batch-check-sources";
import { primaryIds, refLines } from "./knowledge-batch-check-sources";

/** A quote hit must not start or end inside a number or word: "7 mg for 12 weeks" is not inside "1.7 mg for 12 weeks", nor "500 mg" inside "1 500 mg". */
const atBoundary = (hay: string, q: string, i: number) => {
  const alnum = /[\p{L}\d]/u, end = i + q.length;
  const before = alnum.test(hay[i - 1] ?? "") || (/[.,]/.test(hay[i - 1] ?? "") && /\d/.test(hay[i - 2] ?? "")) || (/^\d{3}(?!\d)/.test(q) && /(?<![\d.,])\d{1,3} $/.test(hay.slice(Math.max(0, i - 5), i))); // "1 500"
  const after = alnum.test(hay[end] ?? "") || (/[.,]/.test(hay[end] ?? "") && /\d/.test(hay[end + 1] ?? "")) || (/(?<![\d.,])\d{1,3}$/.test(q) && /^ \d{3}(?![\d])/.test(hay.slice(end, end + 5)));
  return !(alnum.test(q[0]) && before) && !(alnum.test(q[q.length - 1]) && after);
};

export const hasQuote = (hay: string, q: string) => {
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) if (atBoundary(hay, q, i)) return true;
  return false;
};

/** True when the quote starts or ends inside a number-word expression of `hay` ("twenty mg" cut from "one hundred twenty mg"). */
function splitsNumberWords(hay: string, q: string, i: number): boolean {
  const nw = new RegExp(`^(?:${W})$`, "i");
  const first = /^[a-z]+/i.exec(q)?.[0] ?? "", last = /[a-z]+$/i.exec(q)?.[0] ?? "";
  if (nw.test(first)) {
    const before = hay.slice(0, i).trimEnd().split(/\s+/).slice(-2).map((w) => w.replace(/^[^a-z]+/i, ""));
    const p1 = before[before.length - 1] ?? "";
    if (nw.test(p1) || (/^and$/i.test(p1) && /^(?:hundred|thousand)$/i.test(before[0] ?? "") && before.length === 2)) return true;
  }
  if (nw.test(last)) {
    const after = hay.slice(i + q.length).trimStart().split(/\s+/).slice(0, 2).map((w) => w.replace(/^[^a-z]+/i, ""));
    if (nw.test(after[0] ?? "") || (/^and$/i.test(after[0] ?? "") && /^(?:hundred|thousand)$/i.test(last) && nw.test(after[1] ?? ""))) return true;
  }
  return false;
}

/** Find `q` in `hay`, then re-tokenise the whole words around each hit: the token must be a whole token there ("7 mmol/L" is not "1.7 mmol/L"). */
function findWhole(hay: string, q: string, tok: string, lined = false): "ok" | "partial" | "absent" {
  let found = false;
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
    found = true;
    if (!atBoundary(hay, q, i)) continue;
    let a = i, b = i + q.length;
    if (splitsNumberWords(hay, q, i)) continue;
    while (a > 0 && !/\s/.test(hay[a - 1])) a--;
    while (b < hay.length && !/\s/.test(hay[b])) b++;
    const words = tokenise(hay.slice(a, b), { keepRefs: true });
    // A multi-line quote carries its own comparator line; the flattened raw cannot show it, the bare number must still stand.
    if (words.has(tok) || (lined && /^[≥≤><]/.test(tok) && words.has(tok.slice(1)))) return "ok";
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
function citedForEntry(bodyLine: string, tok: string, body: string, tokensOf: (s: string) => Set<string>): Set<string> | null {
  let out: Set<string> | null = null;
  const holding = sentences(bodyLine).filter((x) => tokensOf(x).has(tok));
  for (const sn of holding.length ? holding : [bodyLine]) {
    const ids = citedPubmedIds(body, sn);
    if (ids) { out = out ?? new Set(); ids.forEach((i) => out!.add(i)); }
  }
  return out;
}

/** Body lines where the checker finds `tok`, for the writer to locate. */
function linesWith(body: string, tok: string): string {
  const hits = classifyLines(body).filter((x) => !x.ref).map((x) => x.line).filter((l) => tokenCounts(l).has(tok)).slice(0, 3).map((l) => `"${clip(l, 120)}"`);
  return hits.length ? `; found in: ${hits.join(" | ")}` : "";
}

/** Number tokens that grew between each new sentence and its nearest base sentence: a dose swap between sentences shows here even when the whole-body counts are equal. */
type PairSentence = { sentence: string; inPlace: boolean };
type PairInfo = { pairs: Map<string, PairSentence[]>; orphans: { sentence: string; tokens: string[] }[] };
/** The sentence with its numbers masked: two sentences with the same frame differ only in their values. */
const frame = (t: string) => stripNoise(normChars(t)).toLowerCase().replace(TOKEN_RE(), "#").replace(/\s+/g, " ").trim();
// Bare one- or two-digit integers ("type 2", "1 in 36") are identifiers or counts; AC4 covers their sentences.
const carriesValue = (tok: string) => /^[≥≤><]/.test(tok) || tok.includes(" ") || tok.includes(".") || /^\d{3,}/.test(tok);

export function pairTokenChanges(c: Ctx): PairInfo {
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

export function checkAc2(c: Ctx, added: string[], ac2: Check, raw: RawSet, info: PairInfo): number {
  const rep = c.rep!, tag = `${c.handle}:`;
  const bodyLines = new Set(c.newBody.split(/\r?\n/).map(cleanSentence).filter(Boolean));
  const proseLines = new Set(classifyLines(c.newBody).filter((x) => !x.ref).map((x) => cleanSentence(x.line)).filter(Boolean)); // reference-list lines never need an entry
  const ctxLines = c.newBody.split(/\r?\n/);
  /** Tokens of a body line as the whole-body pass reads them: a list item inherits the comparator of the line above it. */
  const lineTokens = (bl: string): Set<string> => {
    const target = cleanSentence(bl), idx = ctxLines.findIndex((l) => cleanSentence(l) === target);
    if (idx < 0 || !LIST_ITEM.test(ctxLines[idx])) return tokenise(bl, { keepRefs: true });
    let head = idx - 1;
    while (head >= 0 && (LIST_ITEM.test(ctxLines[head]) || !ctxLines[head].trim())) head--;
    if (head < 0) return tokenise(bl, { keepRefs: true });
    const base = tokenCounts(ctxLines[head], { keepRefs: true });
    return new Set([...tokenCounts(`${ctxLines[head]}\n${ctxLines[idx]}`, { keepRefs: true })].filter(([t, n]) => n > (base.get(t) ?? 0)).map(([t]) => t));
  };
  const sources = (prefixed: boolean, src?: string) => (prefixed ? raw.extras.filter((x) => !src || x.repoRel === src) : raw.main ? [{ ...raw.main, path: "" }] : []);
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
    const prefixed = /^\s*(?:NIH|EXTRA|POST:[^:\s]+|POSITION:[^:\s]+):\s*/.exec(entry.raw_quote);
    // POST:<handle>: and POSITION:<path>: name one repo file (US-50 AC1); NIH: and EXTRA: search every extra_raw.
    const named = quoteSource(entry.raw_quote), src = named?.rel;
    if (named?.kind === "POSITION" && src!.startsWith("docs/blog/")) return fail(`POSITION: names a post (${src}); quote a post with POST:<handle>: ${line}`);
    if (src && !raw.extras.some((x) => x.repoRel === src)) return fail(`raw_quote names ${src}, which is not an extra_raw file: ${line}`);
    const quote = prefixed ? entry.raw_quote.slice(prefixed[0].length) : entry.raw_quote;
    const q = normQuote(quote);
    if (q.length < 30 && q.split(" ").length < 6) return fail(`raw_quote too short (need 6 words or 30 characters): ${line}`);
    const inQuote = tokenise(quote, { keepRefs: true });
    const shared = [...lineTokens(entry.body_line)].filter((t) => inQuote.has(t));
    if (!shared.length) {
      const verbatim = sources(!!prefixed, src).some((x) => hasQuote(x.norm, q));
      if (!verbatim) return fail(`raw_quote is not in the raw file: ${line}`);
      if (lineTokens(entry.body_line).size) return fail(`raw_quote shares no number with its body_line: ${line}`);
      ac2.warns.push(`${label} entry supports no number in its body_line: ${line}`); return new Set(); }
    const hits = new Map<string, { pmid: string | null; path: string }[]>();
    let partial = false;
    for (const x of sources(!!prefixed, src)) {
      for (const tok of shared) {
        const r = findWhole(x.norm, q, tok, /\n/.test(quote.trim()));
        if (r === "ok") hits.set(tok, [...(hits.get(tok) ?? []), { pmid: x.pmid, path: "path" in x ? x.path : "" }]); else if (r === "partial") partial = true;
      }
    }
    if (!hits.size) return fail(partial ? `raw_quote: its numbers are not whole tokens in the raw: ${line}` : `raw_quote is not in the raw file: ${line}`);
    // A number whose own sentence cites a PubMed record must be quoted from that record's abstract, not licensed-source or NIH text.
    const ok = new Set<string>();
    for (const [tok, ms] of hits) {
      const cited = c.type === "reference" ? citedForEntry(entry.body_line, tok, c.newBody, lineTokens) : null;
      if (!cited || ms.some((m) => m.pmid !== null && cited.has(m.pmid))) ok.add(tok);
    }
    if (!ok.size) return fail(`number cited to a primary study without its abstract in reach: ${line}`);
    const where = [...hits.values()].flat().find((m) => m.path);
    if (where) ac2.infos.push(`${label} matched in extra_raw ${where.path}`);
    return ok;
  };
  const entries = rep.changed_tokens.flatMap((e, i) => {
    return e.void ? [] : [{ e, ok: verifyEntry(e, i) }]; // loadCtx lists the voids
  });
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
      // Suppress the duplicate diagnostic only when an entry for this token actually failed and said so.
      const attempted = entries.some((x) => !x.ok && lineTokens(x.e.body_line).has(tok) && tokenise(x.e.raw_quote, { keepRefs: true }).has(tok));
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
  for (const line of proseLines) {
    if (baseLines.has(line)) continue;
    const want = [...lineTokens(line)].filter((t) => needed.has(t) && !failed.has(t));
    const have = new Set(valid.filter((e) => cleanSentence(e.body_line) === line).flatMap((e) => [...e.ok]));
    const lack = want.filter((t) => !have.has(t));
    if (lack.length) ac2.fails.push(`${tag} body line has no entry quoting ${lack.map((t) => `"${t}"`).join(", ")}: ${clip(line, 120)}`);
  }
  // A new sentence with no base match that carries a number needs an entry on that sentence.
  for (const o of info.orphans) {
    const toks = o.tokens.filter((t) => !emergencyOnly(c.newBody, t));
    if (!toks.length || toks.some((tk) => added.includes(tk))) continue; // none, or already reported as a new token
    const bare = (t: string) => t.replace(/^[≥≤><]/, ""); // a list item's comparator comes from the line above it
    if (!valid.some((e) => relates(e.body_line, o.sentence) && toks.some((t) => [...e.ok].some((k) => bare(k) === bare(t))))) ac2.fails.push(`${tag} new numeric sentence has no entry: ${clip(o.sentence, 120)}`);
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

export function checkAc3(c: Ctx, hedgeBefore: number, hedgeAfter: number, ac3: Check) {
  const tag = `${c.handle}:`;
  const bs = sentences(c.baseBody), ns = sentences(c.newBody);
  const bset = new Set(bs), nset = new Set(ns);
  const baseOnly = [...bset].filter((x) => !nset.has(x)), newOnly = [...nset].filter((x) => !bset.has(x));
  const entries = (c.rep?.deleted_sentences ?? []).filter((d) => !d.void);
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
  if (type === "guideline") return body;
  return classifyLines(body).filter(({ ref }) => !ref).map((x) => x.line).join("\n");
}

export function checkAc4(c: Ctx, ac4: Check): number {
  const tag = `${c.handle}:`;
  const nowS = new Set(sentences(ac4Body(c.newBody, c.type)));
  const entries = (c.rep?.deleted_sentences ?? []).filter((d) => !d.void);
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

