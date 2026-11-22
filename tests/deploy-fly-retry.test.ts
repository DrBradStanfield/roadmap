// US-46 AC19: a dropped connection to Fly's remote builder does not fail the Deploy. On 2026-11-22 run
// 44937567239 died one second into the build, after the Shopify extensions were published, leaving the widget
// new and the servers old. Each Fly deploy step retries once, and only on that builder-transport error. Runs
// the real steps under a fake `flyctl`.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const STEPS = {
  "fly.toml": { name: "Fly deploy — health-tool-app (commerce)", app: "health-tool-app" },
  "fly.edu.toml": { name: "Fly deploy — health-tool-edu (education)", app: "health-tool-edu" },
};

/** The step's `run: |` body, dedented, up to the next step. */
function stepScript(name: string): string {
  const lines = deploy.split("\n");
  const at = lines.findIndex((l) => l.includes(`- name: ${name}`));
  expect(at).toBeGreaterThan(-1);
  const dash = lines[at].indexOf("- name:");
  const end = lines.findIndex((l, i) => i > at && l.trim() !== "" && l.length - l.trimStart().length <= dash);
  const step = lines.slice(at, end);
  const run = step.findIndex((l) => l.trim() === "run: |");
  expect(run).toBeGreaterThan(-1);
  const indent = step[run].indexOf("run:") + 2;
  return step.slice(run + 1).map((l) => l.slice(indent)).join("\n");
}

// The 2026-11-22 output, verbatim.
const EOF_DROP = "Error: failed to fetch an image or build from source: error building: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF";
const SECRET = "test-token-good";

/** Runs a step with a fake `flyctl` whose call n prints outputs[n-1] and fails, or succeeds past the list. */
function run(config: keyof typeof STEPS, outputs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fly-retry-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "flyctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$LOG"
n=$(wc -l < "$LOG" | tr -d ' ')
out=$(sed -n "\${n}p" "$OUTS")
[ -n "$out" ] || { echo "deployed"; exit 0; }
echo "==> Building image" ; echo "$out" >&2; exit 1
`);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho abc1234\n`);
  chmodSync(join(bin, "flyctl"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(dir, "outs"), outputs.map((o) => `${o}\n`).join(""));
  writeFileSync(join(dir, "step.sh"), stepScript(STEPS[config].name));
  // GitHub runs a bare `run:` as `bash -e {0}`.
  const r = spawnSync("bash", ["-e", join(dir, "step.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, OUTS: join(dir, "outs"), SENTRY_AUTH_TOKEN: SECRET, FLY_API_TOKEN: SECRET },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

describe("US-46 AC19: Fly deploy retries once on a dropped builder connection", { timeout: 30_000 }, () => {
  for (const config of Object.keys(STEPS) as (keyof typeof STEPS)[]) {
    const argv = `deploy -c ${config} --strategy canary --build-arg SENTRY_RELEASE=${STEPS[config].app}@abc1234 --build-secret sentry_auth_token=${SECRET}`;
    describe(config, () => {
      it("works first time: one call with the same command, no warning", () => {
        const r = run(config, []);
        expect(r.code).toBe(0);
        expect(r.calls).toEqual([argv]);
        expect(r.out).not.toContain("::warning::");
      });
      it("the builder drops once (run 44937567239's error), then builds: exit 0, two identical calls, one warning", () => {
        const r = run(config, [EOF_DROP]);
        expect(r.code).toBe(0);
        expect(r.calls).toEqual([argv, argv]);
        expect(r.out.match(/::warning::/g)).toHaveLength(1);
      });
      it("the builder drops twice: the step fails after exactly two calls", () => {
        const r = run(config, [EOF_DROP, EOF_DROP]);
        expect(r.code).toBe(1);
        expect(r.calls).toHaveLength(2);
      });
      it("any other failure fails at once, with no retry", () => {
        for (const other of [
          "Error: failed to fetch an image or build from source: error building: Dockerfile parse error line 3",
          "Error: smoke checks for 1234 failed: the app appears to be crashing",
          "Error: rpc error: code = Unavailable desc = EOF",
        ]) {
          const r = run(config, [other]);
          expect(r.code, other).toBe(1);
          expect(r.calls, other).toHaveLength(1);
          expect(r.out).not.toContain("::warning::");
        }
      });
      it("never prints the secret", () => {
        expect(run(config, [EOF_DROP]).out).not.toContain(SECRET);
      });
    });
  }
});
