#!/usr/bin/env node
/**
 * `node tools/next-ac.mjs <US-id>` prints the next free AC id for that story (US-64 AC40).
 *
 * Workers that run at once each picked "the next free id" from their own base, so four PRs took the same id on
 * 2026-11-25 and each clash cost a rebase and a CI run. This reads the story on origin/main AND on every open
 * PR's head (one `git fetch` of main and each PR's `pull/<n>/head`, so a fork's PR counts too), so an id another
 * open PR already took is not offered again. A head it cannot read is skipped and named on stderr.
 *
 * An AC id counts where it leads a list item (`- AC12 ...`, `  - **AC12a** ...`); a mention inside prose does
 * not. The next id is one above the highest number any version holds, whatever its letter suffix.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStories } from './stories.mjs';

const STORY_HEAD = /^### (US-\d+)\b/;
// A heading of either level ends the story above it.
const ANY_HEAD = /^#{1,3} /;
const LEADING_AC = /^\s*[-*]\s+(?:\*\*)?(AC\d+[a-z]?)(?![\w])/;
// A definition: the id, then punctuation or a status word (`AC9 RETIRED`), not an amendment (`AC39 amended`,
// `AC41 tests:`), which repeats an id on purpose.
const DEFINES_AC = /^\s*[-*]\s+(?:\*\*)?(AC\d+[a-z]?)(?:\*\*)?(?=\s*(?:$|[:(—–.,;]|[A-Z]{3,}\b))/;

/**
 * Every list item's leading AC id, per story, in file order.
 * @param {string} text
 * @param {RegExp} [pattern] LEADING_AC (any leading id), or DEFINES_AC (definitions only)
 * @returns {Map<string, string[]>}
 */
export function leadingAcIds(text, pattern = LEADING_AC) {
  const out = new Map();
  let story = null;
  for (const line of text.split('\n')) {
    const head = line.match(STORY_HEAD);
    if (head) {
      story = head[1];
      if (!out.has(story)) out.set(story, []);
      continue;
    }
    if (ANY_HEAD.test(line)) { story = null; continue; }
    const ac = story && line.match(pattern);
    if (ac) out.get(story).push(ac[1]);
  }
  return out;
}

/**
 * Each AC id that more than one list item inside one story defines, as "US-15 AC66".
 * @param {string} text
 * @returns {string[]}
 */
export function duplicateAcIds(text) {
  const dups = [];
  for (const [story, ids] of leadingAcIds(text, DEFINES_AC)) {
    const seen = new Set();
    for (const id of ids) {
      const key = `${story} ${id}`;
      if (seen.has(id) && !dups.includes(key)) dups.push(key);
      seen.add(id);
    }
  }
  return dups;
}

/**
 * The next free AC id for `story` across every version of the stories text, or null when no version holds it.
 * @param {string[]} texts
 * @param {string} story
 * @returns {string | null}
 */
export function nextAcId(texts, story) {
  let found = false;
  let max = 0;
  for (const text of texts) {
    const ids = leadingAcIds(text).get(story);
    if (!ids) continue;
    found = true;
    for (const id of ids) max = Math.max(max, Number(id.match(/\d+/)[0]));
  }
  return found ? `AC${max + 1}` : null;
}

/** Where the fetch puts open PR `n`'s head: a private ref, so no remote branch is ever overwritten. */
export const prRef = (n) => `refs/next-ac/pr/${n}`;

/**
 * The real git and gh calls, behind one object the test fakes.
 * @param {string} root
 */
export function liveSource(root) {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  return {
    /** @returns {{ number: number, headRefName: string }[]} */
    openPrs: () => JSON.parse(run('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName'])),
    // One fetch: main, and each PR's head from GitHub's own pull/<n>/head ref, which a fork's PR has too.
    /** @param {number[]} numbers */
    fetch: (numbers) => run('git', ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main',
      ...numbers.map((n) => `+refs/pull/${n}/head:${prRef(n)}`)]),
    /** @param {string} ref */
    storiesAt: (ref) => loadStories(root, { ref }),
  };
}

/**
 * Reads origin/main and each open PR's stories text. A version that cannot be read is skipped and named.
 * @param {ReturnType<typeof liveSource>} source
 * @returns {{ texts: string[], read: string[], skipped: string[] }}
 */
export function collectVersions(source) {
  const prs = source.openPrs().filter((pr) => Number.isSafeInteger(pr.number) && pr.number > 0);
  source.fetch(prs.map((pr) => pr.number));
  const texts = [source.storiesAt('origin/main')];
  const read = ['origin/main'];
  const skipped = [];
  for (const pr of prs) {
    try {
      texts.push(source.storiesAt(prRef(pr.number)));
      read.push(`#${pr.number}`);
    } catch {
      skipped.push(`#${pr.number} (${pr.headRefName})`);
    }
  }
  return { texts, read, skipped };
}

/**
 * @param {string[]} argv
 * @param {ReturnType<typeof liveSource>} source
 * @returns {{ code: number, out: string, err: string }}
 */
export function main(argv, source) {
  const story = argv[0];
  if (argv.length !== 1 || !/^US-\d+$/.test(story)) return { code: 2, out: '', err: 'usage: node tools/next-ac.mjs <US-id>, for example US-64\n' };
  const { texts, read, skipped } = collectVersions(source);
  const next = nextAcId(texts, story);
  const note = `read ${read.length} versions (origin/main and ${read.length - 1} open PRs)${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}\n`;
  if (!next) return { code: 1, out: '', err: `${story} is in no version read; ${note}` };
  return { code: 0, out: `${story} ${next}\n`, err: note };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const r = main(process.argv.slice(2), liveSource(root));
    process.stdout.write(r.out);
    process.stderr.write(r.err);
    process.exit(r.code);
  } catch (e) {
    process.stderr.write(`next-ac: ${String(e instanceof Error ? e.message : e).split('\n')[0]}\n`);
    process.exit(1);
  }
}
