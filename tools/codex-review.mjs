#!/usr/bin/env node
// Local adversarial reviewer on a different model (Codex, gpt-6-astra by
// default). Contract: docs/review-format.md. Advisory only: it never edits,
// commits, merges, or gates anything.
//
// Isolation (Codex response to docs/claude-codex.md, point 2 and 5):
//   * reviews an IMMUTABLE snapshot — `git archive <base>` + the patch applied
//     in a scratch dir, so nothing the author does mid-review moves the target;
//     .env and every other untracked/ignored file are absent by construction;
//   * `--ignore-user-config` drops ~/.codex/config.toml AND the ChatGPT
//     connector layer (`codex_apps`: GitHub merge/auto-merge/update-ref, site
//     deploys, the health connector) — verified 2026-09-19: zero MCP tools in
//     this posture; auth still loads. `--record` adds back ONE server, the
//     direct health MCP, with `enabled_tools` limited to the two reads;
//   * `--sandbox read-only`, `--ephemeral`, wall-clock timeout;
//   * output must match a JSON schema; anything else is INCOMPLETE, not a pass.
//
// Usage:
//   node tools/codex-review.mjs                 # uncommitted work vs HEAD
//   node tools/codex-review.mjs --commit <sha>  # one commit
//   node tools/codex-review.mjs --range A..B    # a range (e.g. main..HEAD)
//   options: --model <id> --timeout-min <n> --out <json> --keep --codex <bin>
//            --message "<text>"  (uncommitted: the commit message you intend)
//            --record  give the reviewer READ access (read_record, get_plan only)
//                      to the live scratch record through mcp.drstanfield.com;
//                      needs a one-time `codex mcp login health` by Brad, done
//                      as the scratch (microvitamin.com) Dropbox account
// Exit: 0 clean, 2 blocking findings, 3 incomplete review, 1 usage error.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(name);

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (a, o = {}) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20, ...o });
const CODEX =
  opt("--codex") ??
  process.env.CODEX_BIN ??
  [
    "codex",
    ...(() => {
      try {
        return execFileSync("sh", ["-c", "ls -d ~/.vscode/extensions/openai.chatgpt-*/bin/macos-*/codex 2>/dev/null | sort | tail -1"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
      } catch {
        return [];
      }
    })(),
  ].find((p) => p === "codex" ? which("codex") : existsSync(p));
function which(bin) {
  try { execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }); return true; } catch { return false; }
}
if (!CODEX) { console.error("codex binary not found: pass --codex <path> or set CODEX_BIN"); process.exit(1); }

const MODEL = opt("--model", "gpt-6-astra");
const RECORD = has("--record");
const RECORD_ARGS = RECORD
  ? ["-c", 'mcp_servers.health.url="https://mcp.drstanfield.com/mcp"', "-c", 'mcp_servers.health.enabled_tools=["read_record","get_plan"]']
  : [];
const TIMEOUT_MS = Number(opt("--timeout-min", "25")) * 60_000;

// --- 1. Resolve target: base sha + patch ---------------------------------
let base, label, patch, messages;
if (has("--commit")) {
  const sha = git(["rev-parse", opt("--commit")]).trim();
  base = git(["rev-parse", `${sha}^`]).trim();
  patch = git(["diff", "--binary", base, sha]);
  messages = git(["log", "--format=--- %H%n%B", `${base}..${sha}`]);
  label = `commit ${sha.slice(0, 12)}`;
} else if (has("--range")) {
  const [a, b] = opt("--range").split("..");
  base = git(["rev-parse", a]).trim();
  const head = git(["rev-parse", b || "HEAD"]).trim();
  patch = git(["diff", "--binary", base, head]);
  messages = git(["log", "--format=--- %H%n%B", `${base}..${head}`]);
  label = `range ${base.slice(0, 12)}..${head.slice(0, 12)}`;
} else {
  base = git(["rev-parse", "HEAD"]).trim();
  patch = uncommittedPatch();
  messages = opt("--message", "(uncommitted work: no commit message yet; the author states net production LOC and deletions in their reply, so treat check 8 as unverifiable here, not as a defect)");
  label = "uncommitted work";
}
if (!patch.trim()) { console.log(`Nothing to review (${label}).`); process.exit(0); }

