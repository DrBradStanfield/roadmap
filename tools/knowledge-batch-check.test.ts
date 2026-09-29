import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Report, type Result, exampleReport, main, normQuote, productMentions, renderReport, runBatch, validateExceptions,
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
    expect(productMentions("Try omega-3 from fish oil, or Omega-3.")).toBe(1);
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
const INDEX = JSON.stringify([{ handle: "alpha", summary: "Alpha summary, 200 mg daily.", title: "Alpha", type: "reference" },
  { handle: "beta", summary: "Clinical pathway for beta.", title: "Beta", type: "pathway" }, { handle: "other", summary: "x", title: "O" }], null, 2);

interface Reps { alpha: Report; beta: Report }
let reps: Reps;

function writeReports() {
  for (const r of [reps.alpha, reps.beta]) writeFileSync(join(reports, `${r.handle}.json`), JSON.stringify(r));
}
const run = (over: Partial<Parameters<typeof runBatch>[0]> = {}) => {
  writeReports();
  const { results } = runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports], ...over });
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
      changed_tokens: [{ token: "300 mg", body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg daily" }],
      deleted_sentences: [{ sentence: "Trials used 200 mg in adults [1].", justification: "The new raw says 300 mg." }],
      product_mentions_before: 1, product_mentions_after: 1 },
    beta: { ...base, handle: "beta", type: "pathway", raw_path: betaRaw, raw_sha256: sha256(fx("beta.raw.txt")),
      changed_tokens: [{ token: "6 weeks", body_line: "Review again in 6 weeks.", raw_quote: "please review again in 6 weeks if symptoms persist" }],
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
    const r = run();
    expect(fails(r.AC1)).toEqual([]);
    expect(fails(r.AC6)).toEqual([]); // AC6 lets an AC1-accepted index change through
  });
  it("requires the new summary line to equal the proposed correction after whitespace collapse", () => {
    put("docs/blog/index.json", INDEX.replace("200 mg daily", "300 mg daily"));
    reps.alpha.proposed_summary_correction = "Alpha summary,   300 mg daily.";
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg daily", "300 mg daily"));
    expect(fails(run().AC1)).toEqual([]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg daily", "300 mg twice daily"));
    expect(fails(run().AC1).join()).toContain("summary line differs from proposed_summary_correction");
  });
  it("does not require the proposed correction when the summary line is unchanged", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg daily.";
    expect(fails(run().AC1)).toEqual([]);
  });
  it("AC6 still flags an index change AC1 rejected", () => {
    put("docs/blog/index.json", INDEX.replace('"x"', '"y"'));
    expect(fails(run().AC6).join()).toContain("docs/blog/index.json");
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
    const { results } = runBatch({ root, batch: "t", handles: ["beta"], reportsDir: join(reports, "none"), exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports] });
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
    reps.alpha.changed_tokens.push({ token: "1 g", body_line: "Take 1 g.", raw_quote: "Doses above 2,000 mg were not studied" });
    expect(fails(run().AC2).join()).toContain('"1000 mg"'); // 2,000 mg is not 1 g: quote lacks the token
    reps.alpha.changed_tokens[1].raw_quote = "Doses above 1,000 mg were not studied";
    writeFileSync(join(reports, "alpha.raw.txt"), "In the trial, participants took 300 mg daily. Doses above 1,000 mg were not studied.");
    reps.alpha.raw_sha256 = sha256(readFileSync(join(reports, "alpha.raw.txt")));
    expect(fails(run().AC2)).toEqual([]);
  });
});

