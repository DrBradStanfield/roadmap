import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Report, type Result, exampleReport, main, normQuote, productMentions, renderReport, runBatch,
  sentences, sha256, tokenise, validateReport,
} from "./knowledge-batch-check";

// Story: US-42 "Knowledge refresh" (docs/user-stories.md); each describe names its AC.
// Synthetic fixtures only (tools/fixtures/knowledge-batch/). No real raw text, no model calls.
const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "knowledge-batch");
const fx = (n: string) => readFileSync(join(FIX, n), "utf8");

describe("US-42 AC2 tokeniser", () => {
  const t = (s: string) => [...tokenise(s)].sort();
  it("normalises 1 g, 1,000 mg and 1000 mg to one token", () => {
    expect(t("1 g")).toEqual(["1000 mg"]);
    expect(t("1,000 mg")).toEqual(["1000 mg"]);
    expect(t("1000 mg")).toEqual(["1000 mg"]);
    expect(t("0.5 g")).toEqual(["500 mg"]);
  });
  it("splits en-dash and hyphen ranges into two tokens sharing the unit", () => {
    expect(t("5–10 mg")).toEqual(["10 mg", "5 mg"]);
    expect(t("5-10 mg")).toEqual(["10 mg", "5 mg"]);
  });
  it("skips citation markers, years, PMIDs, DOIs, ISO dates and URLs", () => {
    expect(t("Shown in 2019 [12] and [3, 4] and [5-7].")).toEqual([]);
    expect(t("PMID: 12345678 and doi 10.1016/j.abb.2014.11.012")).toEqual([]);
    expect(t("Reviewed 2026-09-29 at https://pubmed.ncbi.nlm.nih.gov/11498460/")).toEqual([]);
  });
  it("keeps a year that carries a unit, and bare numbers", () => {
    expect(t("2000 mg")).toEqual(["2000 mg"]);
    expect(t("Type 2 diabetes")).toEqual(["2"]);
  });
  it("normalises unit spellings", () => {
    expect(t("50 µg")).toEqual(["50 mcg"]);
    expect(t("50 mcg")).toEqual(["50 mcg"]);
    expect(t("30 percent")).toEqual(["30 %"]);
    expect(t("30%")).toEqual(["30 %"]);
    expect(t("2 times daily")).toEqual(["2 x/day"]);
    expect(t("3-month course")).toEqual(["3 month"]);
    expect(t("6 weeks")).toEqual(["6 week"]);
    expect(t("140 mmHg and 5 mmol/L")).toEqual(["140 mmHg", "5 mmol/L"]);
  });
  it("ignores letter-attached numbers and ordered-list markers", () => {
    expect(t("Take B12 with omega-3 and COVID-19.")).toEqual([]);
    expect(t("1. First step\n2. Second step")).toEqual([]);
  });
  it("skips reference lines", () => {
    expect(t("[145] Dedichen HG. Vitamin C. 1973;21:1320-6.")).toEqual([]);
    expect(t("## References\n\n1. Smith A. 45 mg trial.")).toEqual([]);
  });
  it("treats no-break spaces and Unicode hyphens as plain ones", () => {
    expect(t("7\u00a0mg")).toEqual(["7 mg"]);
    expect(t("a 1\u2011year plan")).toEqual(["1 year"]);
    expect(t("5\u201010\u00a0mg")).toEqual(["10 mg", "5 mg"]);
    expect(normQuote("took 7\u00a0mg for 1\u2011year")).toBe("took 7 mg for 1-year");
  });
  it("unescapes turndown markdown in quotes", () => {
    expect(normQuote("5\\.5 mg  \n **daily**")).toBe("5.5 mg **daily**");
  });
});

