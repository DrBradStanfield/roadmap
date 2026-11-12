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
 * It writes into a repo only with no --out, from the toplevel of the checkout it runs in; an --out inside any git work
 * tree, or one that exists as a symlink, a file or a folder with entries, refuses. With git's GIT_DIR, GIT_WORK_TREE,
 * GIT_COMMON_DIR or GIT_INDEX_FILE set it refuses at once. A write that fails says what it had already changed.
 * Writing into the repo, it refuses rather than overwrite parts written after the split (tools/split-stories-guards.mjs):
 * - during a merge (MERGE_HEAD exists), unless the incoming side holds exactly the split of the monolith at the merge
 *   base, which is how an open branch takes the split commit and re-splits its own monolith;
 * - otherwise, when docs/stories/ exists and the index or a part differs from the output, unless --replace is given.
 * A git that cannot run refuses; only git's own "not a git repository" counts as no repo.
 *
 * --normalize rewrites a split tree, from a git repo's toplevel with no merge in progress and no conflict marker
 * line in the tree (the standing check fails on one too), into the split's exact form, and only its shape: it
 * reassembles the tree, splits it again and writes, refusing when the loader refuses or a part's text would change
 * beyond its trailing blank lines and final newline. It fixes a part with no final newline or with trailing blank
 * lines (they move to the index, so the stories text stays the same) and an index line with a long title. It
 * cannot fix, and refuses, naming the line: a `---` or `#`-`###` heading line inside a part (re-splitting would end
 * the story there), a relative link that would gain a `../` (such as a sibling `./US-02.md`), a part no index line
 * lists (it would be deleted).
 *
 * Usage, from the repo root: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>] [--replace] | --normalize
 *   --from       read the stories at a git ref instead of the working tree.
 *   --out        a dry run into <dir>: a new or empty real folder outside any git work tree, or it refuses.
 *   --replace    outside a merge, overwrite a docs/stories/ that differs from the output.
 *   --normalize  put the repo's split tree into the split's exact form (above); takes no other flag.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX, STORY_LINE, CONSTITUTION_LINE, loadStories, toPart } from './stories.mjs';
import { SplitRefusal, checkExisting, checkGitEnv, checkMerge, checkNormalize, conflictMarker, diffs, gitIn, guardedRoot, mergeHead, readTree } from './split-stories-guards.mjs';

export { SplitRefusal };

const STORY = /^### (US-\d+) · (.*)$/;
const CONSTITUTION = /^## (The product constitution)\b/;
// What ends a part: the next heading of level 1-3, or a `---` line.
const BOUNDARY = /^(#{1,3} |---\s*$)/;
const SHAPE = "one heading, its body to its last non-blank line, one final newline";
const REPAIR = 'run `node tools/split-stories.mjs --normalize`';

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

/**
 * Writes a plan under `root`: the index and docs/stories/, removing any other part file there. Each file goes to
 * `<name>.tmp`, then is renamed into place, so a failed write leaves it as it was. A failure throws
 * SplitRefusal, its `partway` naming what was already created, removed or written.
 */
function writePlan(root, { index, parts }) {
  const dir = join(root, 'docs/stories');
  const removed = [];
  let made, tmp, written = 0;
  try {
    made = mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md') && !parts.has(f))) {
      rmSync(join(dir, f));
      removed.push(f);
    }
    for (const [path, text] of [...[...parts].map(([n, t]) => [join(dir, n), t]), [join(root, INDEX), index]]) {
      tmp = `${path}.tmp`; // a full disk fails the temp file, never the part it replaces
      writeFileSync(tmp, text);
      renameSync(tmp, path);
      tmp = undefined;
      written++;
    }
    return removed;
  } catch (e) {
    try {
      if (tmp !== undefined) rmSync(tmp, { force: true }); // best effort: the refusal below is the error that matters
    } catch {}
    const done = [`${written} file${written === 1 ? '' : 's'} written`, removed.length && `${removed.length} removed`, made && 'docs/stories/ created'];
    throw new SplitRefusal(`cannot write under ${root}: ${e.message}`, written || removed.length || made ? `${done.filter(Boolean).join(', ')} under ${root}` : undefined);
  }
}