describe("US-42 AC2 multiset and body_line", () => {
  it("fails a changed dose whose new value already occurs elsewhere in the body", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "2 g in adults")); // "2 g" was already in the base once
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain('"2000 mg"');
  });
  it("prints the body lines where the checker found a token nobody declared", () => {
    reps.alpha.changed_tokens = [];
    const f = fails(run().AC2).find((x) => x.includes('token "300 mg"'))!;
    expect(f).toContain("found in: \"Trials used 300 mg in adults [1].");
    reps.alpha.changed_tokens = [{ token: "300 mg", body_line: "An unrelated line.", raw_quote: "participants took 300 mg daily" }];
    expect(fails(run().AC2).find((x) => x.includes("body_line does not contain"))).toContain("found in: \"Trials used 300 mg in adults [1].");
  });
  it("matches a comparator token declared with its '>'", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "more than 6 weeks in adults"));
    const raw = "In the study the course lasted more than 6 weeks for the whole group.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ token: ">6 week", body_line: "Trials used more than 6 weeks in adults [1].", raw_quote: "lasted more than 6 weeks for the whole group" }];
    expect(fails(run().AC2)).toEqual([]);
  });
  it("fails a raw_quote holding an ellipsis, which marks a paraphrase", () => {
    for (const q of ["participants took 300 mg ... daily for a while", "participants took 300 mg\u2026 daily for a while"]) {
      reps.alpha.changed_tokens[0].raw_quote = q;
      expect(fails(run().AC2).join()).toContain("raw_quote contains an ellipsis");
    }
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
  it("counts only a pubmed/ abstract with a '# PubMed <pmid>' header as verifying", () => {
    cited();
    const dir = join(reports, "pubmed");
    mkdirSync(dir, { recursive: true });
    const abs = join(dir, "99999999.md");
    writeFileSync(abs, "# PubMed 99999999\n\nSynthetic abstract. doi 10.1000/ABC.DEF\n");
    reps.alpha.extra_raw = [{ path: abs, sha256: sha256(readFileSync(abs)) }];
    expect(run().AC7.evidence.some((e) => e.includes("unverified primary"))).toBe(false);
    // the same identifiers in ordinary raw text (ConsumerLab or NIH) do not verify
    const plain = join(reports, "x.txt");
    writeFileSync(plain, "see PMID 99999999 and 10.1000/ABC.DEF");
    reps.alpha.extra_raw = [{ path: plain, sha256: sha256(readFileSync(plain)) }];
    expect(run().AC7.evidence.some((e) => e.includes("unverified primary"))).toBe(true);
    // a pubmed/ file without the header does not count either
    const bare = join(dir, "bare.md");
    writeFileSync(bare, "PMID 99999999 10.1000/ABC.DEF");
    reps.alpha.extra_raw = [{ path: bare, sha256: sha256(readFileSync(bare)) }];
    expect(run().AC7.evidence.some((e) => e.includes("unverified primary"))).toBe(true);
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
  it("warns when a shrinking reference loses hedges, and fails when it does not shrink", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit. ", ""));
    reps.alpha.deleted_sentences.push({ sentence: "Some evidence suggests benefit.", justification: "Not in raw." });
    const r = run().AC3;
    expect(r.status).toBe("WARN");
    expect(r.evidence.join()).toContain("hedge tokens fell 3 -> 1 (body shrank)");
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit. ", "Benefit was reported in the synthetic trial population overall. "));
    expect(fails(run().AC3).join()).toContain("hedge tokens fell 3 -> 1");
  });
  it("keeps the hard FAIL for a pathway", () => {
    put("docs/pathway/beta.md", fx("beta.base.md").replace("severe.", "severe. It may help."));
    sh(["add", "docs/pathway/beta.md"]); sh(["commit", "-q", "-m", "beta hedge", "--", "docs/pathway/beta.md"]);
    put("docs/pathway/beta.md", fx("beta.new.md"));
    expect(fails(run().AC3).join()).toContain("hedge tokens fell 1 -> 0");
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
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "300 mg in adults and must be taken"));
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

describe("US-42 AC4 references and patterns", () => {
  const withPlaceholder = () => {
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("## Safety", "[See Grokipedia source 3]\n\n## Safety"));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "placeholder", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md"));
    reps.alpha.product_mentions_before = 1;
  };
  it("leaves the reference list to AC7 for a reference", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.", "[1] Smith A. Synthetic trial, revised edition. 2019.\n\n[PubMed](https://pubmed.ncbi.nlm.nih.gov/1/)"));
    expect(fails(run().AC4)).toEqual([]);
  });
  it("still checks body sentences of a pathway, references section aside", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("Go to the emergency department if symptoms are severe. ", ""));
    expect(fails(run().AC4).join()).toContain("sentence removed and not in deleted_sentences");
  });
  it("counts base sentences matching a pattern entry as justified and prints how many", () => {
    withPlaceholder();
    expect(fails(run().AC4).join()).toContain("not in deleted_sentences");
    reps.alpha.deleted_sentences.push({ sentence: "Grokipedia source \\d+", justification: "Placeholder marker.", pattern: true });
    const r = run().AC4;
    expect(fails(r)).toEqual([]);
    expect(r.evidence.join()).toContain("(1 justified by pattern)");
  });
  it("fails a claimed deletion that is still in the body, but not a pattern entry", () => {
    reps.alpha.deleted_sentences.push({ sentence: "Some evidence suggests benefit.", justification: "claimed gone" });
    expect(fails(run().AC4).join()).toContain("claimed deletion still in body: Some evidence suggests benefit.");
    reps.alpha.deleted_sentences[1] = { sentence: "Some evidence suggests", justification: "regex, kept on purpose", pattern: true };
    expect(fails(run().AC4).join()).not.toContain("claimed deletion still in body");
    reps.alpha.deleted_sentences[1] = { sentence: "**Some** evidence  suggests benefit.", justification: "normalised match", pattern: false };
    expect(fails(run().AC4).join()).toContain("claimed deletion still in body");
  });
  it("fails a pattern with an empty justification or an invalid regex", () => {
    withPlaceholder();
    reps.alpha.deleted_sentences.push({ sentence: "Grokipedia source \\d+", justification: " ", pattern: true });
    expect(fails(run().AC4).join()).toContain("pattern has an empty justification");
    reps.alpha.deleted_sentences[1] = { sentence: "([", justification: "x", pattern: true };
    expect(fails(run().AC4).join()).toContain("not a valid regex");
  });
});

