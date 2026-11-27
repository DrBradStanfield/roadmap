// The codex binary tools/codex-review.mjs launches, and what it learns from it before the snapshot (US-40 AC19).
// Side-effect free until called, so the tests pass their own candidates; no test hook sits in the wrapper.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { configArgs, disableArgs, parseFeatures, searchMode, unjudged, VERSION_LINE } from "./codex-review-features.mjs";
export { launchEnv } from "./codex-review-features.mjs";

/** The CLI bundled with the ChatGPT desktop app: on 2026-11-27 it ran gpt-6.2-astra on a ChatGPT login, the Homebrew 0.163 refused it. */
export const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** An executable regular file that only its owner can write: a group- or world-writable binary could be swapped. */
export const isExecutableFile = (p) => { try { accessSync(p, constants.X_OK); const s = statSync(p); return s.isFile() && (s.mode & 0o022) === 0; } catch { return false; } }; // one stat, one handler (Codex R4, PR 2222f)
const isExec = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const onPath = (name, path, ok) => (path ?? "").split(delimiter).filter(isAbsolute).map((d) => join(d, name)).find(ok) ?? null;
const byVersion = (a, b) => { const x = a.split("."), y = b.split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = Number(x[i] ?? 0) - Number(y[i] ?? 0); if (d) return d; } return 0; };
/** A failed CLI call in a few words: its exit code or timeout, never its output. */
const failed = (e) => (e.code === "ETIMEDOUT" || e.signal ? "timed out" : typeof e.status === "number" ? `exited ${e.status}` : "could not start");
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

/** Canonical path of the binary to run: the ChatGPT app's CLI; else `codex` on PATH; else the newest VS Code extension copy (versions compared as numbers); else null. */
export function findCodex({ appBin = CHATGPT_APP_CODEX, home = homedir(), path = process.env.PATH } = {}) {
  if (isExecutableFile(appBin)) return real(appBin);
  const found = onPath("codex", path, isExecutableFile);
  if (found) return real(found);
  const ext = join(home, ".vscode", "extensions");
  let dirs = [];
  try { dirs = readdirSync(ext).flatMap((d) => { const m = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(d); return m ? [[m[1], d]] : []; }); } catch { return null; }
  for (const [, d] of dirs.sort(([a], [b]) => byVersion(b, a))) {
    let plats = [];
    try { plats = readdirSync(join(ext, d, "bin")).filter((p) => p.startsWith("macos-")).sort().reverse(); } catch { continue; }
    const bin = plats.map((p) => join(ext, d, "bin", p, "codex")).find(isExecutableFile);
    if (bin) return real(bin);
  }
  return null;
}

/** A --codex or CODEX_BIN value as a canonical path (Codex R4): a path is resolved against cwd, a bare name looked up on PATH; null when not found. */
export const resolveBin = (given, path = process.env.PATH) => real(given.includes("/") ? resolve(given) : onPath(given, path, isExec) ?? "");

/** The binary for a run: an explicit --codex or CODEX_BIN (`given`; "" is refused), else findCodex(); { bin } or { error }. */
export function chooseCodex(given) {
  if (given === "") return { error: "--codex and CODEX_BIN need a path or name when given" };
  const bin = given ? resolveBin(given) : findCodex();
  if (!bin) return { error: "codex binary not found: pass --codex <path> or set CODEX_BIN" };
  return isExecutableFile(bin) ? { bin } : { error: `codex binary ${JSON.stringify(bin)} is refused: ${REFUSED}` };
}

const REFUSED = "it must be an executable file that neither group nor others can write";
/**
 * What the file IS (Codex R5): device, inode, mode, size, mtime and a sha256 of its bytes (0.6 s for the 300 MB app binary,
 * 2026-11-27), read through one descriptor. null when it cannot be read, or the opened file is not an executable regular
 * file that only its owner can write (Codex R2, PR 2222d). When the path no longer names that same file after the read
 * (a fresh stat differs, or the path is not canonical: replaced or relinked while hashed; Codex R1, PR 2222d), a one-off
 * sentinel that equals no other identity. `afterRead` is a test hook between the read and that stat.
 */