// Tracked + untracked (gitignore respected), via a throwaway index so the
// real index is never touched.
function uncommittedPatch() {
  const idx = join(mkdtempSync(join(tmpdir(), "cr-idx-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  git(["read-tree", "HEAD"], { env });
  git(["add", "-A", "--", ".", ":!docs/claude-codex.md"], { env });
  return git(["diff", "--cached", "--binary", "HEAD"], { env });
}

const patchHash = createHash("sha256").update(patch).digest("hex").slice(0, 12);
const snapshotId = `${base.slice(0, 12)}+${patchHash}`;
const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

// --- 2. Immutable snapshot -------------------------------------------------
const snap = mkdtempSync(join(tmpdir(), "codex-review-"));
execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${base} | tar -x -C "${snap}"`]);
writeFileSync(join(snap, "REVIEW_PATCH.diff"), patch);
writeFileSync(join(snap, "REVIEW_COMMITS.txt"), messages);
try {
  execFileSync("git", ["apply", "--binary", "REVIEW_PATCH.diff"], { cwd: snap, stdio: "pipe" });
} catch (e) {
  console.error("patch did not apply to the snapshot:", String(e.stderr || e));
  cleanup(); process.exit(1);
}
const contractPath = join(snap, "docs", "review-format.md");
const contract = existsSync(contractPath) ? readFileSync(contractPath, "utf8") : readFileSync(join(ROOT, "docs/review-format.md"), "utf8");

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "target", "summary", "findings"],
  properties: {
    status: { type: "string", enum: ["complete", "incomplete"] },
    target: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "blocks_merge", "file", "line", "summary", "failure_scenario", "evidence", "remedy"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          blocks_merge: { type: "boolean" },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
          evidence: { type: "string" },
          remedy: { type: "string" },
        },
      },
    },
  },
};
const schemaPath = join(snap, "REVIEW_SCHEMA.json");
writeFileSync(schemaPath, JSON.stringify(schema));

const prompt = `You are an INDEPENDENT ADVERSARIAL REVIEWER for this repository. You are a
different model from the author. Your verdict is advisory; you cannot edit,
run tests, or merge. The working directory is an immutable snapshot of the
repo with the change already applied. The change itself is REVIEW_PATCH.diff
in the root (${files.length} files: ${files.slice(0, 40).join(", ")}${files.length > 40 ? ", ..." : ""}).
The author's commit message(s) are in REVIEW_COMMITS.txt (the place the
US-id, the LOC declaration, and any dependency justification live). Read
CLAUDE.md first for the repo's rules, then docs/user-stories.md for the story
the change cites.

Target under review: ${label}, snapshot id ${snapshotId}. Put exactly that
snapshot id in the "target" field.

Apply this contract in full (the "Universal checks" section; the "Tier 3
restrictions" section does NOT apply to this session-authored change):

${contract}

${RECORD ? `You also have READ access to a live test record (a scratch account, not a
real person's) through the health MCP server: read_record and get_plan only.
Use them when the change touches what an agent reads (tool descriptions,
units, plan sections, refusals) to check the live behaviour against the code
you are reviewing. A refused or failed MCP call is evidence about auth, not
about the change; say so in a low finding and carry on.

` : ""}Return ONLY the JSON object the schema asks for. Number findings R1, R2, ...
Set status to "incomplete" ONLY if you could not review the change at all
(a file you needed is unreadable, the patch is truncated). A single check you
cannot verify is a low-severity finding that says so, with status "complete".`;

// --- 3. Run Codex ----------------------------------------------------------
const outPath = join(snap, "REVIEW_OUT.json");
const codexArgs = [
  "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
  "--sandbox", "read-only", "--model", MODEL, "-c", 'model_reasoning_effort="high"', ...RECORD_ARGS,
  "-C", snap, "--output-schema", schemaPath, "-o", outPath, "--color", "never", "-",
];
console.error(`codex-review: ${label} → snapshot ${snapshotId} (${files.length} files), model ${MODEL}${RECORD ? ", live record (read-only)" : ""}, timeout ${TIMEOUT_MS / 60000} min`);
const started = Date.now();
const result = await new Promise((resolve) => {
  const child = spawn(CODEX, codexArgs, { cwd: snap, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, CI: "1" } });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, timedOut: true, stderr }); }, TIMEOUT_MS);
  child.on("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut: false, stderr }); });
  child.stdin.end(prompt);
});
const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);

// --- 4. Parse + drift check ------------------------------------------------
let review;
if (result.timedOut) review = incomplete(`timed out after ${TIMEOUT_MS / 60000} min`);
else if (!existsSync(outPath)) review = incomplete(`codex exited ${result.code} with no output; stderr tail: ${result.stderr.slice(-800)}`);
else {
  try { review = JSON.parse(readFileSync(outPath, "utf8")); } catch { review = incomplete("output was not valid JSON"); }
  if (review.target !== snapshotId) review = { ...review, status: "incomplete", summary: `target mismatch (${review.target} ≠ ${snapshotId}). ${review.summary ?? ""}` };
}
function incomplete(why) { return { status: "incomplete", target: snapshotId, summary: why, findings: [] }; }

let drift = null;
if (!has("--commit") && !has("--range")) {
  const nowHash = createHash("sha256").update(uncommittedPatch()).digest("hex").slice(0, 12);
  if (nowHash !== patchHash) drift = `working tree changed during review (${patchHash} → ${nowHash}); this verdict is for the snapshot only`;
}

const mcpAuthFailed = RECORD && /AuthRequired/.test(result.stderr);
const report = { ...review, model: MODEL, label, base, files: files.length, elapsed_min: Number(elapsedMin), drift, record: RECORD ? (mcpAuthFailed ? "auth failed (run: codex mcp login health)" : "read-only") : null };
const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify(report, null, 2));

// --- 5. Print --------------------------------------------------------------
const blocking = report.findings.filter((f) => f.blocks_merge);
console.log(`## Codex review (${MODEL}) — ${label}, snapshot ${snapshotId}, ${elapsedMin} min`);
console.log(`**Status:** ${report.status}${drift ? `  \n**Drift:** ${drift}` : ""}${report.record ? `  \n**Live record:** ${report.record}` : ""}`);
console.log(`\n${report.summary}\n`);
for (const f of report.findings) {
  console.log(`### ${f.id} · ${f.severity}${f.blocks_merge ? " · BLOCKS MERGE" : ""} · ${f.file}:${f.line}`);
  console.log(`${f.summary}\n\n- **Failure:** ${f.failure_scenario}\n- **Evidence:** ${f.evidence}\n- **Remedy:** ${f.remedy}\n`);
}
if (!report.findings.length && report.status === "complete") console.log("No findings.");
if (out) console.log(`\nJSON: ${out}`);

cleanup();
process.exit(report.status !== "complete" ? 3 : blocking.length ? 2 : 0);

function cleanup() { if (!has("--keep")) rmSync(snap, { recursive: true, force: true }); else console.error(`snapshot kept at ${snap}`); }
