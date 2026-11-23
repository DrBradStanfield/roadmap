#!/usr/bin/env node
/**
 * Loop push (US-64 AC39): `node tools/loop-push.mjs`, no arguments, lands a cloud loop's own files on main.
 * It checks HEAD's commit and pushes that one sha to origin's main, all in this one process.
 *
 * Why: scheduled cloud loop sessions run in auto mode, where the classifier refused `git push origin main`,
 * and the reports were stranded. An allow rule for the raw push with a path check in a hook was refuted:
 * a separate or later command can move main or bend what the hook reads (update-ref, a refs/main clash,
 * git replace, diff.ignoreSubmodules hiding a gitlink, glob refspecs, pre-push hooks, compound commands).
 * So this script is the only allow-listed push (`.claude/settings.json`), and it reads nothing it does not
 * pin itself: no shell, no hooks, no GIT_* variables, no replace objects, main fetched into its own ref,
 * HEAD resolved to a sha once, and the push leased to the main it checked (docs/gotchas.md, 2026-11-23).
 *
 * Scope: `docs/loops/**` except docs/loops/LOOP.md, REGISTRY.md, _TEMPLATE.md and docs/loops/<dir>/LOOP.md
 * (Brad's), plus exactly docs/user-stories.md. Never a gitlink or a symlink. Checked on the net change and on
 * every non-merge commit since main, so a file added then removed is still refused. Anything else goes by a
 * `claude/` branch and PR (docs/loops/LOOP.md § Repo rules).
 *
 * Residuals, left to the classifier and review: a credential helper or other git config that runs a program
 * (credential.helper, core.askPass, protocol.ext.allow), set by an earlier command; a merge commit that adds
 * and a later merge that removes content (only non-merge commits are walked); and an agent editing this file.
 */
import { execFileSync } from 'node:child_process';

const NO_REPLACE_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
const BRAD_ONLY = ['docs/loops/loop.md', 'docs/loops/registry.md', 'docs/loops/_template.md'];
const MOVED = 'main has moved: run `git fetch origin main` and `git merge --no-edit origin/main` (separately), then run node tools/loop-push.mjs again.';

function refuse(line) {
  console.error(`loop-push: refused: ${line}`);
  process.exit(1);
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, ...NO_REPLACE_ENV };
}

const ENV = cleanEnv();
let root = null;

/** Runs git with no shell, no hooks and no GIT_* from the caller. Returns stdout, or throws with .status. */
function git(args) {
  const pre = root ? ['-C', root] : [];
  return execFileSync('git', [...pre, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

/** git, or null when it exits 1 (an unset config key, "not an ancestor"). Any other failure refuses. */
function gitOrNull(args) {
  try { return git(args); } catch (e) {
    if (e.status === 1) return null;
    refuse(`git ${args[0]} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

function lines(out) {
  return out.split('\n').filter((l) => l !== '');
}

/** Paths whose new mode is a gitlink or symlink, or that sit outside the loops' scope. */
function scopeProblems(entries) {
  const bad = [];
  for (const { mode, path } of entries) {
    if (mode === '160000') bad.push(`${path} (a gitlink)`);
    else if (mode === '120000') bad.push(`${path} (a symlink)`);
    else if (isBrads(path)) bad.push(`${path} (Brad's file: only Brad edits it)`);
    else if (!inScope(path)) bad.push(path);
  }
  return bad;
}

function isBrads(path) {
  const p = path.toLowerCase();
  return BRAD_ONLY.includes(p) || /^docs\/loops\/[^/]+\/loop\.md$/.test(p);
}

function inScope(path) {
  return path === 'docs/user-stories.md' || (path.startsWith('docs/loops/') && path.length > 'docs/loops/'.length);
}

/** Parses `diff-tree -r -z --raw --no-renames` output: ":old new oldsha newsha S\0path\0" per entry. */
function parseRaw(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\n/, '');
    if (!meta.startsWith(':')) refuse(`unexpected diff-tree output: ${JSON.stringify(meta.slice(0, 40))}`);
    entries.push({ mode: meta.slice(1).split(' ')[1], path: parts[i + 1] });
  }
  return entries;
}

const DIFF = ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--ignore-submodules=none', '--no-commit-id'];

function main() {
  if (process.argv.length > 2) refuse('takes no arguments: run `node tools/loop-push.mjs` alone.');

  // a. the repo of the working folder, never one named by GIT_DIR.
  try { root = git(['rev-parse', '--show-toplevel']).trim(); } catch { refuse('not inside a git work tree.'); }
  if (!root) refuse('not inside a git work tree.');

  // b. origin: one URL, the same for fetch and push, no custom transport programs.
  const fetchUrls = lines(gitOrNull(['remote', 'get-url', '--all', 'origin']) ?? '');
  const pushUrls = lines(gitOrNull(['remote', 'get-url', '--push', '--all', 'origin']) ?? '');
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) refuse('origin must have exactly one fetch URL and one push URL.');
  if (fetchUrls[0] !== pushUrls[0]) refuse("origin's push URL differs from its fetch URL.");
  for (const key of ['remote.origin.receivepack', 'remote.origin.uploadpack', 'core.sshCommand']) {
    if (gitOrNull(['config', '--get-all', key]) !== null) refuse(`${key} is set; unset it first.`);
  }

  // c. the one sha this run checks and pushes.
  const sha = (gitOrNull(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']) ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) refuse('HEAD is not a commit.');

  // d. origin's main, into a ref only this script writes.
  try {
    git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/loop-push/main']);
  } catch (e) {
    refuse(`fetch of origin main failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
  const R = (gitOrNull(['rev-parse', '--verify', '--end-of-options', 'refs/loop-push/main^{commit}']) ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(R)) refuse("could not read origin's main.");

  // e. nothing new, or a fast-forward of main.
  if (sha === R) {
    console.log('loop-push: nothing to push');
    return;
  }
  if (gitOrNull(['merge-base', '--is-ancestor', R, sha]) === null) refuse(MOVED);

  // f. scope: the net change, then every non-merge commit since main against its parent.
  const net = parseRaw(git([...DIFF, R, sha]));
  const bad = new Set(scopeProblems(net));
  for (const c of lines(git(['rev-list', '--no-merges', `${R}..${sha}`]))) {
    for (const p of scopeProblems(parseRaw(git([...DIFF, '--root', c])))) bad.add(p);
  }
  if (bad.size) {
    const list = [...bad];
    refuse(`outside a loop's scope: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. `
      + 'Loops push only docs/loops/ (not LOOP.md, REGISTRY.md, _TEMPLATE.md or a loop\'s LOOP.md) and docs/user-stories.md; '
      + 'land the rest by a claude/ branch and PR.');
  }

  // g. push that sha, leased to the main checked above, so it is a fast-forward or nothing.
  try {
    git(['push', '--no-verify', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=refs/heads/main:${R}`, 'origin', `${sha}:refs/heads/main`]);
  } catch (e) {
    console.error(String(e.stderr || e.message).trim());
    refuse(`push failed. ${MOVED}`);
  }

  // h.
  console.log(`loop-push: pushed ${sha} to main (${net.length} paths)`);
}

main();