export function binaryId(p, { afterRead } = {}) {
  try {
    const fd = openSync(p, "r"), hash = createHash("sha256"), buf = Buffer.alloc(1 << 20);
    try {
      const s = fstatSync(fd, { bigint: true });
      if (!s.isFile() || (s.mode & 0o022n) || !(s.mode & 0o111n)) return null;
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
      afterRead?.();
      const now = statSync(p, { bigint: true });
      if (real(p) !== p || ["dev", "ino", "mode", "size", "mtimeNs"].some((k) => now[k] !== s[k])) return `changed:${randomUUID()}`;
      return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${hash.digest("hex")}`;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/**
 * Pre-flight probe, no model call: `--version`, then `features list` twice under an empty CODEX_HOME (as
 * --ignore-user-config reads no user config; `features list` cannot take that flag): once to learn which features the
 * binary lists, once with the run's own --disable arguments. The search mode is chosen from the version first (Codex R1,
 * PR 2222f), so both listings carry the exact -c settings the review launches with. Returns { version, mode, configArgs,
 * disable, id } (`id` taken before the first call, so recheckCodex also sees a change during the probe), plus
 * `stop` (E_CODEX_CHANGED, E_CODEX_VERSION, E_FEATURES_UNREADABLE or E_UNKNOWN_FEATURES) when the run must not start. A
 * failure names its stage and exit code only: the CLI's own output never reaches the report (Codex R3).
 */
export function probeCodex(bin, env, live, hooks = {}) {
  const home = mkdtempSync(join(tmpdir(), "cr-codex-home-"));
  const run = (a) => execFileSync(bin, a, { encoding: "utf8", env: { ...env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, maxBuffer: 4 << 20 });
  const id = binaryId(bin, hooks); // `hooks.afterRead`: the tests' moment inside the hash
  if (!id || id.startsWith("changed:")) { rmSync(home, { recursive: true, force: true }); return { version: "version unknown", stop: `E_CODEX_CHANGED: the codex binary could not be read, changed while it was hashed, or ${REFUSED}` }; }
  try {
    let version;
    try { version = run(["--version"]).trim().split("\n")[0]; } catch (e) { return { version: "version unknown", stop: `E_CODEX_VERSION: \`--version\` ${failed(e)}` }; }
    if (!VERSION_LINE.test(version)) return { version: "version unknown", stop: "E_CODEX_VERSION: `--version` printed an unrecognised line" }; // Codex R9: the CLI text never reaches the report
    const mode = searchMode(live, version), cfg = configArgs(mode);
    const list = (stage, extra) => {
      let text;
      try { text = run([...extra, ...cfg, "features", "list"]); } catch (e) { return { stop: `\`features list\` (${stage}) ${failed(e)}` }; }
      const parsed = parseFeatures(text);
      return parsed.error ? { stop: `\`features list\` (${stage}) ${parsed.error}` } : parsed;
    };
    const first = list("discovery", []);
    if (first.stop) return { version, mode, stop: `E_FEATURES_UNREADABLE: ${first.stop}` };
    const disable = disableArgs(first.features.map((f) => f.name));
    const after = list("check", disable);
    if (after.stop) return { version, mode, stop: `E_FEATURES_UNREADABLE: ${after.stop}` };
    const names = (l) => l.features.map((f) => f.name).sort().join();
    if (names(after) !== names(first)) return { version, mode, stop: "E_FEATURES_UNREADABLE: `features list` (check) the two listings name different features" };
    const unknown = unjudged(after.features, version);
    return { version, mode, configArgs: cfg, disable, id, ...(unknown.length && { stop: `E_UNKNOWN_FEATURES: codex enables feature(s) no one has judged (${unknown.join(", ")}); judge or disable each in tools/codex-review-features.mjs` }) };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/**
 * Just before the review launches (Codex R5): the same file as probed, or one fresh probe of the new one; a second change
 * stops the run. With `reprobe: false` (a test policy shaped the snapshot; Codex R3, PR 2222d) any change stops it.
 */
export function recheckCodex(bin, probe, env, live, say, { reprobe = true } = {}) {
  if (!isExecutableFile(bin)) return { ...probe, stop: `E_CODEX_CHANGED: the codex binary changed after its probe and ${REFUSED}` }; // Codex R1: before any re-probe
  if (binaryId(bin) === probe.id) return probe;
  if (!reprobe) return { ...probe, stop: "E_CODEX_CHANGED: the codex binary changed after its probe, and a test policy shaped this snapshot, so it is not probed again" };
  say("codex binary changed after its probe; probing it again");
  const again = probeCodex(bin, env, live);
  return again.stop || binaryId(bin) === again.id ? again : { ...again, stop: "E_CODEX_CHANGED: the codex binary changed again after a second probe" };
}

/**
 * The stored login the review will use, read with `login status` under the run's own environment and CODEX_HOME (Codex R2,
 * PR 2222f): null when it exits 0 and the first non-empty line of its output is exactly "Logged in using ChatGPT", else a
 * stop reason naming only the exit code. Both supported CLIs print that line on STDERR with stdout empty (0.163.0 and
 * 0.171.0-alpha.13.2, 2026-11-27), so both streams are read, stdout first. The CLI's text (which can carry a masked key)
 * never reaches the report.
 */
export function checkLogin(bin, env) {
  const r = spawnSync(bin, ["login", "status"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, maxBuffer: 1 << 20 });
  if (r.error || r.signal || r.status !== 0) return `E_LOGIN_NOT_CHATGPT: \`login status\` ${failed({ code: r.error?.code, signal: r.signal, status: r.status })}`;
  const first = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).find(Boolean);
  return first === "Logged in using ChatGPT" ? null : "E_LOGIN_NOT_CHATGPT: `login status` (exit 0) does not report a ChatGPT login";
}

/** The review's argument list, as the wrapper launches it (AC3, AC14, AC19). */
export const launchArgs = ({ disable, configArgs, model, recordArgs = [], src, schemaPath, outPath }) => [
  "exec", "--ignore-user-config", "--strict-config", "--json", "--ephemeral", "--skip-git-repo-check",
  "--sandbox", "read-only",
  ...disable, // AC3's eight, plus every sub-agent, browser, automation and unused feature this binary lists (AC19)
  ...configArgs, // hosted search (AC14, AC19): "cached" on a verified build, else "disabled"; "live" under --live; never "indexed"
  "--model", model, ...recordArgs,
  "-C", src, "--output-schema", schemaPath, "-o", outPath, "--color", "never", "-",
];
