/**
 * Batch acceptance checks for the knowledge refresh (plan 2026-09-29, Phase 0
 * step 5; story US-42 in docs/user-stories.md: AC1-AC4, AC6, AC7, AC11). No model calls. Raw third-party text is read from
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
 *  - Known limits (not fixed): a list item whose inherited comparator changes while its own text stays the same is not
 *    re-checked; two identical list items under different comparator lead-ins resolve to the first occurrence.
 *  - Comparator words are matched longest-first ("no more than" is <=, never ">" from "more than").
 *  - An unchanged (frozen) summary passes even with a proposed correction: the orchestrator applies
 *    corrections later under the paired-arm rule. A summary that changed must equal the proposal.
 *  - A changed_tokens entry may carry "void": true and a "void_reason". Reports are append-only, so a wrong entry is
 *    voided, not deleted: every AC2 check skips it, it never covers a token, and the run lists "VOID <section> <i>: <reason>"
 *    (--out shows a 12-character sha256 of the reason, never its text). current_view_basis, deleted_sentences, extra_raw,
 *    ask_brad, grokipedia_claims and positions_drift entries void the same way; needs_pubmed entries never do.
 *  - After the first write a report is never edited, even to append (Brad 2026-10-20): a correction is a sibling
 *    <handle>.addendum-<N>.json, N = 1, 2, 3 with no gap (see applyAddenda). It appends entries, voids entries with a
 *    reason, or sets proposed_summary_correction; anything else fails. --out prints each report file with its sha256.
 *  - Several extra_raw entries may name one path: any sha256 that matches accepts it; the rest are INFO "superseded sha".
 *  - AC6 allows the --out report path inside the repo: the batch report commits with the batch.
 *
 *   Topic-master batches (US-50 AC1, US-42 AC1 amended) add --masters (put it last or before another flag): on a
 *   reference the frontmatter may gain or change `reviewed: "YYYY-MM-DD"` and a one-line JSON `sources:`, and the
 *   summary may change to the proposed correction; on a post it may gain `topics:` (JSON string array) and
 *   `router: hidden`. Every other field stays protected. A reference with `reviewed` also gets the MASTER body check.
 *   New master batches also pass --key-safety-points (after --masters): each master with a view then FAILS without a
 *   sound "## Key safety points" section (US-50 AC12). Opt-in because the batch-1 and batch-2 masters predate the rule.
 *
 *   Condition-guide batches (US-70 AC1) add --guides instead: every batch handle must be a guideline marked
 *   `kind: condition`, which may be new or rewritten, with its index entry added or changed; the GUIDE check fails a
 *   guide with bad keys (reviewed, sources, thresholds), over 35,000 characters, missing a template section or out of
 *   order, or a red flag without the exact emergency line (guideErrors, shared with knowledge-lint.ts). AC7's reference
 *   checks run on each guide too (citations, link text, identifiers for --check-ids, abstract files for new PubMed
 *   lines), with guide hosts: PubMed, doi.org, NIH ODS, DailyMed, accessdata.fda.gov, the sites the guide's own
 *   `sources:` names, and Brad's video posts; never a licensed testing site.
 *
 *   npx tsx tools/knowledge-batch-check.ts --print-schema
 *   npx tsx tools/knowledge-batch-check.ts --example <handle>
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EVIDENCE_OPENING, isScope, validateExceptions } from "./knowledge-master-rules";
import { normChars, tokenCounts, tokenise, unescapeMd } from "./knowledge-tokenise";
import { GUIDANCE, HEDGES, VIEW_HEADING, cleanSentence, clip, duplicateKeys, fmValue, guideErrors, jsonOf, keySafetyErrors, masterKeyError, normQuote, productMentions, quoteSource, sentences, sha256, splitFrontmatter, squash, totalIn } from "./knowledge-batch-check-text";
import type { Ctx, Exception, Options, Result, Row } from "./knowledge-batch-check-report";
import { Check, DIR_FOR, REPORT_SCHEMA, exampleReport, git, gitShow, loadCtx, readOpt } from "./knowledge-batch-check-report";
import type { PrimaryId, RawSet } from "./knowledge-batch-check-sources";
import { MASTER_RAW, bradLink, checkAc7, guideHosts, loadRaw, verifyIds } from "./knowledge-batch-check-sources";
import { checkAc2, checkAc3, checkAc4, hasQuote, pairTokenChanges } from "./knowledge-batch-check-numbers";
export { normChars, tokenCounts, tokenise, unescapeMd };
export { validateExceptions };
export { BULLET_LINE, EMERGENCY_LINE, GUIDE_SECTIONS, GUIDE_SOURCE_NAMES, MAX_GUIDE_CHARS, MAX_KEY_POINTS_CHARS, PRODUCT_NAMES, SOURCE_NAMES, VIEW_HEADING, cleanSentence, duplicateKeys, fmValue, guideErrors, headings, isGuideText, keySafetyErrors, masterKeyError, normQuote, productMentions, sentences, sha256, splitFrontmatter, validDate } from "./knowledge-batch-check-text";
export type { Entry, Exception, Options, Report, Result, Row, Status } from "./knowledge-batch-check-report";
export { ADDENDUM_VOID, REPORT_SCHEMA, applyAddenda, exampleReport, validateReport } from "./knowledge-batch-check-report";

const MASTER_INDEX_KEYS = ["reviewed", "topics", "router"];
const MASTER_FRONT: Record<string, string[]> = { reference: ["reviewed", "sources"], video: ["topics", "router"] };

/** US-50 AC1: only the master keys for this page type and a summary that equals the proposal may change. */
function checkMasterFront(c: Ctx, bf: string, nf: string, corrections: Map<string, string>, ac1: Check) {
  const keys = MASTER_FRONT[c.type ?? ""] ?? [];
  for (const k of duplicateKeys(nf)) ac1.fails.push(`${c.rel}: frontmatter key ${k} appears more than once`);
  const rest = (f: string) => f.split(/\r?\n/).filter((l) => l && l !== "---" && ![...keys, "summary"].some((k) => l.startsWith(`${k}:`))).join("\n");
  if (rest(bf) !== rest(nf)) ac1.fails.push(`${c.rel}: frontmatter differs beyond the summary line and the master keys (${keys.join(", ") || "none for this type"})`);
  const summaryOf = (f: string) => {
    const v = fmValue(f, "summary") ?? "";
    return (jsonOf(v) as string | undefined) ?? v.replace(/^'|'$/g, "");
  };
  const want = corrections.get(c.handle);
  if (squash(summaryOf(nf)) !== squash(summaryOf(bf)) && (want === undefined || squash(summaryOf(nf)) !== squash(want))) {
    ac1.fails.push(`${c.rel}: summary line differs from proposed_summary_correction${want === undefined ? " (none proposed)" : ""}`);
  }
  for (const k of keys) {
    const v = fmValue(nf, k);
    const err = v === null ? null : masterKeyError(k, v);
    if (err) ac1.fails.push(`${c.rel}: ${k}: ${err}`);
  }
  const has = (k: string) => fmValue(nf, k) !== null;
  if (c.type === "reference" && has("reviewed") !== has("sources")) ac1.fails.push(`${c.rel}: reviewed and sources go together (a master needs both)`);
  if (c.type !== "reference" && has("router") && !has("topics")) ac1.fails.push(`${c.rel}: router: hidden needs topics`);
}

