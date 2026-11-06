#!/usr/bin/env node
/**
 * Builds a contributor batch (US-64 AC13, AC15). Run inside a batch worktree:
 *   node tools/merge-batch.mjs <list-file> [--skip <pr>[,<pr>...]]   lines: <pr-number> <full head sha>
 * --skip builds the list without those PRs, so dropping a rejected PR is one rerun on a fresh worktree.
 * After a build, a pre-flight gives the worktree its package clones and scans the batch's added lines for
 * secret-shaped text. Exit 0 done; 1 head moved, bad input or a worktree that is not clean; 2 conflict for a
 * human (a stories conflict that is not only added, non-duplicate `- AC` lines counts); 3 stories proof failed
 * (merge aborted, tree as before); 4 a git command failed; 5 pre-flight found secret-shaped text (the batch
 * commits stay; fix the fixture).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { mainOf, PATTERNS } from './secret-rules.mjs';

const HTML = 'docs/user-stories.html';
const MD = 'docs/user-stories.md';

// A batch's diff can pass the default 1 MB output cap (ENOBUFS, exit 4).
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const gitOk = (...args) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};
const stop = (code, msg) => {
  try {
    writeSync(2, `${msg}\n`); // console.error to a pipe is async on macOS: exit would cut a long report short
  } catch {
    /* stderr is gone; the exit code still says what happened */
  }
  process.exit(code);
};

const acKey = (line) => {
  const m = /^- AC(\d+)([a-z]*)/.exec(line);
  return m ? [Number(m[1]), m[2]] : null;
};
const byAc = (a, b) => {
  const [an, al] = acKey(a);
  const [bn, bl] = acKey(b);
  return an - bn || (al < bl ? -1 : al > bl ? 1 : 0);
};

const acId = (line) => acKey(line).join('');

/** Keep both sides of every conflict block when each is only added `- AC` lines; { fail } otherwise. */
function resolveStories(text) {
  const lines = text.split('\n');
  const out = [];
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<< ')) {
      out.push(lines[i]);
      continue;
    }
    const sides = [[], []];
    let side = 0;
    let base = false;
    for (i++; i < lines.length && !lines[i].startsWith('>>>>>>> '); i++) {
      if (lines[i].startsWith('||||||| ')) base = true;
      else if (lines[i] === '=======') {
        side = 1;
        base = false;
      } else if (!base) sides[side].push(lines[i]);
    }
    const all = [...sides[0], ...sides[1]];
    if (i >= lines.length || all.length === 0 || !all.every((l) => acKey(l))) return { fail: 'is not only added "- AC" lines' };
    const seen = new Set();
    const kept = all.filter((l) => !seen.has(l) && seen.add(l)).sort(byAc);
    blocks.push({ start: out.length, end: out.length + kept.length });
    out.push(...kept);
  }
  // Two PRs that each took the next free number must not both land under one story.
  for (const { start, end } of blocks) {
    let from = start;
    while (from > 0 && !out[from - 1].startsWith('### ')) from--;
    let to = end;
    while (to < out.length && !out[to].startsWith('### ')) to++;
    const taken = new Set();
    for (let k = from; k < to; k++) if (acKey(out[k]) && !(k >= start && k < end)) taken.add(acId(out[k]));
    for (let k = start; k < end; k++) {
      if (taken.has(acId(out[k]))) return { fail: `repeats AC${acId(out[k])} of the same story` };
      taken.add(acId(out[k]));
    }
  }
  return { text: out.join('\n') };
}

const plusMinus = (diff) =>
  diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .sort()
    .join('\n');

