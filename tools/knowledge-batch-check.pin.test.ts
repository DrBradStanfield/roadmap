import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as checker from "./knowledge-batch-check";
import { type Report, guideErrors, keySafetyErrors, main, renderReport, runBatch, sha256 } from "./knowledge-batch-check";

// Story: US-42 (knowledge refresh), US-50 AC1/AC12 (masters), US-70 AC1 (guides). Golden pins for the file-size split
// of knowledge-batch-check.ts (US-64 AC23): the module's export list and the checker's full output on fixed fixtures.
// Synthetic fixtures only (tools/fixtures/knowledge-batch/, tools/fixtures/condition-guide/). No network, no model calls.
const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(HERE, "fixtures", "knowledge-batch", n), "utf8");
const INDEX = JSON.stringify([{ handle: "alpha", summary: "Alpha summary, 200 mg in adults.", title: "Alpha", type: "reference" },
  { handle: "beta", summary: "Guideline for beta.", title: "Beta", type: "guideline" }, { handle: "other", summary: "x", title: "O" }], null, 2);

let root: string, reports: string, baseSha: string;
const sh = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
/** Temp paths, the base commit and the hashes of report files (they hold the raw path) vary per run; nothing else may. */
const norm = (s: string) => [[realpathSync(root), "<root>"], [root, "<root>"], [realpathSync(reports), "<reports>"], [reports, "<reports>"], [baseSha, "<base-sha>"], [basename(reports), "<reports-dir>"],
  ...readdirSync(reports).filter((f) => f.endsWith(".json")).map((f) => [sha256(readFileSync(join(reports, f))), `<sha256 of ${f}>`])]
  .reduce((t, [a, b]) => t.split(a).join(b), s);

function reportsFor(): { alpha: Report; beta: Report } {
  const base = { old_raw_path: null, headings_before: [], headings_after: [], proposed_summary_correction: null, notes: "" };
  return {
    alpha: { ...base, handle: "alpha", type: "reference", raw_path: join(reports, "alpha.raw.txt"), raw_sha256: sha256(fx("alpha.raw.txt")),
      changed_tokens: [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg in adults" }],
      deleted_sentences: [{ sentence: "Trials used 200 mg in adults [1].", justification: "The new raw says 300 mg." }],
      product_mentions_before: 1, product_mentions_after: 1 },
    beta: { ...base, handle: "beta", type: "guideline", raw_path: join(reports, "beta.raw.txt"), raw_sha256: sha256(fx("beta.raw.txt")),
      changed_tokens: [{ body_line: "Review again in 6 weeks.", raw_quote: "please review again in 6 weeks if symptoms persist" }],
      deleted_sentences: [{ sentence: "Source: Beta guideline", justification: "Review date added." }],
      product_mentions_before: 0, product_mentions_after: 0 },
  };
}
const write = (r: { alpha: Report; beta: Report }) => { for (const x of [r.alpha, r.beta]) writeFileSync(join(reports, `${x.handle}.json`), JSON.stringify(x)); };
const golden = (o: Partial<Parameters<typeof runBatch>[0]> = {}) => {
  const out = runBatch({ root, batch: "t", handles: ["alpha", "beta"], reportsDir: reports, base: "HEAD", rawRoots: [reports], ...o });
  return norm(`${JSON.stringify({ results: out.results, rows: out.rows }, null, 1)}\n${renderReport("t", "HEAD", out.baseSha, out.results, out.rows, !!o.checkIds)}`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-pin-repo-"));
  reports = mkdtempSync(join(tmpdir(), "kb-pin-rep-"));
  sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]);
  put("docs/blog/alpha.md", fx("alpha.base.md"));
  put("docs/guideline/beta.md", fx("beta.base.md"));
  put("docs/blog/index.json", INDEX);
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "base"]);
  baseSha = sh(["rev-parse", "HEAD"]).trim();
  put("docs/blog/alpha.md", fx("alpha.new.md"));
  put("docs/guideline/beta.md", fx("beta.new.md"));
  writeFileSync(join(reports, "alpha.raw.txt"), fx("alpha.raw.txt")); writeFileSync(join(reports, "beta.raw.txt"), fx("beta.raw.txt"));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(reports, { recursive: true, force: true }); });

describe("US-64 AC23 pins for the knowledge-batch-check split", () => {
  it("keeps every export of the module", () => {
    expect(Object.keys(checker).sort()).toMatchSnapshot();
  });

  it("clean batch: results, rows and the --out report", () => {
    write(reportsFor());
    expect(golden()).toMatchSnapshot();
  });

  it("broken batch: an addendum, a void, a lost entry, an index change, a stray file, an unused exception", () => {
    const r = reportsFor();
    r.alpha.changed_tokens = [{ body_line: "Trials used 300 mg in adults [1].", raw_quote: "participants took 300 mg in adults", void: true, void_reason: "wrong line" }];
    r.beta.deleted_sentences = [];
    write(r);
    writeFileSync(join(reports, "alpha.addendum-1.json"), JSON.stringify({ append: { notes: "n" }, set: { proposed_summary_correction: "Alpha summary, 300 mg in adults." } }));
    writeFileSync(join(reports, "alpha.addendum-x.json"), "{}");
    put("docs/blog/index.json", INDEX.replace("Guideline for beta.", "Changed."));
    put("docs/blog/other.md", "stray\n");
    const exceptions = [{ check: "AC7", handle: "alpha", match: "nothing matches this", reason: "r", by: "b", date: "2026-11-12" }];
    expect(golden({ exceptions })).toMatchSnapshot();
  });

  it("masters, key safety points and --check-ids with a fixed HEAD status", () => {
    write(reportsFor());
    put("docs/blog/alpha.md", fx("alpha.new.md").replace("[2] Jones B. Synthetic safety review. 2020.",
      "[2] Jones B. Synthetic safety review. 2020. https://doi.org/10.1000/abc PMID: 1234567 https://pubmed.ncbi.nlm.nih.gov/1234567/"));
    const headStatus = (u: string) => (u.includes("doi.org") ? 404 : 200);
    expect(golden({ masters: true, keySafetyPoints: true, checkIds: true, headStatus, delayMs: 0 })).toMatchSnapshot();
  });

  it("guides", () => {
    write(reportsFor());
    expect(golden({ guides: true })).toMatchSnapshot();
  });

  it("the CLI's printed lines, exit code and --out file", () => {
    write(reportsFor());
    writeFileSync(join(reports, "handles.txt"), "# batch\nalpha\nbeta\n");
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);
    try {
      const out = join(root, "docs", "batch-t.md");
      const code = main(["--batch", "t", "--handles", join(reports, "handles.txt"), "--reports", reports, "--out", out, "--base", "HEAD"], { rawRoots: [reports] });
      expect(norm(`exit ${code}\n${log.mock.calls.flat().join("\n")}\n${readFileSync(out, "utf8")}`)).toMatchSnapshot();
    } finally { process.chdir(cwd); log.mockRestore(); }
  });

  it("the shared text rules on fixed guide and master text", () => {
    const sound = readFileSync(join(HERE, "fixtures", "condition-guide", "sound.md"), "utf8");
    const broken = sound.replace(/\(111 in NZ[^)]*\)/, "(call 111 in NZ)").replace("## Medicines", "## Drugs");
    const master = "## Current view (reviewed 1 Nov 2026)\n\nText.\n\n## Key safety points\n\n- One [1]\n- Two [9]\n\n## References\n\n[1] A.\n";
    expect({ sound: guideErrors(sound), broken: guideErrors(broken), keyPoints: keySafetyErrors(master) }).toMatchSnapshot();
  });
});
