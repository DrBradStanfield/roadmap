import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Report, type Result, REPORT_SCHEMA, applyAddenda, exampleReport, main, normQuote, productMentions, renderReport, runBatch, validateExceptions,
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
    expect(t("Type 2 diabetes")).toEqual([]);
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
    expect(sentences("| a | b |\n|---|---|\n| :-: | --- |\n| Take 5 mg in adults. | ok |")).toEqual([
      "a | b |", "Take 5 mg in adults.", "ok |"]);
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
    const bad = validateReport({ ...exampleReport("x"), changed_tokens: [{ body_line: 12, raw_quote: "q" }] });
    expect(bad).toContain("changed_tokens[0].body_line: body_line must be the body line's text, not a number");
  });
  it("takes entries as body_line + raw_quote and ignores a legacy token field; the example has none", () => {
    expect(exampleReport("x").changed_tokens[0]).not.toHaveProperty("token");
    expect(validateReport({ ...exampleReport("x"), changed_tokens: [{ body_line: "a", raw_quote: "b", notes: "n", token: "junk" }] })).toEqual([]);
    expect(validateReport({ ...exampleReport("x"), changed_tokens: [{ token: "1" }] }).length).toBeGreaterThan(0);
    expect(JSON.stringify(REPORT_SCHEMA.properties.changed_tokens)).not.toContain('"required":["token"');
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
const INDEX = JSON.stringify([{ handle: "alpha", summary: "Alpha summary, 200 mg in adults.", title: "Alpha", type: "reference" },
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
      changed_tokens: [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg in adults" }],
      deleted_sentences: [{ sentence: "Trials used 200 mg in adults [1].", justification: "The new raw says 300 mg." }],
      product_mentions_before: 1, product_mentions_after: 1 },
    beta: { ...base, handle: "beta", type: "pathway", raw_path: betaRaw, raw_sha256: sha256(fx("beta.raw.txt")),
      changed_tokens: [{ body_line: "Review again in 6 weeks.", raw_quote: "please review again in 6 weeks if symptoms persist" }],
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
    put("docs/blog/index.json", INDEX.replace("200 mg in adults", "300 mg in adults"));
    expect(fails(run().AC1).join()).toContain('"alpha"');
  });
  it("allows a summary-only change when the report proposes a correction", () => {
    put("docs/blog/index.json", INDEX.replace("200 mg in adults", "300 mg in adults"));
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg in adults.";
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg in adults", "300 mg in adults"));
    const r = run();
    expect(fails(r.AC1)).toEqual([]);
    expect(fails(r.AC6)).toEqual([]); // AC6 lets an AC1-accepted index change through
  });
  it("requires the new summary line to equal the proposed correction after whitespace collapse", () => {
    put("docs/blog/index.json", INDEX.replace("200 mg in adults", "300 mg in adults"));
    reps.alpha.proposed_summary_correction = "Alpha summary,   300 mg in adults.";
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg in adults", "300 mg in adults"));
    expect(fails(run().AC1)).toEqual([]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg in adults", "300 mg twice daily"));
    expect(fails(run().AC1).join()).toContain("summary line differs from proposed_summary_correction");
  });
  it("does not require the proposed correction when the summary line is unchanged", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg in adults.";
    expect(fails(run().AC1)).toEqual([]);
  });
  it("compares a changed index summary with the proposed correction even when the frontmatter is unchanged", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg in adults.";
    put("docs/blog/index.json", INDEX.replace("200 mg daily", "300 mg in adults").replace("Alpha summary, 200 mg in adults.", "Alpha summary, 300 mg in adults."));
    expect(fails(run().AC1)).toEqual([]);
    put("docs/blog/index.json", INDEX.replace("Alpha summary, 200 mg in adults.", "Alpha summary, 999 mg in adults."));
    expect(fails(run().AC1).join()).toContain('index.json summary for "alpha" differs from proposed_summary_correction');
  });
  it("AC6 still flags an index change AC1 rejected", () => {
    put("docs/blog/index.json", INDEX.replace('"x"', '"y"'));
    expect(fails(run().AC6).join()).toContain("docs/blog/index.json");
  });
  it("allows only the summary line to differ when a correction is proposed", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg in adults.";
    put("docs/blog/index.json", INDEX.replace("200 mg in adults", "300 mg in adults"));
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("200 mg in adults", "300 mg in adults").replace('title: "Alpha"', 'title: "Alpha 2"'));
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
  it("US-42 AC2: an entry whose body_line carries a number fails when its quote shares none", () => {
    const raw = `${fx("alpha.raw.txt")}\nIn total the participants were followed for 12 weeks.`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens[0].raw_quote = "In total the participants were followed for 12 weeks";
    expect(fails(run().AC2).join()).toContain("shares no number with its body_line");
  });
  it("US-42 AC2: an entry whose body_line carries no number only warns, and the quote must be verbatim", () => {
    const raw = `${fx("alpha.raw.txt")}\nIn total the participants were followed for 12 weeks.`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens.push({ body_line: "Take it with food, e.g. at lunch.", raw_quote: "In total the participants were followed for 12 weeks" });
    const r = run().AC2;
    expect(r.evidence.join()).toContain("entry supports no number in its body_line");
    expect(fails(r)).toEqual([]);
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
    const raw = "In the trial, participants took 300\u00a0mg in adults for a 1\u2011year period.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(readFileSync(join(reports, "alpha.raw.txt")));
    expect(fails(run().AC2)).toEqual([]);
  });
  it("accepts 1,000 mg in the raw as 1 g in the body", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("2 g may", "2 g may").replace("Take it", "Take 1 g.\nTake it"));
    reps.alpha.changed_tokens.push({ body_line: "Take 1 g.", raw_quote: "Doses of 2,000 mg were not studied" });
    expect(fails(run().AC2).join()).toContain('"1000 mg"'); // 2,000 mg is not 1 g: quote lacks the token
    reps.alpha.changed_tokens[1].raw_quote = "Doses of 1,000 mg were not studied";
    writeFileSync(join(reports, "alpha.raw.txt"), "In the trial, participants took 300 mg in adults. Doses of 1,000 mg were not studied.");
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
    reps.alpha.changed_tokens = [{ body_line: "An unrelated line.", raw_quote: "participants took 300 mg in adults" }];
    expect(fails(run().AC2).find((x) => x.includes("not a current body line"))).toContain("found in: \"Trials used 300 mg in adults [1].");
  });
  it("US-42 AC2: a changed reference-list line is never asked to quote its number", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.", "[1] Smith A. Dosing at 300 mg. Synthetic trial. 2019."));
    expect(fails(run().AC2)).toEqual([]);
  });
  it("US-42 AC2: a quote must not start inside a longer number in the raw", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "7 mg for 12 weeks"));
    const raw = "In the study, participants took 1.7 mg for 12 weeks in total.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ body_line: "Trials used 7 mg for 12 weeks [1].", raw_quote: "7 mg for 12 weeks in total" }];
    expect(fails(run().AC2).join()).toContain("not whole tokens");
  });
  it("US-42 AC2: a list item takes the comparator of the line above, as the whole-body pass does", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.", "Seek care if you take more than:\n- 5 mg a day"));
    const raw = `${fx("alpha.raw.txt")}\nSafety limits: more than 5 mg a day were not studied.`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens.push({ body_line: "- 5 mg a day", raw_quote: "more than 5 mg a day were not studied" });
    expect(fails(run().AC2)).toEqual([]);
  });
  it("US-42 AC2: a number with no verified coverage fails even when its entry verified another number (R1)", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Trials used 300 mg in adults [1].", "Review after 12 weeks. Take 300 mg."));
    const raw = "Review after 12 weeks before taking 300 mg/kg.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ body_line: "Review after 12 weeks. Take 300 mg.", raw_quote: "Review after 12 weeks before taking 300 mg" }];
    expect(fails(run().AC2).join()).toContain('"300 mg"');
  });
  it("US-42 AC2: a verbatim multi-line quote with a list-item comparator verifies end to end (R3)", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.", "Seek care if you take more than:\n- 5 mg a day"));
    const raw = `${fx("alpha.raw.txt")}\nSeek care if you take more than:\n- 5 mg a day\n`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens.push({ body_line: "- 5 mg a day", raw_quote: "Seek care if you take more than:\n- 5 mg a day" });
    expect(fails(run().AC2)).toEqual([]);
  });
  it("US-42 AC2: a quote that supports no number must still be verbatim in the raw", () => {
    reps.alpha.changed_tokens[0].raw_quote = "the participants were followed for twelve weeks";
    expect(fails(run().AC2).join()).toContain("not in the raw file");
  });
  it("matches a comparator token declared with its '>'", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "more than 6 weeks in adults"));
    const raw = "In the study the course lasted more than 6 weeks for the whole group.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ body_line: "Trials used more than 6 weeks in adults [1].", raw_quote: "lasted more than 6 weeks for the whole group" }];
    expect(fails(run().AC2)).toEqual([]);
  });
  it("fails a raw_quote holding an ellipsis, which marks a paraphrase", () => {
    for (const q of ["participants took 300 mg ... daily for a while", "participants took 300 mg\u2026 daily for a while"]) {
      reps.alpha.changed_tokens[0].raw_quote = q;
      expect(fails(run().AC2).join()).toContain("raw_quote contains an ellipsis");
    }
  });
  it("requires the entry's body_line to be a current line of the body", () => {
    reps.alpha.changed_tokens[0].body_line = "An unrelated line.";
    expect(fails(run().AC2).join()).toContain("not a current body line");
  });
});

