/**
 * Shared spawn helpers for the tests that run the CLIs as real subprocesses.
 *
 * They must NOT spawn `npx tsx`. `npx` resolves through npm's shared cache and
 * installs on a miss, so four concurrent spawns on a cold CI runner race each
 * other over the same cache directory and some of them die half-unpacked
 * ("The following package was not found and will be installed", then a TAR
 * ENOENT on esbuild's binary). The repo-local tsx is already on disk after
 * `npm ci`, so it needs no network and no cache. It is invoked through this
 * process's own node rather than the `.bin` symlink, so neither the exec bit
 * nor the shebang has to be right on the runner.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** Run a TypeScript entry point (path first, then its argv) under the local tsx. */
export function tsxSpawn(args: string[]): [string, string[]] {
  return [process.execPath, [TSX_CLI, ...args]];
}

/**
 * Rewrite a command as a guide tells a reader to type it. `npx tsx …` becomes
 * the local tsx; anything else is passed through untouched.
 */
export function localCommand(command: string[]): [string, string[]] {
  const [bin, ...rest] = command;
  if (bin === 'npx' && rest[0] === 'tsx') return tsxSpawn(rest.slice(1));
  return [bin, rest];
}
