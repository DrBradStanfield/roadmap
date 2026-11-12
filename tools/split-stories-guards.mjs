/**
 * The guards tools/split-stories.mjs runs before writing into the repo (US-64 AC33): where the repo is, whether a
 * merge is in progress and brings exactly the split, and whether docs/stories/ already holds other parts.
 * Every failure, git's included, is a SplitRefusal (exit 1, "refused…"), never a stack trace.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INDEX } from './stories.mjs';

export class SplitRefusal extends Error {}

// Git with the variables that point it at another repo removed, so it answers for the folder it runs in.
const MOVERS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !MOVERS.includes(k)));
export const gitIn = (root) => (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const gitError = (e) => String(e.stderr || e.message).trim();
// Only git's own answer means "no repo": a git that cannot run (ENOENT) refuses, so a guard never skips.
const notARepo = (e) => /not a git repository/.test(String(e.stderr));
// A line git writes into a conflicted file.
const MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/;

/** Whether two existing paths are one folder, by identity (device and inode), never by path. */
function sameFolder(a, b) {
  const [x, y] = [statSync(a), statSync(b)];
  return x.dev === y.dev && x.ino === y.ino;
}

/** The git toplevel holding `root`, as git prints it, or undefined when git answers that `root` is in no repo. */
export function toplevel(root) {
  try {
    return gitIn(root)('rev-parse', '--show-toplevel').trim();
  } catch (e) {
    if (notARepo(e)) return undefined;
    throw new SplitRefusal(`cannot find the repo's toplevel: ${gitError(e)}`);
  }
}

/**
 * The folder holding a `.git` entry (file or folder) at or above the real path of `path`, or of its nearest existing
 * ancestor, or undefined. It walks the disk and never asks git, so no git variable can move the answer.
 */
function workTreeAbove(path) {
  let p = path;
  while (!existsSync(p)) p = dirname(p);
  for (p = realpathSync.native(p); ; p = dirname(p)) {
    if (lstatSync(join(p, '.git'), { throwIfNoEntry: false })) return p;
    if (dirname(p) === p) return undefined;
  }
}

/**
 * The folder whose guards the run must pass, or undefined for a dry run. An `out` is a dry run into a scratch folder,
 * and inside any git work tree it throws SplitRefusal. With no `out` it is `root`, which must be its repo's toplevel
 * (or in no repo), or it throws SplitRefusal.
 */
export function guardedRoot(root, out) {
  if (out !== undefined) {
    const tree = workTreeAbove(out);
    if (tree === undefined) return undefined;
    throw new SplitRefusal(`--out ${out} is inside a git work tree (${tree}): a dry run writes only to a scratch folder outside any git work tree; the real split writes only through the default path (no --out), from the toplevel of the checkout it runs in`);
  }
  const top = toplevel(root) ?? root;
  if (!sameFolder(root, top)) throw new SplitRefusal(`writing into the repo runs from its toplevel, ${top}, not from ${root}: cd there and run this again`);
  return root;
}

/** The first conflict marker line in an index and parts, as "<path> line N is a conflict marker: …", or undefined. */
export function conflictMarker(have) {
  const files = [...[...have.parts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, t]) => [`docs/stories/${n}`, t]), [INDEX, have.index ?? '']];
  for (const [path, text] of files) {
    const k = text.split('\n').findIndex((l) => MARKER.test(l));
    if (k >= 0) return `${path} line ${k + 1} is a conflict marker: ${JSON.stringify(text.split('\n')[k])}`;
  }
  return undefined;
}

/** Throws SplitRefusal unless --normalize may write under `root`: the toplevel of a git repo with no merge in progress. */
export function checkNormalize(root) {
  if (toplevel(root) === undefined) throw new SplitRefusal('--normalize runs only in a git repo, and this folder is in none');
  guardedRoot(root, undefined);
  if (mergeHead(root) !== undefined) throw new SplitRefusal('a merge is in progress: finish it, resolving every conflict in the stories by hand, then run --normalize again');
}