describe("US-42 AC7 identifiers", () => {
  const cited = () => put("docs/blog/alpha.md", fx("alpha.new.md").replace("upset [2].", "upset [2] [3].").trimEnd() + "\n\n[3] Foo B. Study. PMID: 99999999 doi:10.1000/abc.def\n");
  const absFile = (id: string, dirName = "pubmed") => {
    const dir = join(reports, dirName);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${id}.md`);
    writeFileSync(f, `# PubMed ${id}\n\nSynthetic abstract. doi 10.1000/ABC.DEF\n`);
    return { path: f, sha256: sha256(readFileSync(f)) };
  };
  it("fails a NEW PubMed reference whose abstract file is not in extra_raw", () => {
    cited();
    const f = fails(run().AC7).join("\n");
    expect(f).toContain("new PubMed reference has no abstract file in extra_raw");
    expect(f).toContain("PMID: 99999999");
  });
  it("accepts a new PubMed reference once its pubmed/ abstract with the PMID header is in extra_raw", () => {
    cited();
    reps.alpha.extra_raw = [absFile("99999999")];
    expect(fails(run().AC7).join("\n")).not.toContain("no abstract file");
  });
  it("does not accept ordinary raw text, a headerless file, or another PMID's abstract", () => {
    cited();
    const plain = join(reports, "x.txt");
    writeFileSync(plain, "see PMID 99999999 and 10.1000/ABC.DEF");
    reps.alpha.extra_raw = [{ path: plain, sha256: sha256(readFileSync(plain)) }];
    expect(fails(run().AC7).join()).toContain("no abstract file");
    const bare = join(reports, "pubmed", "bare.md");
    mkdirSync(join(reports, "pubmed"), { recursive: true });
    writeFileSync(bare, "PMID 99999999 10.1000/ABC.DEF");
    reps.alpha.extra_raw = [{ path: bare, sha256: sha256(readFileSync(bare)) }];
    expect(fails(run().AC7).join()).toContain("no abstract file");
    reps.alpha.extra_raw = [absFile("11111111")];
    expect(fails(run().AC7).join()).toContain("no abstract file");
  });
  it("leaves a PubMed reference that is already in the base alone, even renumbered", () => {
    const line = (n: number) => `[${n}] Smith A. Synthetic trial. PMID: 99999999 https://pubmed.ncbi.nlm.nih.gov/99999999/`;
    const base = fx("alpha.base.md").replace("[1] Smith A. Synthetic trial. 2019.", line(1));
    put("docs/blog/alpha.md", base);
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "pubmed base", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.", line(1)));
    expect(fails(run().AC7).join()).not.toContain("no abstract file");
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.\n\n[2] Jones B. Synthetic safety review. 2020.", `[1] Jones B. Synthetic safety review. 2020.\n\n${line(2)}`));
    expect(fails(run().AC7).join()).not.toContain("no abstract file");
  });
  it("under --masters, --check-ids resolves retained base citations too, not only new ones (Codex round 2)", () => {
    const line = "[1] Smith A. Synthetic trial. PMID: 99999999 https://pubmed.ncbi.nlm.nih.gov/99999999/";
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("[1] Smith A. Synthetic trial. 2019.", line));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "pubmed base", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.", line));
    const seen: string[] = [];
    const go = (masters: boolean) => { seen.length = 0; return run({ masters, checkIds: true, headStatus: (u) => { seen.push(u); return 404; }, delayMs: 0 }).AC7; };
    expect(fails(go(false)).join()).not.toContain("99999999");
    expect(seen).toEqual([]);
    expect(fails(go(true)).join()).toContain("alpha: pmid 99999999 returned 404");
    expect(fails(go(true)).join()).not.toContain("no abstract file"); // the new-reference abstract rule stays new-only
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
  it("allows a hedge total to fall only inside sentences declared deleted, as a WARN", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.\n", ""));
    reps.alpha.deleted_sentences.push({ sentence: "Some evidence suggests benefit.", justification: "Not in raw." });
    const r = run().AC3;
    expect(r.status).toBe("WARN");
    expect(r.evidence.join()).toContain("hedge tokens fell 3 -> 1, all inside declared deleted sentences");
  });
  it("fails a hedge total that falls through an undeclared removal, even when the body shrank", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.\n", ""));
    const f = fails(run().AC3).join();
    expect(f).toContain("hedge tokens fell 3 -> 1");
    expect(f).not.toContain("body shrank");
  });
  it("keeps the hard FAIL for a pathway", () => {
    put("docs/pathway/beta.md", fx("beta.base.md").replace("severe.", "severe. It may help."));
    sh(["add", "docs/pathway/beta.md"]); sh(["commit", "-q", "-m", "beta hedge", "--", "docs/pathway/beta.md"]);
    put("docs/pathway/beta.md", fx("beta.new.md"));
    expect(fails(run().AC3).join()).toContain("hedge tokens fell 1 -> 0");
  });
  it("fails a hedge lost from a sentence that survives undeclared", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.", "Benefit is shown. It may help. It might help."));
    const f = fails(run().AC3).join("\n");
    expect(f).toContain('hedge lost from a surviving sentence "suggests"');
    expect(f).toContain("base: Some evidence suggests benefit.");
  });
  it("lists hedge loss per sentence pair as WARN when the sentence is declared deleted", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Some evidence suggests benefit.", "Benefit is shown. It may help. It might help."));
    reps.alpha.deleted_sentences.push({ sentence: "Some evidence suggests benefit.", justification: "reworded to match the source" });
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
    put("docs/pathway/beta.md", fx("beta.new.md").replace("Go to the emergency department if symptoms are severe.\n", ""));
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
  it("keeps headings at every level from 1 to 6", () => {
    for (const h of ["##### Deep heading", "###### Deeper heading"]) {
      put("docs/blog/alpha.md", fx("alpha.base.md").replace("## Safety", `${h}\n\nNote text.\n\n## Safety`));
      sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "deep", "--", "docs/blog/alpha.md"]);
      put("docs/blog/alpha.md", fx("alpha.new.md").replace("## Safety", "Note text.\n\n## Safety"));
      expect(fails(run().AC4).join()).toContain(`heading missing from new body: ${h}`);
    }
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
    .replace("Doses of 2 g may cause upset [2].", "Doses of 200 mg may cause upset [2].");
  const swapReport = () => {
    const raw = "The study gave 2,000 mg in adults each week. Doses of 200 mg were not studied at all.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [
      { body_line: "Trials used 2 g in adults [1].", raw_quote: "gave 2,000 mg in adults each week" },
      { body_line: "Doses of 200 mg may cause upset [2].", raw_quote: "Doses of 200 mg were not studied at all" },
    ];
  };
  it("fails a dose swap between two sentences whose wording is unchanged, even with equal whole-body counts", () => {
    put("docs/blog/alpha.md", swapped());
    reps.alpha.changed_tokens = [];
    const f = fails(run().AC2).join("\n");
    expect(f).toContain('token "2000 mg" changed between paired sentences and no entry covers it');
    expect(f).toContain('token "200 mg" changed between paired sentences and no entry covers it');
  });
  const withRaw = (extra: string) => {
    const raw = `${fx("alpha.raw.txt")}\n${extra}`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
  };
  it("R1: a source saying 'one hundred twenty mg' does not verify a body saying 20 mg", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it with food", "Participants took 20 mg daily for six weeks.\nTake it with food"));
    withRaw("Participants took one hundred twenty mg daily for six weeks.");
    reps.alpha.changed_tokens.push({ body_line: "Participants took 20 mg daily for six weeks.", raw_quote: "Participants took one hundred twenty mg daily for six weeks." });
    expect(fails(run().AC2).join("\n")).toContain("20 mg");
    reps.alpha.changed_tokens[reps.alpha.changed_tokens.length - 1].body_line = "Participants took 120 mg daily for six weeks.";
  });
  it("R1 (round 12): a quote cut inside 'one hundred twenty mg' does not verify 20 mg", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it with food", "Participants took 20 mg daily for six weeks.\nTake it with food"));
    withRaw("Participants took one hundred twenty mg daily for six weeks.");
    reps.alpha.changed_tokens.push({ body_line: "Participants took 20 mg daily for six weeks.", raw_quote: "twenty mg daily for six weeks." });
    expect(fails(run().AC2).join("\n")).toContain("20 mg");
  });
  it("R2: swapping 'six mg' and 'twelve mg' between two sentences needs an entry on each line", () => {
    const base = fx("alpha.new.md").replace("Take it with food", "Adults took six mg before breakfast.\nChildren took twelve mg after dinner.\nTake it with food");
    put("docs/blog/alpha.md", base);
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "words", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", base.replace("six mg", "TMP").replace("twelve mg", "six mg").replace("TMP", "twelve mg"));
    withRaw("Adults took twelve mg before breakfast. Children took six mg after dinner.");
    const f = fails(run().AC2).join("\n");
    expect(f).toContain('token "12 mg" changed between paired sentences and no entry covers it');
    expect(f).toContain('token "6 mg" changed between paired sentences and no entry covers it');
  });
  it("fails a swap when only one of the two changed lines has an entry", () => {
    put("docs/blog/alpha.md", swapped());
    swapReport();
    reps.alpha.changed_tokens.pop();
    const f = fails(run().AC2).join("\n");
    expect(f).toContain('token "200 mg" changed between paired sentences and no entry covers it: Doses of 200 mg may cause upset [2].');
    expect(f).not.toContain("Trials used 2 g");
  });
  it("fails a second changed line holding the same new number when only the first has an entry", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it with food", "Children also took 300 mg in trials.\nTake it with food"));
    const f = fails(run().AC2).join("\n");
    expect(f).toContain('body line has no entry quoting "300 mg": Children also took 300 mg in trials.');
    expect(f).not.toContain("quoting \"300 mg\": Trials used");
  });
  it("warns, not fails, when a number relocated into a restructured sentence", () => {
    const tail = (t: string) => `## Timing\n\n${t}\n\n## Safety`;
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("## Safety", tail("Take 75 mg at night.\n\nSome take 25 mg by day.")));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "timing", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("## Safety", tail("Take 75 mg at night and 25 mg by day.")));
    const r = run().AC2;
    expect(fails(r).join("\n")).not.toContain("changed between paired sentences");
    expect(r.evidence.join("\n")).toContain("number moved between sentences");
  });
  it("still fails a value that entered a sentence and raised the whole-body count, or is absent from the base", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Trials used 300 mg in adults [1].", "Trials used 2 g in adults [1]."));
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain('token "2000 mg" is new in the body');
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Doses of 2 g may", "Doses of 4 g may"));
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
    reps.alpha.changed_tokens[1].body_line = "An unrelated line about 200 mg.";
    expect(fails(run().AC2).join()).toContain("not a current body line");
    reps.alpha.changed_tokens[1].body_line = "Doses of 200 mg may cause upset [2].";
    reps.alpha.changed_tokens[1].raw_quote = "Doses of 200 mg were never studied at all";
    expect(fails(run().AC2).join()).toContain("not in the raw file");
  });
  it("fails a new numeric sentence with no base match and no changed_tokens entry, even when counts are unchanged", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Trials used 300 mg in adults [1].", "Pregnancy warrants caution with 200 mg twice."));
    reps.alpha.changed_tokens = [];
    expect(fails(run().AC2).join()).toContain("new numeric sentence has no entry: Pregnancy warrants caution with 200 mg twice.");
    const raw = "Pregnancy warrants caution with 200 mg twice per the study group.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ body_line: "Pregnancy warrants caution with 200 mg twice.", raw_quote: "Pregnancy warrants caution with 200 mg twice per the study group" }];
    expect(fails(run().AC2).join()).not.toContain("new numeric sentence");
  });
  it("warns when a claim keeps its number but loses its citation", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Doses of 2 g may cause upset [2].", "Doses of 2 g may cause upset."));
    reps.alpha.deleted_sentences.push({ sentence: "Doses of 2 g may cause upset [2].", justification: "test" });
    const w = run().AC4.evidence.filter((e) => e.includes("claim lost its citation"));
    expect(w.length).toBe(1);
    expect(w[0]).toContain("Doses of 2 g may cause upset [2].");
    expect(w[0]).toContain("Doses of 2 g may cause upset.");
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
    reps.alpha.changed_tokens[0].raw_quote = "NIH: participants took 300 mg in adults"; // only in the main raw
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

describe("US-42 AC2 a unit-only change (R2)", () => {
  it("fails 90 g/L becoming 90 g/dL without an entry", () => {
    const line = (u: string) => `Albumin was 90 ${u} in the cohort.\n\n## Safety`;
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("## Safety", line("g/L")));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "albumin", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("## Safety", line("g/dL")));
    expect(fails(run().AC2).join()).toContain('token "90 g/dL" is new in the body');
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
    reps.alpha.changed_tokens[0].raw_quote = "300 mg in adults";
    expect(fails(run().AC2).join()).toContain("raw_quote too short");
  });
  it("fails a token that only matches inside a longer number in the raw", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("300 mg in adults", "7 mg in adults"));
    const raw = "In the study participants took 1.7 mg in adults for a while now and more.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.changed_tokens = [{ body_line: "Trials used 7 mg in adults [1].", raw_quote: "7 mg in adults for a while now and more" }];
    expect(fails(run().AC2).join()).toContain("not whole tokens");
    const ok = "In the study participants took 7 mg in adults for a while now and more.";
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
    expect(t("500 mg daily")).toEqual(["500 mg/day"]);
  });
  it("reads daily, a day, each day and per day after a unit as /day, and weekly or a week as /week", () => {
    expect(t("45,000 mcg daily")).toEqual(["45 mg/day"]);
    expect(t("3,000 mg per day for people")).toEqual(["3000 mg/day"]);
    expect(t("2 g a day")).toEqual(["2000 mg/day"]);
    expect(t("50 mg each day")).toEqual(["50 mg/day"]);
    expect(t("500 mg daily")).toEqual(t("500 mg/day"));
    expect(t("10 mg weekly")).toEqual(["10 mg/week"]);
    expect(t("10 mg a week")).toEqual(["10 mg/week"]);
    expect(t("10 mg each week")).toEqual(t("10 mg per week"));
    expect(t("500 mg in adultsish")).toEqual(["500 mg"]);
    expect(t("500 mg and daily")).toEqual(["500 mg"]);
  });
  it("gives /day to a dose unit with daily or per day up to three words later, but not through 'and'", () => {
    expect(t("150 mg enteric coated, daily")).toEqual(["150 mg/day"]);
    expect(t("150 mg enteric coated tablets per day")).toEqual(["150 mg/day"]);
    expect(t("150 mg of the pure powder daily")).toEqual(["150 mg"]); // four words
    expect(t("for 4 weeks, taken daily")).toEqual(["4 week"]); // a duration is not a dose
  });
  it("applies a comparator word that ends a line with ':' to the numbers on the list items below it", () => {
    expect(t("Seek care if you have more than:\n- 3 episodes\n- 5 mg a day")).toEqual([">3", ">5 mg/day"].sort());
    expect(t("Seek care if you have more than:\n- 3 episodes\nBut 4 is fine.")).toEqual(["4", ">3"]);
    expect(t("Doses:\n- 3 episodes")).toEqual(["3"]);
  });
  it("reads comparator words with the right direction, longest phrase first", () => {
    const cases: [string, string][] = [
      ["no more than 2 cups", "≤2"], ["not more than 5 mg", "≤5 mg"], ["up to 3 g", "≤3000 mg"], ["maximum 4 mg", "≤4 mg"], ["maximum of 4 mg", "≤4 mg"],
      ["no less than 2 hours", "≥2 hour"], ["not less than 6 weeks", "≥6 week"], ["at least 3 doses", "≥3"], ["8 or higher", "≥8"], ["8 or above", "≥8"], ["8 or more", "≥8"],
      ["more than 2 cups", ">2"], ["greater than 5 mg", ">5 mg"], ["over 65 years", ">65 year"], ["above 140 mmHg", ">140 mmHg"],
      ["less than 2 cups", "<2"], ["lower than 5 mg", "<5 mg"], ["below 3 mmol/L", "<3 mmol/L"], ["under 18 years", "<18 year"], ["10 or less days", "≤10 day"],
    ];
    for (const [text, key] of cases) expect(t(text), text).toEqual([key]);
    expect(t("no  more  than 2 cups")).toEqual(["≤2"]);
    expect(t("no more than 2 cups")).not.toEqual(t("more than 2 cups"));
    expect(t("Recover the hover 5 mg")).toEqual(["5 mg"]); // "over" inside a word is not a comparator
  });
  it("gives both ends of a range the unit, whichever separator it uses", () => {
    const pct = ["40 %", "60 %"];
    for (const text of ["40–60%", "40-60%", "40 - 60 %", "40 to 60% of patients", "between 40 and 60%", "40 and 60 percent"]) expect(t(text), text).toEqual(pct);
    expect(t("5 to 10 mg")).toEqual(["10 mg", "5 mg"]);
    expect(t("5 mg to 10 mg")).toEqual(["10 mg", "5 mg"]);
    expect(t("between 2 and 4 years")).toEqual(["2 year", "4 year"]);
    expect(t("2 to 4 years")).toEqual(t("2–4 years"));
    expect(t("type 1 and 2 diabetes")).toEqual([]);
  });
  it("reads 'maximum <word> N' like 'maximum of N'", () => {
    expect(t("maximum duration 1 week")).toEqual(["≤1 week"]);
    expect(t("maximum of 1 week")).toEqual(["≤1 week"]);
    expect(t("maximum dose 4 mg")).toEqual(["≤4 mg"]);
    expect(t("maximum 4 mg")).toEqual(["≤4 mg"]);
  });
  it("decodes HTML entities before matching", () => {
    expect(t("5&#xa0;grams")).toEqual(["5000 mg"]);
    expect(t("5&nbsp;mg")).toEqual(["5 mg"]);
    expect(t("5&#160;mg &amp; 6 mg")).toEqual(["5 mg", "6 mg"]);
    expect(t("40&#8211;60 mg")).toEqual(["40 mg", "60 mg"]);
    expect(t("&lt;5 mg")).toEqual(["<5 mg"]);
    expect(t("&gt;5 mg")).toEqual([">5 mg"]);
    expect(normQuote("5&#xa0;grams &amp; more &ndash; ok")).toBe("5 grams & more - ok");
  });
  it("reads a hyphenated unit like its plural form", () => {
    expect(t("30-s chair stand")).toEqual(["30 sec"]);
    expect(t("30-second test")).toEqual(["30 sec"]);
    expect(t("30-second test")).toEqual(t("30 seconds"));
    expect(t("8-week course")).toEqual(["8 week"]);
    expect(t("8-week course")).toEqual(t("8 weeks"));
    expect(t("5 s")).toEqual(["5 sec"]);
    expect(t("the 1990s")).toEqual([]);
  });
  it("reads over/above before a range as a time span, and before a single number as >", () => {
    expect(t("over 12 to 72 hours")).toEqual(["12 hour", "72 hour"]);
    expect(t("came on over 6 to 12 hours")).toEqual(["12 hour", "6 hour"]);
    expect(t("above 5–10 mg")).toEqual(["10 mg", "5 mg"]);
    expect(t("over 12 hours")).toEqual([">12 hour"]);
    expect(t("above 140 mmHg")).toEqual([">140 mmHg"]);
    expect(t("less than 5 to 10 mg")).toEqual(["<10 mg", "<5 mg"]);
  });
  it("skips a digit that is part of a name (5-ASA, 6-MP, 5-HT3, B12, CHA2DS2, COVID-19)", () => {
    expect(t("5-ASA")).toEqual([]);
    expect(t("maximum 5-ASA dose")).toEqual([]);
    expect(t("6-MP 50 mg")).toEqual(["50 mg"]);
    expect(t("5-HT3 blockers")).toEqual([]);
    expect(t("B12 and CHA2DS2 and COVID-19")).toEqual([]);
    expect(t("5-year course")).toEqual(["5 year"]);
    expect(t("5-10 mg")).toEqual(["10 mg", "5 mg"]);
  });
  it("strips trailing punctuation from a unit and reads minute(s) inside a compound unit as min", () => {
    expect(t("40 mL/minute.")).toEqual(["40 mL/min"]);
    expect(t("40 mL/minutes,")).toEqual(["40 mL/min"]);
    expect(t("40 mL/minute")).toEqual(t("40 mL/min"));
    expect(t("90 mL/minute/1.73m2")).toEqual(["90 mL/min/1.73m2"]);
    expect(t("5 mg/m2.")).toEqual(["5 mg/m2"]);
    expect(t("5 mg/second")).toEqual(["5 mg/sec"]);
  });
  it("normalises spelled-out units inside compounds to the symbol compound, denominator case-insensitive", () => {
    expect(t("20 micrograms/L")).toEqual(["20 mcg/L"]);
    expect(t("20 micrograms/L")).toEqual(t("20 mcg/L"));
    expect(t("4 MICROGRAMS/l")).toEqual(t("4 mcg/L"));
    expect(t("5 milligrams/dL")).toEqual(t("5 mg/dL"));
    expect(t("5 grams/L")).toEqual(["5 g/L"]); // a concentration, not 5000 mg/L
    expect(t("5 grams/L")).toEqual(t("5 g/L"));
    expect(t("3 nanograms/mL")).toEqual(t("3 ng/mL"));
    expect(t("3 ng/ml")).toEqual(["3 ng/mL"]);
    expect(t("40 mL/minute")).toEqual(["40 mL/min"]);
    expect(t("10 litres/minute")).toEqual(["10 L/min"]);
    expect(t("5 g/day")).toEqual(["5000 mg/day"]);
  });
  it("skips digits in disease and category names (type 1/2, stage 1-5) but keeps class 2 to 5", () => {
    for (const s of ["type 2 diabetes", "Type 2", "TYPE 1", "CKD stage 3", "stage 5 disease"]) expect(t(s)).toEqual([]);
    expect(t("class 2 to 5")).toEqual(["2", "5"]);
    expect(t("type 2 diabetes, 500 mg")).toEqual(["500 mg"]);
  });
  it("normalises compound units that already work (symbols, spelled-out time and volume, g/day)", () => {
    expect(t("3 ng/ml")).toEqual(["3 ng/mL"]);
    expect(t("40 mL/minute")).toEqual(["40 mL/min"]);
    expect(t("10 litres/minute")).toEqual(["10 L/min"]);
    expect(t("5 g/day")).toEqual(["5000 mg/day"]);
  });
  it("reads spelled-out units like their symbols", () => {
    expect(t("3 grams per day")).toEqual(t("3 g/day"));
    expect(t("3 grams per day")).toEqual(["3000 mg/day"]);
    expect(t("2 milligrams")).toEqual(["2 mg"]);
    expect(t("50 micrograms")).toEqual(["50 mcg"]);
    expect(t("1 kilogram")).toEqual(["1 kg"]);
    expect(t("2 litres")).toEqual(["2 L"]);
    expect(t("2 liters")).toEqual(t("2 litres"));
    expect(t("5 millilitres")).toEqual(["5 mL"]);
    expect(t("5 milliliters")).toEqual(["5 mL"]);
    expect(t("4 hours, 3 days, 2 weeks, 6 months, 5 years")).toEqual(["2 week", "3 day", "4 hour", "5 year", "6 month"]);
  });
  it("knows nmol/L, pmol/L, bpm, breaths/min, L/min, minutes and seconds", () => {
    expect(t("60 bpm")).toEqual(["60 bpm"]);
    expect(t("12 breaths/min")).toEqual(["12 breaths/min"]);
    expect(t("2 L/min")).toEqual(["2 L/min"]);
    expect(t("2 L/min")).not.toEqual(t("2 mL/min"));
    expect(t("5 minutes")).toEqual(["5 min"]);
    expect(t("5 min")).toEqual(["5 min"]);
    expect(t("1 minute")).toEqual(["1 min"]);
    expect(t("30 seconds")).toEqual(["30 sec"]);
    expect(t("4 nmol/L")).toEqual(["4 nmol/L"]);
    expect(t("4 pmol/L")).toEqual(["4 pmol/L"]);
  });
  it("keeps concentration units apart, and never truncates an unknown /suffix", () => {
    const units = ["g/L", "g/dL", "ng/mL", "ng/dL", "mcg/L", "mmol/L", "pmol/L", "nmol/L", "IU/L", "U/L", "mg/dL", "mg/L", "mcg/dL"];
    const keys = units.map((u) => t(`90 ${u}`)[0]);
    expect(keys).toEqual(units.map((u) => `90 ${u}`));
    expect(new Set(keys).size).toBe(units.length);
    expect(t("90 g/L")).not.toEqual(t("90 g/dL"));
    expect(t("90 µg/L")).toEqual(t("90 mcg/L"));
    expect(t("5 mg/m2")).toEqual(["5 mg/m2"]);
    expect(t("5 mg/month")).toEqual(["5 mg/month"]);
    expect(t("5 mg/m2")).not.toEqual(t("5 mg"));
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

describe("US-42 AC2 references sections, unit spellings, aged N (R14)", () => {
  const t = (s: string) => [...tokenise(s)].sort();
  it.each(["# References", "#### Sources", "##### References", "## Sources"])("skips every line under %s, subheadings included", (h) => {
    const body = `## Dose\nTake 5 mg.\n\n${h}\n\nJ Foo. 2019;45:123-130.\n\n###### 2020 papers\nBar. 2020;12:99.\n`;
    expect(t(body)).toEqual(["5 mg"]);
  });
  it("a following heading of the same or higher level ends the section", () => {
    expect(t("### References\nFoo 2019;45:123.\n#### Older\nBar 2018;7:55.\n### Dose\nTake 5 mg.\n")).toEqual(["5 mg"]);
    expect(t("## Sources\nFoo 2019;45:123.\n# Dose\nTake 6 mg.\n")).toEqual(["6 mg"]);
  });
  it("skips [n] reference lines anywhere", () => {
    expect(t("Text 5 mg.\n\n[1] Foo. J Bar. 2019;45:123-130.\n")).toEqual(["5 mg"]);
  });
  it("reads 'per liter', 'per litre' and 'per L' as /L", () => {
    for (const w of ["per liter", "per litre", "per L"]) expect(t(`70 micrograms ${w}`)).toEqual(t("70 mcg/L"));
    expect(t("70 mcg/L")).toEqual(["70 mcg/L"]);
    expect(t("12 ng per litre")).toEqual(t("12 ng/L"));
  });
  it("reads microg and µg as mcg", () => {
    expect(t("50 microg")).toEqual(["50 mcg"]);
    expect(t("50 µg")).toEqual(["50 mcg"]);
    expect(t("50 microg/L")).toEqual(t("50 mcg/L"));
  });
  it("reads /d as /day", () => {
    expect(t("400 micrograms/d")).toEqual(t("400 mcg/day"));
    expect(t("5 mg/d")).toEqual(t("5 mg/day"));
    expect(t("5 mg/dL")).toEqual(["5 mg/dL"]);
  });
  it("reads N-monthly, -weekly, -hourly, -yearly as N month, week, hour, year", () => {
    expect(t("3-monthly")).toEqual(t("3 month"));
    expect(t("6-weekly")).toEqual(t("6 week"));
    expect(t("4-hourly")).toEqual(t("4 hour"));
    expect(t("2-yearly")).toEqual(t("2 year"));
  });
  it("gives 'aged 60 or older' the token of '60 years or older'", () => {
    expect(t("aged 60 or older")).toEqual(t("60 years or older"));
    expect(t("aged 60 years or older")).toEqual(t("60 years or older"));
    expect(t("aged 60 or older")).toEqual(["60 year"]);
    expect(t("aged 6 months")).toEqual(["6 month"]);
    expect(t("aged 18-65 years")).toEqual(t("18-65 years"));
  });
  it("gives '1,000 micrograms a day' and '1 mg a day' one token", () => {
    expect(t("1,000 micrograms a day")).toEqual(t("1 mg a day"));
    expect(t("1,000 micrograms a day")).toEqual(["1 mg/day"]);
    expect(t("400 mcg")).toEqual(["400 mcg"]);
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
  it("reads a DOI with balanced parentheses whole, in the URL, the link text and --check-ids", () => {
    const dois = ["10.1016/s0168-0102(02)00007-x", "10.1016/S0006-3223(99)00103-7", "10.1016/0006-2952(90)90227-x", "10.1093/jn/nxab012"];
    for (const d of dois) {
      withRef(`[3] Foo B. Study. [${d}](https://doi.org/${d})`);
      expect(idFails(), d).toBe("");
      withRef(`[3] Foo B. Study. [doi:${d}](https://doi.org/${d}).`);
      expect(idFails(), d).toBe("");
    }
    withRef("[3] Foo B. Study. [10.1016/s0168-0102(02)00007-y](https://doi.org/10.1016/s0168-0102(02)00007-x)");
    expect(idFails()).toContain("differs from its URL DOI 10.1016/s0168-0102(02)00007-x");
    withRef(`[3] Foo B. Study. [x](https://doi.org/${dois[0]})`);
    const seen: string[] = [];
    run({ checkIds: true, headStatus: (u) => { seen.push(u); return 200; }, delayMs: 0 });
    expect(seen).toEqual([`https://doi.org/${dois[0]}`]);
  });
  it("fails a printed PMID that differs from a pubmed URL id on the same line", () => {
    withRef("[3] Foo B. Study. PMID: 22222222 https://pubmed.ncbi.nlm.nih.gov/33333333/");
    expect(idFails()).toContain("PMID 22222222 differs from the pubmed URL id 33333333");
    withRef("[3] Foo B. Study. PMID: 33333333 https://pubmed.ncbi.nlm.nih.gov/33333333/");
    expect(idFails()).toBe("");
  });
});

describe("US-42 AC2 derived tokens and the emergency number (B)", () => {
  it("ignores a wrong legacy token field: the checker derives the numbers", () => {
    Object.assign(reps.alpha.changed_tokens[0], { token: "999 mg" });
    expect(fails(run().AC2)).toEqual([]);
  });
  it("needs a body line and a quote that carry the SAME number (a mismatch fails)", () => {
    reps.alpha.changed_tokens[0].raw_quote = "Doses of 2,000 mg were not studied";
    expect(fails(run().AC2).join()).toContain("shares no number with its body_line");
  });
  it("skips 111 in a 'call 111' sentence, but not a dose of 111 mg", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it with food", "Call 111 if you feel unwell.\nTake it with food"));
    expect(fails(run().AC2)).toEqual([]);
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Take it with food", "Take 111 mg with food"));
    expect(fails(run().AC2).join()).toContain('"111 mg"');
  });
});

describe("US-42 AC2 every entry sharing a token (R14a)", () => {
  const second = (over = {}) => reps.alpha.changed_tokens.push({ body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg in adults", ...over });
  it("validates each entry, not the first", () => {
    second();
    expect(fails(run().AC2)).toEqual([]);
    reps.alpha.changed_tokens.pop();
    second({ raw_quote: "participants took 300 mg in nobody at all" });
    expect(fails(run().AC2).join()).toContain("not in the raw file");
    reps.alpha.changed_tokens.pop();
    second({ body_line: "An unrelated line." });
    expect(fails(run().AC2).join()).toContain("not a current body line");
    reps.alpha.changed_tokens.pop();
    second({ raw_quote: " " });
    expect(fails(run().AC2).join()).toContain("empty raw_quote");
  });
});

describe("US-42 AC4 body hyperlink lines (R14b)", () => {
  it("counts a whole-line hyperlink in the body as a sentence, but not one in the References section", () => {
    put("docs/blog/alpha.md", fx("alpha.base.md").replace("## Safety", "[Some resource](https://example.org/x)\n\n## Safety"));
    sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "link line", "--", "docs/blog/alpha.md"]);
    put("docs/blog/alpha.md", fx("alpha.new.md"));
    expect(fails(run().AC4).join()).toContain("sentence removed and not in deleted_sentences: [Some resource](https://example.org/x)");
  });
});

describe("US-42 AC2 primary study cited without its abstract (R14d)", () => {
  const pm = "12345678";
  const abstract = (id: string, name = `${id}.md`) => {
    const dir = join(reports, "pubmed");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, name);
    writeFileSync(f, `# PubMed ${id}\n\nIn the trial, participants took 300 mg in adults every day.\n`);
    return { path: f, sha256: sha256(readFileSync(f)) };
  };
  beforeEach(() => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[1] Smith A. Synthetic trial. 2019.", `[1] Smith A. Synthetic trial. PMID: ${pm} https://pubmed.ncbi.nlm.nih.gov/${pm}/`));
  });
  const flagged = () => fails(run().AC2).join("\n");
  it("fails a ConsumerLab-only quote for a number whose sentence cites a PubMed record", () => {
    expect(flagged()).toContain("number cited to a primary study without its abstract in reach");
  });
  it("accepts a quote from the cited PMID's abstract", () => {
    reps.alpha.extra_raw = [abstract(pm)];
    reps.alpha.changed_tokens[0].raw_quote = "EXTRA: participants took 300 mg in adults every day";
    expect(flagged()).toBe("");
  });
  it("fails an NIH quote from a non-abstract extra for a cited number", () => {
    const nih = join(reports, "nih.txt");
    writeFileSync(nih, "NIH says participants took 300 mg in adults every day.");
    reps.alpha.extra_raw = [{ path: nih, sha256: sha256(readFileSync(nih)) }];
    reps.alpha.changed_tokens[0].raw_quote = "NIH: participants took 300 mg in adults every day";
    expect(flagged()).toContain("without its abstract in reach");
  });
  it("lets a number whose own sentence has no [n] quote ConsumerLab", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("Trials used 300 mg in adults [1].", "Trials used 300 mg in adults.").replace("[1] Smith A. Synthetic trial. 2019.", `[1] Smith A. Synthetic trial. PMID: ${pm} https://pubmed.ncbi.nlm.nih.gov/${pm}/`));
    expect(flagged()).not.toContain("without its abstract");
  });
  it("fails a quote found only in another study's abstract", () => {
    reps.alpha.extra_raw = [abstract("87654321")];
    reps.alpha.changed_tokens[0].raw_quote = "EXTRA: participants took 300 mg in adults every day";
    expect(flagged()).toContain("number cited to a primary study without its abstract in reach");
  });
  it("resolves [n] from the entry's own sentence, not from another sentence holding the same number", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md")
      .replace("[1] Smith A. Synthetic trial. 2019.", `[1] Smith A. Synthetic trial. PMID: ${pm} https://pubmed.ncbi.nlm.nih.gov/${pm}/`)
      .replace("Doses of 2 g may cause upset [2].", "Doses of 300 mg may cause upset [2]."));
    const raw = "In the trial, participants took 300 mg in adults for 12 weeks. Elsewhere, doses of 300 mg may cause upset in some people.";
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.extra_raw = [abstract(pm)];
    reps.alpha.changed_tokens = [
      { body_line: "Trials used 300 mg in adults [1].", raw_quote: "EXTRA: participants took 300 mg in adults every day" },
      { body_line: "Doses of 300 mg may cause upset [2].", raw_quote: "Elsewhere, doses of 300 mg may cause upset in some people" },
    ];
    expect(flagged()).not.toContain("without its abstract");
    reps.alpha.changed_tokens[0].raw_quote = "participants took 300 mg in adults for 12 weeks";
    expect(flagged()).toContain("without its abstract in reach");
  });
  it("looks up the citation of a list item with its comparator from the line above (R2)", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md")
      .replace("[1] Smith A. Synthetic trial. 2019.", `[1] Smith A. Synthetic trial. PMID: ${pm} https://pubmed.ncbi.nlm.nih.gov/${pm}/`)
      .replace("Some evidence suggests benefit.", "Seek care if you take more than:\n- 5 mg a day [1]."));
    const raw = `${fx("alpha.raw.txt")}\nSafety limits: more than 5 mg a day were evaluated in adults.`;
    writeFileSync(join(reports, "alpha.raw.txt"), raw);
    reps.alpha.raw_sha256 = sha256(raw);
    reps.alpha.extra_raw = [abstract(pm)];
    reps.alpha.changed_tokens = [
      { body_line: "Trials used 300 mg in adults [1].", raw_quote: "EXTRA: participants took 300 mg in adults every day" },
      { body_line: "- 5 mg a day [1].", raw_quote: "more than 5 mg a day were evaluated in adults" },
    ];
    expect(flagged()).toContain("without its abstract in reach");
  });
  it("does not apply when the cited reference is not a PubMed record", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md"));
    reps.alpha.extra_raw = [abstract("87654321")];
    reps.alpha.changed_tokens[0].raw_quote = "EXTRA: participants took 300 mg in adults every day";
    expect(flagged()).not.toContain("without its abstract");
  });
});

