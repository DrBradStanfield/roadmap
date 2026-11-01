// Secret rules shared by tools/codex-review.mjs and tools/agent-channel.mjs, in a module with no side effects
// (codex-review.mjs runs on import): the known credential shapes, their streaming bound, and the hardened lookup
// of a repo's main checkout. The credential-name rule is its peer, tools/codex-review-names.mjs.
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * Known credential shapes, found under any name in any file (US-40 AC11): a
 * stop names the file and the shape, never the text. Each needs a body after
 * its prefix, so prose or a doc that names a prefix passes, and each is
 * bounded (PATTERN_SPAN) so a streamed read's carry always holds a whole
 * match (codex-review.mjs). A plain `sk-` body must hold a digit within 100 characters, so a
 * word like `sk-learn-...` passes; `sk-proj-`, `sk-svcacct-`, `sk-admin-` and
 * `sk-ant-` need none. A test fixture must assemble these shapes at run time.
 */
// A prefix holding `_` or `-` cannot sit inside a standard base64 run: it only must not continue a word, so `//tok@`, `:tok` and `@tok` match.
export const NW = "(?<![A-Za-z0-9])";
// An alphanumeric prefix could be the middle of a base64 run: no letter, digit or `+` before it, and a `/` only as in `//` or `:/`.
export const NB = "(?<![A-Za-z0-9+])(?<!(?<![:/])/)";
export const PATTERNS = {
  shopify: `${NW}shp(?:ss|at|ca|pa)_[a-fA-F0-9]{16}`,
  openai_anthropic: `${NW}sk-(?:(?:proj|svcacct|admin|ant)-[A-Za-z0-9_-]{20}|(?=[A-Za-z0-9_-]{0,99}\\d)[A-Za-z0-9_-]{20})`,
  stripe: `${NW}[sr]k_live_[A-Za-z0-9]{10}`,
  aws_access_key: `${NB}AKIA[0-9A-Z]{16}`,
  google_api_key: `${NB}AIza[0-9A-Za-z_-]{35}`,
  slack_token: `${NW}xox[abposr]-[A-Za-z0-9-]{10}`,
  github_token: `${NW}gh[pousr]_[A-Za-z0-9]{36}`,
  github_pat: `${NW}github_pat_[A-Za-z0-9_]{10}`,
  google_oauth_secret: `${NW}GOCSPX-[A-Za-z0-9_-]{10}`,
  google_oauth_token: `${NB}ya29\\.[A-Za-z0-9_-]{10}`,
  private_key: "-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----(?:\\\\[rn]|\\s){1,8}[A-Za-z0-9+/]{40}",
  discord_webhook: "discord(?:app)?\\.com/api/webhooks/\\d+/",
  slack_webhook: "hooks\\.slack\\.com/services/[A-Za-z0-9]{8}",
  gitlab_token: `${NW}glpat-[A-Za-z0-9_-]{10}`,
  meta_token: `${NB}EAA[A-Za-z0-9]{50}`,
};
/**
 * Longer than any PATTERNS match plus its lookahead (the `sk-` digit look reaches 103), so a streamed read's carry
 * always holds a whole match. Chosen as the next power of two above the widest reach; secret-rules.test.ts computes
 * each pattern's reach and holds it below this.
 */
export const PATTERN_SPAN = 128;

/** A real folder: a directory that is not itself a symlink. */
export const realFolder = (d) => { try { const st = lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/**
 * The main checkout of the repo holding `dir` (the folder holding its common .git), real path; never cwd, never a
 * worktree's own folder. Null when git cannot say.
 */
export const mainOf = (dir) => {
  try {
    // GIT_DIR and friends would redirect the answer to another repo (adversary R4).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)$/.test(k)));
    const common = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (basename(common) === ".git" && realFolder(common)) return realpathSync(dirname(common));
  } catch { /* null below */ }
  return null;
};
