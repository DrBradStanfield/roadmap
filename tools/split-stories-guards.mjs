/**
 * The guards tools/split-stories.mjs runs before writing into the repo (US-64 AC33): where the repo is, whether a
 * merge is in progress and brings exactly the split, and whether docs/stories/ already holds other parts.
 * Every failure, git's included, is a SplitRefusal (exit 1, "refused…"), never a stack trace.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { INDEX } from './stories.mjs';

export class SplitRefusal extends Error {}

export const gitIn = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const gitError = (e) => String(e.stderr || e.message).trim();
const notARepo = (e) => e.code === 'ENOENT' || /not a git repository/.test(String(e.stderr));

/** The real path of `p` (symlinks, `..` and the disk's own letter case resolved); a missing tail is kept as given. */
function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(real(up), basename(p));
  }
}

/** The real path of the git toplevel holding `root`, or undefined when `root` is in no git repo. */
function toplevel(root) {
  try {
    return real(gitIn(root)('rev-parse', '--show-toplevel').trim());
  } catch (e) {
    if (notARepo(e)) return undefined;
    throw new SplitRefusal(`cannot find the repo's toplevel: ${gitError(e)}`);
  }
}

/**
 * True when the run writes into the repo: no `out`, or an `out` whose real path is the repo's toplevel (or `root`
 * itself, outside a repo). Throws SplitRefusal when it does and `root` is not that toplevel.
 */
export function intoRepo(root, out) {
  const top = toplevel(root) ?? real(resolve(root));
  const into = out === undefined || real(resolve(out)) === top;
  if (into && real(resolve(root)) !== top) {
    throw new SplitRefusal(`writing into the repo runs from its toplevel, ${top}, not from ${real(resolve(root))}: cd there and run this again`);
  }
  return into;
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
 * the monolith before splitting, and the refusal names the order that keeps those changes.
 */
export function checkMerge(root, incoming, planSplit) {
  const git = gitIn(root);
  const at = incoming.slice(0, 12);
  let base, diff;
  try {
    base = git('merge-base', 'HEAD', incoming).trim();
    const names = git('ls-tree', '--name-only', incoming, 'docs/stories/').split('\n').filter((p) => p.endsWith('.md'));
    const have = { index: git('show', `${incoming}:${INDEX}`), parts: new Map(names.map((p) => [p.slice('docs/stories/'.length), git('show', `${incoming}:${p}`)])) };
    diff = firstDiff(have, planSplit(git('show', `${base}:${INDEX}`)));
  } catch (e) {
    diff = e instanceof SplitRefusal ? e.message : gitError(e);
  }
  if (diff === undefined) return;
  let parent;
  try {
    parent = git('rev-parse', '-q', '--verify', `${incoming}^1`).trim();
    if (parent === base || git('ls-tree', '--name-only', parent, 'docs/stories/').trim()) parent = undefined;
  } catch {
    parent = undefined; // no first parent: the general advice stands
  }
  const how = parent
    ? `The split commit's parent is not the merge base, so main changed the monolith before splitting: abort this merge, merge ${parent.slice(0, 12)} (the commit before the split) first, commit, then merge ${at}, then run this again.`
    : 'Abort the merge and merge exactly the split commit, nothing after it, then run this again.';
  throw new SplitRefusal(`a merge is in progress, and its incoming side (MERGE_HEAD ${at}) is not exactly the split of the monolith at the merge base${base ? ` ${base.slice(0, 12)}` : ''}: ${diff}. ${how}`);
}

/** Throws SplitRefusal when docs/stories/ under `root` exists and the index or a part there differs from `plan`. */
export function checkExisting(root, plan) {
  if (!existsSync(join(root, 'docs/stories'))) return;
  const diff = firstDiff(readTree(root), plan);
  if (diff !== undefined) throw new SplitRefusal(`docs/stories/ already holds parts that differ from the split: ${diff}. Pass --replace to overwrite them.`);
}
