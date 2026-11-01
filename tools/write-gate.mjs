/**
 * write-gate.mjs — live writes run merged code only (Brad 2026-11-01; docs/git-workflow.md § Exceptions).
 *
 * A live write (a Shopify page or article PUT, a production Supabase write, a staged Fly secret) runs only from
 * the main checkout, or from a session worktree of it whose HEAD is exactly origin/main with no tracked change.
 * A session worktree's own unmerged tool or content changes never run live. Checked TWICE: the tool's own
 * location (realpath of tools/..) and the invoking checkout (realpath of process.cwd() and its git top level), so
 * a scratch folder whose tools/ links to the real one is refused too.
 *
 * Ported from claude_business tools/write-gate.js, its checkout check only: this repo's live writes take no
 * --authorised-by record, so that half has no caller here. The main checkout is trusted as it is, so
 * `git pull --ff-only` there first.
 *
 * No I/O at import time: safe to load from tests.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo roots allowed to run a live write: Brad's main checkout. (No cloud loop runs a live write here.)
export const CANONICAL_ROOTS = ['/Users/bradstanfield/Documents/roadmap.nosync'];
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function realpathOrSelf(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/** Trimmed stdout of `git <args>` in `dir`; '' for empty output, null on error. */
function gitIn(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); } catch { return null; }
}

/**
 * Null when `dir` is a session worktree of a canonical root (<root>/.claude/worktrees/<name>, its own git top
 * level and listed by that root's `git worktree list`) at exactly refs/remotes/origin/main, with no tracked change
 * and no skip-worktree or assume-unchanged flag hiding one; else why not. It trusts the local origin/main ref (a
 * stale one only ever runs code that was once merged). `git` is injectable for tests.
 */
export function mergedWorktreeProblem(dir, roots, git = gitIn) {
  const real = realpathOrSelf(dir);
  const root = roots.find((r) => path.dirname(real) === path.join(r, '.claude', 'worktrees'));
  if (!root) return 'not a canonical session worktree';
  // A plain folder (or a worktree that lost its .git file) resolves to the main checkout's git: refuse it.
  const top = git(real, ['rev-parse', '--show-toplevel']);
  if (!top || realpathOrSelf(top) !== real) return 'not a git worktree (its git top level is elsewhere)';
  if (realpathOrSelf(path.dirname(git(real, ['rev-parse', '--path-format=absolute', '--git-common-dir']) || '/')) !== root) return 'not a worktree of the canonical repo';
  const listed = (git(root, ['worktree', 'list', '--porcelain']) || '').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => realpathOrSelf(l.slice(9)));
  if (!listed.includes(real)) return 'not a registered worktree of the canonical repo';
  const head = git(real, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head || head !== git(real, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}'])) return 'its HEAD is not exactly origin/main (merge your PR, then `git merge --ff-only origin/main`)';
  const status = git(real, ['status', '--porcelain', '--untracked-files=no']);
  if (status === null) return 'git status failed (try again)';
  if (status !== '') return 'it has tracked changes';
  const flags = git(real, ['ls-files', '-v']);
  if (flags === null || flags.split('\n').some((l) => /^([a-z]|S) /.test(l))) return 'a tracked file is flagged skip-worktree or assume-unchanged';
  return null;
}

/**
 * Null when BOTH the tool's repo root and the invoking checkout (cwd realpath + its git top level) are a
 * canonical root, or a merged session worktree of one; else the refusal. Options exist for tests:
 * { roots, repoRoot, cwd, git }.
 */
export function checkCanonicalRoot(opts = {}) {
  const allowed = opts.roots || CANONICAL_ROOTS;
  const roots = allowed.map(realpathOrSelf);
  const git = opts.git || gitIn;
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const isCanon = (p) => !!p && (roots.includes(realpathOrSelf(p)) || !mergedWorktreeProblem(p, roots, git));
  if (!isCanon(repoRoot)) {
    const why = mergedWorktreeProblem(repoRoot, roots, git);
    return `live writes run only from the main checkout (${allowed.join(' or ')}) or a session worktree of it at exactly origin/main; this tool copy is at ${realpathOrSelf(repoRoot)}${why === 'not a canonical session worktree' ? '' : ` (${why})`}`;
  }
  const cwd = realpathOrSelf(opts.cwd || process.cwd());
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return `live writes must be invoked from inside the main checkout; cwd ${cwd} is not in a git checkout`;
  if (!isCanon(top)) return `live writes must be invoked from the main checkout or a merged session worktree; cwd ${cwd} belongs to ${realpathOrSelf(top)}`;
  return null;
}

/** For a tool's live-write branch: print the refusal and exit 1 unless merged code is running. */
export function requireMergedCode(what) {
  const err = checkCanonicalRoot();
  if (!err) return;
  console.error(`REFUSED (${what}): ${err}. Nothing written.`);
  process.exit(1);
}
