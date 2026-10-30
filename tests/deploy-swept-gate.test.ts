// US-46 AC10: CLAUDE.md commits other sessions' work to main as
// "Swept, unreviewed: ..." and says to gate the DEPLOY instead. deploy.yml's
// gate job refuses while a commit since the last successful Deploy run has that
// subject and no commit message in that range names it with a
// "Reviewed-sweep: <sha>" line. A refusal is filed as an issue for Brad.
// Runs the real gate step from deploy.yml under a fake `gh` that answers from a
// scenario file.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const STEP = "Refuse unreviewed sweeps since the last deploy";
const TITLE = "Deploy refused: unreviewed sweeps on main";

/** The `run: |` body of the step named `name`, dedented. */
function stepScript(name: string): string {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  expect(at, `deploy.yml has no step "${name}"`).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const indent = lines[run].indexOf("run:") + 2;
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== "" && !l.startsWith(" ".repeat(indent))) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

// Like the real API, compare lists at most 250 commits unpaged; with
// `--paginate` and per_page=100 it prints one object per page. `fail` makes
// every API call whose path starts with it print an error body and exit 1, as
// gh does.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s' "$*" | tr '\\n' ' ' >> "$LOG"; echo >> "$LOG"
sub=$1; shift
jqe=""; p=""; pag=0
if [ "$sub" = issue ]; then
  act=$1; shift
  while [ $# -gt 0 ]; do case "$1" in --jq) jqe=$2; shift 2;; *) shift;; esac; done
  case "$act" in
    list) jq -c '.issues // []' "$SCEN" | jq -r "\${jqe:-.}";;
    create) echo "https://github.com/o/r/issues/77";;
    comment) echo "https://github.com/o/r/issues/5#issuecomment-1";;
    *) exit 9;;
  esac
  exit 0
fi
[ "$sub" = api ] || exit 9
while [ $# -gt 0 ]; do case "$1" in --jq) jqe=$2; shift 2;; --paginate) pag=1; shift;; -*) shift;; *) p=\${1#repos/o/r/}; shift;; esac; done
out() { if [ -n "$jqe" ]; then jq -r "$jqe"; else cat; fi; }
fail=$(jq -r '.fail // empty' "$SCEN")
if [ -n "$fail" ] && [ "\${p#"$fail"}" != "$p" ]; then echo '{"message":"Server Error"}'; exit 1; fi
case "$p" in
  actions/workflows/deploy.yml/runs*) jq -c '{workflow_runs: (if .last then [{head_sha: .last}] else [] end)}' "$SCEN" | out;;
  commits/main) jq -c '{sha: .main}' "$SCEN" | out;;
  compare/*)
    n=$(jq '.commits | length' "$SCEN")
    if [ "$pag" = 1 ]; then pages=$(( (n + 99) / 100 )); [ "$pages" -gt 0 ] || pages=1; size=100; else pages=1; size=250; fi
    for i in $(seq 0 $((pages - 1))); do
      jq -c --argjson i "$i" --argjson z "$size" '{total_commits: (.total // (.commits | length)),
        commits: [.commits[($i * $z):(($i + 1) * $z)][] | {sha, commit: {message}}]}' "$SCEN"
    done | out;;
  *) echo "unexpected: $p" >&2; exit 9;;
esac
`;

const sha = (c: string) => c.repeat(40);
/** A distinct 40-character sha per `i`, distinct in its first 12 characters too. */
const hex = (i: number) => (0x1000000 + i).toString(16).padEnd(40, "0");
const SWEEP = { sha: sha("a"), message: "Swept, unreviewed: another session's chart change. Not run separately." };
const PLAIN = { sha: sha("b"), message: "US-07 AC3: fix a label" };
type Commit = { sha: string; message: string };
type Scen = { last?: string | null; commits: Commit[]; total?: number; fail?: string; issues?: { number: number; title: string }[] };