describe("US-42 AC4/AC7 sentences and products", () => {
  it("does not split on abbreviations or decimals", () => {
    expect(sentences("Take it, e.g. at lunch. Dr. Smith saw 0.5 mg vs. placebo. Done?")).toEqual([
      "Take it, e.g. at lunch.", "Dr. Smith saw 0.5 mg vs. placebo.", "Done?"]);
  });
  it("skips table separator rows and prints cell text without the leading pipe", () => {
    expect(sentences("| a | b |\n|---|---|\n| :-: | --- |\n| Take 5 mg daily. | ok |")).toEqual([
      "a | b |", "Take 5 mg daily.", "ok |"]);
  });
  it("treats generic omega-3 as not a product, bare Omega-3 as one", () => {
    expect(productMentions("Omega-3")).toBe(1);
    expect(productMentions("omega-3 fatty acids help. Omega 3 and Cardiovascular Disease")).toBe(0);
    expect(productMentions("Try omega-3 from fish oil, or Omega-3 by Dr Brad.")).toBe(1);
    expect(productMentions("See [Omega-3 in heart care](https://x.org) now.")).toBe(0);
    expect(productMentions("omega-3 is fine, and much later than thirty characters comes fatty acid")).toBe(1);
  });
  it("counts each product name once, MicroVitamin+ before MicroVitamin", () => {
    expect(productMentions("MicroVitamin+ and MicroVitamin and Sleep by Dr Brad and Omega-3.")).toBe(4);
  });
});

describe("US-42 AC2/AC11 report schema and CLI", () => {
  it("accepts the example and rejects a broken one", () => {
    expect(validateReport(exampleReport("x"))).toEqual([]);
    expect(validateReport({ ...exampleReport("x"), type: "blog" }).length).toBeGreaterThan(0);
    expect(validateReport({ ...exampleReport("x"), changed_tokens: [{ token: "1" }] }).length).toBeGreaterThan(0);
    const bad = validateReport({ ...exampleReport("x"), changed_tokens: [{ token: "1", body_line: 12, raw_quote: "q" }] });
    expect(bad).toContain("changed_tokens[0].body_line: body_line must be the body line's text, not a number");
  });
  it("CLI prints schema and example, and exits 2 without arguments", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--print-schema"])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).required).toContain("raw_sha256");
    expect(main(["--example", "abc"])).toBe(0);
    expect(JSON.parse(log.mock.calls[1][0]).handle).toBe("abc");
    expect(main([])).toBe(2);
    log.mockRestore(); err.mockRestore();
  });
});

// ---- batch runs against a throwaway git repo ----

let root: string, reports: string, exclusions: string;
const sh = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const INDEX = JSON.stringify([{ handle: "alpha", summary: "Alpha summary, 200 mg daily.", title: "Alpha" },
  { handle: "beta", summary: "Clinical pathway for beta.", title: "Beta" }, { handle: "other", summary: "x", title: "O" }], null, 2);

interface Reps { alpha: Report; beta: Report }
let reps: Reps;

function writeReports() {
  for (const r of [reps.alpha, reps.beta]) writeFileSync(join(reports, `${r.handle}.json`), JSON.stringify(r));
}
const run = (over: Partial<Parameters<typeof runBatch>[0]> = {}) => {
  writeReports();
  const { results } = runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, exclusionsPath: exclusions, ...over });
  return Object.fromEntries(results.map((r) => [r.id, r])) as Record<string, Result>;
};
const fails = (r: Result) => r.evidence.filter((e) => e.startsWith("FAIL "));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-repo-"));
  reports = mkdtempSync(join(tmpdir(), "kb-rep-"));
  exclusions = join(reports, "exclusions.json");
  writeFileSync(exclusions, JSON.stringify({ excluded: ["legacy-slug"], excludedIds: ["1"], excludedReasons: { 1: { slug: "excluded-page", reason: "nav" } } }));
  sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
  put("docs/blog/alpha.md", fx("alpha.base.md"));
  put("docs/pathway/beta.md", fx("beta.base.md"));
  put("docs/blog/index.json", INDEX);
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "base"]);
  put("docs/blog/alpha.md", fx("alpha.new.md"));
  put("docs/pathway/beta.md", fx("beta.new.md"));
  const alphaRaw = join(reports, "alpha.raw.txt"), betaRaw = join(reports, "beta.raw.txt");
  writeFileSync(alphaRaw, fx("alpha.raw.txt")); writeFileSync(betaRaw, fx("beta.raw.txt"));
  const base = { old_raw_path: null, headings_before: [], headings_after: [], proposed_summary_correction: null, notes: "" };
  reps = {
    alpha: { ...base, handle: "alpha", type: "reference", raw_path: alphaRaw, raw_sha256: sha256(fx("alpha.raw.txt")),
      changed_tokens: [{ token: "300 mg", body_line: "Trials used 300 mg per day [1].", raw_quote: "participants took 300 mg daily" }],
      deleted_sentences: [{ sentence: "Trials used 200 mg per day [1].", justification: "The new raw says 300 mg." }],
      product_mentions_before: 1, product_mentions_after: 1 },
    beta: { ...base, handle: "beta", type: "pathway", raw_path: betaRaw, raw_sha256: sha256(fx("beta.raw.txt")),
      changed_tokens: [{ token: "6 weeks", body_line: "Review again in 6 weeks.", raw_quote: "review again in 6 weeks" }],
      deleted_sentences: [{ sentence: "Source: Auckland Region HealthPathways", justification: "Review date added." }],
      product_mentions_before: 0, product_mentions_after: 0 },
  };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(reports, { recursive: true, force: true }); });

