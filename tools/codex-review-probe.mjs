#!/usr/bin/env node
// Live probe of the codex CLI that tools/codex-review.mjs launches (US-40 AC19, Codex R9 on PR 2222; made stricter after
// R3-R5 of the next review). It MAKES MODEL CALLS on the ChatGPT subscription: run it only by hand, when Brad asks. Never
// in tests, CI, loops or cloud sessions. Tests import only its judge functions and run --dry-run.
//
// It launches `codex exec` with the wrapper's own argument list (launchArgs, configArgs, the probed --disable list, the
// minimal env), in an empty temp folder holding one synthetic file. PASS needs positive evidence; anything less is
// INCONCLUSIVE, never PASS:
//   a  the sandboxed shell has no network. Control first, OUTSIDE the sandbox: this script's own `curl` must reach
//      https://example.com/ (if not, the machine is offline: INCONCLUSIVE). Then PASS only if the sandboxed curl ran and
//      failed with a resolve or connect error (curl exit 6 or 7); exit 0 is FAIL; any other code is INCONCLUSIVE.
//   b  web search stays cached-only. Two steps (AC14's 2026-10-03 method): a real search question first (a DOI on
//      PubMed), then open a never-seen URL (example.com with a random nonce). PASS only when a web_search event for that
//      exact URL is seen AND a cache miss is reported; the page's own title is FAIL; no search event at all, or none for
//      the URL, is its own INCONCLUSIVE line. --control repeats it with web_search="live", which should open the page.
//   c  the forced ChatGPT login. An ISOLATED empty CODEX_HOME holding only a fake API key ("test-key-not-real"; Brad's
//      real CODEX_HOME is never read or written). Control: `login status` on that same file store must report API-key
//      auth (else INCONCLUSIVE). Then PASS only if exec refuses with text specific to the login method; a 401 or an
//      invalid-key error is FAIL (it tried the key); a generic "not logged in" is INCONCLUSIVE.
// Inputs are public and synthetic only. Output names the evidence KIND (an exit code, a matched phrase), never the model's
// or the CLI's full text. Exit 0 only when every check run passes.
//
// Usage: node tools/codex-review-probe.mjs [--codex <bin>] [--model <id>] [--only a,b,c] [--control] [--dry-run]
//   --dry-run  prints each check's argument list after the no-model pre-flight probe; makes no model call
// Cost: one short model turn per check (two for b with --control), on the default model unless --model says otherwise.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv, readers } from "./codex-review-args.mjs";
import { chooseCodex, configArgs, launchArgs, launchEnv, probeCodex } from "./codex-review-bin.mjs";

const done = (r, type) => r.events.filter((e) => e.type === "item.completed" && e.item?.type === type).map((e) => e.item);

/** Check a. `control` is the script's own curl exit code (outside the sandbox); `r` the exec result. */
export function judgeShell(control, r) {
  if (control !== 0) return ["INCONCLUSIVE", `the control curl outside the sandbox exited ${control}: the machine may be offline`];
  const curls = done(r, "command_execution").filter((c) => /curl/.test(c.command ?? "") && typeof c.exit_code === "number");
  if (!curls.length) return ["INCONCLUSIVE", `the sandboxed curl never ran (exec exit ${r.status})`];
  if (curls.some((c) => c.exit_code === 0)) return ["FAIL", "a sandboxed curl to example.com exited 0: the shell reached the network"];
  const codes = curls.map((c) => c.exit_code);
  return codes.every((c) => c === 6 || c === 7) ? ["PASS", `sandboxed curl exit code(s) ${codes.join(", ")} (could not resolve or connect); the control reached the site`]
    : ["INCONCLUSIVE", `sandboxed curl exit code(s) ${codes.join(", ")}: not a resolve or connect denial`];
}

/** Check b, for one mode. `url` is the nonce URL the prompt named. */
export function judgeSearch(r, url, web) {
  const searches = done(r, "web_search");
  const page = /Example Domain/i.test(r.answer);
  if (!searches.length) return ["INCONCLUSIVE", "no web_search event at all: the model never used the search tool"];
  const opens = searches.filter((s) => JSON.stringify(s).includes(url));
  if (!opens.length) return ["INCONCLUSIVE", `${searches.length} web_search event(s), none for the nonce URL`];
  const missInEvent = opens.some((s) => /cache miss/i.test(JSON.stringify(s))), miss = missInEvent || /cache miss/i.test(r.answer);
  if (web === "live") return page ? ["PASS", "control: live mode opened the nonce URL and returned the page"] : ["INCONCLUSIVE", "control: live mode opened the nonce URL but no page came back"];
  if (page) return ["FAIL", "the nonce URL's page came back: it was fetched live"];
  return miss ? ["PASS", `the nonce URL was opened and a cache miss was reported (${missInEvent ? "in the event" : "in the model's answer"})`] : ["INCONCLUSIVE", "the nonce URL was opened, with neither a cache miss nor the page"];
}