/** Throws SplitRefusal unless loadStories of the plan, written to a temporary folder, is `text` byte for byte. */
export function verifyPlan(text, plan) {
  const tmp = mkdtempSync(join(tmpdir(), 'split-stories-'));
  try {
    try {
      writePlan(tmp, plan);
    } catch (e) {
      throw new SplitRefusal(e.message); // the temporary folder goes below, so nothing stays written
    }
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
 * Splits the stories under `root` (at `from` when given) into `out`, or the repo itself, after proving the round trip.
 * @returns {{ stories: number, parts: number, indexBytes: number, stale: string[] }}
 */
export function splitStories({ root = process.cwd(), from, out, replace = false } = {}) {
  const guarded = guardedRoot(root, out);
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
  if (guarded !== undefined) {
    const incoming = mergeHead(guarded);
    if (incoming !== undefined) checkMerge(guarded, incoming, planSplit);
    else if (!replace) checkExisting(guarded, plan);
  }
  const stale = writePlan(out ?? root, plan);
  return {
    stories: [...plan.parts.keys()].filter((n) => n.startsWith('US-')).length,
    parts: plan.parts.size,
    indexBytes: Buffer.byteLength(plan.index),
    stale,
  };
}

/** The split tree under `root` and its exact form (the plan of its reassembled text), or the first conflict marker in it. Throws when the loader does. */
function treeAndPlan(root) {
  if (!existsSync(join(root, 'docs/stories'))) throw new SplitRefusal('there is no split tree here: docs/stories/ does not exist');
  const have = readTree(root);
  const marker = conflictMarker(have); // on the raw files, before the loader can stumble on a conflict
  if (marker !== undefined) return { marker: `${marker}: resolve the conflict by hand` };
  let text;
  try {
    text = loadStories(root);
  } catch (e) {
    throw new SplitRefusal(`the loader refuses the tree: ${e.message}`);
  }
  return { have, plan: planSplit(text), text };
}

/**
 * The standing check: undefined when the split tree under `root` is in the split's exact form; otherwise a report
 * naming the first file out of it, the rule, the repair and that file's first differing line.
 */
export function shapeReport(root) {
  const { have, plan, marker } = treeAndPlan(root);
  if (marker !== undefined) return marker;
  const [d] = diffs(have, plan);
  if (d === undefined) return undefined;
  if (d.have === undefined || d.want === undefined) return `${d.path} ${d.have === undefined ? 'is missing' : 'is listed in no index line'}`;
  const rule = d.path === INDEX ? "the split's exact index (the text outside the parts as is, one line per part)" : `the split's exact form (${SHAPE})`;
  const [a, b] = [d.have.split('\n'), d.want.split('\n')];
  let k = 0;
  while (k < a.length && a[k] === b[k]) k++;
  const at = (l) => (k < l.length ? JSON.stringify(l[k]) : '(end of file)');
  return `${d.path} is not in ${rule}: ${REPAIR}\n  line ${k + 1}\n    have: ${at(a)}\n    want: ${at(b)}`;
}

/** --normalize: rewrites the repo's split tree into its exact form, shape only. Returns the paths it changed. */
export function normalizeStories({ root = process.cwd() } = {}) {
  checkNormalize(root);
  const { have, plan, text, marker } = treeAndPlan(root);
  if (marker !== undefined) throw new SplitRefusal(marker);
  verifyPlan(text, plan);
  const changed = diffs(have, plan);
  for (const d of changed) {
    if (d.want === undefined) throw new SplitRefusal(`${d.path} is listed in no index line, so normalizing would delete it`);
    if (d.have === undefined) throw new SplitRefusal(`normalizing would make a new part, ${d.path}: a story heading sits inside another part`);
    if (d.path === INDEX || d.have.trimEnd() === d.want.trimEnd()) continue;
    const [a, b] = [d.have.trimEnd().split('\n'), d.want.trimEnd().split('\n')];
    let k = 0;
    while (a[k] === b[k]) k++;
    while (k < a.length - 1 && !a[k].trim()) k++;
    const where = k < a.length ? `, from its line ${k + 1}: ${JSON.stringify(a[k])}` : `: it would gain its line ${k + 1}, ${JSON.stringify(b[k])}`;
    throw new SplitRefusal(`normalizing would change the text of ${d.path}, not only its shape${where}. Edit it by hand`);
  }
  if (changed.length) writePlan(root, plan);
  return changed.map((d) => d.path);
}

function main(argv) {
  const opts = {};
  const usage = () => {
    console.error('usage: node tools/split-stories.mjs [--from <git-ref>] [--out <dir>] [--replace] | --normalize');
    return 64;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--replace' || flag === '--normalize') {
      opts[flag.slice(2)] = true;
      i--;
      continue;
    }
    if ((flag !== '--from' && flag !== '--out') || value === undefined || value.startsWith('--')) return usage();
    opts[flag.slice(2)] = flag === '--out' ? resolve(value) : value;
  }
  if (opts.normalize && Object.keys(opts).length > 1) return usage();
  try {
    checkGitEnv();
    if (opts.normalize) {
      const changed = normalizeStories();
      console.log(changed.length
        ? `split-stories: normalized ${changed.join(', ')}; the stories text is unchanged.`
        : "split-stories: the tree is already in the split's exact form; nothing written.");
      return 0;
    }
    const r = splitStories(opts);
    const where = opts.out ?? process.cwd();
    console.log(`split-stories: ${r.stories} stories, ${r.parts} parts, index ${r.indexBytes} bytes, written under ${where}; round trip exact.`);
    if (r.stale.length) console.log(`split-stories: removed stale parts: ${r.stale.join(', ')}`);
    return 0;
  } catch (e) {
    if (!(e instanceof SplitRefusal)) throw e;
    console.error(`split-stories: ${e.partway ? `refused partway: ${e.partway}` : 'refused, nothing written'}: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