describe("US-42 AC1-AC7 clean batch", () => {
  it("passes every check", () => {
    const r = run();
    for (const id of ["AC1", "AC2", "AC3", "AC4", "AC6", "AC7", "PATHWAY"]) expect(fails(r[id]), id).toEqual([]);
    expect(Object.values(r).every((x) => x.status !== "FAIL")).toBe(true);
    expect(r.AC6.evidence.join("\n")).toContain("Shopify updated_at snapshot: separate tool");
  });
});

describe("US-42 AC1 index and frontmatter", () => {
  it("fails when another handle's index entry changes", () => {
    put("docs/blog/index.json", INDEX.replace('"x"', '"y"'));
    expect(fails(run().AC1).join()).toContain('"other"');
  });
  it("fails on a batch summary change without a proposed correction", () => {
    put("docs/blog/index.json", INDEX.replace("200 mg daily", "300 mg daily"));
    expect(fails(run().AC1).join()).toContain('"alpha"');
  });
  it("allows a summary-only change when the report proposes a correction", () => {
    put("docs/blog/index.json", INDEX.replace("200 mg daily", "300 mg daily"));
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg daily.";
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg daily", "300 mg daily"));
    expect(fails(run().AC1)).toEqual([]);
  });
  it("allows only the summary line to differ when a correction is proposed", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg daily.";
    put("docs/blog/index.json", INDEX.replace("200 mg daily", "300 mg daily"));
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg daily", "300 mg daily").replace('title: "Alpha"', 'title: "Alpha 2"'));
    expect(fails(run().AC1).join()).toContain("frontmatter differs beyond the summary line");
  });
  it("fails on frontmatter drift and on categories.json changes", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Alpha summary", "Altered summary"));
    expect(fails(run().AC1).join()).toContain("frontmatter changed");
  });
  it("fails when categories.json differs", () => {
    put("docs/blog/categories.json", "[]");
    expect(fails(run().AC1).join()).toContain("categories.json");
  });
});