describe("US-42 AC9 pathway source line (R14c)", () => {
  it("requires Last reviewed: <month> <year> on the source line", () => {
    const src = (line: string) => put("docs/pathway/beta.md", fx("beta.new.md").replace(/^\*Source:.*$/m, line));
    src("*Source: Auckland Region HealthPathways*");
    expect(fails(run().PATHWAY).join()).toContain('Last reviewed: <month> <year>');
    src("*Source: Auckland Region HealthPathways. Last reviewed: 2026*");
    expect(fails(run().PATHWAY).join()).toContain('Last reviewed: <month> <year>');
    src("*Source: Auckland Region HealthPathways. Last reviewed: March 2026*");
    expect(fails(run().PATHWAY)).toEqual([]);
    src("*Source: Auckland Region HealthPathways. Last reviewed: Mar 2026*");
    expect(fails(run().PATHWAY)).toEqual([]);
  });
});

describe("US-42 AC9 pathway rules", () => {
  it("fails without the source line or deferral blockquote", () => {
    put("docs/pathway/beta.md", fx("beta.new.md").replace("*Source: Auckland Region HealthPathways. Last reviewed: January 2026*", "Source elsewhere").replace(/^>.*$/m, ""));
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
  it("fails funding criteria, but not a bare 'funded' or 'fully funded'", () => {
    const withLine = (l: string) => put("docs/pathway/beta.md", fx("beta.new.md").replace("Review again", `${l} Review again`));
    for (const bad of ["Special Authority applies.", "Check the funding criteria.", "Eligible for public funding.", "Eligibility for funding is limited.", "It is funded only if the patient has diabetes.", "Funded when the test is abnormal.", "Subsidised only for adults.", "PHARMAC decides.", "Subsidized if ordered by a specialist."]) {
      withLine(bad);
      expect(fails(run().PATHWAY).join("\n"), bad).toContain("forbidden term");
    }
    for (const ok of ["This medicine is funded.", "Fully funded in New Zealand.", "The test is subsidised.", "Take it to the pharmacy.", "Ask your pharmacist."]) {
      withLine(ok);
      expect(fails(run().PATHWAY), ok).toEqual([]);
    }
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

describe("US-42 AC2 void entries, number words, abbreviations (v3)", () => {
  const t = (s: string) => [...tokenise(s)].sort();
  it("void entries are skipped, listed as VOID lines, and never cover a token", () => {
    reps.alpha.changed_tokens.push({ body_line: "No such line.", raw_quote: "nothing like this in raw", void: true, void_reason: "typo in first draft" });
    const ok = run().AC2;
    expect(fails(ok)).toEqual([]);
    expect(ok.evidence.join("\n")).toContain("alpha: VOID changed_tokens 1 [base]: typo in first draft");
    reps.alpha.changed_tokens[0].void = true;
    reps.alpha.changed_tokens[0].void_reason = "retired";
    const bad = run().AC2;
    expect(fails(bad).join()).toContain('"300 mg"');
    expect(bad.evidence.join("\n")).toContain("alpha: VOID changed_tokens 0 [base]: retired");
  });
  it("lists every void entry in the --out markdown as section, index and a short reason hash: no free text (review R2)", () => {
    reps.alpha.changed_tokens.push({ body_line: "No such line, and a long one that runs past sixty characters for the clip.", raw_quote: "secret raw words here for the quote", void: true, void_reason: "typo | first draft" });
    const md = renderReport("t", "HEAD", "abc", [run().AC2], [], false);
    expect(md).toContain("## Voided entries");
    expect(md).toContain(`- alpha: VOID changed_tokens 1 [base] (reason sha256 ${sha256("typo | first draft").slice(0, 12)})`);
    for (const t of ["secret raw words", "typo", "No such line"]) expect(md).not.toContain(t);
  });
  it("validates void and void_reason, and documents them in the schema", () => {
    const r = { ...exampleReport("x"), changed_tokens: [{ body_line: "a", raw_quote: "b", void: "yes" }] };
    expect(validateReport(r).join()).toContain("void");
    const v = { ...exampleReport("x"), changed_tokens: [{ body_line: "a", raw_quote: "b", void: true }] };
    expect(validateReport(v).join()).toContain("void entry without void_reason");
    expect(JSON.stringify(REPORT_SCHEMA)).toContain("void_reason");
  });
  it("reads number words before a unit", () => {
    expect(t("for six weeks")).toEqual(["6 week"]);
    expect(t("for Forty-five days")).toEqual(["45 day"]);
    expect(t("a twelve-week trial")).toEqual(["12 week"]);
    expect(t("took a hundred mg")).toEqual(["100 mg"]);
    expect(t("took one hundred mg")).toEqual(["100 mg"]);
    expect(t("for twenty-one days")).toEqual(["21 day"]);
    expect(t("for Ninety days")).toEqual(["90 day"]);
    expect(t("for fifteen minutes")).toEqual(["15 min"]);
  });
  it("parses compound number words whole, and yields nothing for a part it cannot parse", () => {
    expect(t("took one hundred twenty mg")).toEqual(["120 mg"]);
    expect(t("took two hundred and fifty mg")).toEqual(["250 mg"]);
    expect(t("took one thousand mg")).toEqual(["1000 mg"]);
    expect(t("took twenty-five mg")).toEqual(["25 mg"]);
    expect(t("took five six mg")).toEqual([]);
    expect(t("took twenty twenty mg")).toEqual([]);
    expect(t("between six and twelve mg")).toEqual(["12 mg"]);
  });
  it("reads a number word with no unit only when it opens a sentence before a counted noun", () => {
    expect(t("Forty-five adults took it.")).toEqual(["45"]);
    expect(t("It helped. Twelve patients improved.")).toEqual(["12"]);
    expect(t("We saw forty-five adults.")).toEqual([]);
    expect(t("Take one capsule with food.")).toEqual([]);
    expect(t("One was enough.")).toEqual([]);
  });
  it("reads abbreviated time units", () => {
    expect(t("4 wk")).toEqual(["4 week"]);
    expect(t("8 wks")).toEqual(["8 week"]);
    expect(t("72 h")).toEqual(["72 hour"]);
    expect(t("12 hr and 6 hrs")).toEqual(["12 hour", "6 hour"]);
    expect(t("10 d")).toEqual(["10 day"]);
  });
  it("lets a unit and its per-liter denominator sit up to four words apart", () => {
    expect(t("70 micrograms of lithium per liter")).toEqual(["70 mcg/L"]);
    expect(t("70 mcg/L")).toEqual(["70 mcg/L"]);
    expect(t("5 mg of a very long per litre")).toEqual(["5 mg/L"]);
    expect(t("5 mg of a very long drug name per litre")).toEqual(["5 mg"]);
  });
  it("reads a range whose daily suffix follows the second value", () => {
    expect(t("2 mg to 20 mg of the compound daily")).toEqual(["2 mg/day", "20 mg/day"]);
    expect(t("2 mg to 20 mg daily")).toEqual(["2 mg/day", "20 mg/day"]);
    expect(t("2 mg to 20 mg of the compound")).toEqual(["2 mg", "20 mg"]);
  });
  it("decodes numeric entities and reads g.kg-1 as per kg", () => {
    expect(t("0.1 g&#x2219;kg-1")).toEqual(t("0.1 g/kg"));
    expect(t("0.1 g&#x2219;kg-1")).toEqual(["100 mg/kg"]);
  });
  it("does not split sentences after Jr. Sr. et al. e.g. i.e. vs. Dr.", () => {
    expect(sentences("Martin Luther King Jr. spoke. Smith Sr. agreed with Lee et al. today, i.e. fine, e.g. here, vs. none. Dr. Who left.")).toEqual([
      "Martin Luther King Jr. spoke.", "Smith Sr. agreed with Lee et al. today, i.e. fine, e.g. here, vs. none.", "Dr. Who left."]);
  });
});

// ---- US-50 AC1 / US-42 AC1 amended: topic-master batches (--masters) ----

describe("US-50 AC1 topic-master frontmatter (US-42 AC1 amended)", () => {
  const SRC = '[{"name":"nih-ods","url":"https://ods.od.nih.gov/x","checked":"2026-10-20","fingerprint":"abc123"}]';
  const OTHER = "https://drstanfield.com/blogs/articles/other";
  const VIEW = `## Current view (reviewed 20 October 2026)\n\nShort view ([Brad, 1 Mar 2026](${OTHER})).\n`;
  const sections = (view = VIEW, videos = `## Brad's videos on this topic\n\n- 1 Mar 2026, [O](${OTHER}): take.\n`) =>
    `\n${view}\n${videos}`;
  const OTHER_TEXT = "---\ntitle: \"O\"\n---\n\nIn this video Brad explains why he changed his view on alpha supplements.\n";
  const POSTQ = "POST:other: Brad explains why he changed his view on alpha supplements";
  /** The current_view_basis entries a test's view sentences need. */
  const basisFor = (...sentences: string[]) => { reps.alpha.current_view_basis = sentences.map((sentence) => ({ sentence, source: "other", quote: POSTQ })); };
  beforeEach(() => {
    // "other" is a video post (index entry with no type) outside the batch: the Current view cites it, and it is an extra_raw.
    put("docs/blog/other.md", OTHER_TEXT);
    sh(["add", "docs/blog/other.md"]); sh(["commit", "-q", "-m", "post", "--", "docs/blog/other.md"]);
    reps.alpha.extra_raw = [{ path: "/elsewhere/docs/blog/other.md", sha256: sha256(OTHER_TEXT) }];
    basisFor(`Short view ([Brad, 1 Mar 2026](${OTHER})).`);
  });
  const alphaFm = (extra: string[], summary = "Alpha summary, 200 mg in adults.") =>
    fx("alpha.new.md").replace(/^summary:.*$/m, [`summary: "${summary}"`, ...extra].join("\n"));
  const master = (extra: string[], body = sections(), summary?: string) => {
    put("docs/blog/alpha.md", alphaFm(extra, summary).replace("## Dosing", `${body.trim()}\n\n## Dosing`));
  };
  const GOOD = [`reviewed: "2026-10-20"`, `sources: ${SRC}`];
  const mrun = () => run({ masters: true });
  const f1 = (r: Record<string, Result>) => fails(r.AC1).join("\n");

  it("without the flag, added master keys still fail exactly as today", () => {
    master(GOOD);
    expect(f1(run())).toContain("frontmatter changed");
  });
  it("allows added reviewed and sources on a reference", () => {
    master(GOOD);
    const r = mrun();
    expect(fails(r.AC1)).toEqual([]);
    expect(fails(r.MASTER)).toEqual([]);
  });
  it("allows a changed summary when it equals the proposed correction, and only then", () => {
    reps.alpha.proposed_summary_correction = "Alpha summary, 300 mg in adults.";
    put("docs/blog/index.json", INDEX.replace("200 mg in adults", "300 mg in adults"));
    master(GOOD, sections(), "Alpha summary, 300 mg in adults.");
    expect(fails(mrun().AC1)).toEqual([]);
    master(GOOD, sections(), "Alpha summary, 999 mg in adults.");
    expect(f1(mrun())).toContain("summary line differs from proposed_summary_correction");
  });
  it("fails a changed summary with no proposed correction", () => {
    master(GOOD, sections(), "Alpha summary, 999 mg in adults.");
    expect(f1(mrun())).toContain("summary");
  });
  it("allows reviewed, topics and router in the index diff of a batch handle, and nothing else", () => {
    master(GOOD);
    const entries = JSON.parse(INDEX);
    entries[0] = { ...entries[0], reviewed: "2026-10-20", topics: ["alpha"], router: "hidden" };
    put("docs/blog/index.json", JSON.stringify(entries, null, 2));
    expect(fails(mrun().AC1)).toEqual([]);
    entries[0].title = "Alpha 2";
    put("docs/blog/index.json", JSON.stringify(entries, null, 2));
    expect(f1(mrun())).toContain("index.json");
  });
  it("fails a frontmatter key that appears twice", () => {
    master([...GOOD, `reviewed: "2026-10-21"`]);
    expect(f1(mrun())).toContain("reviewed appears more than once");
    master([...GOOD, `summary: "Alpha summary, 200 mg in adults."`]);
    expect(f1(mrun())).toContain("summary appears more than once");
  });
  it("still protects every other frontmatter field", () => {
    master(GOOD);
    put("docs/blog/alpha.md", readFileSync(join(root, "docs/blog/alpha.md"), "utf8").replace('title: "Alpha"', 'title: "Alpha 2"'));
    expect(f1(mrun())).toContain("frontmatter");
    master([...GOOD, 'tags: ["x"]']);
    expect(f1(mrun())).toContain("frontmatter");
  });
  it("rejects topics or router on a reference", () => {
    master([...GOOD, 'topics: ["alpha"]']);
    expect(f1(mrun())).toContain("frontmatter");
    master([...GOOD, "router: hidden"]);
    expect(f1(mrun())).toContain("frontmatter");
  });
  it("rejects an invalid reviewed date", () => {
    master([`reviewed: "2026-13-40"`, `sources: ${SRC}`]);
    expect(f1(mrun())).toContain("reviewed");
    master([`reviewed: 2026-10-20`, `sources: ${SRC}`]);
    expect(f1(mrun())).toContain("reviewed");
  });
  it("rejects sources that do not parse, miss a key, are empty, or are absent next to reviewed", () => {
    master([`reviewed: "2026-10-20"`, "sources: [not json"]);
    expect(f1(mrun())).toContain("sources");
    master([`reviewed: "2026-10-20"`, `sources: [{"name":"n","url":"u","checked":"2026-10-20"}]`]);
    expect(f1(mrun())).toContain("fingerprint");
    master([`reviewed: "2026-10-20"`]);
    expect(f1(mrun())).toContain("sources");
    master([`reviewed: "2026-10-20"`, "sources: []"]);
    expect(f1(mrun())).toContain("sources");
  });
  it("rejects a source name outside consumerlab, nih-ods and brad-video", () => {
    master([`reviewed: "2026-10-20"`, `sources: ${SRC.replace("nih-ods", "NIH ODS")}`]);
    expect(f1(mrun())).toContain("name must be one of consumerlab, nih-ods, brad-video");
  });
  it("rejects a multi-line sources value", () => {
    master([`reviewed: "2026-10-20"`, "sources:", `  - name: x`]);
    expect(f1(mrun())).toContain("sources");
  });

  describe("posts", () => {
    const post = (extra: string[]) => `---\ntitle: "O"\n${extra.join("\n")}${extra.length ? "\n" : ""}---\n\nBody.\n`;
    const only = (extra: string[]) => {
      // "other" is a video post in the index (no type): commit it, then change its frontmatter.
      put("docs/blog/other.md", post([]));
      sh(["add", "-A"]); sh(["commit", "-q", "--allow-empty", "-m", "post"]);
      put("docs/blog/other.md", post(extra));
      const { results } = runBatch({ root, batch: "t", handles: ["other"], reportsDir: reports, exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports], masters: true });
      return Object.fromEntries(results.map((x) => [x.id, x])) as Record<string, Result>;
    };
    it("allows added topics and router: hidden", () => {
      expect(f1(only(['topics: ["alpha","beta"]', "router: hidden"]))).toBe("");
    });
    it("rejects topics that are not a JSON string array, and any router value but hidden", () => {
      expect(f1(only(["topics: [1,2]"]))).toContain("topics");
      expect(f1(only(["topics: alpha"]))).toContain("topics");
      expect(f1(only(["router: shown"]))).toContain("router");
    });
    it("rejects reviewed or sources on a post, and a changed title", () => {
      expect(f1(only([`reviewed: "2026-10-20"`]))).toContain("frontmatter");
      expect(f1(only(['title: "O2"']))).toContain("frontmatter");
    });
  });

  describe("master body", () => {
    it("fails a reviewed master with neither a Current view nor an evidence-position section", () => {
      master(GOOD, "\n## Brad's videos on this topic\n\nNone.\n");
      expect(fails(mrun().MASTER).join()).toContain("Current view");
    });
    it("fails a master with both sections", () => {
      master(GOOD, sections() + "\n## Current evidence position\n\nText.\n");
      expect(fails(mrun().MASTER).join()).toContain("exactly one");
    });
    const EVIDENCE = "## Current evidence position\n\nBrad has not made a video on this topic; this is a summary of the evidence, not his view. Evidence summary.\n";
    const NONE_YET = "## Brad's videos on this topic\n\nNone yet.\n";
    it("passes the evidence-position form with a videos list of None yet.", () => {
      master(GOOD, sections(EVIDENCE, NONE_YET));
      expect(fails(mrun().MASTER)).toEqual([]);
    });
    it("fails an evidence position that does not open with the contract sentence, or that lists videos", () => {
      master(GOOD, sections("## Current evidence position\n\nEvidence summary.\n", NONE_YET));
      expect(fails(mrun().MASTER).join()).toContain("must open with");
      master(GOOD, sections(EVIDENCE));
      expect(fails(mrun().MASTER).join()).toContain("lists some");
    });
    it("fails a Current evidence position that cites a Brad post or his current guidance", () => {
      master(GOOD, sections(EVIDENCE.replace("Evidence summary.", `See ([Brad, 1 Mar 2026](${OTHER})).`), NONE_YET));
      expect(fails(mrun().MASTER).join()).toContain("a Current evidence position cites Brad");
      master(GOOD, sections(EVIDENCE.replace("Evidence summary.", "A view (Brad's current guidance, 9 Oct 2026)."), NONE_YET));
      expect(fails(mrun().MASTER).join()).toContain("a Current evidence position cites Brad");
    });
    it("rejects plain None.: only None yet. is accepted", () => {
      master(GOOD, sections(EVIDENCE, "## Brad's videos on this topic\n\nNone.\n"));
      expect(fails(mrun().MASTER).join()).toContain('says None (write "None yet."');
    });
    it("fails a Current view master whose videos section is missing, or says None yet. while the view cites a post", () => {
      master(GOOD, sections(undefined, ""));
      expect(fails(mrun().MASTER).join()).toContain("Brad's videos");
      master(GOOD, sections(undefined, NONE_YET));
      expect(fails(mrun().MASTER).join()).toContain("says None yet");
      master(GOOD, sections(undefined, "## Brad's videos on this topic\n\nNone.\n"));
      expect(fails(mrun().MASTER).join()).toContain("says None");
    });
    describe("US-50 AC1: a position-sourced sentence is cited unlinked as (Brad's current guidance, D Mon YYYY)", () => {
      const PROD = "Products. Lithium is not an established nutrient and has no recommended intake.\n";
      const Q = "Lithium is not an established nutrient and has no recommended intake";
      const SENT = "Lithium is not an established nutrient (Brad's current guidance, 9 Oct 2026).";
      const pos = (sentence = SENT) => {
        put("docs/products.md", PROD); sh(["add", "docs/products.md"]); sh(["commit", "-q", "-m", "p", "--", "docs/products.md"]);
        reps.alpha.extra_raw = [{ path: "/elsewhere/docs/products.md", sha256: sha256(PROD) }];
        master(GOOD, sections(`## Current view (reviewed 20 October 2026)\n\n${sentence}\n`, NONE_YET));
      };
      const basis = (quote: string, sentence = SENT) => { reps.alpha.current_view_basis = [{ sentence, source: "docs/products.md", quote }]; };
      it("passes with a POSITION: quote in current_view_basis (Current view from positions alone, None yet.)", () => {
        pos(); basis(`POSITION:docs/products.md: ${Q}`);
        expect(fails(mrun().MASTER)).toEqual([]);
      });
      it("fails with only a changed_tokens quote: the current_view_basis entry is required", () => {
        pos(); reps.alpha.current_view_basis = [];
        reps.alpha.changed_tokens.push({ body_line: SENT, raw_quote: `POSITION:docs/products.md: ${Q}` });
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
      });
      const masterFails = () => fails(mrun().MASTER).join();
      it("rejects a one-letter basis sentence with a one-word quote (round-2 probe 1)", () => {
        pos("Lithium cures depression and everyone should take it (Brad's current guidance, 9 Oct 2026).");
        basis("POSITION:docs/products.md: no", "e");
        expect(masterFails()).toContain("no current_view_basis entry");
      });
      it("rejects the exact sentence with a one-word quote, and an empty quote after the prefix (probes 2, 3)", () => {
        const S = "Lithium cures depression (Brad's current guidance, 9 Oct 2026).";
        pos(S); basis("POSITION:docs/products.md: Products", S);
        expect(masterFails()).toContain("no current_view_basis entry");
        basis("POSITION:docs/products.md: ", S);
        expect(masterFails()).toContain("no current_view_basis entry");
      });
      it("rejects a guidance citation whose date is not a real month (probe 4)", () => {
        const S = "Lithium is not an established nutrient (Brad's current guidance, 31 Foo 1901).";
        pos(S); basis(`POSITION:docs/products.md: ${Q}`, S);
        expect(masterFails()).toContain("no current_view_basis entry");
      });
      it("rejects one basis entry covering several sentences by substring (probe 5)", () => {
        pos("Lithium is not an established nutrient (Brad's current guidance, 9 Oct 2026). Lithium cures gout (Brad's current guidance, 9 Oct 2026).");
        basis(`POSITION:docs/products.md: ${Q}`, "Lithium");
        expect(fails(mrun().MASTER).filter((f) => f.includes("no current_view_basis entry"))).toHaveLength(2);
      });
      it("rejects a basis entry whose sentence only contains the body sentence", () => {
        pos(); basis(`POSITION:docs/products.md: ${Q}`, `${SENT} And more.`);
        expect(masterFails()).toContain("no current_view_basis entry");
      });
      it("whole batch: a laundered sentence fails (probe 7)", () => {
        pos("Brad takes lithium every day for mood (Brad's current guidance, 9 Oct 2026).");
        basis("POSITION:docs/products.md: no", "e");
        expect(fails(mrun().MASTER).length).toBeGreaterThan(0);
      });
      it("dates do not hide doses (probe 6)", () => {
        expect([...tokenise("- 15 Oct 2026, [T](https://drstanfield.com/blogs/articles/x): take 15 mg.")]).toContain("15 mg");
        expect([...tokenise("Take 15 mg ([Brad, 15 Oct 2026](https://drstanfield.com/blogs/articles/x)).")]).toContain("15 mg");
        expect([...tokenise("Take 15 mg (Brad's current guidance, 15 Oct 2026).")]).toContain("15 mg");
        expect([...tokenise("Current view (reviewed 15 Oct 2026) take 15 mg")].length).toBeGreaterThan(0);
      });
      it("fails with no POSITION: quote, an unprefixed one, one not verbatim, or one for another sentence", () => {
        pos();
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
        basis(Q);
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
        basis("POSITION:docs/products.md: Lithium is an established nutrient with a recommended intake");
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
        basis(`POSITION:docs/products.md: ${Q}`, "Some other sentence (Brad's current guidance, 9 Oct 2026).");
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
      });
      it("fails when the path is not an extra_raw at base", () => {
        pos(); basis(`POSITION:docs/products.md: ${Q}`); reps.alpha.extra_raw = [];
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
      });
      it("rejects a repo-path link in the body", () => {
        pos("A position ([Brad, 9 Oct 2026](docs/products.md)) (Brad's current guidance, 9 Oct 2026).");
        basis(`POSITION:docs/products.md: ${Q}`, "A position ([Brad, 9 Oct 2026](docs/products.md)) (Brad's current guidance, 9 Oct 2026).");
        expect(fails(mrun().MASTER).join()).toContain("links a repo file (docs/products.md)");
      });
      it("the date in the guidance citation carries no AC2 number", () => {
        expect([...tokenise("Not a nutrient (Brad's current guidance, 9 Oct 2026).")]).toEqual([]);
        expect([...tokenise("Not a nutrient (Brad’s current guidance, 19 October 2026).")]).toEqual([]);
      });
    });

    describe("US-50 AC1: every Current view sentence cites a post or position in extra_raw", () => {
      const view = (t: string) => sections(`## Current view (reviewed 20 October 2026)\n\n${t}\n`);
      it("fails a sentence with no link, while its neighbour passes", () => {
        basisFor(`One cited ([Brad, 1 Mar 2026](${OTHER})).`, "Two uncited.");
        master(GOOD, view(`One cited ([Brad, 1 Mar 2026](${OTHER})). Two uncited.`));
        const f = fails(mrun().MASTER);
        expect(f).toHaveLength(1);
        expect(f[0]).toContain("no current_view_basis entry for this exact sentence with a verbatim POST:<the linked post>: or POSITION:<path>: quote (6 words or 30 characters): Two uncited.");
      });
      it("fails a link to a video post that is not an extra_raw, a reference page, or another site", () => {
        reps.alpha.extra_raw = [];
        master(GOOD, view(`Cited ([Brad, 1 Mar 2026](${OTHER})).`));
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
        reps.alpha.extra_raw = [{ path: "/elsewhere/docs/blog/other.md", sha256: sha256(OTHER_TEXT) }];
        master(GOOD, view("Cited ([Brad, 1 Mar 2026](https://drstanfield.com/blogs/articles/alpha))."));
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
        master(GOOD, view("Cited ([Brad, 1 Mar 2026](https://example.com/blogs/articles/other))."));
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
      });
      it("a post link with no verified POST quote for that sentence fails (probe 8)", () => {
        const S = `Brad takes lithium every day for mood ([Brad, 1 Mar 2026](${OTHER})).`;
        master(GOOD, view(S));
        expect(fails(mrun().MASTER).join()).toContain("no current_view_basis entry");
      });
      it("a post-linked sentence needs a POST quote for that same post, 6 words or 30 characters, verbatim at base", () => {
        const S = `Cited ([Brad, 1 Mar 2026](${OTHER})).`;
        master(GOOD, view(S));
        for (const quote of [
          "POSITION:docs/products.md: Brad explains why he changed his view on alpha supplements", // wrong kind
          "POST:post-y: Brad explains why he changed his view on alpha supplements", // another handle
          "POST:other: changed his view", // under the floor
          "POST:other: Brad explains why he never changed his view on beta supplements", // not verbatim
          "Brad explains why he changed his view on alpha supplements", // no prefix
        ]) {
          reps.alpha.current_view_basis = [{ sentence: S, source: "other", quote }];
          expect(fails(mrun().MASTER).join(), quote).toContain("no current_view_basis entry");
        }
        basisFor(S);
        expect(fails(mrun().MASTER)).toEqual([]);
      });
      it("fails an empty Current view", () => {
        master(GOOD, view(""));
        expect(fails(mrun().MASTER).join()).toContain("is empty");
      });
    });

    describe("US-50 AC1: every batch reference is a master under --masters", () => {
      it("fails a reference with a Current view but no reviewed or sources", () => {
        master([]);
        const f = fails(mrun().MASTER).join("\n");
        expect(f).toContain("a master needs reviewed");
        expect(f).toContain("a master needs sources");
      });
      it("fails a reference without the master sections, even with no reviewed key", () => {
        master([], "\n");
        expect(fails(mrun().MASTER).join()).toContain("needs exactly one");
      });
      it("fails when a base master loses reviewed and sources", () => {
        master(GOOD);
        sh(["add", "docs/blog/alpha.md"]); sh(["commit", "-q", "-m", "master", "--", "docs/blog/alpha.md"]);
        put("docs/blog/alpha.md", readFileSync(join(root, "docs/blog/alpha.md"), "utf8").replace(/^reviewed:.*\n^sources:.*\n/m, ""));
        expect(fails(mrun().MASTER).join()).toContain("a master needs reviewed");
      });
    });

    it("US-50 AC1 tokeniser: the heading date, a citation date and a video-line date carry no number; other dates still do", () => {
      expect([...tokenise("## Current view (reviewed 15 October 2026)")]).toEqual([]);
      expect([...tokenise("Current view (reviewed 15 October 2026)")]).toEqual([]); // the heading as a cleaned body line
      expect([...tokenise("He said so ([Brad, 15 Oct 2026](https://drstanfield.com/blogs/articles/x)).")]).toEqual([]);
      expect([...tokenise("- 15 Oct 2026, [Title](https://drstanfield.com/blogs/articles/x): take.")]).toEqual([]);
      expect([...tokenise("Trials ran from 15 Oct 2026.")]).toEqual(["15"]);
      expect([...tokenise("## Current view (reviewed 15 October 2026) 5 mg")].sort()).toEqual(["15", "5 mg"]); // not the bare heading
    });
    it("US-50 AC1: a master's dates (heading, citation, video line) are not numbers; the happy path passes AC2", () => {
      basisFor(`Short view ([Brad, 15 Oct 2026](${OTHER})).`);
      master(GOOD, sections(`## Current view (reviewed 20 October 2026)\n\nShort view ([Brad, 15 Oct 2026](${OTHER})).\n`,
        `## Brad's videos on this topic\n\n- 15 Oct 2026, [O](${OTHER}): take.\n- 3 Dec 2025, [O](${OTHER}): older take.\n`));
      const r = mrun();
      expect(fails(r.AC2)).toEqual([]);
      expect(r.AC2.evidence.join()).not.toContain('"15"');
      expect(fails(r.MASTER)).toEqual([]);
    });
    it("does not run in the default mode", () => {
      expect(run().MASTER).toBeUndefined();
    });
  });

  describe("--masters reads only the batch's own committed exceptions file", () => {
    const cli = (ex?: string) => {
      put("handles.txt", "alpha\n");
      vi.spyOn(process, "cwd").mockReturnValue(root);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const code = main(["--batch", "t", "--handles", join(root, "handles.txt"), "--base", "HEAD", "--reports", reports, "--no-exclusions", "--masters", ...(ex ? ["--exceptions", ex] : [])]);
      const msg = err.mock.calls.map((c) => String(c[0])).join("\n");
      vi.restoreAllMocks();
      return { code, msg };
    };
    it("refuses no --exceptions, another file, and an uncommitted batch file", () => {
      expect(cli().msg).toContain("--masters needs --exceptions docs/knowledge-refresh/exceptions-t.json");
      put("other.json", "[]");
      expect(cli(join(root, "other.json")).msg).toContain("--masters needs --exceptions");
      put("docs/knowledge-refresh/exceptions-t.json", "[]");
      const r = cli(join(root, "docs/knowledge-refresh/exceptions-t.json"));
      expect(r.code).toBe(2);
      expect(r.msg).toContain("has uncommitted changes");
    });
    it("accepts the committed batch file", () => {
      put("docs/knowledge-refresh/exceptions-t.json", "[]");
      sh(["add", "docs/knowledge-refresh/exceptions-t.json"]); sh(["commit", "-q", "-m", "x", "--", "docs/knowledge-refresh/exceptions-t.json"]);
      expect(cli(join(root, "docs/knowledge-refresh/exceptions-t.json")).code).not.toBe(2);
    });
  });
  it("the CLI accepts --masters", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--masters"])).toBe(2); // still needs --batch
    expect(String(err.mock.calls[0][0])).toContain("[--masters]");
    err.mockRestore();
  });
});

describe("US-50 AC1 masters: Brad's posts and positions as raw, drstanfield.com references, batch files", () => {
  const POST = "---\ntitle: \"O\"\n---\n\nIn my view participants took 300 mg in adults and did well.\n";
  const rawEntry = (rel: string, text = POST, at = `/elsewhere/${rel}`) => ({ path: at, sha256: sha256(text) });
  const withPost = (quote: string, rel = "docs/blog/other.md", text = POST) => {
    put(rel, text);
    sh(["add", rel]); sh(["commit", "-q", "--allow-empty", "-m", "post", "--", rel]);
    reps.alpha.extra_raw = [rawEntry(rel, text)];
    reps.alpha.changed_tokens = [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: quote }];
  };
  const q = "participants took 300 mg in adults and did well";
  const f2 = (r: Record<string, Result>) => fails(r.AC2).join("\n");

  it("accepts a POST:<handle>: quote against a docs/blog file, checked at the base revision", () => {
    withPost(`POST:other: ${q}`);
    expect(f2(run({ masters: true }))).toBe("");
  });
  it("without --masters the same report still fails", () => {
    withPost(`POST:other: ${q}`);
    expect(f2(run())).not.toBe("");
  });
  it("accepts POSITION:<path>: against a positions file", () => {
    withPost(`POSITION:docs/products.md: ${q}`, "docs/products.md");
    expect(f2(run({ masters: true }))).toBe("");
  });
  it("fails a POST quote whose handle is not an extra_raw file, or a quote not in the file", () => {
    withPost(`POST:other-post: ${q}`);
    expect(f2(run({ masters: true }))).toContain("other-post");
    withPost("POST:other: participants took 999 mg in adults and did well");
    expect(f2(run({ masters: true }))).toContain("raw_quote");
  });
  it("verifies the sha256 against the base revision, not the working tree", () => {
    withPost(`POST:other: ${q}`);
    put("docs/blog/other.md", POST.replace("300 mg", "400 mg"));
    expect(f2(run({ masters: true }))).toBe("");
    reps.alpha.extra_raw = [{ ...rawEntry("docs/blog/other.md"), sha256: sha256("other") }];
    expect(f2(run({ masters: true }))).toContain("sha256 mismatch");
  });
  it("rejects a self-quote, a reference as a post, and a post this batch changes", () => {
    withPost(`POST:alpha: ${q}`, "docs/blog/alpha.md", readFileSync(join(root, "docs/blog/alpha.md"), "utf8"));
    expect(f2(run({ masters: true }))).toContain("extra_raw docs/blog/alpha.md is not a video post outside this batch");
    // A reference outside the batch: commit an index that lists gamma as a reference.
    const idx = JSON.parse(INDEX); idx.push({ handle: "gamma", summary: "g", title: "G", type: "reference" });
    put("docs/blog/index.json", JSON.stringify(idx, null, 2)); sh(["add", "docs/blog/index.json"]); sh(["commit", "-q", "-m", "i", "--", "docs/blog/index.json"]);
    withPost(`POST:gamma: ${q}`, "docs/blog/gamma.md");
    expect(f2(run({ masters: true }))).toContain("extra_raw docs/blog/gamma.md is not a video post outside this batch");
    withPost(`POST:other: ${q}`);
    expect(f2(run({ masters: true, handles: ["alpha", "beta", "other"] }))).toContain("extra_raw docs/blog/other.md is not a video post outside this batch");
  });
  it("rejects a post quoted under POSITION:", () => {
    withPost(`POSITION:docs/blog/other.md: ${q}`);
    expect(f2(run({ masters: true }))).toContain("POSITION: names a post");
  });
  it("rejects an extra_raw path outside the repo's posts and positions files", () => {
    withPost(`POST:other: ${q}`);
    reps.alpha.extra_raw = [{ path: "/elsewhere/docs/blog/../../secret.md", sha256: sha256(POST) }];
    expect(f2(run({ masters: true }))).toContain("extra_raw");
    reps.alpha.extra_raw = [{ path: "/elsewhere/docs/other/post-x.md", sha256: sha256(POST) }];
    expect(f2(run({ masters: true }))).toContain("extra_raw");
  });

  const refAlpha = (url: string) => put("docs/blog/alpha.md", fx("alpha.new.md").replace("## References", `## References\n\n[3] Stanfield B. A video post. drstanfield.com. [${url}](${url})`));
  const f7 = (r: Record<string, Result>) => fails(r.AC7).join("\n");
  it("allows drstanfield.com article and roadmap URLs as reference hosts under --masters only", () => {
    refAlpha("https://drstanfield.com/blogs/articles/other");
    expect(f7(run({ masters: true }))).not.toContain("unknown host");
    expect(f7(run())).toContain("unknown host drstanfield.com");
    refAlpha("https://drstanfield.com/pages/roadmap");
    expect(f7(run({ masters: true }))).not.toContain("unknown host");
    refAlpha("https://drstanfield.com/cart/evil");
    expect(f7(run({ masters: true }))).toContain("unknown host drstanfield.com");
    refAlpha("https://drstanfield.com/blogs/articles/some-post"); // not in the index
    expect(f7(run({ masters: true }))).toContain("unknown host drstanfield.com");
    refAlpha("https://drstanfield.com/blogs/articles/beta"); // a pathway, not a video post
    expect(f7(run({ masters: true }))).toContain("unknown host drstanfield.com");
    refAlpha("https://drstanfield.com/blogs/articles/alpha"); // a reference, not a video post
    expect(f7(run({ masters: true }))).toContain("unknown host drstanfield.com");
  });

  it("AC6: the batch's notes and exceptions files are batch files under --masters only", () => {
    put("docs/knowledge-refresh/t-notes.md", "n");
    put("docs/knowledge-refresh/exceptions-t.json", "[]");
    sh(["add", "docs/knowledge-refresh/exceptions-t.json"]); sh(["commit", "-q", "-m", "x", "--", "docs/knowledge-refresh/exceptions-t.json"]);
    expect(fails(run({ masters: true }).AC6)).toEqual([]);
    expect(fails(run().AC6).join()).toContain("unexpected change: docs/knowledge-refresh/t-notes.md");
    put("docs/knowledge-refresh/other-notes.md", "n");
    expect(fails(run({ masters: true }).AC6).join()).toContain("other-notes.md");
  });
  it("AC6: an exceptions file written or changed after its last commit is flagged (US-42 AC11)", () => {
    put("docs/knowledge-refresh/exceptions-t.json", "[]");
    expect(fails(run({ masters: true }).AC6).join()).toContain("unexpected change: docs/knowledge-refresh/exceptions-t.json");
    sh(["add", "docs/knowledge-refresh/exceptions-t.json"]); sh(["commit", "-q", "-m", "x", "--", "docs/knowledge-refresh/exceptions-t.json"]);
    sh(["commit", "-q", "--allow-empty", "-m", "later"]);
    put("docs/knowledge-refresh/exceptions-t.json", "[ ]");
    expect(fails(run({ masters: true, base: "HEAD~2" }).AC6).join()).toContain("unexpected change: docs/knowledge-refresh/exceptions-t.json");
  });
});

describe("US-42 AC2 report addenda: reports stay append-only, corrections go in <handle>.addendum-<N>.json", () => {
  const add = (n: number | string, a: unknown, handle = "alpha") => writeFileSync(join(reports, `${handle}.addendum-${n}.json`), JSON.stringify(a));
  const wrong = () => { reps.alpha.changed_tokens = [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 999 mg in adults" }]; };
  const good = { body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg in adults" };
  const batch = (over: Partial<Parameters<typeof runBatch>[0]> = {}) => {
    writeReports();
    return runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, exclusionsPath: exclusions, base: "HEAD", rawRoots: [reports], ...over });
  };

  const fileSha = (n: string) => sha256(readFileSync(join(reports, n)));

  it("appends entries and voids a wrong one with its reason; the base report file is never written", () => {
    wrong();
    expect(fails(run().AC2).join()).toContain("300 mg");
    add(1, { append: { changed_tokens: [good] }, void: [{ section: "changed_tokens", index: 0, reason: "quoted the wrong dose" }] });
    const before = readFileSync(join(reports, "alpha.json"), "utf8");
    const { results, rows } = batch();
    const ac2 = results.find((r) => r.id === "AC2")!;
    expect(fails(ac2)).toEqual([]);
    expect(ac2.evidence.join("\n")).toContain("alpha: VOID changed_tokens 0 [addendum-1]: quoted the wrong dose");
    expect(readFileSync(join(reports, "alpha.json"), "utf8")).toBe(before);
    expect(rows.find((r) => r.handle === "alpha")!.reportFiles).toEqual([
      { name: "alpha.json", sha256: fileSha("alpha.json") }, { name: "alpha.addendum-1.json", sha256: fileSha("alpha.addendum-1.json") }]);
    expect(rows.find((r) => r.handle === "beta")!.reportFiles).toEqual([{ name: "beta.json", sha256: fileSha("beta.json") }]);
  });
  it("voiding a changed_tokens entry without a replacement leaves its token uncovered (AC2 FAIL)", () => {
    add(1, { void: [{ section: "changed_tokens", index: 0, reason: "retired" }] });
    expect(fails(run().AC2).join()).toContain('"300 mg"');
  });
  it("sets proposed_summary_correction with an INFO naming the addendum, never empty, and nothing else (R5)", () => {
    put("docs/blog/alpha.md", fx("alpha.new.md").replace(/^summary:.*$/m, 'summary: "Alpha summary, 300 mg in adults."'));
    expect(fails(run().AC1).join()).toContain("proposed_summary_correction");
    add(1, { set: { proposed_summary_correction: "Alpha summary, 300 mg in adults." } });
    const r = run();
    expect(fails(r.AC1)).toEqual([]);
    expect(r.AC2.evidence.join("\n")).toContain("alpha: proposed_summary_correction set by addendum-1");
    expect(renderReport("t", "HEAD", "abc", [r.AC2], [], false)).toContain("- alpha: proposed_summary_correction set by addendum-1"); // N3
    add(1, { set: { proposed_summary_correction: " " } });
    expect(fails(run().AC2).join()).toContain("set.proposed_summary_correction: non-empty string expected");
    add(1, { set: { notes: "x" } });
    expect(fails(run().AC2).join()).toContain("alpha.addendum-1.json: set.notes: unknown key");
  });
  it("fails an unknown key at any level", () => {
    add(1, { replace: {} });
    expect(fails(run().AC2).join()).toContain("alpha.addendum-1.json: replace: unknown key");
    add(1, { append: { headings_after: [] } });
    expect(fails(run().AC2).join()).toContain("append.headings_after: unknown key");
    add(1, { void: [{ section: "changed_tokens", index: 0, reason: "r", extra: 1 }] });
    expect(fails(run().AC2).join()).toContain("void[0].extra: unknown key");
  });
  it("fails a void without a reason, out of range, twice, or on a section that cannot be voided (R6)", () => {
    add(1, { void: [{ section: "changed_tokens", index: 0 }] });
    expect(fails(run().AC2).join()).toContain("void[0].reason: non-empty string expected");
    add(1, { void: [{ section: "changed_tokens", index: 0, reason: " " }] });
    expect(fails(run().AC2).join()).toContain("void[0].reason: non-empty string expected");
    add(1, { void: [{ section: "changed_tokens", index: 5, reason: "r" }] });
    expect(fails(run().AC2).join()).toContain("void[0].index: no changed_tokens entry 5");
    add(1, { void: [{ section: "needs_pubmed", index: 0, reason: "r" }] });
    expect(fails(run().AC2).join()).toContain("void[0].section");
    add(1, { void: [{ section: "deleted_sentences", index: 0, reason: "a" }, { section: "deleted_sentences", index: 0, reason: "b" }] });
    expect(fails(run().AC2).join()).toContain("void[1]: deleted_sentences entry 0 is voided twice");
    add(1, { void: [{ section: "deleted_sentences", index: 0, reason: "a" }] });
    add(2, { void: [{ section: "deleted_sentences", index: 0, reason: "b" }] });
    expect(fails(run().AC2).join()).toContain("alpha.addendum-2.json: void[0]: deleted_sentences entry 0 is already void");
  });
  it("validates void: true and a void_reason on every voidable section, inline or appended, and lists every void (R4)", () => {
    const r = (o: Record<string, unknown>) => validateReport({ ...exampleReport("x"), ...o }).join();
    expect(r({ ask_brad: [{ item: "a", void: true }] })).toContain("ask_brad[0].void_reason: void entry without void_reason");
    expect(r({ extra_raw: [{ path: "p", sha256: "s", void: "yes" }] })).toContain("extra_raw[0].void: boolean expected");
    expect(r({ current_view_basis: [{ sentence: "s", quote: "q", void: false }] })).toBe(""); // N1: false is absent
    expect(r({ deleted_sentences: [{ sentence: "s", justification: "j", void: true, void_reason: "" }] })).toContain("deleted_sentences[0].void_reason");
    expect(r({ needs_pubmed: [{ claim: "c", void: true }] })).toBe(""); // not a voidable section: it carries safety work items
    add(1, { append: { current_view_basis: [{ sentence: "s", quote: "q", void: true }] } });
    expect(fails(run().AC2).join()).toContain("current_view_basis[0].void_reason: void entry without void_reason");
    add(1, { append: { current_view_basis: [{ sentence: "s", quote: "q", void: true, void_reason: "drafted then dropped" }] } });
    const md = renderReport("t", "HEAD", "abc", [run().AC2], [], false);
    expect(md).toContain(`- alpha: VOID current_view_basis 0 [addendum-1] (reason sha256 ${sha256("drafted then dropped").slice(0, 12)})`);
    expect(JSON.stringify(REPORT_SCHEMA)).not.toContain("drafted");
    for (const k of ["changed_tokens", "current_view_basis", "deleted_sentences", "extra_raw", "ask_brad", "grokipedia_claims", "positions_drift"]) { // N4
      expect(JSON.stringify((REPORT_SCHEMA.properties as Record<string, unknown>)[k]), k).toContain("void_reason");
    }
    (reps.alpha as unknown as Record<string, unknown>).ask_brad = [{ item: "a", why: "b", void: true, void_reason: "settled" }];
    add(1, { void: [{ section: "deleted_sentences", index: 0, reason: "kept" }] });
    const ev = run().AC2.evidence.join("\n");
    expect(ev).toContain("alpha: VOID ask_brad 0 [base]: settled");
    expect(ev).toContain("alpha: VOID deleted_sentences 0 [addendum-1]: kept");
  });
  it("voids informational grokipedia_claims and positions_drift entries with a reason, inline or by addendum (US-42 AC2)", () => {
    const base = { grokipedia_claims: [{ claim: "c", outcome: "kept on [7]" }], positions_drift: [{ file: "f", line_text: "l", master_says: "m" }] };
    for (const k of ["grokipedia_claims", "positions_drift"]) {
      Object.assign(reps.alpha, base);
      add(1, { void: [{ section: k, index: 0 }] });
      expect(fails(run().AC2).join(), k).toContain("void[0].reason: non-empty string expected");
      add(1, { void: [{ section: k, index: 5, reason: "r" }] });
      expect(fails(run().AC2).join(), k).toContain(`void[0].index: no ${k} entry 5`);
      add(1, { void: [{ section: k, index: 0, reason: "reference [7] removed" }] });
      const ac2 = run().AC2;
      expect(fails(ac2), k).toEqual([]);
      expect(ac2.evidence.join("\n"), k).toContain(`alpha: VOID ${k} 0 [addendum-1]: reference [7] removed`);
      expect(renderReport("t", "HEAD", "abc", [ac2], [], false)).toContain(`- alpha: VOID ${k} 0 [addendum-1] (reason sha256 ${sha256("reference [7] removed").slice(0, 12)})`);
      rmSync(join(reports, "alpha.addendum-1.json"));
      Object.assign(reps.alpha, { [k]: [{ claim: "c", void: true }] });
      expect(fails(run().AC2).join(), k).toContain(`${k}[0].void_reason: void entry without void_reason`);
      Object.assign(reps.alpha, { [k]: [{ claim: "c", void: true, void_reason: "settled" }] });
      expect(fails(run().AC2), k).toEqual([]);
      expect(run().AC2.evidence.join("\n"), k).toContain(`alpha: VOID ${k} 0 [base]: settled`);
    }
  });
  it("needs_pubmed carries safety work items: an addendum cannot void one (US-42 AC2)", () => {
    Object.assign(reps.alpha, { needs_pubmed: [{ claim: "c", study_as_named: "s" }] });
    add(1, { void: [{ section: "needs_pubmed", index: 0, reason: "r" }] });
    expect(fails(run().AC2).join()).toContain("void[0].section: one of");
  });
  it("a void pairs with a corrected grokipedia_claims outcome appended by the same addendum (US-42 AC2)", () => {
    Object.assign(reps.alpha, { grokipedia_claims: [{ claim: "c", outcome: "kept on [7]" }] });
    add(1, { append: { grokipedia_claims: [{ claim: "c", outcome: "deleted with [7]" }] }, void: [{ section: "grokipedia_claims", index: 0, reason: "[7] removed" }] });
    expect(fails(run().AC2)).toEqual([]);
    const out = applyAddenda(reps.alpha as unknown as Record<string, unknown>, [{ name: "alpha.addendum-1.json", data: JSON.parse(readFileSync(join(reports, "alpha.addendum-1.json"), "utf8")) }]);
    expect(out.report.grokipedia_claims).toEqual([{ claim: "c", outcome: "kept on [7]", void: true, void_reason: "[7] removed" }, { claim: "c", outcome: "deleted with [7]" }]);
  });
  it("grokipedia_claims, needs_pubmed and positions_drift are arrays of strings or objects: a FAIL, never a throw; a string entry cannot be voided (US-42 AC2)", () => {
    for (const k of ["grokipedia_claims", "needs_pubmed", "positions_drift"]) {
      Object.assign(reps.alpha, { [k]: "oops" });
      expect(fails(run().AC2).join(), k).toContain(`${k} must be an array`);
      Object.assign(reps.alpha, { [k]: [7] });
      expect(fails(run().AC2).join(), k).toContain(`${k}[0]: string or object expected`);
      Object.assign(reps.alpha, { [k]: ["a string entry"] });
      expect(fails(run().AC2), k).toEqual([]);
      if (k !== "needs_pubmed") {
        add(1, { void: [{ section: k, index: 0, reason: "r" }] });
        expect(fails(run().AC2).join(), k).toContain(`void[0].index: no ${k} entry 0`);
        rmSync(join(reports, "alpha.addendum-1.json"));
      }
      Object.assign(reps.alpha, { [k]: [] });
    }
    expect(fails(run().AC2)).toEqual([]);
  });
  it("an addendum may give a reason to a base void that has none, which makes the report valid again (R7)", () => {
    (reps.alpha as unknown as Record<string, unknown>).ask_brad = [{ item: "a", why: "b", void: true }];
    expect(fails(run().AC2).join()).toContain("ask_brad[0].void_reason: void entry without void_reason");
    add(1, { void: [{ section: "ask_brad", index: 0, reason: "answered by Brad" }] });
    const r = run().AC2;
    expect(fails(r)).toEqual([]);
    expect(r.evidence.join("\n")).toContain("alpha: VOID ask_brad 0 [addendum-1]: answered by Brad");
  });
  it("addenda never apply to a base report with any other error: that needs a fresh report (N2)", () => {
    (reps.alpha as unknown as Record<string, unknown>).ask_brad = [{ item: "a", why: "b", void: true }];
    (reps.alpha as unknown as Record<string, unknown>).notes = 5;
    add(1, { void: [{ section: "ask_brad", index: 0, reason: "answered by Brad" }] });
    const f = fails(run().AC2).join();
    expect(f).toContain("notes: string expected");
    expect(f).toContain("ask_brad[0].void_reason: void entry without void_reason");
  });
  it("applies addenda in numeric order (2 before 10), voids indexing the array merged so far", () => {
    wrong();
    add(1, {});
    add(2, { append: { changed_tokens: [good, good] } });
    for (let n = 3; n <= 9; n++) add(n, {});
    add(10, { void: [{ section: "changed_tokens", index: 0, reason: "first draft" }, { section: "changed_tokens", index: 2, reason: "duplicate" }] });
    const { results, rows } = batch();
    const ac2 = results.find((r) => r.id === "AC2")!;
    expect(fails(ac2)).toEqual([]);
    expect(ac2.evidence.join("\n")).toContain("alpha: VOID changed_tokens 2 [addendum-10]: duplicate");
    expect(rows[0].reportFiles!.map((f) => f.name)).toEqual(["alpha.json", ...Array.from({ length: 10 }, (_, i) => `alpha.addendum-${i + 1}.json`)]);
    const md = renderReport("t", "HEAD", "abc", results, rows, false);
    expect(md).toContain(`alpha.json ${fileSha("alpha.json")} + alpha.addendum-1.json ${fileSha("alpha.addendum-1.json")} + alpha.addendum-2.json`);
    expect(md).toContain(`alpha.addendum-10.json ${fileSha("alpha.addendum-10.json")}`);
  });
  it("fails a numbering gap and WARNs on a file that looks like an addendum but does not match the pattern (R1, R8)", () => {
    add(1, {}); add(3, {});
    expect(fails(run().AC2).join()).toContain("alpha: addendum numbering gap: alpha.addendum-2.json missing");
    rmSync(join(reports, "alpha.addendum-3.json"));
    writeFileSync(join(reports, "alpha.addendum-02.json"), "{}");
    writeFileSync(join(reports, "alpha.addendum.json"), "{}");
    const r = run().AC2;
    expect(fails(r)).toEqual([]);
    const w = r.evidence.filter((e) => e.startsWith("WARN ")).join("\n");
    expect(w).toContain("alpha: alpha.addendum-02.json is not <handle>.addendum-<N>.json; ignored");
    expect(w).toContain("alpha: alpha.addendum.json is not <handle>.addendum-<N>.json; ignored");
  });
  it("applyAddenda appends notes, voids the other sections, and leaves a report without addenda unchanged", () => {
    const r = { ...exampleReport("x"), notes: "base", ask_brad: [{ item: "a", why: "b" }] } as Record<string, unknown>;
    const copy = JSON.stringify(r);
    expect(applyAddenda(r, [])).toEqual({ report: r, errors: [], infos: [], sources: {} });
    const out = applyAddenda(r, [{ name: "x.addendum-1.json", data: { append: { notes: "more", ask_brad: [{ item: "c", why: "d" }] },
      void: [{ section: "ask_brad", index: 0, reason: "answered" }, { section: "deleted_sentences", index: 0, reason: "kept" }] } }]);
    expect(out.errors).toEqual([]);
    expect(out.report.notes).toBe("base\nmore");
    expect(out.report.ask_brad).toEqual([{ item: "a", why: "b", void: true, void_reason: "answered" }, { item: "c", why: "d" }]);
    expect((out.report.deleted_sentences as { void?: boolean }[])[0].void).toBe(true);
    expect(JSON.stringify(r)).toBe(copy);
  });
  it("a voided deleted_sentences entry no longer justifies a removal", () => {
    add(1, { void: [{ section: "deleted_sentences", index: 0, reason: "wrong sentence" }] });
    expect(fails(run().AC4).join()).toContain("sentence removed and not in deleted_sentences");
  });
  it("fails an addendum that is not JSON", () => {
    writeFileSync(join(reports, "alpha.addendum-1.json"), "{");
    expect(fails(run().AC2).join()).toContain("alpha.addendum-1.json: not JSON");
  });

  describe("extra_raw: several entries for one path (US-50)", () => {
    const POST = "---\ntitle: \"O\"\n---\n\nIn my view participants took 300 mg in adults and did well.\n";
    beforeEach(() => {
      put("docs/blog/other.md", POST);
      sh(["add", "docs/blog/other.md"]); sh(["commit", "-q", "-m", "post", "--", "docs/blog/other.md"]);
      reps.alpha.changed_tokens = [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: "POST:other: participants took 300 mg in adults and did well" }];
      reps.alpha.extra_raw = [{ path: "/elsewhere/docs/blog/other.md", sha256: sha256("stale frontmatter") }];
    });
    it("a stale sha alone FAILs; an addendum with the current sha passes and the stale one is INFO", () => {
      expect(fails(run({ masters: true }).AC2).join()).toContain("sha256 mismatch");
      add(1, { append: { extra_raw: [{ path: "/elsewhere/docs/blog/other.md", sha256: sha256(POST) }] } });
      const ac2 = run({ masters: true }).AC2;
      expect(fails(ac2)).toEqual([]);
      expect(ac2.evidence.join("\n")).toContain(`alpha: extra_raw docs/blog/other.md: superseded sha ${sha256("stale frontmatter")}`);
    });
    it("works the same for a raw file outside the repo", () => {
      reps.alpha.changed_tokens = [good];
      const f = join(reports, "extra.txt");
      writeFileSync(f, "anything");
      reps.alpha.extra_raw = [{ path: f, sha256: sha256("old") }, { path: f, sha256: sha256("anything") }];
      const ac2 = run().AC2;
      expect(fails(ac2)).toEqual([]);
      expect(ac2.evidence.join("\n")).toContain(`superseded sha ${sha256("old")}`);
    });
  });

  describe("--check-ids-cap", () => {
    const many = (n: number) => put("docs/blog/alpha.md", fx("alpha.new.md").trimEnd() + "\n\n" + Array.from({ length: n }, (_, i) => `[${i + 3}] R. T. PMID: ${10000000 + i}`).join("\n\n") + "\n");
    it("defaults to 60 without --masters and to unlimited with it; the option overrides both", () => {
      many(65);
      const seen: string[] = [];
      const go = (over: Partial<Parameters<typeof runBatch>[0]>) => { seen.length = 0; return run({ checkIds: true, headStatus: (u) => { seen.push(u); return 200; }, delayMs: 0, ...over }).AC7; };
      go({});
      expect(seen.length).toBe(60);
      go({ masters: true });
      expect(seen.length).toBe(65);
      expect(go({ masters: true, idCap: 10 }).evidence.join()).toContain("55 identifiers not checked (cap 10)");
      expect(seen.length).toBe(10);
    });
    it("the CLI takes a positive integer and rejects anything else", () => {
      many(3);
      writeReports();
      writeFileSync(join(reports, "handles.txt"), "alpha\nbeta\n");
      const cwd = process.cwd();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      process.chdir(root);
      try {
        const seen: string[] = [];
        const args = ["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--no-exclusions", "--base", "HEAD", "--check-ids"];
        const ov = { rawRoots: [reports], headStatus: (u: string) => { seen.push(u); return 200; }, delayMs: 0 };
        main([...args, "--check-ids-cap", "2"], ov);
        expect(seen.length).toBe(2);
        expect(main([...args, "--check-ids-cap", "0"], ov)).toBe(2);
        expect(main([...args, "--check-ids-cap", "x"], ov)).toBe(2);
        expect(main([...args, "--check-ids-cap"], ov)).toBe(2);
      } finally { process.chdir(cwd); log.mockRestore(); err.mockRestore(); }
    });
  });
});
