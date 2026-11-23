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
 * pin itself (docs/gotchas.md, 2026-11-23):
 * - /usr/bin/git by absolute path, no shell, hooks off, ext transport off, no fsmonitor, no askpass; every
 *   GIT_* variable removed, replace objects and grafts ignored; a grafts file or alternates refuse.
 * - git config read whole: any key off CONFIG_ALLOWED refuses (credential.*, url.*, include*, remote.*.vcs, ...).
 * - origin: one URL, https or ssh (no pushurl); origin's main fetched into its own ref; HEAD resolved to a sha once.
 * - this file must be `<toplevel>/tools/loop-push.mjs` and byte-equal to main's copy. That catches a copy run
 *   from another folder and an accidental edit; an edit that deletes this check runs its own code (residual).
 * - the push is plain, never forced: git and the server allow only a fast-forward of main.
 *
 * Scope: `docs/loops/**` except Brad's files (docs/loops/REGISTRY.md, _TEMPLATE.md, any LOOP.md and any
 * lint-allowlist.json at any depth, case ignored), plus exactly docs/user-stories.md. Never a gitlink or a
 * symlink. Checked on the net change, on every non-merge commit since main against its parent, and on every
 * merge by its combined diff (what the merge itself made, never what it brought from main). Anything else goes
 * by a `claude/` branch and PR (docs/loops/LOOP.md § Repo rules).
 *
 * TEST-ONLY: LOOP_PUSH_TEST_ALLOW_LOCAL=1, outside a cloud session (CLAUDE_CODE_REMOTE != true), lets origin be a
 * plain local path, for tools/loop-push.test.ts's bare remotes. It reaches only a repo on this disk, never
 * origin's main, and in Claude Code an earlier command cannot set the environment of a later Bash call.
 *
 * Unproven until the first real cloud run: the push's authentication. The stripped env drops the cloud's
 * GIT_ASKPASS, GIT_SSL_CAINFO and command-scope config (credential.interactive, url insteadOf to https). A refusal
 * or auth failure there strands the report, as before, and never harms main.
 *
 * Residuals, left to the classifier and review: `node` itself is found through PATH (a planted node runs before
 * this code); a system credential.helper=osxkeychain is accepted (Apple git ships it); an agent editing this file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT = '/usr/bin/git';
const PINNED = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'core.fsmonitor=false', '-c', 'core.askPass='];
const PINNED_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const MOVED = 'main has moved: run `git fetch origin main` and `git merge --no-edit origin/main` (separately), then run node tools/loop-push.mjs again.';

/** Every config key git may hold, by scope (lowercase; `*` is one subsection). What a cloud container carries. */
const CONFIG_ALLOWED = {
  system: ['filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'filter.lfs.required', 'credential.helper=osxkeychain'],
  global: ['user.name', 'user.email', 'user.signingkey', 'gpg.format', 'gpg.ssh.program', 'commit.gpgsign',
    'http.proxyauthmethod', 'core.checkstat', 'core.trustctime', 'push.negotiate', 'safe.directory'],
  local: ['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase',
    'core.precomposeunicode', 'core.symlinks', 'gc.auto', 'remote.origin.url', 'remote.origin.fetch',
    'branch.*.remote', 'branch.*.merge', 'user.name', 'user.email'],
  command: PINNED.filter((a) => a !== '-c').map((a) => a.slice(0, a.indexOf('=')).toLowerCase()),
};

function refuse(line) {
  console.error(`loop-push: refused: ${line}`);
  process.exit(1);
}

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), ...PINNED_ENV };
let root = null;

/** Runs /usr/bin/git with no shell, the pins and no GIT_* from the caller. Returns stdout, or throws with .status. */
function git(args, encoding = 'utf8') {
  const pre = root ? ['-C', root] : [];
  return execFileSync(GIT, [...pre, ...PINNED, ...args], {
    env: ENV, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
}

const firstLine = (e) => String(e.stderr || e.message).trim().split('\n')[0];

/** git, or null when it exits 1 (an unset key, "not an ancestor"). Any other failure refuses. */
function gitOrNull(args) {
  try { return git(args); } catch (e) {
    if (e.status === 1) return null;
    refuse(`git ${args[0]} failed: ${firstLine(e)}`);
  }
}

const lines = (out) => out.split('\n').filter((l) => l !== '');

/** Config keys (from `config --list --show-scope -z`) that are off CONFIG_ALLOWED, as "scope key". */
function configProblems(out) {
  const parts = out.split('\0');
  const bad = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    const nl = parts[i + 1].indexOf('\n');
    const key = (nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl)).toLowerCase();
    const value = nl < 0 ? '' : parts[i + 1].slice(nl + 1);
    const ok = (CONFIG_ALLOWED[scope] ?? []).some((rule) => {
      const [name, want] = rule.split('=');
      const rx = new RegExp(`^${name.replace(/[.]/g, '\\.').replace('*', '.+')}$`);
      return rx.test(key) && (want === undefined || value === want);
    });
    if (!ok) bad.push(`${scope} ${key}`);
  }
  return bad;
}

/** Paths whose new mode is a gitlink or symlink, Brad's files, or paths outside the loops' scope. */
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
  return p === 'docs/loops/registry.md' || p === 'docs/loops/_template.md'
    || /^docs\/loops\/(.+\/)?(loop\.md|lint-allowlist\.json)$/.test(p);
}

function inScope(path) {
  return path === 'docs/user-stories.md' || (path.startsWith('docs/loops/') && path.length > 'docs/loops/'.length);
}

/**
 * Parses `diff-tree -r -z --raw` output, ":old new oldsha newsha S\0path\0" per entry, or for a merge's combined
 * diff (-c) "::m1 m2 new s1 s2 snew MM\0path\0": with n leading colons (n parents), the new mode is field n.
 */