/**
 * Check c. `status` is `login status` on the isolated store; `r` the exec result. Every line also counts the event stream's
 * `turn.started` events: zero means no model turn began, which is the evidence available short of the refusal text (it
 * does not prove no request left: an auth exchange could precede a turn). The verdict rules are unchanged by the count.
 */
export function judgeLogin(status, r) {
  const turns = `${r.events.filter((e) => e.type === "turn.started").length} turn.started event(s)`;
  if (!status || !/api key/i.test(`${status.stdout}${status.stderr}`)) return ["INCONCLUSIVE", `the control did not show the CLI reading the stored API key; ${turns}`];
  const tried = r.text.match(/401|unauthori[sz]ed|incorrect api key|invalid_api_key|invalid api key/i)?.[0];
  const specific = r.text.match(/forced_login_method|login method|requires? (a )?chatgpt (login|account|sign[- ]in)|api key (auth(entication)?|login) is not (allowed|permitted)/i)?.[0];
  if (r.status === 0) return ["FAIL", `exec completed with only a fake API key stored; ${turns}`];
  if (tried) return ["FAIL", `exec tried API-key auth (matched "${tried.toLowerCase()}"); ${turns}`];
  if (specific) return ["PASS", `the control read the stored key; exec refused for the login method (exit ${r.status}, matched "${specific.toLowerCase()}"); ${turns}`];
  return ["INCONCLUSIVE", `exec exited ${r.status ?? r.signal} without a login-method message (a generic refusal is not enough); ${turns}`];
}

const main = () => {
  const { has, opt } = readers(parseArgv(process.argv.slice(2), ["--codex", "--model", "--only"]));
  const { bin, error } = chooseCodex(has("--codex") ? opt("--codex") ?? "" : process.env.CODEX_BIN); // the wrapper's own rule
  if (error) { console.error(`probe: ${error}`); process.exit(1); }
  const model = opt("--model", "gpt-6.2-sol"), only = (opt("--only", "a,b,c") ?? "").split(","), DRY = has("--dry-run");
  const env = launchEnv(process.env);
  const pre = probeCodex(bin, env, configArgs("cached"));
  console.log(`probe: codex ${JSON.stringify(bin)} (${pre.version}), model ${model}`);
  if (pre.stop) { console.log(`probe: pre-flight stopped: ${pre.stop.split(":")[0]}; fix that first`); process.exit(1); }
  const work = mkdtempSync(join(tmpdir(), "cr-probe-")), results = [];
  const say = (check, [verdict, evidence]) => { results.push(verdict); console.log(`${verdict.padEnd(12)} ${check}: ${evidence}`); };
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
  try {
    if (only.includes("a")) {
      const control = DRY ? null : spawnSync("curl", ["-sS", "-m", "15", "-o", "/dev/null", "https://example.com/"], { timeout: 30_000 }).status;
      const r = run("a", "Run exactly this one shell command and nothing else: curl -sS -m 15 -o /dev/null https://example.com/\nThen set answer to its exit code.");
      if (r) say("a shell network", judgeShell(control, r));
    }
    if (only.includes("b")) {
      for (const web of has("--control") ? ["cached", "live"] : ["cached"]) {
        const url = `https://example.com/?codex-review-probe=${randomBytes(8).toString("hex")}`;
        const r = run(`b-${web}`, `Step 1: use your web search tool to find the PubMed entry for DOI 10.1080/15502783.2022.2041988 and note its title.\nStep 2: use your web search tool to open exactly this URL and nothing else: ${url}\nDo not run shell commands. Set answer to the title from step 1, then what the tool returned in step 2, quoting any error text exactly.`, { web });
        if (r) say(`b web search (${web})`, judgeSearch(r, url, web));
      }
    }
    if (only.includes("c")) {
      const home = mkdtempSync(join(tmpdir(), "cr-probe-home-")); // isolated: only a fake key, never Brad's CODEX_HOME
      try {
        writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "test-key-not-real" }));
        const envOver = { CODEX_HOME: home }, store = ["-c", 'cli_auth_credentials_store="file"'];
        const status = DRY ? null : spawnSync(bin, [...store, "login", "status"], { env: { ...env, ...envOver }, encoding: "utf8", timeout: 30_000 });
        const r = run("c", "Set answer to the word ok.", { extraConfig: store, envOver });
        if (r) say("c forced ChatGPT login", judgeLogin(status, r));
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  process.exit(DRY || (results.length && results.every((v) => v === "PASS")) ? 0 : 1);
};
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