describe("US-42 AC2/AC4 sentence pairs", () => {
  const swapped = () => fx("alpha.new.md")
    .replace("Trials used 300 mg in adults [1].", "Trials used 2 g in adults [1].")
    .replace("Doses above 2 g may cause upset [2].", "Doses above 200 mg may cause upset [2].");
  const swapReport = () => {
    const raw = "The study gave 2,000 mg in adults each week. Doses above 200 mg were not studied at all.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [
      { token: "2 g", body_line: "Trials used 2 g in adults [1].", raw_quote: "gave 2,000 mg in adults each week" },
      { token: "200 mg", body_line: "Doses above 200 mg may cause upset [2].", raw_quote: "Doses above 200 mg were not studied at all" },
    ];
  };
  it("warns, not fails, on numbers that only moved between sentences (whole-body counts equal)", () => {
    put("docs/blog/alpha.md", swapped());
    reps.alpha.changed_tokens = [];
    const r = run().AC2;
    expect(fails(r)).toEqual([]);
    const w = r.evidence.filter((e) => e.startsWith("WARN")).join("\n");
    expect(w).toContain('number moved between sentences: "2000 mg"');
    expect(w).toContain('number moved between sentences: "200 mg"');
    expect(r.status).toBe("WARN");
  });
  it("still fails a value that entered a sentence and raised the whole-body count, or is absent from the base", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Trials used 300 mg in adults [1].", "Trials used 2 g in adults [1]."));
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain('token "2000 mg" is new in the body');
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Doses above 2 g may", "Doses above 4 g may"));
    expect(fails(run().AC2).join()).toContain('token "4000 mg" is new in the body');
  });
  it("ignores bare one- or two-digit integers in the pair check (type 1 and type 2 are identifiers)", () => {
    const tail = (a: string, b: string) => `\nType ${a} diabetes is rarer.\n\nType ${b} diabetes is common.\n`;
    put("docs/blog/alpha.md", fx("alpha.base.md").trimEnd() + tail("1", "2"));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "types", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md").trimEnd() + tail("2", "1"));
    expect(fails(run().AC2).join()).not.toContain("changed between paired sentences");
  });
  it("accepts the swap once each new sentence has its entry and quote", () => {
    put("docs/blog/alpha.md", swapped());
    swapReport();
    expect(fails(run().AC2)).toEqual([]);
    reps.alpha.changed_tokens[0].body_line = "Trials used 2 g in adults [1]. Some evidence suggests benefit."; // a line holding the sentence
    expect(fails(run().AC2)).toEqual([]);
    reps.alpha.changed_tokens[1].body_line = "An unrelated line about 200 mg.";
    expect(fails(run().AC2)).toEqual([]); // moved numbers need no sentence match, but an entry's quote is still checked
    reps.alpha.changed_tokens[1].raw_quote = "Doses above 200 mg were never studied at all";
    expect(fails(run().AC2).join()).toContain("not in the raw file");
  });
  it("warns when a claim keeps its number but loses its citation", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Doses above 2 g may cause upset [2].", "Doses above 2 g may cause upset."));
    reps.alpha.deleted_sentences.push({ sentence: "Doses above 2 g may cause upset [2].", justification: "test" });
    const w = run().AC4.evidence.filter((e) => e.includes("claim lost its citation"));
    expect(w.length).toBe(1);
    expect(w[0]).toContain("Doses above 2 g may cause upset [2].");
    expect(w[0]).toContain("Doses above 2 g may cause upset.");
    expect(run().AC4.status).toBe("WARN");
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
  it("warns, not fails, when the report's product counts differ but nothing rose", () => {
    reps.alpha.product_mentions_before = 2; reps.alpha.product_mentions_after = 2;
    const r = run().AC7;
    expect(fails(r).filter((f) => f.includes("report says"))).toEqual([]);
    expect(r.evidence.join()).toContain("count differs from report: report says product mentions 2 -> 2, recomputed 1 -> 1");
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
    const { results } = runBatch({ root, batch: "t", handles: ["legacy-slug"], reportsDir: reports, exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports] });
    expect(results.find((r) => r.id === "AC7")!.evidence.join()).toContain("legacy-slug: handle is on the HealthPathways exclusion list");
  });
});

