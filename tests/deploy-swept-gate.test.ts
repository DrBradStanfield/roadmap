// US-46 AC10: CLAUDE.md commits other sessions' work to main as
// "Swept, unreviewed: ..." and says to gate the DEPLOY instead. deploy.yml's
// gate job refuses while a commit since the last successful Deploy run has that
// subject and no later commit message clears it with a "Reviewed-sweep: <sha>"
// line. Runs the real gate step from deploy.yml under a fake `gh` that answers
// from a scenario file.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const STEP = "Refuse unreviewed sweeps since the last deploy";

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

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$LOG"
[ "$1" = api ] || exit 9
p=\${2#repos/o/r/}; shift 2; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe=$2; shift 2;; *) shift;; esac; done
out() { if [ -n "$jqe" ]; then jq -r "$jqe"; else cat; fi; }
case "$p" in
  actions/workflows/deploy.yml/runs*) jq -c '{workflow_runs: (if .last then [{head_sha: .last}] else [] end)}' "$SCEN" | out;;
  commits/main) jq -c '{sha: .main}' "$SCEN" | out;;
  compare/*) jq -c '{total_commits: (.total // (.commits | length)), commits: [.commits[] | {sha, commit: {message}}]}' "$SCEN" | out;;
  *) echo "unexpected: $p" >&2; exit 9;;
esac
`;

const sha = (c: string) => c.repeat(40);
const SWEEP = { sha: sha("a"), message: "Swept, unreviewed: another session's chart change. Not run separately." };
const PLAIN = { sha: sha("b"), message: "US-07 AC3: fix a label" };

function gate(scen: { last?: string | null; commits: { sha: string; message: string }[]; total?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "swept-gate-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), FAKE_GH);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeFileSync(join(dir, "scen.json"), JSON.stringify({ last: sha("0"), main: sha("f"), ...scen }));
  writeFileSync(join(dir, "step.sh"), stepScript(STEP));
  writeFileSync(join(dir, "log"), "");
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r",
      LOG: join(dir, "log"), SCEN: join(dir, "scen.json") },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout + r.stderr, calls: readFileSync(join(dir, "log"), "utf8") };
}

describe("deploy refuses unreviewed sweeps (US-46 AC10)", () => {
  it("runs in the gate job before the veto email, with permission to read past Deploy runs", () => {
    const gateJob = yaml.slice(yaml.indexOf("\n  gate:"), yaml.indexOf("\n  pages-smoke:"));
    expect(gateJob).toContain("actions: read");
    expect(gateJob.indexOf(`- name: ${STEP}`)).toBeGreaterThan(-1);
    expect(gateJob.indexOf(`- name: ${STEP}`)).toBeLessThan(gateJob.indexOf("- name: Veto-window notification"));
  });

  it("compares main with the head of the last successful Deploy run", () => {
    const r = gate({ commits: [PLAIN] });
    expect(r.code).toBe(0);
    expect(r.calls).toContain("actions/workflows/deploy.yml/runs?status=success&per_page=1");
    expect(r.calls).toContain(`compare/${sha("0")}...${sha("f")}`);
  });

  it("an unreviewed sweep since the last deploy refuses, naming it and the way to clear it", () => {
    const r = gate({ commits: [SWEEP, PLAIN] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(sha("a").slice(0, 12));
    expect(r.out).toContain("Reviewed-sweep: <sha>");
  });

  it("a later commit with a Reviewed-sweep line naming it (full sha or 7+ characters) clears it", () => {
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

  it("fails closed with no earlier successful deploy or more commits than the compare lists", () => {
    expect(gate({ last: null, commits: [PLAIN] }).code).toBe(1);
    expect(gate({ commits: [PLAIN], total: 300 }).code).toBe(1);
  });
});
