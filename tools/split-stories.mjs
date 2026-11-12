#!/usr/bin/env node
/**
 * Splits the user stories into an index and one file per story: the exact inverse of tools/stories.mjs (US-64 AC33).
 *
 * In:  the monolith docs/user-stories.md, in the working tree or at a git ref. A file that is already an index
 *      is refused; splitting loadStories of its output gives every file back byte for byte.
 * Out: docs/user-stories.md, the index: every line of the text outside the constitution and the stories, kept as is
 *      (H1 and intro, the epic headings and their intros, the blank and `---` lines between stories, Coverage), and
 *      in place of each part one line: `- [The product constitution](stories/_constitution.md)` or
 *      `- [US-NN · <short title>](stories/US-NN.md)`, the short title being the heading's title before " — ".
 *      docs/stories/_constitution.md and docs/stories/US-NN.md: each part runs from its heading (`## The product
 *      constitution…` or `### US-NN · …`) to its last non-blank line before the next `#`, `##` or `###` heading or
 *      `---` line, through toPart (every relative link target gains `../`), ending in one "\n".
 *
 * It refuses, writing nothing (exit 1), when a story id repeats, a short title would not make an index line
 * (empty, or holding `[` or `]`), a `### US-` heading lacks its ` · `, the input already holds index lines, or
 * loadStories of the would-be output is not the input byte for byte (checked in a temporary folder first).
 * Writing into the repo itself (no --out), it also refuses rather than overwrite parts written after the split:
 * - during a merge (MERGE_HEAD exists), unless the incoming side holds exactly the split of the monolith at the merge
 *   base, which is how an open branch takes the split commit and re-splits its own monolith;
 * - otherwise, when docs/stories/ exists and the index or a part differs from the output, unless --replace is given.
 *
 * Usage, from the repo root: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>] [--replace]
 *   --from     read the stories at a git ref instead of the working tree.
 *   --out      write under <dir> (a dry run) instead of the repo root. Stale docs/stories/*.md there are removed.
 *   --replace  outside a merge, overwrite a docs/stories/ that differs from the output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX, STORY_LINE, CONSTITUTION_LINE, loadStories, toPart } from './stories.mjs';

const STORY = /^### (US-\d+) · (.*)$/;
const CONSTITUTION = /^## (The product constitution)\b/;
// What ends a part: the next heading of level 1-3, or a `---` line.
const BOUNDARY = /^(#{1,3} |---\s*$)/;

export class SplitRefusal extends Error {}

/**
 * Pure: the index text and the part files (name -> text) for a stories text.
 * @param {string} text
 * @returns {{ index: string, parts: Map<string, string> }}
 */
