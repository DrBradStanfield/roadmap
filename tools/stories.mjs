/**
 * Reads the user stories as one text, whichever shape the repo holds them in.
 *
 * Two shapes, same text out:
 * - Monolith: docs/user-stories.md holds every story. It is returned as is.
 * - Split: docs/user-stories.md is an index, with one file per story at docs/stories/US-NN.md
 *   and the constitution at docs/stories/_constitution.md. The index is reassembled.
 * The split shape is in force when the stories/ folder beside the index exists (on disk, or in the git ref).
 *
 * The reassembly rule (tools/split-stories.mjs must be its exact inverse):
 * 1. Split the index into lines on "\n".
 * 2. A story line is exactly `- [US-NN · <title>](stories/US-NN.md)`, the same NN twice.
 *    The constitution line is exactly `- [<text>](stories/_constitution.md)`.
 * 3. Each such line is replaced by its file's text, less one final "\n". Every other line is kept as is,
 *    blank lines included: the blank lines between stories live in the index, not in the parts.
 * 4. In that file's text, every link target that starts with `../` loses it once (fromPart). The split
 *    gives every relative link target in a part a `../` prefix (toPart), so links resolve from docs/stories/.
 * 5. The lines are joined again with "\n".
 * Nothing else changes: headings and bodies are byte-identical.
 *
 * Usage: loadStories(root?, { ref? }) for the repo's own file; readStories(indexPath, { ref? }) for any index.
 * With `ref`, every file is read with `git show <ref>:./<path>`, run from the index's folder.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX = 'docs/user-stories.md';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const STORY_LINE = /^- \[US-(\d+) · .*\]\((?<target>stories\/US-\1\.md)\)$/;
const CONSTITUTION_LINE = /^- \[[^\]]+\]\((?<target>stories\/_constitution\.md)\)$/;
// A markdown link target, as scripts/build-user-stories-html.ts reads one.
const TARGET = /\]\(([^)\s]+)\)/g;
const isRelative = (t) => !/^([a-z][a-z0-9+.-]*:|[#/])/i.test(t);

/** A story's text as its part file holds it: every relative link target gains `../`. */
export const toPart = (text) => text.replace(TARGET, (m, t) => (isRelative(t) ? `](../${t})` : m));
/** The inverse of toPart: every link target starting with `../` loses it once. */
export const fromPart = (text) => text.replace(TARGET, (m, t) => (t.startsWith('../') ? `](${t.slice(3)})` : m));

/** True for the index and every part: the paths whose text loadStories puts together. */
export const isStoriesPath = (p) => p === INDEX || /^docs\/stories\/[^/]+\.md$/.test(p);

/** Pure core: the index with every story and constitution line expanded through `readPart(relPath)`. */
export function expandIndex(index, readPart) {
  return index
    .split('\n')
    .map((line) => {
      const target = (STORY_LINE.exec(line) || CONSTITUTION_LINE.exec(line))?.groups?.target;
      if (!target) return line;
      const text = readPart(target);
      return fromPart(text.endsWith('\n') ? text.slice(0, -1) : text);
    })
    .join('\n');
}

/**
 * The stories text an index file holds, reassembled when stories/ sits beside it.
 * With `ref`, a failure to read the index keeps git's error (its `stderr` says whether the path is absent);
 * a missing part is always a plain Error, so no caller can take it for an absent index.
 * @param {string} indexPath
 * @param {{ ref?: string }} [opts]
 * @returns {string}
 */
export function readStories(indexPath, { ref } = {}) {
  const dir = dirname(indexPath);
  // git runs from the nearest folder that exists, since the ref may hold folders the working tree does not.
  let cwd = dir;
  while (!existsSync(cwd)) cwd = dirname(cwd);
  const at = (rel) => `${ref}:./${relative(cwd, join(dir, rel))}`;
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  const read = ref === undefined ? (rel) => readFileSync(join(dir, rel), 'utf8') : (rel) => git('show', at(rel));
  const has = (rel) => {
    if (ref === undefined) return existsSync(join(dir, rel));
    try {
      git('cat-file', '-e', at(rel));
      return true;
    } catch {
      return false;
    }
  };
  const index = read(basename(indexPath));
  if (!has('stories')) return index;
  return expandIndex(index, (rel) => {
    try {
      return read(rel);
    } catch (e) {
      throw new Error(`stories: the index links ${rel}, which cannot be read${ref === undefined ? '' : ` at ${ref}`}: ${String(e.stderr || e.message).trim()}`);
    }
  });
}

/**
 * The repo's stories text: docs/user-stories.md under `root`, at `ref` when given.
 * @type {(root?: string, opts?: { ref?: string }) => string}
 */
export const loadStories = (root = repoRoot, opts = {}) => readStories(join(root, INDEX), opts);