function parseRaw(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\n/, '');
    const n = meta.match(/^:+/)?.[0].length ?? 0;
    if (!n) refuse(`unexpected diff-tree output: ${JSON.stringify(meta.slice(0, 40))}`);
    entries.push({ mode: meta.slice(n).split(' ')[n], path: parts[i + 1] });
  }
  return entries;
}

/** https, ssh or scp-style ssh; a bare local path only for the tests (see the header). */
function allowedUrl(url) {
  if (/^https:\/\/[^\s]+$/.test(url) || /^ssh:\/\/[^\s]+$/.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^:\s][^\s]*$/.test(url)) return true;
  return process.env.LOOP_PUSH_TEST_ALLOW_LOCAL === '1' && process.env.CLAUDE_CODE_REMOTE !== 'true' && /^\/[^:\s]*$/.test(url);
}

/** A path under the repo's common git folder exists. (Not `--git-path`: it reports GIT_GRAFT_FILE's /dev/null.) */
function gitPathExists(p) {
  const common = git(['rev-parse', '--git-common-dir']).trim();
  return existsSync(join(isAbsolute(common) ? common : resolve(root, common), p));
}

const DIFF = ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--ignore-submodules=none', '--no-commit-id'];

function main() {
  if (process.argv.length > 2) refuse('takes no arguments: run `node tools/loop-push.mjs` alone.');
  if (!existsSync(GIT)) refuse(`${GIT} is missing.`);

  // a. the repo of the working folder, never one named by GIT_DIR.
  try { root = git(['rev-parse', '--show-toplevel']).trim(); } catch { refuse('not inside a git work tree.'); }
  if (!root) refuse('not inside a git work tree.');

  // a2. no config git could run or redirect through, no grafts, no borrowed objects.
  const badConfig = configProblems(git(['config', '--list', '--show-scope', '-z']));
  if (badConfig.length) refuse(`git config this script does not allow: ${badConfig.slice(0, 5).join(', ')}; unset it first.`);
  if (gitPathExists('info/grafts')) refuse('a grafts file (.git/info/grafts) exists; remove it first.');
  if (process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES !== undefined || gitPathExists('objects/info/alternates')) {
    refuse('alternate object stores are set (objects/info/alternates); remove them first.');
  }

  // b. origin: one URL, https or ssh. (A pushurl or url.*.insteadOf is refused above, so push uses this one.)
  const urls = lines(gitOrNull(['remote', 'get-url', '--all', 'origin']) ?? '');
  if (urls.length !== 1) refuse('origin must have exactly one URL.');
  if (!allowedUrl(urls[0])) refuse('origin must be an https:// or ssh URL.');

  // c. the one sha this run checks and pushes.
  const sha = (gitOrNull(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']) ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) refuse('HEAD is not a commit.');

  // d. origin's main, into a ref only this script writes.
  try {
    git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/loop-push/main']);
  } catch (e) {
    refuse(`fetch of origin main failed: ${firstLine(e)}`);
  }
  const R = (gitOrNull(['rev-parse', '--verify', '--end-of-options', 'refs/loop-push/main^{commit}']) ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(R)) refuse("could not read origin's main.");

  // d2. this file is the toplevel's tools/loop-push.mjs, byte for byte main's copy.
  const self = realpathSync(fileURLToPath(import.meta.url));
  const expected = join(realpathSync(root), 'tools', 'loop-push.mjs');
  if (realpathSync(process.argv[1]) !== expected || self !== expected) {
    refuse(`run it from the repo's top folder as node tools/loop-push.mjs (this copy is ${self}).`);
  }
  let mainCopy = null;
  try { mainCopy = git(['cat-file', 'blob', `${R}:tools/loop-push.mjs`], 'buffer'); } catch { /* main has no copy */ }
  if (!mainCopy || !readFileSync(self).equals(mainCopy)) refuse(`this copy differs from main's. ${MOVED}`);

  // e. nothing new, or a fast-forward of main.
  if (sha === R) {
    console.log('loop-push: nothing to push');
    return;
  }
  if (gitOrNull(['merge-base', '--is-ancestor', sha, R]) !== null) {
    console.log('loop-push: nothing to push (HEAD is behind main)');
    return;
  }
  if (gitOrNull(['merge-base', '--is-ancestor', R, sha]) === null) refuse(MOVED);

  // f. scope: the net change, every non-merge commit since main against its parent, every merge by its combined diff.
  const net = parseRaw(git([...DIFF, R, sha]));
  const bad = new Set(scopeProblems(net));
  for (const c of lines(git(['rev-list', '--no-merges', `${R}..${sha}`]))) {
    for (const p of scopeProblems(parseRaw(git([...DIFF, '--root', c])))) bad.add(p);
  }
  for (const m of lines(git(['rev-list', '--merges', `${R}..${sha}`]))) {
    for (const p of scopeProblems(parseRaw(git([...DIFF, '-c', m])))) bad.add(p);
  }
  if (bad.size) {
    const list = [...bad];
    refuse(`outside a loop's scope: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. `
      + 'Loops push only docs/loops/ (not REGISTRY.md, _TEMPLATE.md, any LOOP.md or lint-allowlist.json) and docs/user-stories.md; '
      + 'land the rest by a claude/ branch and PR.');
  }

  // g. push that sha, never forced: only a fast-forward of main is accepted.
  try {
    git(['push', '--no-verify', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${sha}:refs/heads/main`]);
  } catch (e) {
    console.error(String(e.stderr || e.message).trim());
    refuse(`push failed. ${MOVED}`);
  }

  // h.
  console.log(`loop-push: pushed ${sha} to main (${net.length} paths)`);
}

main();