// Approximates gitleaks' generic-api-key rule (CI's secret scan): a keyword, an operator, then a 10+ character
// value whose Shannon entropy is 3.5 or more. Skipped like gitleaks skips them: a value of only letters, `_`, `.`
// and `-` (its own allowlist), and one holding a word (5+ letters of one case), standing in for its ~1,500 stop
// words. CI's gitleaks stays the real gate.
const GENERIC =
  /(?:access|auth|api|credential|creds|key|passw(?:or)?d|secret|token)[ \t\w.-]{0,20}[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[`'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?=[`'"\s;]|\\[nr]|$)/gi;
const entropy = (s) => {
  const n = {};
  for (const c of s) n[c] = (n[c] || 0) + 1;
  return Object.values(n).reduce((e, k) => e - (k / s.length) * Math.log2(k / s.length), 0);
};
const generic = (v) => !/^[a-zA-Z_.-]+$|[a-z]{5}|[A-Z]{5}/.test(v) && entropy(v) >= 3.5;
const SHAPES = Object.entries(PATTERNS).map(([rule, re]) => [rule, new RegExp(re, 'g')]);

/**
 * file:line and rule of every added line shaped like a secret; never the value. The credential shapes are matched
 * across each run of added lines (a private key spans lines); the generic rule line by line, as gitleaks does.
 */
function secretShapes(diff) {
  const hits = new Set();
  let file = '';
  let line = 0;
  let header = false;
  let block = [];
  const flush = () => {
    const first = line - block.length;
    const starts = [];
    let at = 0;
    for (const t of block) {
      starts.push(at);
      at += t.length + 1;
    }
    const text = block.join('\n');
    for (const [rule, re] of SHAPES) {
      let k = 0; // matches come in offset order, so one forward pass maps them all to lines
      for (const m of text.matchAll(re)) {
        while (k + 1 < starts.length && starts[k + 1] <= m.index) k++;
        hits.add(`${file}:${first + k} ${rule}`);
      }
    }
    block.forEach((t, k) => {
      if ([...t.matchAll(GENERIC)].some((m) => generic(m[1]))) hits.add(`${file}:${first + k} generic-api-key`);
    });
    block = [];
  };
  for (const l of diff.split('\n')) {
    if (!header && l.startsWith('+')) {
      block.push(l.slice(1));
      line++;
      continue;
    }
    flush();
    if (l.startsWith('diff --git ')) header = true;
    else if (header && l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '');
    else if (l.startsWith('@@')) {
      header = false;
      line = Number(/\+(\d+)/.exec(l)[1]);
    }
  }
  flush();
  return [...hits];
}

/**
 * Package clones, so reviewers spawned from the main checkout can run tests here: worktree-new.sh makes them, but a
 * worktree made another way, or whose clone failed, has none, so feed the hook its event (linkPackages). Always
 * the MAIN checkout's hook: the batch tree's copy is contributor code until it lands. Its own folder list.
 */
const PACKAGE_DIRS = ['node_modules', 'widget-src/node_modules', 'packages/health-core/node_modules'];
function linkClones() {
  const top = realpathSync(git('rev-parse', '--show-toplevel').trim());
  const main = mainOf(top);
  if (!main || main === top) return; // the main checkout has its own packages
  const hook = join(main, '.claude/hooks/worktree-guard.cjs');
  const missing = () => PACKAGE_DIRS.filter((d) => existsSync(join(main, d)) && !existsSync(join(top, d)));
  if (!existsSync(hook) || !missing().length) return;
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: top });
  try {
    execFileSync('node', [hook], { cwd: main, input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 300000 });
  } catch {
    /* reported below */
  }
  const still = missing();
  if (still.length) console.log(`pre-flight: no ${still.join(', ')}; run: echo '${input}' | node ${hook}`);
}