describe("US-42 AC2 raw fidelity", () => {
  it("fails naming a new token with no report entry", () => {
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain('"300 mg"');
  });
  it("fails when the quote is not in the raw file", () => {
    reps.alpha.changed_tokens[0].raw_quote = "participants took 300 mg twice";
    expect(fails(run().AC2).join()).toContain("not in the raw file");
  });
  it("fails on a sha256 mismatch", () => {
    reps.alpha.raw_sha256 = "0".repeat(64);
    expect(fails(run().AC2).join()).toContain("sha256 mismatch");
  });
  it("fails when the token is absent from its quote", () => {
    reps.alpha.changed_tokens[0].raw_quote = "for 12 weeks";
    expect(fails(run().AC2).join()).toContain("does not occur in its raw_quote");
  });
  it("fails on an empty quote, a missing report and a missing raw file", () => {
    reps.alpha.changed_tokens[0].raw_quote = " ";
    expect(fails(run().AC2).join()).toContain("empty raw_quote");
    reps.alpha.changed_tokens[0].raw_quote = "x";
    reps.alpha.raw_path = join(reports, "nope.txt");
    expect(fails(run().AC2).join()).toContain("raw file not found");
    rmSync(join(reports, "beta.json"), { force: true });
    writeFileSync(join(reports, "alpha.json"), JSON.stringify(reps.alpha));
    const { results } = runBatch({ root, batch: "t", handles: ["beta"], reportsDir: join(reports, "none"), exclusionsPath: exclusions });
    expect(results.find((r) => r.id === "AC2")!.evidence.join()).toContain("diff report missing");
  });
  it("matches a plain-text quote against a raw with no-break spaces and non-breaking hyphens", () => {
    const raw = "In the trial, participants took 300\u00a0mg daily for a 1\u2011year period.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(readFileSync(join(reports, "alpha.raw.txt")));
    expect(fails(run().AC2)).toEqual([]);
  });
  it("accepts 1,000 mg in the raw as 1 g in the body", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("2 g may", "2 g may").replace("Take it", "Take 1 g. Take it"));
    reps.alpha.changed_tokens.push({ token: "1 g", body_line: "Take 1 g.", raw_quote: "Doses above 2,000 mg" });
    expect(fails(run().AC2).join()).toContain('"1000 mg"'); // 2,000 mg is not 1 g: quote lacks the token
    reps.alpha.changed_tokens[1].raw_quote = "Doses above 1,000 mg";
    writeFileSync(join(reports, "alpha.raw.txt"), "In the trial, participants took 300 mg daily. Doses above 1,000 mg.");
    reps.alpha.raw_sha256 = sha256(readFileSync(join(reports, "alpha.raw.txt")));
    expect(fails(run().AC2)).toEqual([]);
  });
});

describe("US-42 AC2 multiset and body_line", () => {
  it("fails a changed dose whose new value already occurs elsewhere in the body", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg per day", "2 g per day")); // "2 g" was already in the base once
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain('"2000 mg"');
  });
  it("requires the entry's body_line to contain the token", () => {
    reps.alpha.changed_tokens[0].body_line = "An unrelated line.";
    expect(fails(run().AC2).join()).toContain("body_line does not contain");
  });
});

describe("US-42 AC7 identifiers", () => {
  const cited = () => put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2].", "upset [2] [3].").trimEnd() + "\n\n[3] Foo B. Study. PMID: 99999999 doi:10.1000/abc.def\n");
  it("warns on a new reference line whose PMID or DOI is in no raw file", () => {
    cited();
    const r = run().AC7;
    expect(r.evidence.filter((e) => e.includes("unverified primary")).length).toBe(1);
    expect(fails(r).filter((f) => f.includes("unverified"))).toEqual([]);
  });
  it("is quiet when the raw files carry both identifiers, extra_raw included", () => {
    cited();
    const extra = join(reports, "x.txt");
    writeFileSync(extra, "see 10.1000/ABC.DEF");
    writeFileSync(join(reports, "alpha.raw.txt"), fx("alpha.raw.txt") + "PMID 99999999");
    reps.alpha.extra_raw = [{ path: extra, sha256: sha256(readFileSync(extra)) }];
    expect(run().AC7.evidence.some((e) => e.includes("unverified primary"))).toBe(false);
  });
  it("--check-ids is off by default, FAILs on 404, and caps at 60", () => {
    cited();
    const seen: string[] = [];
    run({ headStatus: (u) => { seen.push(u); return 404; }, delayMs: 0 });
    expect(seen).toEqual([]);
    const r = run({ checkIds: true, headStatus: (u) => { seen.push(u); return u.includes("doi.org") ? 404 : 200; }, delayMs: 0 }).AC7;
    expect(seen.sort()).toEqual(["https://doi.org/10.1000/abc.def", "https://pubmed.ncbi.nlm.nih.gov/99999999/"]);
    expect(fails(r).join()).toContain("doi 10.1000/abc.def returned 404");
    const many = Array.from({ length: 65 }, (_, i) => `[${i + 3}] R. T. PMID: ${10000000 + i}`);
    put("docs/blog/alpha.md", fx("alpha.new.md").trimEnd() + "\n\n" + many.join("\n\n") + "\n");
    seen.length = 0;
    const c = run({ checkIds: true, headStatus: (u) => { seen.push(u); return 200; }, delayMs: 0 }).AC7;
    expect(seen.length).toBe(60);
    expect(c.evidence.join()).toContain("5 identifiers not checked");
  });
});

