// US-46 AC15: deploy.yml's pages-smoke waits for the Pages run of the commit
// auto-ship merged, not of whatever main is when the job starts, and gives a
// just-dispatched Pages run time to appear in the run list. US-46 AC16: a run
// cancelled because a newer Pages run replaced it hands over to that run, and a
// missing run is said on the deploy's notification issue. Runs the real
// "Wait for the Pages deploy" step under a fake `gh` and `git`, `sleep` stubbed.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const STEP = "Wait for the Pages deploy of this commit";

/** The lines of the step named `name`, up to the next step. */
function stepLines(yaml: string, name: string): string[] {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  expect(at).toBeGreaterThan(-1);
  const dash = lines[at].indexOf("- name:");
  const end = lines.findIndex((l, i) => i > at && l.trim() !== "" && l.length - l.trimStart().length <= dash);
  return lines.slice(at, end === -1 ? undefined : end);
}

/** The step's `run: |` body, dedented. */
function stepScript(yaml: string, name: string): string {
  const lines = stepLines(yaml, name);
  const run = lines.findIndex((l) => l.trim() === "run: |");
  const indent = lines[run].indexOf("run:") + 2;
  return lines.slice(run + 1).map((l) => l.slice(indent)).join("\n");
}

const M = "1".repeat(40); // the commit auto-ship merged
const N = "2".repeat(40); // main's tip when pages-smoke starts (a later server-only commit)

