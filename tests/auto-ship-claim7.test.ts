// US-46 AC5: auto-ship claim 7 (update a behind branch, re-test, merge at the
// new sha). Runs the real merge-step bash from auto-ship.yml under a fake `gh`
// that answers from a scenario file, with `sleep` stubbed out.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = join(__dirname, "..", ".github", "workflows", "auto-ship.yml");

// The step's `run: |` block is the last block in the file: dedent 10 spaces.
function stepScript(yaml: string = readFileSync(WORKFLOW, "utf8")): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "        run: |");
  expect(start).toBeGreaterThan(-1);
  return lines
    .slice(start + 1)
    .filter((l) => l.startsWith("          ") || l.trim() === "")
    .map((l) => l.slice(10))
    .join("\n");
}

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$LOG"
q() { jq -r "$1" "$SCEN"; }
case "$1" in
  issue) if [ "$2" = create ]; then while [ $# -gt 0 ]; do [ "$1" = --body ] && printf '%s' "$2" > "$LOG.body"; shift; done; echo "https://x/issues/99"; fi; exit 0;;
  pr) exit 0;;
  workflow) [ "$2" = run ] && [ "$3" = deploy.yml ] && [ "$(q .failDeploy)" = true ] && exit 1; exit 0;;
esac
shift; p=\${1#repos/o/r/}; shift; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe=$2; shift 2;; -f) shift 2;; *) shift;; esac; done
upd=0; [ -f "$LOG.updated" ] && upd=1
out() { if [ -n "$jqe" ]; then jq -r "$jqe"; else cat; fi; }
case "$p" in
  pulls/7/update-branch) touch "$LOG.updated"; echo '{}';;
  pulls/7/files) jq -c '.prFiles // []' "$SCEN" | out;;
  pulls/7) jq -c --argjson u $upd '{state:"open",title:"t",body:(.prBody // "b"),user:{login:"u"},labels:[],
    head:{ref:"claude/x",repo:{full_name:"o/r"},sha:(if $u==1 then .newSha else .head end)}}' "$SCEN" | out;;
  issues/7/comments*) jq -c '[{user:{type:"Bot",login:"github-actions[bot]"},body:("VERDICT: APPROVE "+.head)}]' "$SCEN" | out;;
  commits/main) jq -c '{sha:.main}' "$SCEN" | out;;
  commits/*/check-runs*) sha=\${p#commits/}; sha=\${sha%%/*}
    jq -c --arg s "$sha" 'if $s==.head then {check_runs:[{app:{slug:"github-actions"},conclusion:"success",check_suite:{id:1}}]}
      elif .testNew=="none" then {check_runs:[]}
      else {check_runs:[{app:{slug:"github-actions"},conclusion:.testNew,check_suite:{id:2}}]} end' "$SCEN" | out;;
  commits/*) jq -c '{parents:(.newCommit.parents|map({sha:.})),commit:{verification:{verified:.newCommit.verified}},committer:{login:.newCommit.login}}' "$SCEN" | out;;
  compare/*) left=\${p#compare/}; left=\${left%%...*}
    if [ "$left" = "$(q .main)" ]; then jq -c --argjson u $upd '{behind_by:(if $u==1 then 0 else .behind end)}' "$SCEN" | out
    else jq -c '{files:[{filename:(if .workflowTouched then ".github/workflows/ci.yml" else "a.ts" end)}]}' "$SCEN" | out; fi;;
  actions/runs*) echo '{"workflow_runs":[{"path":".github/workflows/ci.yml"}]}' | out;;
  *) echo "unexpected: $p" >&2; exit 9;;
esac
`;

const base = {
  head: "aaaa", main: "bbbb", newSha: "cccc", behind: 0, workflowTouched: false,
  testNew: "success", failDeploy: false,
  newCommit: { parents: ["aaaa", "bbbb"], verified: true, login: "web-flow" },
};

function run(over: Record<string, unknown>, script: string = stepScript()) {
  const dir = mkdtempSync(join(tmpdir(), "autoship-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const scen = join(dir, "scen.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);
  writeFileSync(log, "");
  writeFileSync(scen, JSON.stringify({ ...base, ...over }));
  writeFileSync(join(dir, "step.sh"), script);
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", PR: "7", GITHUB_REPOSITORY: "o/r",
      GITHUB_SERVER_URL: "https://x", LOG: log, SCEN: scen },
    encoding: "utf8",
  });
  const issueBody = existsSync(`${log}.body`) ? readFileSync(`${log}.body`, "utf8") : "";
  return { code: r.status, calls: readFileSync(log, "utf8"), out: r.stdout + r.stderr, issueBody };
}

const merged = (c: string) => c.split("\n").filter((l) => l.startsWith("pr merge"));
const closed = (c: string) => c.split("\n").filter((l) => l.startsWith("issue close"));

describe("auto-ship claim 7 (US-46 AC5)", { timeout: 60_000 }, () => {
  it("a: not behind merges at the original sha", () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
    expect(r.calls).not.toContain("update-branch");
  });
  it("b: behind, web-flow merge commit, test green merges at the new sha", () => {
    const r = run({ behind: 1 });
    expect(r.code).toBe(0);
    expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit cccc"]);
  });
  it("c: wrong parents skips without merging", () => {
    const r = run({ behind: 1, newCommit: { ...base.newCommit, parents: ["aaaa", "zzzz"] } });
    expect(merged(r.calls)).toEqual([]);
    expect(closed(r.calls)[0]).toContain("branch changed during update");
  });
  it("d: right parents but not verified web-flow skips", () => {
    for (const newCommit of [{ ...base.newCommit, login: "someone" }, { ...base.newCommit, verified: false }]) {
      const r = run({ behind: 1, newCommit });
      expect(merged(r.calls)).toEqual([]);
      expect(closed(r.calls)[0]).toContain("branch changed during update");
    }
  });
  it("e: main touched workflow files skips before any update call", () => {
    const r = run({ behind: 1, workflowTouched: true });
    expect(r.calls).not.toContain("update-branch");
    expect(merged(r.calls)).toEqual([]);
    expect(closed(r.calls)[0]).toContain("update needs workflow-file changes");
  });
  it("f: test failed after update exits 0 without merging", () => {
    const r = run({ behind: 1, testNew: "failure" });
    expect(r.code).toBe(0);
    expect(merged(r.calls)).toEqual([]);
  });
  it("g: test still pending after update exits 1 and closes the issue", () => {
    const r = run({ behind: 1, testNew: "none" });
    expect(r.code).toBe(1);
    expect(merged(r.calls)).toEqual([]);
    expect(closed(r.calls)).toHaveLength(1);
  });
  it("h: deploy dispatch failing after merge says Merged, not NOT merged", () => {
    const r = run({ failDeploy: true });
    expect(r.code).not.toBe(0);
    expect(merged(r.calls)).toHaveLength(1);
    const c = closed(r.calls).join("\n");
    expect(c).toContain("Merged aaaa, but dispatching deploy.yml failed");
    expect(c).not.toContain("NOT merged");
  });
  it("i: unreadable behind_by skips instead of counting as not behind", () => {
    const r = run({ behind: null });
    expect(merged(r.calls)).toEqual([]);
    expect(closed(r.calls)[0]).toContain("could not compare with main");
  });
  // US-46 AC6: the notification caps come from jq slices, not `| head`, so
  // pipefail cannot kill the step with 141 when a big body or file list fills the pipe.
  describe("notification truncation (US-46 AC6)", () => {
    const long = "x".repeat(1000);
    const scen = {
      prBody: Array.from({ length: 200 }, (_, i) => `BODYLINE${i} ${long}`).join("\n"),
      prFiles: Array.from({ length: 60 }, (_, i) => ({ filename: `FILE${i}-${long}`, additions: 1, deletions: 2 })),
    };
    const count = (text: string, tag: string) => text.split("\n").filter((l) => l.includes(tag)).length;

    it("completes and the issue body holds exactly 20 body lines and 15 file lines", () => {
      const r = run(scen);
      expect(r.code).toBe(0);
      expect(merged(r.calls)).toHaveLength(1);
      expect(count(r.issueBody, "BODYLINE")).toBe(20);
      expect(r.issueBody).toContain("BODYLINE19 ");
      expect(r.issueBody).not.toContain("BODYLINE20 ");
      expect(count(r.issueBody, "FILE")).toBe(15);
      expect(r.issueBody).toContain("## Files (60 changed)");
    });

    it("the old `| head` form dies with 141 on the same input (the test has teeth)", () => {
      const yaml = readFileSync(WORKFLOW, "utf8")
        .replace(String.raw`pr_json | jq -r '(.body // "") | split("\n")[:20] | join("\n")')`, `pr_json | jq -r '.body // ""' | head -20)`)
        .replace(String.raw`--jq '.[:15][] | "- \(.filename) (+\(.additions)/-\(.deletions))"')`, String.raw`--jq '.[] | "- \(.filename) (+\(.additions)/-\(.deletions))"' | head -15)`);
      expect(yaml).toContain("| head -20)");
      expect(yaml).toContain("| head -15)");
      expect(run(scen, stepScript(yaml)).code).toBe(141);
    });
  });
});