describe("US-42 AC11 exceptions", () => {
  const dirty = () => put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "See Grokipedia. Take it"));
  const failText = () => fails(run().AC7).find((f) => f.includes("grokipedia"))!.replace(/^FAIL alpha: /, "");
  const exc = (match: string, over = {}) => ({ check: "AC7", handle: "alpha", match, reason: "quoted source name", by: "Brad", date: "2026-09-30", ...over });
  it("turns a FAIL matched by its full text into a WARN and lists it", () => {
    dirty();
    const r = run({ exceptions: [exc(failText())] });
    expect(r.AC7.status).toBe("WARN");
    expect(r.AC7.evidence.join()).toContain("EXCEPTION (Brad, 2026-09-30): quoted source name");
    expect(r.AC7.excepted?.length).toBe(1);
  });
  it("accepts the sha256 of the full text", () => {
    dirty();
    expect(run({ exceptions: [exc(sha256(failText()))] }).AC7.status).toBe("WARN");
  });
  it("does not match a substring, and a non-matching exception is itself a FAIL", () => {
    dirty();
    const r = run({ exceptions: [exc("grokipedia")] }).AC7;
    expect(r.status).toBe("FAIL");
    expect(fails(r).join("\n")).toContain("unused exception");
    expect(fails(r).join("\n")).toContain('"grokipedia" in body');
  });
  it("fails an exception for another handle or check, or when nothing fails", () => {
    dirty();
    const text = failText();
    for (const o of [{ handle: "beta" }, { check: "AC4" }]) {
      const r = run({ exceptions: [exc(text, o)] });
      expect([...r.AC7.evidence, ...r.AC4.evidence].join("\n")).toContain("unused exception");
    }
    put("docs/blog/alpha.md", fx("alpha.new.md"));
    expect(fails(run({ exceptions: [exc("anything at all")] }).AC7).join()).toContain("unused exception");
  });
  it("validates the exceptions file shape and rejects an empty match", () => {
    expect(validateExceptions([exc("x")])).toEqual([]);
    expect(validateExceptions([exc("")]).join()).toContain("match");
    expect(validateExceptions([exc("x", { check: "AC1" })]).join()).toContain("check");
    expect(validateExceptions({}).length).toBeGreaterThan(0);
  });
  it("is a usage error (exit 2) when the file is missing or holds an empty match; applies a valid file", () => {
    dirty();
    writeReports();
    writeFileSync(join(reports, "handles.txt"), "alpha\nbeta\n");
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(root);
    try {
      const out = join(root, "docs", "b.md");
      const args = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--out", out, "--no-exclusions", "--base", "HEAD"];
      const ov = { rawRoots: [reports] };
      expect(main([...args, "--exceptions", join(reports, "missing.json")], ov)).toBe(2);
      writeFileSync(join(reports, "exc.json"), JSON.stringify([exc("")]));
      expect(main([...args, "--exceptions", join(reports, "exc.json")], ov)).toBe(2);
      writeFileSync(join(reports, "exc.json"), JSON.stringify([exc(failText())]));
      main([...args, "--exceptions", join(reports, "exc.json")], ov);
      expect(readFileSync(out, "utf8")).toContain("Accepted exceptions");
    } finally { process.chdir(cwd); log.mockRestore(); err.mockRestore(); }
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
    writeFileSync(nih, "NIH says adults need 300 mg in adults.");
    reps.alpha.changed_tokens[0].raw_quote = "NIH: adults need 300 mg in adults";
    reps.alpha.extra_raw = [{ path: nih, sha256: sha256(readFileSync(nih)) }];
    const r = run().AC2;
    expect(fails(r)).toEqual([]);
    expect(r.evidence.join()).toContain("matched in extra_raw " + nih);
    reps.alpha.changed_tokens[0].raw_quote = "EXTRA: adults need 300 mg in adults";
    expect(fails(run().AC2)).toEqual([]);
    reps.alpha.changed_tokens[0].raw_quote = "NIH: participants took 300 mg daily"; // only in the main raw
    expect(fails(run().AC2).join()).toContain("not in the raw file");
    reps.alpha.changed_tokens[0].raw_quote = "NIH: adults need 300 mg in adults";
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

describe("US-42 AC2 raw roots (R2)", () => {
  const useRaw = (path: string, text: string) => {
    writeFileSync(path, text);
    reps.alpha.raw_path = path;
    reps.alpha.raw_sha256 = sha256(text);
  };
  it("fails a raw_path outside the allowed roots", () => {
    expect(fails(run({ rawRoots: [join(reports, "elsewhere")] }).AC2).join()).toContain("outside the allowed raw roots");
  });
  it("fails a raw_path inside the repo even when the repo is listed as a root", () => {
    useRaw(join(root, "raw.txt"), fx("alpha.raw.txt"));
    expect(fails(run({ rawRoots: [root, reports] }).AC2).join()).toContain("inside the repo");
  });
  it("fails a symlink that escapes the roots, and an extra_raw outside them", () => {
    const outside = mkdtempSync(join(tmpdir(), "kb-out-"));
    writeFileSync(join(outside, "t.txt"), fx("alpha.raw.txt"));
    symlinkSync(join(outside, "t.txt"), join(reports, "link.txt"));
    reps.alpha.raw_path = join(reports, "link.txt");
    expect(fails(run().AC2).join()).toContain("outside the allowed raw roots");
    reps.alpha.raw_path = join(reports, "alpha.raw.txt");
    reps.alpha.extra_raw = [{ path: join(outside, "t.txt"), sha256: sha256(fx("alpha.raw.txt")) }];
    expect(fails(run().AC2).join()).toContain("extra_raw");
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("US-42 AC2 quote matching (R3)", () => {
  it("fails a quote shorter than 6 words and 30 characters", () => {
    reps.alpha.changed_tokens[0].raw_quote = "300 mg daily";
    expect(fails(run().AC2).join()).toContain("raw_quote too short");
  });
  it("fails a token that only matches inside a longer number in the raw", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "7 mg in adults"));
    const raw = "In the study participants took 1.7 mg daily for a while now and more.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ token: "7 mg", body_line: "Trials used 7 mg in adults [1].", raw_quote: "7 mg daily for a while now and more" }];
    expect(fails(run().AC2).join()).toContain("not a whole token");
    const ok = "In the study participants took 7 mg daily for a while now and more.";
    writeFileSync(join(reports, "alpha.raw.txt"), ok);
    reps.alpha.raw_sha256 = sha256(ok);
    expect(fails(run().AC2)).toEqual([]);
  });
});

describe("US-42 AC6 and AC2 batch scope (R5, R6, R12)", () => {
  it("fails a handle the diff does not touch", () => {
    writeFileSync(join(reports, "ghost.json"), JSON.stringify({ ...reps.alpha, handle: "ghost" }));
    const r = run({ handles: ["alpha", "beta", "ghost"] });
    expect(fails(r.AC6).join()).toContain("nothing to check for ghost");
  });
  it("allows only the directory matching the entry's type", () => {
    put("docs/pathway/alpha.md", "# x");
    expect(fails(run().AC6).join()).toContain("docs/pathway/alpha.md");
  });
  it("takes the type from the index and fails a report that disagrees", () => {
    reps.alpha.type = "video";
    expect(fails(run().AC2).join()).toContain('report type "video" does not match index type "reference"');
  });
  it("fails a handle absent from the index unless the report says new, then uses the frontmatter type", () => {
    put("docs/blog/gamma.md", fx("alpha.new.md"));
    const g = { ...reps.alpha, handle: "gamma" };
    writeFileSync(join(reports, "gamma.json"), JSON.stringify(g));
    expect(fails(run({ handles: ["gamma"] }).AC2).join()).toContain("not in docs/blog/index.json");
    writeFileSync(join(reports, "gamma.json"), JSON.stringify({ ...g, new: true }));
    const f = fails(run({ handles: ["gamma"] }).AC2).join();
    expect(f).not.toContain("not in docs/blog/index.json");
    expect(f).not.toContain("does not match");
    writeFileSync(join(reports, "gamma.json"), JSON.stringify({ ...g, new: true, type: "pathway" }));
    expect(fails(run({ handles: ["gamma"] }).AC2).join()).toContain("does not match frontmatter type");
  });
  it("fails an unparseable reference URL", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2].", "upset [2] [3].").trimEnd() + "\n\n[3] Foo B. Study. http://[bad\n");
    expect(fails(run().AC7).join()).toContain("unparseable URL");
  });
});

describe("US-42 AC2 tokeniser units and comparators (R7)", () => {
  const t = (s: string) => [...tokenise(s)].sort();
  it("keeps compound units whole", () => {
    expect(t("2 mg/kg")).toEqual(["2 mg/kg"]);
    expect(t("40 mL/min")).toEqual(["40 mL/min"]);
    expect(t("90 mL/min/1.73m2")).toEqual(["90 mL/min/1.73m2"]);
    expect(t("7 mmol/mol, 5 ng/L, 3 pmol/L")).toEqual(["3 pmol/L", "5 ng/L", "7 mmol/mol"]);
    expect(t("10 µmol/L")).toEqual(t("10 umol/L"));
    expect(t("10 micromol/L")).toEqual(t("10 micromole/L"));
    expect(t("5 nanogram/L")).toEqual(["5 ng/L"]);
  });
  it("makes a leading or trailing comparator part of the token", () => {
    expect(t("≥ 30 mg/mmol")).toEqual(["≥30 mg/mmol"]);
    expect(t("≥ 30 mg/mmol")).not.toEqual(t("30 mg/mmol"));
    expect(t("at least 3 hours")).toEqual(["≥3 hour"]);
    expect(t("more than 3 months")).toEqual([">3 month"]);
    expect(t("less than 5 kg")).toEqual(["<5 kg"]);
    expect(t("5 or more years")).toEqual(["≥5 year"]);
    expect(t("10 or less days")).toEqual(["≤10 day"]);
    expect(t("<= 7 mg")).toEqual(["≤7 mg"]);
  });
  it("keeps /day, /dose, /week, /kg and per day as part of the unit", () => {
    expect(t("500 mg/day")).toEqual(["500 mg/day"]);
    expect(t("500 mg/day")).not.toEqual(t("500 mg"));
    expect(t("500 mg per day")).toEqual(["500 mg/day"]);
    expect(t("1 g / dose")).toEqual(["1000 mg/dose"]);
    expect(t("2 mg/kg/day")).toEqual(["2 mg/kg/day"]);
    expect(t("5 mg per week")).toEqual(["5 mg/week"]);
    expect(t("10 mg per kg")).toEqual(["10 mg/kg"]);
    expect(t("500 mg daily")).toEqual(["500 mg"]);
  });
  it("keeps a leading comparator in a token or quote, and strips '> ' only from body lines", () => {
    expect([...tokenise(">6 week", { keepRefs: true })]).toEqual([">6 week"]);
    expect([...tokenise("> 6 week", { keepRefs: true })]).toEqual([">6 week"]);
    expect(t("> more than 6 weeks")).toEqual([">6 week"]);
    expect(t("> 6 weeks")).toEqual(["6 week"]);
  });
  it("reads .5 mg as 0.5 mg and ignores a blockquote marker", () => {
    expect(t("take .5 mg")).toEqual(["0.5 mg"]);
    expect(t("> 30 mg")).toEqual(["30 mg"]);
  });
});

describe("US-42 AC7 product counting (R9)", () => {
  it("keeps the omega-3 carve-out off when the brand is within 40 characters", () => {
    expect(productMentions("omega-3 fatty acids, made by MicroVitamin")).toBe(2);
    expect(productMentions("Omega-3 leaflet by Dr. Brad")).toBe(1);
    expect(productMentions("Omega 3 fish oil by Dr Brad")).toBe(0); // "Omega 3" with a space is never the product name
    expect(productMentions("omega-3 fatty acids help. ".padEnd(80, "x") + " MicroVitamin")).toBe(1);
  });
  it("counts Potassium Fibre and Sleep by Dr. Brad as products", () => {
    expect(productMentions("Potassium Fibre and Sleep by Dr. Brad and Potassium Fiber")).toBe(3);
  });
});

describe("US-42 AC4/AC7 numbered references heading", () => {
  it.each(["## 8. References", "## 8) Sources", "### 12. Citations", "## Bibliography"])("treats %s as the reference section", (h) => {
    const numbered = fx("alpha.new.md")
      .replace("## References", h)
      .replace("[1] Smith A. Synthetic trial. 2019.", "1. Smith A. Synthetic trial. 2019.")
      .replace("[2] Jones B. Synthetic safety review. 2020.", "2. Jones B. Synthetic safety review. 2020.");
    put("docs/blog/alpha.md", numbered);
    const f = fails(run().AC7).join("\n");
    expect(f).not.toContain("citations with no reference line");
    expect(f).not.toContain("reference lines never cited");
    expect([...tokenise(numbered)]).not.toContain("2019");
    expect([...tokenise(numbered.replace("Trials used", "Trials used 5 mg"))]).toContain("5 mg");
  });
});

describe("US-42 AC7 identifier link text (R13)", () => {
  const withRef = (line: string) => put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2].", "upset [2] [3].").trimEnd() + `\n\n${line}\n`);
  const idFails = () => fails(run().AC7).filter((f) => f.includes("differs from")).join("\n");
  it("fails a PMID link text that differs from the PMID in its pubmed URL", () => {
    withRef("[3] Foo B. Study. [PMID 11111111](https://pubmed.ncbi.nlm.nih.gov/11111112/)");
    expect(idFails()).toContain("PMID link text 11111111 differs from its URL id 11111112");
    withRef("[3] Foo B. Study. [11111112](https://pubmed.ncbi.nlm.nih.gov/11111112/)");
    expect(idFails()).toBe("");
    withRef("[3] Foo B. Study. [PubMed](https://pubmed.ncbi.nlm.nih.gov/11111112/)");
    expect(idFails()).toBe("");
  });
  it("fails a DOI link text that differs from the DOI in its doi.org URL", () => {
    withRef("[3] Foo B. Study. [10.1000/abc](https://doi.org/10.1000/abd)");
    expect(idFails()).toContain("DOI link text 10.1000/abc differs from its URL DOI 10.1000/abd");
    withRef("[3] Foo B. Study. [10.1000/ABC](https://doi.org/10.1000/abc)");
    expect(idFails()).toBe("");
  });
  it("fails a printed PMID that differs from a pubmed URL id on the same line", () => {
    withRef("[3] Foo B. Study. PMID: 22222222 https://pubmed.ncbi.nlm.nih.gov/33333333/");
    expect(idFails()).toContain("PMID 22222222 differs from the pubmed URL id 33333333");
    withRef("[3] Foo B. Study. PMID: 33333333 https://pubmed.ncbi.nlm.nih.gov/33333333/");
    expect(idFails()).toBe("");
  });
});

