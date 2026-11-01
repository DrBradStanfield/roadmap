// Credential-name rule and known credential shapes for tools/codex-review.mjs, in a module with no side
// effects so tests and tools/codex-review-links.mjs use the REAL rule (the
// wrapper runs on import). Moved verbatim from codex-review.mjs 2026-09-29.

/**
 * Credential names (US-40 AC11): a path is a credential file when ANY
 * component, in any case, matches one of these globs:
 *   `.env*`          starts with .env: .env, .env.local, .env~, .env-old, .env_backup, .envrc
 *   `*.env`          ends with .env: prod.env, a keys.env/ directory
 *   `*.env.*`        holds ".env.": secrets.env.bak, prod.env.local
 *   `env.<stage>`, `env.<stage>.*`  for the ENV_STAGES words: env.local, env.production.bak
 * Deliberately NOT matched: environment.ts, env.ts, env.d.ts, env.test.ts,
 * vite-env.d.ts, dotenv.js, a src/env/ directory. Code named `<x>.env.<ext>`
 * (config/prod.env.js, app.env.ts) IS a credential file: withheld, and its
 * lines collected as values, so a copy of one of its lines elsewhere stops
 * the run (fail-closed on purpose). The value check below reads
 * values ONLY from files this rule names, so it is no backstop for a name it
 * misses: such a file is neither withheld nor searched for. It catches a
 * credential file's values copied or renamed elsewhere. `.env.example` is included: a template can
 * gain a real value, and nothing here can tell which. claude_business tracks
 * claude-integration/.env, and it reached review patches before this existed.
 * One list feeds both the git pathspecs and the regex, so the layers agree.
 */
export const ENV_STAGES = ["local", "dev", "development", "prod", "production", "staging", "secret", "secrets", "backup", "bak", "old", "orig"];
export const SECRET_GLOBS = [".env*", "*.env", "*.env.*", ...ENV_STAGES.flatMap((s) => [`env.${s}`, `env.${s}.*`])];
const SECRET_NAME = new RegExp(`^(?:${SECRET_GLOBS.map((g) => g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).join("|")})$`, "i");
export const isSecretName = (c) => SECRET_NAME.test(c);
export const isSecretPath = (p) => p.split("/").some(isSecretName);
export const SECRET_EXCLUDES = SECRET_GLOBS.flatMap((g) => [`:(exclude,glob,icase)**/${g}`, `:(exclude,glob,icase)**/${g}/**`]);

/**
 * Known credential shapes, found under any name in any file (US-40 AC11): a
 * stop names the file and the shape, never the text. Each needs a body after
 * its prefix, so prose or a doc that names a prefix passes, and each is
 * bounded (PATTERN_SPAN) so a streamed read's carry always holds a whole
 * match (codex-review.mjs). Moved verbatim 2026-11-01 so tools/agent-channel.mjs
 * uses the same shapes. A plain `sk-` body must hold a digit within 100 characters, so a
 * word like `sk-learn-...` passes; `sk-proj-`, `sk-svcacct-`, `sk-admin-` and
 * `sk-ant-` need none. A test fixture must assemble these shapes at run time.
 */
// A prefix holding `_` or `-` cannot sit inside a standard base64 run: it only must not continue a word, so `//tok@`, `:tok` and `@tok` match.
const NW = "(?<![A-Za-z0-9])";
// An alphanumeric prefix could be the middle of a base64 run: no letter, digit or `+` before it, and a `/` only as in `//` or `:/`.
const NB = "(?<![A-Za-z0-9+])(?<!(?<![:/])/)";
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
