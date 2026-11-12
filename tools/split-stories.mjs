#!/usr/bin/env node
/**
 * Splits the user stories into an index and one file per story: the exact inverse of tools/stories.mjs (US-64 AC33).
 *
 * In:  the monolith docs/user-stories.md, in the working tree or at a git ref. A file that is already an index
 *      is refused: a rerun on its own output changes nothing, and splitting loadStories of its output gives every
 *      file back byte for byte.
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
 *
 * Usage, from the repo root: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>]
 *   --from  read the stories at a git ref instead of the working tree.
 *   --out   write under <dir> (a dry run) instead of the repo root. Stale docs/stories/*.md there are removed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Splits the stories under `root` (at `from` when given) into `out`, after proving the round trip.
 * @returns {{ stories: number, parts: number, indexBytes: number, stale: string[] }}
 */
export function splitStories({ root = process.cwd(), from, out = root } = {}) {
  let text;
  try {
    text = from === undefined
      ? readFileSync(join(root, INDEX), 'utf8')
      : execFileSync('git', ['show', `${from}:${INDEX}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  } catch (e) {
    throw new SplitRefusal(`cannot read the stories${from === undefined ? '' : ` at ${from}`}: ${String(e.stderr || e.message).trim()}`);
  }
  const plan = planSplit(text);
  verifyPlan(text, plan);
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
    if ((flag !== '--from' && flag !== '--out') || value === undefined || value.startsWith('--')) {
      console.error('usage: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>]');
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