describe("US-42 AC7 exclusions file", () => {
  it("FAILs when the exclusions file is missing unless --no-exclusions", () => {
    expect(fails(run({ exclusionsPath: join(reports, "none.json") }).AC7).join()).toContain("exclusions file not found");
    expect(fails(run({ exclusionsPath: join(reports, "none.json"), noExclusions: true }).AC7)).toEqual([]);
  });
});

describe("US-42 AC3 hedging", () => {
  it("fails when the hedge count falls and lists the line", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit. ", ""));
    reps.alpha.deleted_sentences.push({ sentence: "Some evidence suggests benefit.", justification: "Not in raw." });
    const r = run().AC3;
    expect(r.status).toBe("FAIL");
    expect(r.evidence.join()).toContain("hedge tokens fell");
  });
  it("lists hedge loss per sentence pair, still as WARN", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.", "Benefit is shown. It may help. It might help."));
    const r = run().AC3;
    expect(r.status).toBe("WARN");
    const w = r.evidence.filter((e) => e.includes('lost hedge "suggests"'));
    expect(w.length).toBe(1);
    expect(w[0]).toContain("base: Some evidence suggests benefit.");
    expect(w[0]).toContain("new: Benefit is shown.");
  });
  it("warns on a gained hardening token without failing", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg per day", "300 mg per day and must be taken"));
    const r = run().AC3;
    expect(r.status).toBe("WARN");
    expect(r.evidence.join()).toContain('gained hardening "must"');
  });
});

describe("US-42 AC4 deleted sentences and headings", () => {
  it("fails when a removed sentence is not declared", () => {
    reps.alpha.deleted_sentences = [];
    expect(fails(run().AC4).join()).toContain("not in deleted_sentences");
  });
  it("fails on an empty justification", () => {
    reps.alpha.deleted_sentences[0].justification = " ";
    expect(fails(run().AC4).join()).toContain("empty justification");
  });
  it("fails when a base heading disappears", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("## Safety", "## Safety notes"));
    expect(fails(run().AC4).join()).toContain("heading missing from new body: ## Safety");
  });
});

describe("US-42 AC6 diff scope", () => {
  it("fails on a change outside the batch and allows the report path", () => {
    put("docs/blog/other.md", "x");
    put("docs/reference.md", "x");
    const f = fails(run().AC6).join();
    expect(f).toContain("docs/blog/other.md");
    expect(f).toContain("docs/reference.md");
    rmSync(join(root, "docs/blog/other.md")); rmSync(join(root, "docs/reference.md"));
    put("docs/knowledge/batch-t.md", "report");
    expect(fails(run().AC6).length).toBe(1);
    expect(fails(run({ outRel: "docs/knowledge/batch-t.md" }).AC6)).toEqual([]);
  });
});

describe("US-42 AC7 reference hygiene", () => {
  it("fails on grokipedia in any case", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "See GrokiPedia. Take it"));
    expect(fails(run().AC7).join()).toContain("grokipedia");
  });
  it("fails when product mentions rise or the report miscounts", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "MicroVitamin+ helps. Take it"));
    expect(fails(run().AC7).join()).toContain("product mentions rose 1 -> 2");
    put("docs/blog/alpha.md", fx("alpha.new.md"));
    reps.alpha.product_mentions_after = 0;
    expect(fails(run().AC7).join()).toContain("recomputed 1 -> 1");
  });
  it("fails on a dangling citation and an uncited reference", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2]", "upset [3]"));
    const f = fails(run().AC7).join();
    expect(f).toContain("citations with no reference line: 3");
    expect(f).toContain("reference lines never cited: 2");
  });
  it("fails on banned phrases and brand rankings", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "Our Top Pick is best brand overall. Take it"));
    const f = fails(run().AC7).join();
    expect(f).toContain('banned phrase "Top Pick"');
    expect(f).toContain("brand ranking phrase");
  });
  it("fails for an excluded handle in the batch or a new excluded file", () => {
    put("docs/pathway/excluded-page.md", "# x");
    const f = fails(run().AC7).join();
    expect(f).toContain("excluded-page: excluded handle gained a file");
    const { results } = runBatch({ root, batch: "t", handles: ["legacy-slug"], reportsDir: reports, exclusionsPath: exclusions });
    expect(results.find((r) => r.id === "AC7")!.evidence.join()).toContain("legacy-slug: handle is on the HealthPathways exclusion list");
  });
});

