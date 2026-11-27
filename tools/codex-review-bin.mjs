// The codex binary tools/codex-review.mjs launches, and what it learns from it before the snapshot (US-40 AC19).
// Side-effect free until called, so the tests pass their own candidates; no test hook sits in the wrapper.
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { disableArgs, parseFeatures, unjudged } from "./codex-review-features.mjs";
export { configArgs, launchEnv } from "./codex-review-features.mjs";

/** The CLI bundled with the ChatGPT desktop app: on 2026-11-27 it ran gpt-6.2-astra on a ChatGPT login, the Homebrew 0.163 refused it. */
export const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** An executable regular file that only its owner can write: a group- or world-writable binary could be swapped. */
export const isExecutableFile = (p) => isExec(p) && (statSync(p).mode & 0o022) === 0;
const isExec = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const onPath = (name, path, ok) => (path ?? "").split(delimiter).filter(isAbsolute).map((d) => join(d, name)).find(ok) ?? null;
const byVersion = (a, b) => { const x = a.split("."), y = b.split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = Number(x[i] ?? 0) - Number(y[i] ?? 0); if (d) return d; } return 0; };

/** Absolute path of the binary to run: the ChatGPT app's CLI; else `codex` on PATH; else the newest VS Code extension copy (versions compared as numbers); else null. */
export function findCodex({ appBin = CHATGPT_APP_CODEX, home = homedir(), path = process.env.PATH } = {}) {
  if (isExecutableFile(appBin)) return appBin;
  const found = onPath("codex", path, isExecutableFile);
  if (found) return found;
  const ext = join(home, ".vscode", "extensions");
  let dirs = [];
  try { dirs = readdirSync(ext).flatMap((d) => { const m = /^openai\.chatgpt-(\d+(?:\.\d+)*)/.exec(d); return m ? [[m[1], d]] : []; }); } catch { return null; }
  for (const [, d] of dirs.sort(([a], [b]) => byVersion(b, a))) {
    let plats = [];
    try { plats = readdirSync(join(ext, d, "bin")).filter((p) => p.startsWith("macos-")).sort().reverse(); } catch { continue; }
    const bin = plats.map((p) => join(ext, d, "bin", p, "codex")).find(isExecutableFile);
    if (bin) return bin;
  }
  return null;
}

/** A --codex or CODEX_BIN value as an absolute path: a path is resolved against cwd, a bare name looked up on PATH; null when not found. */
export const resolveBin = (given, path = process.env.PATH) => (given.includes("/") ? resolve(given) : onPath(given, path, isExec));

/**
 * Pre-flight probe, no model call: `--version`, then `features list` twice under an empty CODEX_HOME (as
 * --ignore-user-config reads no user config; `features list` cannot take that flag): once to learn which features the
 * binary lists, once with the run's own --disable and -c arguments. Returns { version, disable }, plus `stop` (an
 * E_FEATURES_UNREADABLE or E_UNKNOWN_FEATURES reason) when the run must not start.
 */
export function probeCodex(bin, env, configArgs) {
  const home = mkdtempSync(join(tmpdir(), "cr-codex-home-"));
  const run = (a) => execFileSync(bin, a, { encoding: "utf8", env: { ...env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, maxBuffer: 4 << 20 });
  try {
    let version = "version unknown";
    try { version = run(["--version"]).trim().split("\n")[0] || version; } catch { /* reported as unknown */ }
    let disable, after;
    try {
      disable = disableArgs(parseFeatures(run(["features", "list"])).map((f) => f.name));
      after = parseFeatures(run([...disable, ...configArgs, "features", "list"]));
    } catch (e) { return { version, stop: `E_FEATURES_UNREADABLE: \`features list\` failed (${String(e.stderr || e.message).trim().split("\n")[0].slice(0, 200)})` }; }
    if (!after.length) return { version, stop: "E_FEATURES_UNREADABLE: `features list` listed no features" };
    const unknown = unjudged(after);
    return { version, disable, ...(unknown.length && { stop: `E_UNKNOWN_FEATURES: codex enables feature(s) no one has judged (${unknown.join(", ")}); judge or disable each in tools/codex-review-features.mjs` }) };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
