// US-46 AC9: the deploy notification states the window that really exists.
// deploy.yml's 'production' environment has had no wait timer since 2026-09-02
// and the workflow has no wait step, so production changes start once the
// Pages smoke, the tests and the builds pass (6 to 10 minutes on the 14
// successful Deploy runs of 2026-10-27 to 2026-10-30). The email used to say
// "starts in ~30 min" and "Cancel the run before the timer ends". Runs the real
// notify step from deploy.yml under a fake `gh`.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WF = join(__dirname, "..", ".github", "workflows");
const deploy = readFileSync(join(WF, "deploy.yml"), "utf8");

/** The `run: |` body of the step named `name`, dedented. */
function stepScript(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  expect(at).toBeGreaterThan(-1);
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
case "$1" in
  issue) while [ $# -gt 0 ]; do [ "$1" = --body ] && printf '%s' "$2" > "$BODY"; shift; done; echo "https://x/issues/42"; exit 0;;
  api) jqe=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && jqe=$2; shift; done
    echo '{"commit":{"message":"Fix a thing\\n\\nWhy it matters."},"files":[{"filename":"a.ts","additions":1,"deletions":2}]}' | jq -r "$jqe";;
esac
`;

function notifyBody(): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-notify-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), FAKE_GH);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  writeFileSync(join(dir, "step.sh"), stepScript(deploy, "Veto-window notification"));
  const r = spawnSync("bash", [join(dir, "step.sh")], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, GITHUB_SERVER_URL: "https://x", GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "1", GITHUB_SHA: "aaaa", GITHUB_ACTOR: "u", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_OUTPUT: join(dir, "out"), BODY: join(dir, "body") },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(dir, "body"), "utf8");
}

describe("deploy notification window (US-46 AC9)", () => {
  it("the workflow still has no wait: no wait timer in the environment and no long sleep", () => {
    expect(deploy.replace(/\n\s*#\s*/g, " ")).toContain("has had no wait timer or required reviewer since 2026-09-02");
    const sleeps = [...deploy.matchAll(/\bsleep\s+(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...sleeps)).toBeLessThan(60);
  });

  it("the email says there is no wait timer and promises no 30-minute window", () => {
    const body = notifyBody();
    expect(body).toContain("**Fix a thing**");
    expect(body).toContain("no wait timer");
    expect(body).toContain("6 to 10 minutes");
    expect(body).not.toMatch(/30 min/);
    expect(body).not.toMatch(/timer ends/);
  });

  it("auto-ship's closing note does not promise deploy.yml a 30-minute window", () => {
    const autoShip = readFileSync(join(WF, "auto-ship.yml"), "utf8");
    const note = autoShip.split("\n").find((l) => l.includes("and dispatched deploy.yml"));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/30-min/);
    expect(note).toContain("no wait timer");
  });
});