/** Before reviewers start: the worktree's package clones, then the secret scan. */
function preflight() {
  linkClones();
  const hits = secretShapes(git('diff', '-U0', '--no-color', '--no-ext-diff', 'origin/main...HEAD'));
  if (hits.length) stop(5, `pre-flight found secret-shaped text (the batch commits stay; fix the fixture):\n${hits.join('\n')}`);
  console.log('pre-flight ok: no secret-shaped text');
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--skip');
  const skip = at >= 0 ? args.splice(at, 2)[1] : '';
  if (at >= 0 && !/^\d+(,\d+)*$/.test(skip || '')) stop(1, '--skip wants <pr>[,<pr>...]');
  const listFile = args[0];
  if (!listFile || args.length > 1) stop(1, 'usage: node tools/merge-batch.mjs <list-file> [--skip <pr>[,<pr>...]]');
  const all = readFileSync(listFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+) ([0-9a-f]{40})$/.exec(l);
      if (!m) stop(1, `bad line "${l}": want "<pr-number> <full head sha>"`);
      return { pr: m[1], sha: m[2] };
    });
  const skipped = skip ? skip.split(',') : [];
  const unknown = skipped.filter((p) => !all.some((e) => e.pr === p));
  if (unknown.length) stop(1, `--skip: PR #${unknown.join(', #')} is not in ${listFile}`);
  const entries = all.filter((e) => !skipped.includes(e.pr));
  if (!entries.length) stop(1, `--skip leaves nothing to build from ${listFile}`);

  if (gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD')) stop(1, 'a merge is in progress; finish or abort it first');
  if (git('status', '--porcelain').trim()) stop(1, 'the worktree is not clean; commit or stash first');

  // A skipped PR must stay out: no kept head may share a commit main lacks with its reviewed or current head, so
  // a kept PR built on any of its commits, the middle ones included, is refused. All checked before anything merges.
  const out = [];
  for (const e of all.filter((x) => skipped.includes(x.pr))) {
    git('fetch', 'origin', `pull/${e.pr}/head`);
    const now = git('rev-parse', 'FETCH_HEAD').trim(); // before a fetch by sha moves FETCH_HEAD
    // A head force-pushed away since the review may not be here: fetch it by sha, or stop unable to check.
    const have = () => gitOk('cat-file', '-e', `${e.sha}^{commit}`);
    if (!have() && !(gitOk('fetch', 'origin', e.sha) && have())) {
      stop(4, `skipped PR #${e.pr}: reviewed head ${e.sha.slice(0, 8)} cannot be fetched, so its commits cannot be checked`);
    }
    for (const s of new Set([e.sha, now])) out.push({ pr: e.pr, sha: s });
  }
  // Exit 1 with no output is "no common ancestor"; any other failure means the ancestry is unknown.
  const bases = (a, b, what) => {
    try {
      return git('merge-base', '--all', a, b).split('\n').filter(Boolean);
    } catch (err) {
      if (err.status === 1 && !`${err.stdout}${err.stderr}`.trim()) return [];
      stop(4, `${what} cannot be checked: ${String(err.stderr || err.message).trim()}`);
    }
  };
  for (const { pr, sha } of entries) {
    git('fetch', 'origin', `pull/${pr}/head`);
    const head = git('rev-parse', 'FETCH_HEAD').trim();
    if (head !== sha) stop(1, `PR #${pr}: head moved (now ${head.slice(0, 8)}, reviewed ${sha.slice(0, 8)}): needs a new review`);
    for (const s of out) {
      const shared = bases(s.sha, sha, `PR #${pr}: its ancestry against skipped PR #${s.pr}`).find((b) => !gitOk('merge-base', '--is-ancestor', b, 'origin/main'));
      if (shared) stop(1, `PR #${pr} shares commit ${shared.slice(0, 8)} with skipped PR #${s.pr}, not on main; skip both or neither`);
    }
  }

  for (const { pr, sha } of entries) {
    const msg = `Merge PR #${pr} (${sha.slice(0, 8)}) into the batch`;
    const note = [];

    let mergeErr = null;
    try {
      // The merge runs `git stash create`, which reads the index unrefreshed. In a new worktree macOS is still
      // tagging files (com.apple.provenance), which bumps only their ctime, so that check saw changes its own
      // refresh then did not, and it failed: "fatal: stash failed" (US-64 AC20). Edits always move mtime.
      git('-c', 'core.trustctime=false', 'merge', '--no-ff', '--no-edit', '-m', msg, sha);
    } catch (err) {
      mergeErr = String(err.stderr || err.message).trim();
    }
    if (mergeErr !== null) {
      const unmerged = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      if (unmerged.length === 0) stop(2, `PR #${pr}: merge failed with no conflicted file; resolve by hand. git said: ${mergeErr || '(nothing)'}`);
      const other = unmerged.find((f) => f !== HTML && f !== MD);
      if (other) stop(2, `PR #${pr}: conflict in ${other}; resolve by hand`);
      if (unmerged.includes(HTML)) {
        git('rm', '-q', '-f', '--', HTML);
        note.push('dropped user-stories.html');
      }
      if (unmerged.includes(MD)) {
        const fixed = resolveStories(readFileSync(MD, 'utf8'));
        if (fixed.fail) stop(2, `PR #${pr}: conflict in ${MD} ${fixed.fail}; resolve by hand`);
        writeFileSync(MD, fixed.text);
        git('add', '--', MD);
        // Prove before committing: on a mismatch the merge is aborted and the tree is as it was.
        const merged = plusMinus(git('diff', '--cached', 'HEAD', '--', MD));
        const own = plusMinus(git('diff', `origin/main...${sha}`, '--', MD));
        if (merged !== own) {
          git('merge', '--abort');
          stop(3, `PR #${pr}: merge would change ${MD} by more than the PR's own lines; merge aborted`);
        }
        git('commit', '-q', '-m', msg);
        note.push('stories ACs merged, proof ok');
      } else {
        git('commit', '-q', '-m', msg);
      }
    }
    if (git('ls-files', HTML).trim()) {
      git('rm', '-q', '--', HTML);
      git('commit', '-q', '-m', `Drop ${HTML} (untracked since US-64 AC11)`);
      note.push('dropped user-stories.html');
    }
    console.log(`PR #${pr} ${sha.slice(0, 8)} merged${note.length ? ` (${[...new Set(note)].join('; ')})` : ''}`);
  }
  console.log(`HEAD ${git('rev-parse', 'HEAD').trim()}`);
  preflight();
}

try {
  main();
} catch (e) {
  stop(4, `git failed: ${String(e.stderr || e.message).trim()}`);
}
