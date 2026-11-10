// US-46 AC17: a slow package mirror does not leave a live deploy unverified.
// verify-live's longer limit covers a crawl; the install loop covers only an
// install that fails outright. Runs the real "Install Playwright WebKit" step
// under a fake `npx`, and checks the step sets no apt config: the runner image's
// /etc/apt/apt.conf.d/zz-retries sorts last and would override it.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const STEP = "Install Playwright WebKit";

/** The text of job `job`, up to the next job. */
function jobText(yaml: string, job: string): string {
  const start = yaml.indexOf(`\n  ${job}:\n`);
  expect(start).toBeGreaterThan(-1);
  const next = yaml.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next + 1);
}

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
  expect(run).toBeGreaterThan(-1);
  const indent = lines[run].indexOf("run:") + 2;
  return lines.slice(run + 1).map((l) => l.slice(indent)).join("\n");
}

const smokeScript = stepScript(jobText(deploy, "pages-smoke"), STEP);
const verifyScript = stepScript(jobText(deploy, "verify-live"), STEP);

/** Runs the step with a fake `npx` that fails its first `failures` calls. */
function run(failures: number) {
  const dir = mkdtempSync(join(tmpdir(), "install-retry-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), `#!/bin/sh
echo "$*" >> "$LOG"
n=$(wc -l < "$LOG")
[ "$n" -le ${failures} ] && exit 1
exit 0
`);
  chmodSync(join(bin, "npx"), 0o755);
  writeFileSync(join(dir, "step.sh"), verifyScript);
  const r = spawnSync("bash", ["-e", join(dir, "step.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, LOG: log },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

describe("the Playwright install survives a hard failure (US-46 AC17)", { timeout: 30_000 }, () => {
  it("pages-smoke and verify-live run the same install script", () => {
    expect(verifyScript).toContain("npx playwright install --with-deps webkit");
    expect(smokeScript).toBe(verifyScript);
  });

  it("an install that works the first time: exit 0, one call, no warning", () => {
    const r = run(0);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["playwright install --with-deps webkit"]);
    expect(r.out).not.toContain("::warning::");
  });

  it("one failed install, then success: exit 0, two calls, one warning", () => {
    const r = run(1);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.out.match(/::warning::Playwright install try 1 failed/g)).toHaveLength(1);
  });

  it("three failed installs: the step fails after exactly three tries", () => {
    const r = run(3);
    expect(r.code).not.toBe(0);
    expect(r.calls).toHaveLength(3);
  });

  it("sets no apt config: the runner image's zz-retries would override it", () => {
    expect(verifyScript).not.toMatch(/\bsudo\b/);
    expect(verifyScript).not.toMatch(/apt\.conf|Acquire::/);
  });

  it("verify-live's limit covers a crawl and stays finite: 30 to 45 minutes", () => {
    const m = jobText(deploy, "verify-live").match(/\n {4}timeout-minutes: (\d+)\b/);
    expect(m).not.toBeNull();
    const limit = Number(m![1]);
    expect(limit).toBeGreaterThanOrEqual(30);
    expect(limit).toBeLessThanOrEqual(45);
  });
});