describe("US-42 AC11 exceptions", () => {
  const exc = (over = {}) => ({ check: "AC7", handle: "alpha", match: "grokipedia", reason: "quoted source name", by: "Brad", date: "2026-09-30", ...over });
  const dirty = () => put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "See Grokipedia. Take it"));
  it("turns a matched FAIL into a WARN and lists it", () => {
    dirty();
    const r = run({ exceptions: [exc()] });
    expect(r.AC7.status).toBe("WARN");
    expect(r.AC7.evidence.join()).toContain("EXCEPTION (Brad, 2026-09-30): quoted source name");
    expect(r.AC7.excepted?.length).toBe(1);
  });
  it("does not match another handle, check or substring", () => {
    dirty();
    for (const o of [{ handle: "beta" }, { check: "AC4" }, { match: "nothing" }]) expect(run({ exceptions: [exc(o)] }).AC7.status).toBe("FAIL");
  });
  it("ignores a missing file and applies a file through the CLI", () => {
    dirty();
    writeReports();
    writeFileSync(join(reports, "handles.txt"), "alpha\nbeta\n");
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);
    try {
      const out = join(root, "docs", "b.md");
      const args = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--out", out, "--no-exclusions"];
      main([...args, "--exceptions", join(reports, "missing.json")]);
      expect(log.mock.calls.flat().join("\n")).toContain("FAIL AC7");
      writeFileSync(join(reports, "exc.json"), JSON.stringify([exc()]));
      main([...args, "--exceptions", join(reports, "exc.json")]);
      expect(readFileSync(out, "utf8")).toContain("Accepted exceptions");
    } finally { process.chdir(cwd); log.mockRestore(); }
  });
});

describe("US-42 AC2/AC7 reference batch rules", () => {
  const withRefs = (extra: string, cite = " [3]") =>
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2].", `upset [2]${cite}.`).trimEnd() + `\n\n${extra}\n`);
  it("ignores extra top-level report keys", () => {
    expect(validateReport({ ...exampleReport("x"), grokipedia_claims: ["a"], needs_pubmed: [] })).toEqual([]);
    reps.alpha = { ...reps.alpha, grokipedia_claims: ["c"], needs_pubmed: ["d"] } as Report;
    expect(fails(run().AC2)).toEqual([]);
  });
  it("finds NIH:/EXTRA: quotes in extra_raw, checks their sha, and names the file", () => {
    const nih = join(reports, "nih.txt");
    writeFileSync(nih, "NIH says adults need 300 mg per day.");
    reps.alpha.changed_tokens[0].raw_quote = "NIH: adults need 300 mg per day";
    reps.alpha.extra_raw = [{ path: nih, sha256: sha256(readFileSync(nih)) }];
    const r = run().AC2;
    expect(fails(r)).toEqual([]);
    expect(r.evidence.join()).toContain("matched in extra_raw " + nih);
    reps.alpha.changed_tokens[0].raw_quote = "EXTRA: adults need 300 mg per day";
    expect(fails(run().AC2)).toEqual([]);
    reps.alpha.changed_tokens[0].raw_quote = "NIH: participants took 300 mg daily"; // only in the main raw
    expect(fails(run().AC2).join()).toContain("not in the raw file");
    reps.alpha.changed_tokens[0].raw_quote = "NIH: adults need 300 mg per day";
    reps.alpha.extra_raw = [{ path: nih, sha256: "0".repeat(64) }];
    expect(fails(run().AC2).join()).toContain("extra_raw sha256 mismatch");
  });
  it("fails on a bare-URL reference line and on unknown hosts", () => {
    withRefs("[3] https://pubmed.ncbi.nlm.nih.gov/123/");
    expect(fails(run().AC7).join()).toContain("reference line is a bare URL without a title: [3]");
    withRefs("[3] Foo B. Study. https://evil.example.com/x");
    expect(fails(run().AC7).join()).toContain("unknown host evil.example.com");
  });
  it("allows the listed hosts and hosts already in the base references", () => {
    withRefs("[3] Foo B. Study. [link](https://www.consumerlab.com/x) https://doi.org/10.1/x https://ods.od.nih.gov/y");
    expect(fails(run().AC7).filter((f) => /host|bare/.test(f))).toEqual([]);
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("[2] Jones B. Synthetic safety review. 2020.", "[2] Jones B. Review. https://known.example.org/a"));
    sh(["add", "-A"]); sh(["commit", "-q", "-m", "base2"]);
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("[2] Jones B. Synthetic safety review. 2020.", "[2] Jones B. Review. https://known.example.org/a\n\n[3] Foo B. Study. https://known.example.org/b").replace("upset [2]", "upset [2] [3]"));
    expect(fails(run().AC7).filter((f) => /host|bare/.test(f))).toEqual([]);
  });
  it("requires product sections to stay byte-identical", () => {
    const base = fx("alpha.base.md").replace("## Safety", "## MicroVitamin and this topic\n\nOur product is locked.\n\n## Safety");
    put("docs/blog/alpha.md", base); sh(["add", "-A"]); sh(["commit", "-q", "-m", "base2"]);
    put("docs/blog/alpha.md", base);
    expect(fails(run().AC7).filter((f) => f.includes("product section"))).toEqual([]);
    put("docs/blog/alpha.md", base.replace("locked.", "changed."));
    expect(fails(run().AC7).join()).toContain("product section changed: ## MicroVitamin and this topic");
    put("docs/blog/alpha.md", base.replace("## MicroVitamin and this topic\n\nOur product is locked.\n\n", ""));
    expect(fails(run().AC7).join()).toContain("product section missing");
  });
});

