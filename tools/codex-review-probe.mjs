#!/usr/bin/env node
// Live probe of the codex CLI that tools/codex-review.mjs launches (US-40 AC19, Codex R9 on PR 2222). It MAKES MODEL
// CALLS on the ChatGPT subscription: run it only by hand, when Brad asks. Never in tests, CI, loops or cloud sessions.
//
// It launches `codex exec` with the wrapper's own argument list (launchArgs, configArgs, the probed --disable list, the
// minimal env), in an empty temp folder holding one synthetic file, and checks three things AC14 and AC19 claim:
//   a  the sandboxed shell has no network: a `curl` to https://example.com/ fails (AC14's 2026-10-03 method: doi.org, exit 6);
//   b  web search stays cached-only: opening a never-seen URL (example.com with a random nonce query) reports a cache
//      miss rather than the page (AC14's 2026-10-03 nonce method);
//   c  the forced ChatGPT login: with an ISOLATED empty CODEX_HOME holding only a fake API key ("test-key-not-real"),
//      exec refuses to run instead of trying API-key auth. Brad's real CODEX_HOME is never read or written by check c.
// Inputs are public and synthetic only. Output is PASS / FAIL / INCONCLUSIVE per check with the evidence KIND (an exit
// code, a matched keyword), never the model's or the CLI's text. Exit 0 only when every check run passes.
//
// Usage: node tools/codex-review-probe.mjs [--codex <bin>] [--model <id>] [--only a,b,c] [--control] [--dry-run]
//   --control  also runs check b with web_search="live", which should OPEN the page (shows check b can tell the two apart)
//   --dry-run  prints each check's argument list after the no-model pre-flight probe; makes no model call
// Cost: one short model turn per check (two for b with --control), on the default model unless --model says otherwise.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, readers } from "./codex-review-args.mjs";
import { chooseCodex, configArgs, launchArgs, launchEnv, probeCodex } from "./codex-review-bin.mjs";

const { has, opt } = readers(parseArgv(process.argv.slice(2), ["--codex", "--model", "--only"]));
const { bin, error } = chooseCodex(has("--codex") ? opt("--codex") ?? "" : process.env.CODEX_BIN); // the wrapper's own rule
if (error) { console.error(`probe: ${error}`); process.exit(1); }
const model = opt("--model", "gpt-6.2-sol");
const only = (opt("--only", "a,b,c") ?? "").split(",");
const DRY = has("--dry-run");

const env = launchEnv(process.env);
const pre = probeCodex(bin, env, configArgs("cached"));
console.log(`probe: codex ${JSON.stringify(bin)} (${pre.version}), model ${model}`);
if (pre.stop) { console.log(`probe: pre-flight stopped: ${pre.stop.split(":")[0]}; fix that first`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "cr-probe-"));
const results = [];
try {
  const run = (name, prompt, { web = "cached", extraConfig = [], envOver = {} } = {}) => {
    const src = join(work, `${name}-src`), schemaPath = join(work, `${name}-schema.json`), outPath = join(work, `${name}-out.json`);
    mkdirSync(src);
    writeFileSync(join(src, "README.md"), "Synthetic probe folder for tools/codex-review-probe.mjs. Nothing private here.\n");
    writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }));
    const args = launchArgs({ disable: pre.disable, configArgs: [...configArgs(web), ...extraConfig], model, src, schemaPath, outPath });
    if (DRY) { console.log(`probe ${name}: ${JSON.stringify([bin, ...args])}`); return null; }
    const r = spawnSync(bin, args, { cwd: src, input: prompt, env: { ...env, ...envOver }, encoding: "utf8", timeout: 600_000, maxBuffer: 64 << 20 });
    const events = (r.stdout ?? "").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    let answer = ""; try { answer = JSON.parse(readFileSync(outPath, "utf8")).answer ?? ""; } catch { /* no answer */ }
    return { status: r.status, signal: r.signal, events, answer, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  };
  const items = (r, type) => r.events.filter((e) => e.type === "item.completed" && e.item?.type === type).map((e) => e.item);
  const say = (check, verdict, evidence) => { results.push(verdict); console.log(`${verdict.padEnd(12)} ${check}: ${evidence}`); };

  if (only.includes("a")) {
    const r = run("a", "Run exactly this one shell command and nothing else: curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com/\nThen set answer to its exit code.");
    if (r) {
      const curls = items(r, "command_execution").filter((c) => /curl/.test(c.command ?? ""));
      if (!curls.length) say("a shell network", "INCONCLUSIVE", `no curl command ran (exec exit ${r.status})`);
      else if (curls.some((c) => c.exit_code === 0)) say("a shell network", "FAIL", "a curl to example.com exited 0: the shell reached the network");
      else say("a shell network", "PASS", `curl exit code(s) ${curls.map((c) => c.exit_code).join(", ")}, none 0`);
    }
  }
  if (only.includes("b")) {
    for (const web of has("--control") ? ["cached", "live"] : ["cached"]) {
      const url = `https://example.com/?codex-review-probe=${randomBytes(8).toString("hex")}`;
      const r = run(`b-${web}`, `Use your web search tool to open exactly this URL and nothing else: ${url}\nDo not run shell commands. Set answer to what the tool returned, quoting any error text exactly.`, { web });
      if (!r) continue;
      const opened = /Example Domain/i.test(r.answer), miss = /cache miss/i.test(`${r.answer}\n${JSON.stringify(items(r, "web_search"))}`);
      const check = `b web search (${web})`;
      if (web === "cached") say(check, opened ? "FAIL" : miss ? "PASS" : "INCONCLUSIVE", opened ? "the page's own title came back: it was fetched live" : miss ? "a cache miss was reported" : "neither a cache miss nor the page");
      else say(check, opened ? "PASS" : "INCONCLUSIVE", opened ? "control: live mode opened the page" : "control: live mode did not open the page");
    }
  }
  if (only.includes("c")) {
    const home = mkdtempSync(join(tmpdir(), "cr-probe-home-")); // isolated: only a fake key, never Brad's CODEX_HOME
    try {
      writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key-not-real" }));
      const envOver = { CODEX_HOME: home };
      const status = DRY ? null : spawnSync(bin, ["login", "status"], { env: { ...env, ...envOver }, encoding: "utf8", timeout: 30_000 });
      if (status) console.log(`probe c: login status ${/api key/i.test(`${status.stdout}${status.stderr}`) ? "sees" : "does not see"} the stored API key (exit ${status.status})`);
      const r = run("c", "Set answer to the word ok.", { extraConfig: ["-c", 'cli_auth_credentials_store="file"'], envOver });
      if (r) {
        const tried = r.text.match(/401|unauthori[sz]ed|incorrect api key|invalid_api_key|invalid api key/i)?.[0];
        const refused = r.text.match(/forced_login_method|chatgpt login|login method|not logged in|log ?in with chatgpt/i)?.[0];
        if (r.status === 0) say("c forced ChatGPT login", "FAIL", "exec completed with only a fake API key stored");
        else if (tried) say("c forced ChatGPT login", "FAIL", `exec tried API-key auth (matched "${tried.toLowerCase()}")`);
        else if (refused) say("c forced ChatGPT login", "PASS", `exec refused (exit ${r.status}, matched "${refused.toLowerCase()}")`);
        else say("c forced ChatGPT login", "INCONCLUSIVE", `exec exited ${r.status ?? r.signal} with neither a refusal nor an auth error matched`);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
} finally { rmSync(work, { recursive: true, force: true }); }
process.exit(DRY || (results.length && results.every((v) => v === "PASS")) ? 0 : 1);
