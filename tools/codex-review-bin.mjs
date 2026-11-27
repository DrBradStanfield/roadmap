// Which codex binary tools/codex-review.mjs launches when neither --codex nor CODEX_BIN names one (US-40 AC19).
// Side-effect free, so the tests call it with their own candidate path; no test hook sits in the wrapper.
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

/** The CLI bundled with the ChatGPT desktop app: on 2026-11-27 it ran gpt-6.2-astra on a ChatGPT login, the Homebrew 0.163 refused it. */
export const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

const isExecutableFile = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

/** The ChatGPT app's binary when it is an executable file; else `codex` on PATH; else the newest VS Code extension copy; else null. */
export function findCodex(appBin = CHATGPT_APP_CODEX) {
  if (isExecutableFile(appBin)) return appBin;
  try { execFileSync("sh", ["-c", "command -v codex"], { stdio: "ignore" }); return "codex"; } catch { /* not on PATH */ }
  try {
    return execFileSync("sh", ["-c", "ls -d ~/.vscode/extensions/openai.chatgpt-*/bin/macos-*/codex 2>/dev/null | sort | tail -1"], { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

/** `<bin> --version`, one line, under the child's own minimal env; "version unknown" when it fails. Makes no model call. */
export function codexVersion(bin, env) {
  try { return execFileSync(bin, ["--version"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim().split("\n")[0] || "version unknown"; } catch { return "version unknown"; }
}
