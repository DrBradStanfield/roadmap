// Credential-name rule for tools/codex-review.mjs, in a module with no side
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