export function planSplit(text) {
  const lines = text.split('\n');
  const already = lines.find((l) => STORY_LINE.test(l) || CONSTITUTION_LINE.test(l));
  if (already !== undefined) throw new SplitRefusal(`the input is already split: it holds the index line "${already}"`);
  const index = [];
  const parts = new Map();
  for (let i = 0; i < lines.length; ) {
    const story = STORY.exec(lines[i]);
    if (!story && lines[i].startsWith('### US-')) throw new SplitRefusal(`a story heading is not "### US-NN · <title>": ${lines[i]}`);
    const cons = !story && CONSTITUTION.exec(lines[i]);
    if (!story && !cons) {
      index.push(lines[i++]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !BOUNDARY.test(lines[end])) end++;
    while (end > i + 1 && lines[end - 1] === '') end--;
    const name = story ? `${story[1]}.md` : '_constitution.md';
    if (parts.has(name)) throw new SplitRefusal(`${story ? story[1] : 'the constitution'} appears twice`);
    const label = story ? `${story[1]} · ${story[2].split(' — ')[0]}` : cons[1];
    const line = `- [${label}](stories/${name})`;
    if (/[[\]]/.test(label) || (story && !story[2].split(' — ')[0].trim()) || !(story ? STORY_LINE : CONSTITUTION_LINE).test(line)) {
      throw new SplitRefusal(`the title of ${story ? story[1] : 'the constitution'} would break its index line: ${line}`);
    }
    parts.set(name, `${toPart(lines.slice(i, end).join('\n'))}\n`);
    index.push(line);
    i = end;
  }
  return { index: index.join('\n'), parts };
}

/** Writes a plan under `root`: the index and docs/stories/, removing any other part file there. */
function writePlan(root, { index, parts }) {
  const dir = join(root, 'docs/stories');
  mkdirSync(dir, { recursive: true });
  const stale = readdirSync(dir).filter((f) => f.endsWith('.md') && !parts.has(f));
  for (const f of stale) rmSync(join(dir, f));
  for (const [name, text] of parts) writeFileSync(join(dir, name), text);
  writeFileSync(join(root, INDEX), index);
  return stale;
}

/** Throws SplitRefusal unless loadStories of the plan, written to a temporary folder, is `text` byte for byte. */
export function verifyPlan(text, plan) {
  const tmp = mkdtempSync(join(tmpdir(), 'split-stories-'));
  try {
    writePlan(tmp, plan);
    const back = loadStories(tmp);
    if (back === text) return;
    let k = 0;
    while (k < back.length && back[k] === text[k]) k++;
    const line = text.slice(0, k).split('\n').length;
    throw new SplitRefusal(`the round trip is not exact: the reassembled text first differs at line ${line} (${back.length} vs ${text.length} bytes)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The first file where `have` (an index and parts) differs from `plan`, as "<path> differs", or undefined. */
function firstDiff(have, plan) {
  for (const name of [...new Set([...have.parts.keys(), ...plan.parts.keys()])].sort()) {
    if (!have.parts.has(name)) return `docs/stories/${name} is missing`;
    if (!plan.parts.has(name)) return `docs/stories/${name} is not in the split`;
    if (have.parts.get(name) !== plan.parts.get(name)) return `docs/stories/${name} differs`;
  }
  return have.index === plan.index ? undefined : `${INDEX} differs`;
}

const gitIn = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });

/** The commit a merge in progress under `root` brings in, or undefined when none is (or `root` is no git repo). */
function mergeHead(root) {
  try {
    return gitIn(root)('rev-parse', '-q', '--verify', 'MERGE_HEAD').trim();
  } catch (e) {
    if (e.status === 1 || /not a git repository/.test(String(e.stderr))) return undefined;
    throw e;
  }
}

/** Throws SplitRefusal unless the commit `incoming` holds exactly the split of the monolith at its merge base with HEAD. */
function checkMerge(root, incoming) {
  const git = gitIn(root);
  const at = incoming.slice(0, 12);
  let base, diff;
  try {
    base = git('merge-base', 'HEAD', incoming).trim();
    const names = git('ls-tree', '--name-only', incoming, 'docs/stories/').split('\n').filter((p) => p.endsWith('.md'));
    const have = { index: git('show', `${incoming}:${INDEX}`), parts: new Map(names.map((p) => [p.slice('docs/stories/'.length), git('show', `${incoming}:${p}`)])) };
    diff = firstDiff(have, planSplit(git('show', `${base}:${INDEX}`)));
  } catch (e) {
    diff = e instanceof SplitRefusal ? e.message : String(e.stderr || e.message).trim();
  }
  if (diff !== undefined) {
    throw new SplitRefusal(`a merge is in progress, and its incoming side (MERGE_HEAD ${at}) is not exactly the split of the monolith at the merge base${base ? ` ${base.slice(0, 12)}` : ''}: ${diff}. Abort the merge and merge exactly the split commit, nothing after it, then run this again.`);
  }
}

/** Throws SplitRefusal when docs/stories/ under `root` exists and the index or a part there differs from `plan`. */
function checkExisting(root, plan) {
  const dir = join(root, 'docs/stories');
  if (!existsSync(dir)) return;
  const have = {
    index: existsSync(join(root, INDEX)) ? readFileSync(join(root, INDEX), 'utf8') : undefined,
    parts: new Map(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(dir, f), 'utf8')])),
  };
  const diff = firstDiff(have, plan);
  if (diff !== undefined) throw new SplitRefusal(`docs/stories/ already holds parts that differ from the split: ${diff}. Pass --replace to overwrite them.`);
}

/**
 * Splits the stories under `root` (at `from` when given) into `out`, after proving the round trip.
 * @returns {{ stories: number, parts: number, indexBytes: number, stale: string[] }}
 */
export function splitStories({ root = process.cwd(), from, out = root, replace = false } = {}) {
  let text;
  try {
    text = from === undefined
      ? readFileSync(join(root, INDEX), 'utf8')
      : gitIn(root)('show', `${from}:${INDEX}`);
  } catch (e) {
    throw new SplitRefusal(`cannot read the stories${from === undefined ? '' : ` at ${from}`}: ${String(e.stderr || e.message).trim()}`);
  }
  const plan = planSplit(text);
  verifyPlan(text, plan);
  if (resolve(out) === resolve(root)) {
    const incoming = mergeHead(root);
    if (incoming !== undefined) checkMerge(root, incoming);
    else if (!replace) checkExisting(root, plan);
  }
  const stale = writePlan(out, plan);
  return {
    stories: [...plan.parts.keys()].filter((n) => n.startsWith('US-')).length,
    parts: plan.parts.size,
    indexBytes: Buffer.byteLength(plan.index),
    stale,
  };
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--replace') {
      opts.replace = true;
      i--;
      continue;
    }
    if ((flag !== '--from' && flag !== '--out') || value === undefined || value.startsWith('--')) {
      console.error('usage: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>] [--replace]');
      return 64;
    }
    opts[flag.slice(2)] = flag === '--out' ? resolve(value) : value;
  }
  try {
    const r = splitStories(opts);
    const where = opts.out ?? process.cwd();
    console.log(`split-stories: ${r.stories} stories, ${r.parts} parts, index ${r.indexBytes} bytes, written under ${where}; round trip exact.`);
    if (r.stale.length) console.log(`split-stories: removed stale parts: ${r.stale.join(', ')}`);
    return 0;
  } catch (e) {
    if (!(e instanceof SplitRefusal)) throw e;
    console.error(`split-stories: refused, nothing written: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
