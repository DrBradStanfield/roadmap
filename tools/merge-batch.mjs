#!/usr/bin/env node
/**
 * Builds a contributor batch (US-64 AC13). Run inside a batch worktree:
 *   node tools/merge-batch.mjs <list-file>      lines: <pr-number> <full head sha>
 * Exit 0 done, 1 head moved or bad input, 2 conflict for a human, 3 stories proof failed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const HTML = 'docs/user-stories.html';
const MD = 'docs/user-stories.md';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOk = (...args) => {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
};
const stop = (code, msg) => {
  console.error(msg);
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

/** Keep both sides of every conflict block when each is only added `- AC` lines; null otherwise. */
function resolveStories(text) {
  const lines = text.split('\n');
  const out = [];
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
    if (i >= lines.length) return null;
    const all = [...sides[0], ...sides[1]];
    if (all.length === 0 || !all.every((l) => acKey(l))) return null;
    const seen = new Set();
    out.push(...all.filter((l) => !seen.has(l) && seen.add(l)).sort(byAc));
  }
  return out.join('\n');
}

const plusMinus = (diff) =>
  diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .sort()
    .join('\n');

function main() {
  const listFile = process.argv[2];
  if (!listFile) stop(1, 'usage: node tools/merge-batch.mjs <list-file>');
  const entries = readFileSync(listFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+) ([0-9a-f]{40})$/.exec(l);
      if (!m) stop(1, `bad line "${l}": want "<pr-number> <full head sha>"`);
      return { pr: m[1], sha: m[2] };
    });

  for (const { pr, sha } of entries) {
    git('fetch', 'origin', `pull/${pr}/head`);
    const head = git('rev-parse', 'FETCH_HEAD').trim();
    if (head !== sha) stop(1, `PR #${pr}: head moved (now ${head.slice(0, 8)}, reviewed ${sha.slice(0, 8)}): needs a new review`);
    const msg = `Merge PR #${pr} (${sha.slice(0, 8)}) into the batch`;
    const note = [];

    if (!gitOk('merge', '--no-ff', '--no-edit', '-m', msg, sha)) {
      const unmerged = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      if (unmerged.length === 0) stop(2, `PR #${pr}: merge failed with no conflicted file; resolve by hand`);
      const other = unmerged.find((f) => f !== HTML && f !== MD);
      if (other) stop(2, `PR #${pr}: conflict in ${other}; resolve by hand`);
      if (unmerged.includes(HTML)) {
        git('rm', '-q', '-f', '--', HTML);
        note.push('dropped user-stories.html');
      }
      if (unmerged.includes(MD)) {
        const fixed = resolveStories(readFileSync(MD, 'utf8'));
        if (fixed === null) stop(2, `PR #${pr}: conflict in ${MD} is not only added "- AC" lines; resolve by hand`);
        writeFileSync(MD, fixed);
        git('add', '--', MD);
        git('commit', '-q', '-m', msg);
        const merged = plusMinus(git('diff', 'HEAD^1', 'HEAD', '--', MD));
        const own = plusMinus(git('diff', `origin/main...${sha}`, '--', MD));
        if (merged !== own) stop(3, `PR #${pr}: merge changed ${MD} by more than the PR's own lines; stopped`);
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
}

main();