// Scenario: runs[sha] = { id, appearsOn (1-based list call for that sha it first shows on), conclusion
// ("running" = still in progress on every poll) }; main = the runs on main by id, newest first in the list
// (appearsOn counts the branch=main list calls); failComment = `gh issue comment` fails; failNewer = every
// branch=main list call fails (HTTP 502).
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$LOG"
[ "$1" = issue ] && [ "$(jq -r '.failComment' "$SCEN")" = true ] && exit 1
[ "$1" = api ] || exit 0
p=$2; jqe=""; shift 2
while [ $# -gt 0 ]; do [ "$1" = --jq ] && jqe=$2; shift; done
case "$p" in
  */actions/workflows/pages.yml/runs\\?head_sha=*) sha=\${p##*head_sha=}
    n=$(( $(cat "$LOG.lists.$sha" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$LOG.lists.$sha"
    jq -c --arg s "$sha" --argjson n "$n" \\
      '{workflow_runs: [(.runs[$s] // empty) | select(.appearsOn <= $n) | {id}]}' "$SCEN" | jq -r "$jqe";;
  *"/actions/workflows/pages.yml/runs?branch=main&per_page=1") n=$(( $(cat "$LOG.newer" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$LOG.newer"
    [ "$(jq -r '.failNewer' "$SCEN")" = true ] && { echo "HTTP 502" >&2; exit 1; }
    jq -c --argjson n "$n" '{workflow_runs: [.main | map(select(.appearsOn <= $n)) | sort_by(-.id) | .[0] // empty | {id}]}' \\
      "$SCEN" | jq -r "$jqe";;
  */actions/runs/*) id=\${p##*/}
    jq -c --argjson id "$id" '[.runs[] | select(.id == $id)][0]
      | if .conclusion == "running" then {status: "in_progress", conclusion: null} else {status: "completed", conclusion} end' \\
      "$SCEN" | jq -r "$jqe";;
  *) echo "unexpected: $p" >&2; exit 9;;
esac
`;

type Run = { id: number; appearsOn: number; conclusion: string };
function run(opts: { pagesSha?: string; runs?: Record<string, Run>; main?: { id: number; appearsOn: number }[];
  notifyIssue?: string; failComment?: boolean; failNewer?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "pages-smoke-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const scen = join(dir, "scen.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  // The job checks out main: by now its tip is N, not the merged commit.
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] && { echo ${N}; exit 0; }\nexit 9\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\necho \"$1\" >> \"$LOG.sleeps\"\n");
  for (const f of ["gh", "git", "sleep"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(log, "");
  writeFileSync(scen, JSON.stringify({ runs: opts.runs ?? {}, main: opts.main ?? [], failComment: opts.failComment ?? false,
    failNewer: opts.failNewer ?? false }));
  writeFileSync(join(dir, "step.sh"), stepScript(deploy, STEP));
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r", LOG: log, SCEN: scen,
      GITHUB_SERVER_URL: "https://x", GITHUB_RUN_ID: "77",
      ...(opts.pagesSha === undefined ? {} : { PAGES_SHA: opts.pagesSha }),
      ...(opts.notifyIssue === undefined ? {} : { NOTIFY_ISSUE: opts.notifyIssue }) },
    encoding: "utf8",
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const lists = calls.filter((c) => c.includes("/actions/workflows/pages.yml/runs?head_sha="));
  const newer = calls.filter((c) => c.includes("/actions/workflows/pages.yml/runs?branch="));
  const comments = calls.filter((c) => c.startsWith("issue "));
  const sleeps = existsSync(`${log}.sleeps`) ? readFileSync(`${log}.sleeps`, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls, lists, newer, comments, sleeps };
}

const listFor = (sha: string) => `api repos/o/r/actions/workflows/pages.yml/runs?head_sha=${sha} --jq .workflow_runs[0].id // empty`;
const newerThan = (id: number) =>
  `api repos/o/r/actions/workflows/pages.yml/runs?branch=main&per_page=1 --jq .workflow_runs[0] | select(.id > ${id}) | .id`;

describe("pages-smoke waits for the merged commit's Pages run (US-46 AC15)", { timeout: 60_000 }, () => {
  it("deploy.yml takes a pages_sha input and hands it to the wait step", () => {
    const inputs = deploy.slice(deploy.indexOf("    inputs:"), deploy.indexOf("\n# No pull_request trigger") + 1);
    expect(inputs).toMatch(/\n {6}pages_sha:\n(?: {8}.*\n)*? {8}type: string\n/);
    expect(inputs).toMatch(/\n {6}pages_sha:\n(?: {8}.*\n)*? {8}default: ""\n/);
    expect(stepLines(deploy, STEP).map((l) => l.trim())).toContain("PAGES_SHA: ${{ inputs.pages_sha }}");
  });

  it("main moved on: it waits on the merged commit's failed Pages run, not main's tip", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "failure" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Pages deploy failed (failure)");
    expect(r.lists).toEqual([listFor(M)]);
  });

  it("main moved on: the merged commit's successful Pages run lets the smoke go ahead", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" } } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Pages deploy succeeded.");
    expect(r.calls).toContain("api repos/o/r/actions/runs/5 --jq .conclusion // \"\"");
  });

  it("a just-dispatched Pages run that lists late is still waited on", () => {
    for (const appearsOn of [2, 12]) {
      const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn, conclusion: "failure" } } });
      expect(r.code).toBe(1);
      expect(r.out).toContain("Pages deploy failed (failure)");
      expect(r.lists).toEqual(Array(appearsOn).fill(listFor(M)));
      // 10 s between looks, none after the run is found (the status poll's own sleeps come after).
      expect(r.sleeps.slice(0, appearsOn - 1)).toEqual(Array(appearsOn - 1).fill("10"));
    }
  });

  it("no Pages run for the named commit after 12 lookups: it warns and smokes the existing site", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 13, conclusion: "failure" } } });
    expect(r.code).toBe(0);
    // Then one look at main's tip, which has no Pages run of its own here.
    expect(r.lists).toEqual([...Array(12).fill(listFor(M)), listFor(N)]);
    expect(r.sleeps).toEqual(Array(11).fill("10")); // no sleep after the last look
    expect(r.out).toContain(`::warning::No pages.yml run for ${M} after 12 looks (about 2 minutes)`);
    expect(r.out).toContain("smoking the existing Pages site");
  });

  // Adversary B1 (round 2): the deploy job ships main's tip, so a commit that
  // landed after the merge must not reach production without its own Pages run.
  it("main moved on to a commit whose own Pages run failed: the step fails", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" },
      [N]: { id: 6, appearsOn: 1, conclusion: "failure" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Pages deploy failed (failure)");
    expect(r.out).toContain(`main has moved on to ${N}`);
    expect(r.lists).toEqual([listFor(M), listFor(N)]);
    expect(r.calls).toContain("api repos/o/r/actions/runs/5 --jq .conclusion // \"\"");
    expect(r.calls).toContain("api repos/o/r/actions/runs/6 --jq .conclusion // \"\"");
  });

  it("main moved on: main's tip is waited on even when the merged commit's run never listed", () => {
    const r = run({ pagesSha: M, runs: { [N]: { id: 6, appearsOn: 1, conclusion: "cancelled" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::warning::No pages.yml run for ${M} after 12 looks`);
    expect(r.out).toContain("Pages deploy failed (cancelled)");
    expect(r.lists).toEqual([...Array(12).fill(listFor(M)), listFor(N)]);
  });

  it("main moved on: both Pages runs succeed, so the smoke goes ahead", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" },
      [N]: { id: 6, appearsOn: 1, conclusion: "success" } } });
    expect(r.code).toBe(0);
    expect(r.out.match(/Pages deploy succeeded\./g)).toHaveLength(2);
    expect(r.calls).toContain("api repos/o/r/actions/runs/6 --jq .status");
  });

  it("main moved on to a commit with no Pages run listed: one look at it, then the smoke goes ahead", () => {
    // N's run listing on its second look is not seen: main's tip gets one look, as the manual path does.
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" },
      [N]: { id: 6, appearsOn: 2, conclusion: "failure" } } });
    expect(r.code).toBe(0);
    expect(r.lists).toEqual([listFor(M), listFor(N)]);
    expect(r.sleeps).toEqual([]);
    expect(r.out).toContain(`main has moved on to ${N}; no pages.yml run for it (server-only change)`);
  });

  it("main has not moved on (pages_sha is main's tip): one wait, no second lookup", () => {
    const r = run({ pagesSha: N, runs: { [N]: { id: 6, appearsOn: 1, conclusion: "success" } } });
    expect(r.code).toBe(0);
    expect(r.lists).toEqual([listFor(N)]);
    expect(r.out).not.toContain("main has moved on");
  });

  it("a manual deploy (no pages_sha) still looks up main's tip once, as before", () => {
    for (const pagesSha of [undefined, ""]) {
      const none = run({ pagesSha, runs: { [N]: { id: 6, appearsOn: 2, conclusion: "failure" } } });
      expect(none.code).toBe(0);
      expect(none.lists).toEqual([listFor(N)]);
      expect(none.out).toContain(`No pages.yml run for ${N} (server-only change)`);
      expect(none.sleeps).toEqual([]);
      expect(none.out).not.toContain("main has moved on");
      const found = run({ pagesSha, runs: { [N]: { id: 6, appearsOn: 1, conclusion: "cancelled" } } });
      expect(found.code).toBe(1);
      expect(found.out).toContain("Pages deploy failed (cancelled)");
    }
  });

  it("a Pages run still running after 150 polls, 10 s apart, fails the step", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "running" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::Timed out waiting for the Pages deploy.");
    expect(r.calls.filter((c) => c === "api repos/o/r/actions/runs/5 --jq .status")).toHaveLength(150);
    expect(r.sleeps).toEqual(Array(150).fill("10"));
    expect(r.lists).toEqual([listFor(M)]);
  });

  it("refuses a pages_sha that is not a full lowercase commit sha, before any lookup", () => {
    for (const bad of ["main", M.slice(0, 39), `${M}0`, M.toUpperCase().replace(/1/g, "A"), `${M.slice(0, 39)}g`,
      `${M}\n`, `x$(false)${M.slice(0, 31)}`]) {
      const r = run({ pagesSha: bad, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" } } });
      expect(r.code, bad).toBe(1);
      expect(r.out).toContain("::error::pages_sha must be a full 40-character commit sha");
      expect(r.calls).toEqual([]);
    }
  });
});

const P = "3".repeat(40); // a commit that landed on main after M; its Pages run is the newer one
const notice = (sha: string) =>
  `issue comment 42 -R o/r --body @DrBradStanfield, the Pages smoke found no pages.yml run for \`${sha}\` after 12 looks ` +
  "(about 2 minutes), so it will smoke the existing Pages site, which may not hold this commit yet. " +
  "A missing run does not stop the deploy: it goes on unless a later step fails. Run: https://x/o/r/actions/runs/77";

describe("pages-smoke: a replaced Pages run, a missing run (US-46 AC16)", { timeout: 60_000 }, () => {
  it("the merged commit's run cancelled by a newer Pages run on main: it waits for the newer run instead", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" },
      [P]: { id: 7, appearsOn: 1, conclusion: "success" } }, main: [{ id: 7, appearsOn: 1 }, { id: 5, appearsOn: 1 }] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Pages run 5 was cancelled; newer Pages run 7 on main replaced it: waiting for that one.");
    expect(r.out).not.toContain("::error::");
    expect(r.out.match(/Pages deploy succeeded\./g)).toHaveLength(1); // run 7's, once: run 5 never "succeeded"
    expect(r.newer).toEqual([newerThan(5)]);
    expect(r.calls).toContain("api repos/o/r/actions/runs/7 --jq .conclusion // \"\"");
    expect(r.lists).toEqual([listFor(M), listFor(N)]); // then the tip's one look, as before
  });

  it("the newer run is held to the same rule: a failed or still-running one fails the step", () => {
    const failed = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" },
      [P]: { id: 7, appearsOn: 1, conclusion: "failure" } }, main: [{ id: 7, appearsOn: 1 }] });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("Pages deploy failed (failure)");
    const slow = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" },
      [P]: { id: 7, appearsOn: 1, conclusion: "running" } }, main: [{ id: 7, appearsOn: 1 }] });
    expect(slow.code).toBe(1);
    expect(slow.out).toContain("::error::Timed out waiting for the Pages deploy.");
    expect(slow.calls.filter((c) => c === "api repos/o/r/actions/runs/7 --jq .status")).toHaveLength(150);
  });

  it("a newer run that was itself replaced hands over again", () => {
    const Q = "4".repeat(40);
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" },
      [P]: { id: 7, appearsOn: 1, conclusion: "cancelled" }, [Q]: { id: 8, appearsOn: 1, conclusion: "success" } },
      main: [{ id: 7, appearsOn: 1 }, { id: 8, appearsOn: 2 }] }); // 8 lists only on the second look
    expect(r.code).toBe(0);
    expect(r.newer).toEqual([newerThan(5), newerThan(7)]);
    expect(r.out).toContain("newer Pages run 8 on main replaced it");
  });

  it("a newer run that lists late is still found: up to 12 looks, 10 s apart", () => {
    for (const appearsOn of [2, 12]) {
      const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" },
        [P]: { id: 7, appearsOn: 99, conclusion: "success" } }, main: [{ id: 7, appearsOn }] });
      expect(r.code).toBe(0);
      expect(r.newer).toEqual(Array(appearsOn).fill(newerThan(5)));
      expect(r.sleeps).toEqual(Array(appearsOn - 1).fill("10"));
    }
  });

  it("a cancelled run with no newer run on main still fails the step, after 12 looks", () => {
    // Nothing newer than run 5: a run cancelled by hand, or the newest main run is older (a re-run keeps its id).
    for (const main of [[], [{ id: 5, appearsOn: 1 }], [{ id: 4, appearsOn: 1 }]]) {
      const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" } }, main });
      expect(r.code).toBe(1);
      expect(r.out).toContain("Pages deploy failed (cancelled)");
      expect(r.newer).toEqual(Array(12).fill(newerThan(5)));
      expect(r.sleeps).toEqual(Array(11).fill("10"));
    }
  });

  it("only a cancelled run hands over: a failed run with a newer run on main still fails", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "failure" },
      [P]: { id: 7, appearsOn: 1, conclusion: "success" } }, main: [{ id: 7, appearsOn: 1 }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Pages deploy failed (failure)");
    expect(r.newer).toEqual([]);
  });

  it("the tip's run, and a hand deploy's, hand over the same way", () => {
    const tip = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" },
      [N]: { id: 6, appearsOn: 1, conclusion: "cancelled" }, [P]: { id: 7, appearsOn: 1, conclusion: "success" } },
      main: [{ id: 7, appearsOn: 1 }] });
    expect(tip.code).toBe(0);
    expect(tip.newer).toEqual([newerThan(6)]);
    const hand = run({ runs: { [N]: { id: 6, appearsOn: 1, conclusion: "cancelled" },
      [P]: { id: 7, appearsOn: 1, conclusion: "success" } }, main: [{ id: 7, appearsOn: 1 }] });
    expect(hand.code).toBe(0);
    expect(hand.newer).toEqual([newerThan(6)]);
  });

  it("a failed newer-run lookup ends the step at once: no retry, no further looks, no ::error:: line", () => {
    const r = run({ pagesSha: M, runs: { [M]: { id: 5, appearsOn: 1, conclusion: "cancelled" } }, failNewer: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 502");
    expect(r.out).not.toContain("::error::");
    expect(r.newer).toEqual([newerThan(5)]);
    expect(r.sleeps).toEqual([]);
  });

  it("no run for the named commit after 12 looks: it comments on the deploy's notification issue and goes on", () => {
    const r = run({ pagesSha: M, notifyIssue: "42" });
    expect(r.code).toBe(0);
    expect(r.comments).toEqual([notice(M)]);
    expect(r.calls.indexOf(notice(M))).toBeGreaterThan(r.calls.lastIndexOf(listFor(M)));
    expect(r.out).toContain(`::warning::No pages.yml run for ${M} after 12 looks`);
  });

  it("a failed comment only warns: the step still goes on", () => {
    const r = run({ pagesSha: M, notifyIssue: "42", failComment: true });
    expect(r.code).toBe(0);
    expect(r.comments).toEqual([notice(M)]);
    expect(r.out).toContain("::warning::Could not comment on the deploy notification issue #42.");
  });

  it("no notification issue: the warning only, no comment call", () => {
    for (const notifyIssue of [undefined, ""]) {
      const r = run({ pagesSha: M, notifyIssue });
      expect(r.code).toBe(0);
      expect(r.comments).toEqual([]);
      expect(r.out).toContain(`::warning::No pages.yml run for ${M} after 12 looks`);
    }
  });

  it("no comment when a run is found, on a hand deploy, or for a tip with no run", () => {
    const cases = [
      run({ pagesSha: M, notifyIssue: "42", runs: { [M]: { id: 5, appearsOn: 1, conclusion: "success" } } }),
      run({ notifyIssue: "42" }),
      run({ pagesSha: M, notifyIssue: "42", runs: { [M]: { id: 5, appearsOn: 3, conclusion: "success" } } }),
    ];
    for (const r of cases) {
      expect(r.code).toBe(0);
      expect(r.comments).toEqual([]);
    }
  });

  it("pages-smoke gets the issue number and a token scoped to what it does, kept out of git", () => {
    expect(stepLines(deploy, STEP).map((l) => l.trim())).toContain("NOTIFY_ISSUE: ${{ needs.gate.outputs.notify_issue }}");
    const job = deploy.slice(deploy.indexOf("\n  pages-smoke:\n"), deploy.indexOf("\n  deploy:\n"));
    const perms = job.match(/\n {4}permissions:\n((?: {6}.*\n)+)/);
    expect(perms?.[1].split("\n").filter(Boolean).map((l) => l.replace(/#.*/, "").trim()))
      .toEqual(["contents: read", "actions: read", "issues: write"]);
    expect(job).toMatch(/- uses: actions\/checkout@v5\n {8}with:\n {10}ref: main\n {10}persist-credentials: false(?: #.*)?\n/);
  });
});