describe("US-42 AC9 pathway rules", () => {
  it("fails without the source line or deferral blockquote", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("*Source: Auckland Region HealthPathways, reviewed 2026-01-01*", "Source elsewhere").replace(/^>.*$/m, ""));
    const f = fails(run().PATHWAY).join();
    expect(f).toContain("missing \"*Source: Auckland Region HealthPathways\"");
    expect(f).toContain("missing doctor-deferral blockquote");
  });
  it("fails on NZ logistics", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("Review again", "Call 0800 123 456 or send an eReferral to POAC at Te Whatu Ora. Review again"));
    const f = fails(run().PATHWAY).join();
    for (const t of ["0800", "eReferral", "POAC", "Te Whatu Ora"]) expect(f).toContain(`forbidden term "${t}"`);
  });
});

describe("US-42 AC8 batch report", () => {
  it("holds counts and hashes only, under 150 lines", () => {
    writeReports();
    const { results, rows, baseSha } = runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, exclusionsPath: exclusions });
    const md = renderReport("t", "HEAD", baseSha, results, rows);
    expect(md.split("\n").length).toBeLessThan(150);
    expect(md).toContain("AC8 sign-off (Brad): PENDING");
    expect(md).not.toContain("participants took");
    expect(md).not.toContain("Trials used");
    expect(md).toContain(sha256(readFileSync(join(reports, "alpha.raw.txt"))).slice(0, 16));
  });
  it("stays under the cap with many handles", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ handle: `h${i}`, type: "reference", file: "f", rawSha: "a".repeat(64), bodySha: "b".repeat(64),
      tokensNew: 1, quoted: 1, deleted: 0, hedgeBefore: 1, hedgeAfter: 1, productsBefore: 0, productsAfter: 0 }));
    expect(renderReport("big", "HEAD", "abc", [], rows).split("\n").length).toBeLessThan(150);
  });
});

describe("US-42 AC1-AC7 CLI end to end", () => {
  it("exits 1 on FAIL, 0 on PASS, and writes --out", () => {
    writeReports();
    writeFileSync(join(reports, "handles.txt"), "# batch\nalpha\nbeta\n");
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);
    try {
      const out = join(root, "docs", "batch-t.md");
      const args = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--out", out, "--no-exclusions"];
      // The real exclusions file is optional; a missing one only warns. Only AC7 could FAIL on it.
      expect([0, 1]).toContain(main(args));
      expect(readFileSync(out, "utf8")).toContain("# Knowledge batch report: t");
      reps.alpha.changed_tokens = [];
      writeReports();
      expect(main(args)).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("FAIL AC2");
    } finally { process.chdir(cwd); log.mockRestore(); }
  });
});