/**
 * Under --masters every batch reference is a master: reviewed and sources, one Current view or Current evidence position,
 * and a videos section. Each Current view sentence links a video post or a position file that is an extra_raw (US-50 AC1).
 */
function checkMasterBody(c: Ctx, m: Check, raw: RawSet | null, isPost: (h: string) => boolean, keyPoints?: boolean) {
  if (c.type !== "reference" || c.newText === null) return;
  if (keyPoints) for (const e of keySafetyErrors(c.newBody)) m.fails.push(`${c.handle}: ${e}`);
  const front = splitFrontmatter(c.newText).front;
  for (const k of ["reviewed", "sources"]) if (fmValue(front, k) === null) m.fails.push(`${c.handle}: a master needs ${k} in its frontmatter`);
  const secs: { line: string; text: string[] }[] = [];
  let fence = false;
  for (const line of c.newBody.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^#{1,2}\s/.test(line)) secs.push({ line, text: [] }); else secs.at(-1)?.text.push(line);
  }
  const views = secs.filter((s) => VIEW_HEADING.test(s.line));
  if (views.length !== 1) m.fails.push(`${c.handle}: needs exactly one of "## Current view (reviewed …)" or "## Current evidence position" (found ${views.length})`);
  const view = views.length === 1 ? views[0] : null, isView = !!view && !!VIEW_HEADING.exec(view.line)![1];
  const said = view ? sentences(view.text.join("\n")) : [];
  if (view && !said.length) m.fails.push(`${c.handle}: "${view.line.replace(/^##\s+/, "")}" is empty`);
  if (view && !isView && said.length && squash(said[0]) !== EVIDENCE_OPENING) m.fails.push(`${c.handle}: a Current evidence position must open with "${EVIDENCE_OPENING}"`);
  // Each Current view sentence has a current_view_basis entry for that exact sentence whose quote is verbatim, at base, in
  // the file it names: POST:<handle>: for a sentence linking that post, POSITION:<path>: for "(Brad's current guidance, …)".
  const postsIn = (sn: string) => [...sn.matchAll(/\]\(([^)\s]+)\)/g)].map(([, u]) => bradLink(u)?.[1]?.toLowerCase()).filter((h): h is string => !!h);
  const verified = (sn: string) => (c.rep?.current_view_basis ?? []).filter((b) => !b.void).flatMap((b) => {
    const named = cleanSentence(String(b.sentence ?? "")) === sn ? quoteSource(String(b.quote ?? "")) : null;
    const x = named && !(named.kind === "POSITION" && named.rel.startsWith("docs/blog/")) ? raw?.extras.find((e) => e.repoRel === named.rel) : undefined;
    const q = normQuote(named?.text ?? "");
    return x && !(q.length < 30 && q.split(" ").length < 6) && hasQuote(x.norm, q) ? [named!] : [];
  });
  const supported = (sn: string) => {
    const v = verified(sn);
    return postsIn(sn).some((h) => isPost(h) && v.some((n) => n.kind === "POST" && n.rel === `docs/blog/${h}.md`)) ||
      (GUIDANCE.test(sn) && v.some((n) => n.kind === "POSITION"));
  };
  for (const [, u] of c.newBody.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^[a-z]+:/i.test(u) && MASTER_RAW.test(u)) m.fails.push(`${c.handle}: the body links a repo file (${u}); cite a position as "(Brad's current guidance, <D Mon YYYY>)"`);
  const scope = isView ? said.filter((sn) => !supported(sn) && isScope(sn, c.handle)) : [];
  if (scope.length > 1) m.fails.push(`${c.handle}: a Current view holds more than one uncited scope sentence: ${clip(scope[1], 100)}`);
  if (scope.length && said.every((sn) => scope.includes(sn))) m.fails.push(`${c.handle}: a Current view holds only a scope sentence`);
  if (isView) for (const sn of said) if (!supported(sn) && sn !== scope[0]) m.fails.push(`${c.handle}: Current view sentence has no current_view_basis entry for this exact sentence with a verbatim POST:<the linked post>: or POSITION:<path>: quote (6 words or 30 characters): ${clip(sn, 100)}`);
  if (view && !isView) for (const sn of said) if (postsIn(sn).length || /\(Brad['’]s current guidance/.test(sn)) m.fails.push(`${c.handle}: a Current evidence position cites Brad (a post link or his current guidance): ${clip(sn, 100)}`);
  const videos = secs.filter((s) => /^##\s+Brad['’]s videos on this topic\s*$/.test(s.line));
  if (videos.length !== 1) { m.fails.push(`${c.handle}: needs one "## Brad's videos on this topic" section (found ${videos.length})`); return; }
  const text = videos[0].text.join("\n").trim(), none = /^none yet\.$/i.test(text);
  if (!text || /^none\.?$/i.test(text)) m.fails.push(`${c.handle}: "Brad's videos on this topic" ${text ? "says None" : "is empty"} (write "None yet." if there are none)`);
  else if (view && !isView && !none) m.fails.push(`${c.handle}: a Current evidence position says Brad has no video, but "Brad's videos on this topic" lists some`);
  else if (isView && none && said.some((sn) => postsIn(sn).length)) m.fails.push(`${c.handle}: "Brad's videos on this topic" says None yet, but the Current view cites a post`);
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
        if (o.guides && batch.has(h) && y?.type === "guideline" && y.kind === "condition") { ac1.infos.push(`allowed guide entry: ${h}`); continue; }
        const free = o.masters ? ["summary", ...MASTER_INDEX_KEYS] : ["summary"];
        const summaryMoved = JSON.stringify(x?.summary) !== JSON.stringify(y?.summary);
        const ok = batch.has(h) && (corrections.has(h) || (o.masters && !summaryMoved)) && x && y &&
          Object.keys({ ...x, ...y }).every((k) => free.includes(k) || JSON.stringify(x[k]) === JSON.stringify(y[k]));
        if (ok && corrections.has(h) && summaryMoved && squash(String(y.summary ?? "")) !== squash(corrections.get(h)!)) ac1.fails.push(`${idxRel}: index.json summary for "${h}" differs from proposed_summary_correction`);
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
    if (o.guides) continue; // the GUIDE check owns a guide's frontmatter
    if (o.masters) { checkMasterFront(c, bf, nf, corrections, ac1); continue; }
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

export function runBatch(o: Options): { results: Result[]; rows: Row[]; baseSha: string } {
  const base = o.base;
  const baseSha = git(o.root, ["rev-parse", base]).trim();
  const ac1 = new Check("AC1", "index.json and categories.json unchanged (except approved summary corrections)");
  const ac2 = new Check("AC2", "raw fidelity of every new number token");
  const ac3 = new Check("AC3", "hedging held; hardening words listed");
  const ac4 = new Check("AC4", "deleted sentences justified; headings kept");
  const ac6 = new Check("AC6", "diff touches only batch files");
  const ac7 = new Check("AC7", "grokipedia, products, references, banned phrases");
  const master = new Check("MASTER", "topic-master sections (Current view or evidence position, Brad's videos)");
  const guide = new Check("GUIDE", "condition-guide keys, cap, template sections and emergency line");
  const rows: Row[] = [];
  let index = new Map<string, { type?: string }>();
  try {
    index = new Map((JSON.parse(readOpt(join(o.root, "docs/blog/index.json")) ?? "[]") as { handle: string; type?: string }[]).map((e) => [e.handle, e]));
  } catch { /* AC1 reports an unparseable index */ }
  const ctxs = o.handles.map((h) => loadCtx(o, base, h, ac2, index));
  const isPost = (h: string) => index.has(h) && !index.get(h)!.type; // a video post: an index entry with no type
  const ids = new Map<string, PrimaryId & { handle: string }>();

  checkAc1(o, base, ctxs, ac1);
  for (const c of ctxs) {
    const newTokens = tokenCounts(c.newBody), baseTokens = tokenCounts(c.baseBody);
    const added = [...newTokens].filter(([t, n]) => n > (baseTokens.get(t) ?? 0)).map(([t]) => t);
    const hedgeBefore = totalIn(c.baseBody, HEDGES), hedgeAfter = totalIn(c.newBody, HEDGES);
    let quoted = 0, deleted = 0;
    const raw = c.rep ? loadRaw(c.rep, o, `${c.handle}:`, ac2, isPost) : null;
    if (c.newText !== null) {
      if (c.rep && raw) quoted = checkAc2(c, added, ac2, raw, c.baseText !== null ? pairTokenChanges(c) : { pairs: new Map(), orphans: [] });
      if (o.masters) checkMasterBody(c, master, raw, isPost, o.keySafetyPoints);
      if (o.guides) for (const e of c.type === "guideline" ? guideErrors(c.newText) : ["not a guideline"]) guide.fails.push(`${c.handle}: ${e}`);
      checkAc3(c, hedgeBefore, hedgeAfter, ac3);
      if (c.baseText !== null) deleted = checkAc4(c, ac4);
      checkAc7(c, ac7, raw ? raw.abstracts : [], ids, o.masters || o.guides ? isPost : undefined, o.guides ? guideHosts(c.newText) : undefined);
    }
    rows.push({ handle: c.handle, type: c.type ?? "?", file: c.rel, rawRel: raw?.main?.rel ?? "-", rawSha: c.rep?.raw_sha256 ?? "-",
      bodySha: sha256(c.newBody), tokensNew: added.length, quoted, deleted, hedgeBefore, hedgeAfter,
      productsBefore: productMentions(c.baseBody), productsAfter: productMentions(c.newBody), reportFiles: c.reportFiles });
  }

  if (o.checkIds) verifyIds(ids, o, ac7);

  // AC6 (only the directory of each entry's type) and nothing-to-check.
  const changed = new Set([
    ...git(o.root, ["diff", "--name-only", "--no-renames", base]).split("\n"),
    ...git(o.root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean));
  const allowed = new Set<string>(o.outRel ? [o.outRel] : []);
  if (o.masters || o.guides) {
    allowed.add(`docs/knowledge-refresh/${o.batch}-notes.md`);
    // The exceptions file is a batch file only once committed: a run must not pass on exceptions written after it started.
    const exRel = `docs/knowledge-refresh/exceptions-${o.batch}.json`;
    if (!git(o.root, ["status", "--porcelain", "--", exRel]).trim()) allowed.add(exRel);
  }
  if (!ac1.fails.length) { allowed.add("docs/blog/index.json"); allowed.add("docs/blog/categories.json"); } // AC1 accepted them
  for (const c of ctxs) {
    const mine = (c.type ? [DIR_FOR[c.type]] : ["blog", "guideline"]).map((d) => `docs/${d}/${c.handle}.md`);
    mine.forEach((f) => allowed.add(f));
    if (!mine.some((f) => changed.has(f))) ac6.fails.push(`nothing to check for ${c.handle}: the diff against ${base} touches none of its files`);
  }
  for (const f of changed) {
    if (!allowed.has(f)) ac6.fails.push(`unexpected change: ${f}`);
  }
  ac6.infos.push(`${changed.size} changed paths versus ${base}`);
  ac6.infos.push("Shopify updated_at snapshot: separate tool, NOT checked here");

  const used = new Set<Exception>();
  const results = [ac1, ac2, ac3, ac4, ac6, ac7, ...(o.masters ? [master] : []), ...(o.guides ? [guide] : [])].map((c) => c.result(o.exceptions, used));
  for (const x of o.exceptions ?? []) {
    if (used.has(x)) continue;
    const r = results.find((y) => y.id === x.check) ?? results[results.length - 1];
    r.evidence.unshift(`FAIL unused exception (${x.check}, ${x.handle}): ${clip(x.match, 80)}`);
    r.status = "FAIL";
  }
  return { results, rows, baseSha };
}


/** A batch report must not sit under docs/blog or on any file the batch checks. */
export function validateOut(outRel: string, handles: string[]): string | null {
  if (outRel.startsWith("docs/blog/")) return `--out ${outRel} is under docs/blog`;
  const checked = handles.flatMap((h) => ["blog", "guideline"].map((d) => `docs/${d}/${h}.md`));
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
    "| handle | type | raw (relative) | raw sha256 | body sha256 | new tokens | quoted | sentences removed | hedge | products | diff report + addenda (sha256) |",
    "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.slice(0, cap)) {
    L.push(`| ${r.handle} | ${r.type} | ${r.rawRel} | ${r.rawSha} | ${r.bodySha.slice(0, 16)} | ${r.tokensNew} | ${r.quoted} | ${r.deleted} | ${r.hedgeBefore}>${r.hedgeAfter} | ${r.productsBefore}>${r.productsAfter} | ${(r.reportFiles ?? []).map((f) => `${f.name} ${f.sha256}`).join(" + ") || "-"} |`);
  }
  if (rows.length > cap) L.push("", `${rows.length - cap} more handles omitted to stay under the line cap.`);
  // A void's reason is free text: the committed report carries only a short hash of it (review R2).
  const voids = results.flatMap((r) => r.evidence).flatMap((e) => {
    const m = /^(\S+): VOID (\w+) (\d+) (\[[\w-]+\]): ([\s\S]*)$/.exec(e);
    return m ? [`- ${m[1]}: VOID ${m[2]} ${m[3]} ${m[4]} (reason sha256 ${sha256(m[5]).slice(0, 12)})`] : [];
  });
  if (voids.length) L.push("", "## Voided entries", "", ...voids);
  const sets = results.flatMap((r) => r.evidence).filter((e) => /^\S+: proposed_summary_correction set by addendum-\d+$/.test(e));
  if (sets.length) L.push("", "## Summary corrections from addenda", "", ...sets.map((e) => `- ${e}`));
  const ex = results.flatMap((r) => r.excepted ?? []);
  if (ex.length) {
    L.push("", "## Accepted exceptions", "", "| check | handle | by | date | reason | match sha256 |", "|---|---|---|---|---|---|");
    for (const x of ex) L.push(`| ${x.check} | ${x.handle} | ${x.by} | ${x.date} | ${x.reason.replace(/\|/g, "/")} | ${sha256(x.match).slice(0, 16)} |`);
  }
  L.push("", "Body hashes are the first 16 hex characters of sha256; raw hashes are in full.", "", "## Not covered by this script", "",
    "- AC5 answer checks (harness)",
    "- AC6 Shopify updated_at snapshot (separate tool)",
    checkIds ? "- DOI/PMID resolution: checked with --check-ids (see the run output for the cap)" : "- DOI/PMID resolution: NOT checked (run with --check-ids)",
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
  const usage = (msg: string) => { console.error(`${msg}\nusage: knowledge-batch-check.ts --batch <name> --handles <file> --base <git ref> [--reports <dir>] [--out <file>] [--exceptions <file>] [--check-ids [--check-ids-cap <n>]] [--masters] [--key-safety-points] [--guides]`); return 2; };
  if (typeof a.batch !== "string" || typeof a.handles !== "string") return usage("--batch and --handles are required");
  if (typeof a.base !== "string") return usage("--base is required (no default)");
  if (a["key-safety-points"] !== undefined && a.masters === undefined) return usage("--key-safety-points needs --masters");
  if (a.masters !== undefined && a.guides !== undefined) return usage("--masters and --guides are separate batches");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const handles = readFileSync(a.handles, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const reportsDir = typeof a.reports === "string" ? resolve(a.reports) : join(homedir(), ".codex-review", "diff-reports", a.batch);
  const out = typeof a.out === "string" ? realPath(resolve(a.out)) : undefined;
  const rel = out ? relative(root, out) : "";
  const outRel = out && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
  if (outRel) { const bad = validateOut(outRel, handles); if (bad) return usage(bad); }
  if (a.masters !== undefined || a.guides !== undefined) {
    // A masters or guides run reads only its own committed exceptions file (US-42 AC11): none written after the run began.
    const exRel = `docs/knowledge-refresh/exceptions-${a.batch}.json`;
    if (typeof a.exceptions !== "string" || !existsSync(a.exceptions) || realPath(resolve(a.exceptions)) !== realPath(join(root, exRel))) return usage(`--${a.masters !== undefined ? "masters" : "guides"} needs --exceptions ${exRel}`);
    if (git(root, ["status", "--porcelain", "--", exRel]).trim()) return usage(`${exRel} has uncommitted changes; commit it before the run`);
  }
  let exceptions: Exception[] = [];
  if (a.exceptions !== undefined) {
    if (typeof a.exceptions !== "string" || !existsSync(a.exceptions)) return usage(`--exceptions file not found: ${String(a.exceptions)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(a.exceptions, "utf8")); } catch (e) { return usage(`--exceptions is not JSON: ${(e as Error).message}`); }
    const errs = validateExceptions(parsed);
    if (errs.length) return usage(`--exceptions invalid: ${errs.join("; ")}`);
    exceptions = parsed as Exception[];
  }
  const checkIds = a["check-ids"] === true, capArg = a["check-ids-cap"];
  if (capArg !== undefined && (typeof capArg !== "string" || !/^[1-9]\d*$/.test(capArg))) return usage("--check-ids-cap needs a positive integer");
  const { results, rows, baseSha } = runBatch({ root, batch: a.batch, handles, reportsDir, base: a.base, outRel, exceptions,
    checkIds, masters: a.masters !== undefined, keySafetyPoints: a["key-safety-points"] !== undefined, guides: a.guides !== undefined,
    idCap: typeof capArg === "string" ? Number(capArg) : undefined, ...overrides });
  for (const r of results) {
    console.log(`${r.status} ${r.id} ${r.title}`);
    for (const e of r.evidence) console.log(`    ${e}`);
  }
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, renderReport(a.batch, a.base, baseSha, results, rows, checkIds)); }
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