function gate(scen: Scen, env: Record<string, string> = {}, script = stepScript(STEP)) {
  const dir = mkdtempSync(join(tmpdir(), "swept-gate-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), FAKE_GH);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeFileSync(join(dir, "scen.json"), JSON.stringify({ last: sha("0"), main: sha("f"), ...scen }));
  writeFileSync(join(dir, "step.sh"), script);
  writeFileSync(join(dir, "log"), "");
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r",
      GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_ACTOR: "github-actions[bot]", LOG: join(dir, "log"), SCEN: join(dir, "scen.json"), ...env },
    encoding: "utf8",
  });
  const calls = readFileSync(join(dir, "log"), "utf8");
  return { code: r.status, out: r.stdout + r.stderr, calls, issueCalls: calls.split("\n").filter((l) => /^issue (create|comment)/.test(l)) };
}

/** `n` plain commits with distinct shas. */
const plains = (n: number): Commit[] => Array.from({ length: n }, (_, i) => ({ sha: hex(i), message: `US-07 AC${i}: change ${i}` }));

describe("deploy refuses unreviewed sweeps (US-46 AC10)", () => {
  it("runs in the gate job before the veto email, with permission to read past Deploy runs and file issues", () => {
    const gateJob = yaml.slice(yaml.indexOf("\n  gate:"), yaml.indexOf("\n  pages-smoke:"));
    expect(gateJob).toContain("actions: read");
    expect(gateJob).toContain("issues: write");
    expect(gateJob.indexOf(`- name: ${STEP}`)).toBeGreaterThan(-1);
    expect(gateJob.indexOf(`- name: ${STEP}`)).toBeLessThan(gateJob.indexOf("- name: Veto-window notification"));
  });

  it("compares main with the head of the last successful Deploy run", () => {
    const r = gate({ commits: [PLAIN] });
    expect(r.code).toBe(0);
    expect(r.calls).toContain("actions/workflows/deploy.yml/runs?status=success&per_page=1");
    expect(r.calls).toContain(`compare/${sha("0")}...${sha("f")}`);
    expect(r.issueCalls).toEqual([]);
  });

  it("an unreviewed sweep since the last deploy refuses, naming it and the way to clear it", () => {
    const r = gate({ commits: [SWEEP, PLAIN] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(sha("a").slice(0, 12));
    expect(r.out).toContain("Reviewed-sweep: <sha>");
  });

  it("a Reviewed-sweep line naming it (full sha or 7+ characters) in any commit of the range clears it", () => {
    for (const ref of [sha("a"), sha("a").slice(0, 7)]) {
      const r = gate({ commits: [SWEEP, { sha: sha("c"), message: `Review the chart sweep\n\nChecked by hand.\n\nReviewed-sweep: ${ref}` }] });
      expect(r.code, r.out).toBe(0);
    }
  });

  it("a marker for another sha, a 6-character prefix or one not at a line start does not clear it", () => {
    for (const message of [`x\n\nReviewed-sweep: ${sha("d")}`, "x\n\nReviewed-sweep: aaaaaa", `x\n\nsee Reviewed-sweep: ${sha("a")}`]) {
      expect(gate({ commits: [SWEEP, { sha: sha("c"), message }] }).code).toBe(1);
    }
  });

  it("a revert of the sweep does not clear it; only a Reviewed-sweep line does", () => {
    const revert = { sha: sha("c"), message: `Revert "Swept, unreviewed: another session's chart change."\n\nThis reverts commit ${sha("a")}.` };
    expect(gate({ commits: [SWEEP, revert] }).code).toBe(1);
  });

  it("with two sweeps and one cleared, the other still refuses", () => {
    const second = { sha: sha("e"), message: "Swept, unreviewed: docs drafts" };
    const r = gate({ commits: [SWEEP, second, { sha: sha("c"), message: `ok\n\nReviewed-sweep: ${sha("a")}` }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(sha("e").slice(0, 12));
    expect(r.out).not.toContain(`${sha("a").slice(0, 12)} Swept`);
  });

  it("only a subject starting 'Swept, unreviewed' counts; the word in a body does not", () => {
    expect(gate({ commits: [{ sha: sha("b"), message: "Fix a label\n\nSwept, unreviewed: none" }] }).code).toBe(0);
  });

  // The compare API lists 250 commits at most unless paged; the range from the
  // 2026-09-18 deploy to the 2026-10-07 deploy held 281.
  it("a range of more than 250 commits is read in full, page by page", () => {
    const many = plains(300);
    const all = gate({ commits: many });
    expect(all.code, all.out).toBe(0);
    expect(all.calls).toMatch(/--paginate/);
    const late = { sha: hex(280), message: "Swept, unreviewed: a late sweep" };
    const withSweep = [...many.slice(0, 280), late, ...many.slice(281)];
    const refused = gate({ commits: withSweep });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(hex(280).slice(0, 12));
    const cleared = [...withSweep.slice(0, 290), { sha: hex(290), message: `ok\n\nReviewed-sweep: ${hex(280)}` }, ...withSweep.slice(291)];
    expect(gate({ commits: cleared }).code).toBe(0);
  });

  it("fails closed when the pages list fewer commits than the compare counts", () => {
    expect(gate({ commits: [PLAIN], total: 300 }).code).not.toBe(0);
  });

  it("fails closed, and files the refusal, when a gh call fails (set -euo pipefail)", () => {
    expect(stepScript(STEP).split("\n")[0]).toBe("set -euo pipefail");
    for (const fail of ["compare/", "commits/main", "actions/"]) {
      const r = gate({ commits: [PLAIN], fail });
      expect(r.code, fail).not.toBe(0);
      expect(r.issueCalls.length, fail).toBe(1);
    }
  });

  it("with no earlier successful deploy it refuses unless a dispatch names the sha last deployed", () => {
    const r = gate({ last: null, commits: [PLAIN] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("sweeps_since");
    const since = gate({ last: null, commits: [PLAIN] }, { SINCE_INPUT: sha("9") });
    expect(since.code, since.out).toBe(0);
    expect(since.calls).toContain(`compare/${sha("9")}...${sha("f")}`);
    // With a successful run on record the input is ignored, so it is no bypass.
    const ignored = gate({ commits: [PLAIN] }, { SINCE_INPUT: sha("f") });
    expect(ignored.calls).toContain(`compare/${sha("0")}...${sha("f")}`);
    expect(yaml).toMatch(/workflow_dispatch:\n {4}inputs:[\s\S]*?\n {6}sweeps_since:/);
    expect(yaml).toContain("SINCE_INPUT: ${{ inputs.sweeps_since }}");
  });

  // On the auto-ship path the run's actor is github-actions[bot] and auto-ship
  // has already closed its own issue, so a failed run alone reaches no one.
  it("a refusal opens an issue assigned to Brad that names the sweeps, the run and the recovery", () => {
    const r = gate({ commits: [SWEEP, PLAIN] });
    expect(r.issueCalls.length).toBe(1);
    const call = r.issueCalls[0];
    expect(call).toMatch(/^issue create /);
    expect(call).toContain(`--title ${TITLE}`);
    expect(call).toContain("--assignee DrBradStanfield");
    expect(call).toContain("@DrBradStanfield");
    expect(call).toContain(sha("a").slice(0, 12));
    expect(call).toContain("https://github.com/o/r/actions/runs/42");
    expect(call).toContain("dispatch Deploy");
  });

  it("a refusal comments on the open refusal issue instead of opening another", () => {
    const r = gate({ commits: [SWEEP], issues: [{ number: 3, title: "Deploying: something" }, { number: 5, title: TITLE }] });
    expect(r.code).toBe(1);
    expect(r.issueCalls.length).toBe(1);
    expect(r.issueCalls[0]).toMatch(/^issue comment 5 /);
    expect(r.issueCalls[0]).toContain(sha("a").slice(0, 12));
  });

  it("the refusal still fails the run when filing the issue fails", () => {
    const script = stepScript(STEP).replace(/^set -euo pipefail$/m, "set -euo pipefail\ngh() { if [ \"$1\" = issue ]; then return 1; fi; command gh \"$@\"; }");
    expect(gate({ commits: [SWEEP] }, {}, script).code).toBe(1);
  });
});