/** The commit a merge in progress under `root` brings in, or undefined when none is (or `root` is no git repo). */
export function mergeHead(root) {
  try {
    return gitIn(root)('rev-parse', '-q', '--verify', 'MERGE_HEAD').trim();
  } catch (e) {
    if (e.status === 1 || notARepo(e)) return undefined;
    throw new SplitRefusal(`cannot tell whether a merge is in progress: ${gitError(e)}`);
  }
}

/** Every file where `have` (an index and parts) differs from `plan`, parts first: { path, have, want }, a missing side undefined. */
export function diffs(have, plan) {
  const out = [];
  for (const name of [...new Set([...have.parts.keys(), ...plan.parts.keys()])].sort()) {
    if (have.parts.get(name) !== plan.parts.get(name)) out.push({ path: `docs/stories/${name}`, have: have.parts.get(name), want: plan.parts.get(name) });
  }
  if (have.index !== plan.index) out.push({ path: INDEX, have: have.index, want: plan.index });
  return out;
}

/** The first difference as "<path> differs", "is missing" or "is not in the split", or undefined. */
function firstDiff(have, plan) {
  const [d] = diffs(have, plan);
  if (d === undefined) return undefined;
  return `${d.path} ${d.have === undefined ? 'is missing' : d.want === undefined ? 'is not in the split' : 'differs'}`;
}

/** The index and parts under `root`, as they are on disk. */
export function readTree(root) {
  const dir = join(root, 'docs/stories');
  return {
    index: existsSync(join(root, INDEX)) ? readFileSync(join(root, INDEX), 'utf8') : undefined,
    parts: new Map(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(dir, f), 'utf8')])),
  };
}

/**
 * Throws SplitRefusal unless the commit `incoming` holds exactly the split (by `planSplit`) of the monolith at its
 * merge base with HEAD. When `incoming` is the split commit itself but its parent is not the merge base, main changed
 * the monolith before splitting, and the refusal names the order that keeps those changes. When its parent is the
 * merge base and it holds parts, it is an impure split: the refusal says to port its story edits by hand.
 */
export function checkMerge(root, incoming, planSplit) {
  const git = gitIn(root);
  const at = incoming.slice(0, 12);
  let base, diff, names = [];
  try {
    base = git('merge-base', 'HEAD', incoming).trim();
    names = git('ls-tree', '--name-only', incoming, 'docs/stories/').split('\n').filter((p) => p.endsWith('.md'));
    const have = { index: git('show', `${incoming}:${INDEX}`), parts: new Map(names.map((p) => [p.slice('docs/stories/'.length), git('show', `${incoming}:${p}`)])) };
    diff = firstDiff(have, planSplit(git('show', `${base}:${INDEX}`)));
  } catch (e) {
    diff = e instanceof SplitRefusal ? e.message : gitError(e);
  }
  if (diff === undefined) return;
  let parent;
  try {
    parent = git('rev-parse', '-q', '--verify', `${incoming}^1`).trim();
    if (parent === base ? !names.length : git('ls-tree', '--name-only', parent, 'docs/stories/').trim()) parent = undefined;
  } catch {
    parent = undefined; // no first parent: the general advice stands
  }
  const how = parent === undefined
    ? 'Abort the merge and merge exactly the split commit, nothing after it, then run this again.'
    : parent === base
      ? `So the incoming commit ${at} itself differs from a pure split of its parent. This tool cannot re-split the branch: finish the merge taking the incoming commit's docs/stories/ and index, then port its own story edits into the parts by hand.`
      : `The split commit's parent is not the merge base, so main changed the monolith before splitting: abort this merge, merge ${parent.slice(0, 12)} (the commit before the split) first, commit, then merge ${at}, then run this again.`;
  throw new SplitRefusal(`a merge is in progress, and its incoming side (MERGE_HEAD ${at}) is not exactly the split of the monolith at the merge base${base ? ` ${base.slice(0, 12)}` : ''}: ${diff}. ${how}`);
}

/** Throws SplitRefusal when docs/stories/ under `root` exists and the index or a part there differs from `plan`. */
export function checkExisting(root, plan) {
  if (!existsSync(join(root, 'docs/stories'))) return;
  const diff = firstDiff(readTree(root), plan);
  if (diff !== undefined) throw new SplitRefusal(`docs/stories/ already holds parts that differ from the split: ${diff}. Pass --replace to overwrite them.`);
}