describe("US-42 AC9 pathway rules", () => {
  it("fails without the source line or deferral blockquote", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("*Source: Auckland Region HealthPathways, reviewed 2026-01-01*", "Source elsewhere").replace(/^>.*$/m, ""));
    const f = fails(run().PATHWAY).join();
    expect(f).toContain("missing \"*Source: Auckland Region HealthPathways\"");
    expect(f).toContain("missing doctor-deferral blockquote");
  });
  it("normalises no-break spaces, matches plural and prefix forms, and finds phone numbers outside URLs", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("Review again", "Ask Te\u00a0Whatu\u00a0Ora about DHBs and eReferrals. Ring 09 373 1599 or 0508 123 456.\n\nSee [x](https://a.org/0900123456789).\n\nReview again"));
    const f = fails(run().PATHWAY).join("\n");
    for (const t of ["Te Whatu Ora", "DHB", "eReferral", "phone number"]) expect(f).toContain(t);
    expect(f).not.toContain("a.org");
    put("docs/pathway/beta.md", fx("beta.new.md").replace("*Source: Auckland Region HealthPathways", "*Source:\u00a0Auckland Region HealthPathways"));
    expect(fails(run().PATHWAY)).toEqual([]);
  });
  it("normalises no-break spaces before the banned-phrase check", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it", "Our Top\u00a0Pick. Take it"));
    expect(fails(run().AC7).join()).toContain('banned phrase "Top Pick"');
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
    const { results, rows, baseSha } = runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports] });
    const md = renderReport("t", "HEAD", baseSha, results, rows, false);
    expect(md.split("\n").length).toBeLessThan(150);
    expect(md).toContain("AC8 sign-off (Brad): PENDING");
    expect(md).not.toContain("participants took");
    expect(md).not.toContain("Trials used");
    expect(md).toContain(sha256(readFileSync(join(reports, "alpha.raw.txt")))); // the full sha256
    expect(rows[0].rawRel.startsWith("/")).toBe(false);
    expect(rows[0].rawRel.endsWith("/alpha.raw.txt")).toBe(true);
    expect(md).toContain(rows[0].rawRel);
  });
  it("lists what it does not cover, and how DOI/PMID resolution depends on --check-ids", () => {
    const off = renderReport("t", "HEAD", "abc", [], [], false), on = renderReport("t", "HEAD", "abc", [], [], true);
    for (const t of ["AC5", "Shopify", "section placement", "primary-study abstract"]) expect(off).toContain(t);
    expect(off).toContain("DOI/PMID resolution: NOT checked");
    expect(on).toContain("DOI/PMID resolution: checked with --check-ids");
  });
  it("stays under the cap with many handles", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ handle: `h${i}`, type: "reference", file: "f", rawRel: "refresh-x/f.md", rawSha: "a".repeat(64), bodySha: "b".repeat(64),
      tokensNew: 1, quoted: 1, deleted: 0, hedgeBefore: 1, hedgeAfter: 1, productsBefore: 0, productsAfter: 0 }));
    expect(renderReport("big", "HEAD", "abc", [], rows, false).split("\n").length).toBeLessThan(150);
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
      const args = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--out", out, "--no-exclusions", "--base", "HEAD"];
      const ov = { rawRoots: [reports] };
      expect(main(args, ov)).toBe(0);
      expect(readFileSync(out, "utf8")).toContain("# Knowledge batch report: t");
      reps.alpha.changed_tokens = [];
      writeReports();
      expect(main(args, ov)).toBe(1);
      expect(log.mock.calls.flat().join("\n")).toContain("FAIL AC2");
    } finally { process.chdir(cwd); log.mockRestore(); }
  });
  it("is a usage error without --base, or with --out under docs/blog or on a checked file", () => {
    writeReports();
    writeFileSync(join(reports, "handles.txt"), "alpha\nbeta\n");
    const cwd = process.cwd();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(root);
    try {
      const base = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--no-exclusions"];
      const ov = { rawRoots: [reports] };
      expect(main(base, ov)).toBe(2);
      expect(main([...base, "--base", "HEAD", "--out", join(root, "docs/blog/report.md")], ov)).toBe(2);
      expect(main([...base, "--base", "HEAD", "--out", join(root, "docs/pathway/beta.md")], ov)).toBe(2);
    } finally { process.chdir(cwd); err.mockRestore(); }
  });
});
