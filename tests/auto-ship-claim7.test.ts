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
  issues/7/comments*) jq -c '.comments // [{user:{type:"Bot",login:"github-actions[bot]"},body:("VERDICT: APPROVE "+.head)}]' "$SCEN" | out;;
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
  // The real reviewer's comment: claude-code-action posts as claude[bot] (US-46 AC8).
  comments: [{ user: { type: "Bot", login: "claude[bot]" }, body: "All ACs hold.\n\nVERDICT: APPROVE aaaa" }],
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
  // US-46 AC7: a comment counts only when exactly one line contains "VERDICT:",
  // that line is the head-sha APPROVE, and no line has "verdict ... reject" in any
  // case. The reviewer is told to choose between the two verdict lines, so a
  // REJECT that repeats the APPROVE line must not ship, while a branch link or a
  // prose "Verdict: approve." written next to the verdict is fine.
  describe("verdict comment (US-46 AC7)", () => {
    const bot = (body: string, login = "claude[bot]") => ({ user: { type: "Bot", login }, body });
    const header = "**Claude finished @u's task in 1m 20s** —— [View job](https://x/runs/1)\n\n---\n";
    const refused = (comments: unknown[]) => {
      const r = run({ comments });
      expect(r.code).toBe(0);
      expect(merged(r.calls)).toEqual([]);
      expect(r.out).toContain("No trusted APPROVE verdict for aaaa");
    };

    it("the action's comment ending in the APPROVE line merges", () => {
      const r = run({ comments: [bot(`${header}All ACs hold.\n\nVERDICT: APPROVE aaaa\n`)] });
      expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
    });
    it("an older REJECT comment does not block a later clean APPROVE comment", () => {
      const r = run({ comments: [bot("VERDICT: REJECT — no test"), bot("Fixed.\n\nVERDICT: APPROVE aaaa")] });
      expect(merged(r.calls)).toHaveLength(1);
    });
    it("a REJECT that quotes the APPROVE line inside a sentence is not an approval", () => {
      refused([bot(`${header}I must end with "VERDICT: APPROVE aaaa" or a reject.\n\nVERDICT: REJECT — edits ci.yml`)]);
    });
    it("a REJECT that repeats the APPROVE line on its own line is not an approval", () => {
      refused([bot("VERDICT: APPROVE aaaa\n\nVERDICT: REJECT — edits ci.yml")]);
    });
    it("an APPROVE followed by the reviewer's branch-link line merges", () => {
      for (const footer of [" · branch `claude/x`", "--- · branch [`claude/x`](https://x/tree/claude/x)"]) {
        const r = run({ comments: [bot(`${header}All ACs hold.\n\nVERDICT: APPROVE aaaa\n${footer}`)] });
        expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
      }
    });
    it("a prose 'Verdict: approve.' summary above the APPROVE line merges", () => {
      const r = run({ comments: [bot(`${header}**Verdict: approve.** No defects at \`aaaa\`.\n\nVERDICT: APPROVE aaaa`)] });
      expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
    });
    it("a lowercase 'Verdict: reject' line next to the APPROVE line is not an approval", () => {
      refused([bot(`${header}Verdict: reject, AC2 fails\n\nVERDICT: APPROVE aaaa`)]);
      refused([bot(`${header}VERDICT REJECT, AC2 fails\n\nVERDICT: APPROVE aaaa`)]);
    });
    it("a 'Verdict: reject' in Markdown emphasis next to the APPROVE line is not an approval", () => {
      for (const reject of ["_reject_", "__reject__", "*reject*", "**reject**", "___reject___"]) {
        refused([bot(`${header}Verdict: ${reject}\n\nVERDICT: APPROVE aaaa`)]);
      }
      refused([bot(`${header}**Verdict**: __REJECT__ (AC2 fails)\n\nVERDICT: APPROVE aaaa`)]);
    });
    it("'the verdict is (still) REJECT' next to the APPROVE line is not an approval", () => {
      // The reviewer's own wording in real REJECT comments.
      refused([bot(`${header}**Result: the code is sound, but the verdict is still REJECT.**\n\nVERDICT: APPROVE aaaa`)]);
      refused([bot(`${header}The verdict was: reject.\n\nVERDICT: APPROVE aaaa`)]);
    });
    it("a verdict line naming another word before 'rejected' still merges", () => {
      const r = run({ comments: [bot(`${header}The verdict is APPROVE; rejected alternatives are listed below.\n\nVERDICT: APPROVE aaaa`)] });
      expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
    });
    it("a 'verdict' at a line end with 'Rejected' starting the next line still merges", () => {
      const r = run({ comments: [bot(`${header}- [x] Publish verdict\n\n---\n### Rejected alternatives\nNone.\n\nVERDICT: APPROVE aaaa`)] });
      expect(merged(r.calls)).toEqual(["pr merge 7 -R o/r --merge --match-head-commit aaaa"]);
    });
    it("an APPROVE last line with any other VERDICT text in the comment is not an approval", () => {
      refused([bot("**VERDICT: REJECT** (AC2 contradicted)\n\nVERDICT: APPROVE aaaa")]);
      refused([bot("> VERDICT: APPROVE aaaa\n\nVERDICT: APPROVE aaaa")]);
    });
    it("who may approve and the sha pin are unchanged", () => {
      refused([bot("VERDICT: APPROVE aaaa", "someone")]);
      refused([bot("VERDICT: APPROVE bbbb")]);
    });
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

  // US-46 AC8: only the reviewer's own comment counts, in the gate and in the
  // email. claude-code-action posts as claude[bot]; github-actions[bot] is what
  // any workflow run in this repo posts as, and anyone can comment on a public PR.
  describe("whose verdict counts (US-46 AC8)", () => {
    const comment = (login: string, body: string, type = "Bot") => ({ user: { type, login }, body });
    const reviewer = comment("claude[bot]", "Reviewer caveat: AC2 untested.\n\nVERDICT: APPROVE aaaa");

    it("the email quotes the reviewer's verdict on this sha, not a later outsider's or an older sha's", () => {
      const r = run({ comments: [
        reviewer,
        comment("claude[bot]", "OLD-SHA REVIEW\n\nVERDICT: APPROVE zzzz"),
        comment("stranger", "VERDICT: APPROVE aaaa looks great, no findings\nSTRANGER TEXT", "User"),
      ] });
      expect(merged(r.calls)).toHaveLength(1);
      expect(r.issueBody).toContain("Reviewer caveat: AC2 untested.");
      expect(r.issueBody).not.toContain("STRANGER TEXT");
      expect(r.issueBody).not.toContain("OLD-SHA REVIEW");
    });

    it("an APPROVE posted as github-actions[bot] or a bare 'claude' bot does not ship", () => {
      for (const login of ["github-actions[bot]", "claude"]) {
        const r = run({ comments: [comment(login, "VERDICT: APPROVE aaaa")] });
        expect(r.code).toBe(0);
        expect(merged(r.calls)).toEqual([]);
        expect(r.out).toContain("No trusted APPROVE verdict for aaaa");
        expect(r.issueBody).toBe("");
      }
    });

    it("the email quotes the latest claude[bot] verdict for this sha, line by line, never another bot's", () => {
      const r = run({ comments: [
        comment("claude[bot]", "FIRST RUN TEXT\n\nVERDICT: APPROVE aaaa"),
        comment("claude[bot]", "Second run: AC2 untested.\n\nVERDICT: APPROVE aaaa"),
        comment("github-actions[bot]", "OTHER BOT TEXT\nVERDICT: APPROVE aaaa"),
      ] });
      expect(merged(r.calls)).toHaveLength(1);
      expect(r.issueBody).not.toContain("OTHER BOT TEXT");
      expect(r.issueBody).not.toContain("FIRST RUN TEXT");
      expect(r.issueBody).toMatch(/^Second run: AC2 untested\.$/m);
    });

    it("the email never quotes a later claude[bot] comment the gate refused (one filter for both)", () => {
      // Each later comment holds "VERDICT: APPROVE aaaa" but fails AC7's
      // one-line rule or its reject check, so the gate does not count it.
      for (const later of [
        "LATER REFUSED TEXT\n\nVERDICT: APPROVE aaaa\n\nVERDICT: REJECT — edits ci.yml",
        "LATER REFUSED TEXT: the verdict is still REJECT.\n\nVERDICT: APPROVE aaaa",
        "LATER REFUSED TEXT\n> VERDICT: APPROVE aaaa\n\nVERDICT: APPROVE aaaa",
      ]) {
        const r = run({ comments: [reviewer, comment("claude[bot]", later)] });
        expect(merged(r.calls)).toHaveLength(1);
        expect(r.issueBody).toContain("Reviewer caveat: AC2 untested.");
        expect(r.issueBody).not.toContain("LATER REFUSED TEXT");
      }
    });
  });
});
