/**
 * US-47 (docs/user-stories.md): documentation Artifacts built from Markdown.
 * tools/md-artifact.mjs build-time link rewriting: relative links in the
 * EMBEDDED Markdown point at the linked doc's Artifact, else GitHub, else stay
 * and warn; code is untouched and the .md on disk never changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOL = resolve(__dirname, 'md-artifact.mjs');
const ART = 'https://claude.ai/artifact/abc123';
const SOURCE = `---
title: Main
---
# Main

- artifact: [plan](sub/plan.md#goals) and [bare](sub/plan.md)
- github: [notes](notes.txt#L3), [dir](sub/), [spaced](<my file.txt>)
- missing: [gone](nope.md#x)
- left alone: [web](https://example.com/a.md), [anchor](#main), [abs](/etc/hosts), [mail](mailto:a@b.c)
- image: ![pic](notes.txt)
- code span: \`[plan](sub/plan.md)\` and \`\`[x](notes.txt)\`\`
- html: <a href="sub/plan.md#top">plan</a>

- html code: <code>[x](notes.txt)</code> and <code><a href="notes.txt">y</a></code>
- untracked: [stray](stray.txt), [ignored](output/draft.txt)
- colon: [colon](notes:x.md), [win](C:\\docs\\a.md)
- images by reference: ![logo][logo], ![both][shared], and a link [see][shared]

[ref]: notes.txt
[logo]: notes.txt
[shared]: my%20file.txt

> [bq]: notes.txt

\`\`\`md
[fenced](sub/plan.md)
\`\`\`

An indented code block:

    [indented](notes.txt)
    <a href="notes.txt">x</a>

- a list item

    [listprose](notes.txt)
`;

let repo: string;
let result: ReturnType<typeof spawnSync>;
let md: string;
let html: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'md-artifact-'))); // macOS /var -> /private/var
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'plan.md'), `---\nartifact: ${ART}\n---\n# Plan\n`);
  writeFileSync(join(repo, 'notes.txt'), 'n\n');
  writeFileSync(join(repo, 'my file.txt'), 'n\n');
  writeFileSync(join(repo, 'notes:x.md'), 'n\n');
  writeFileSync(join(repo, 'main.md'), SOURCE);
  writeFileSync(join(repo, '.gitignore'), 'output/\n');
  git('add', '-A');
  mkdirSync(join(repo, 'output'));
  writeFileSync(join(repo, 'output', 'draft.txt'), 'n\n'); // gitignored
  writeFileSync(join(repo, 'stray.txt'), 'n\n'); // untracked
  result = spawnSync('node', [TOOL, join(repo, 'main.md')], { encoding: 'utf8' });
  html = readFileSync(join(repo, '.artifacts', 'main.html'), 'utf8');
  md = JSON.parse(html.match(/window\.__MD__ = (".*?");<\/script>/s)![1]);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('md-artifact link rewriting', () => {
  it('builds and prints the summary line', () => {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('links:    3 rewritten to artifacts, 7 to GitHub, 4 unresolved');
  });

  it('points .md links with artifact: front matter at the Artifact, keeping the fragment', () => {
    expect(md).toContain(`[plan](${ART}#goals)`);
    expect(md).toContain(`[bare](${ART})`);
    expect(md).toContain(`<a href="${ART}#top">plan</a>`);
  });

  it('points other existing repo files at GitHub (blob, tree for dirs)', () => {
    const gh = 'https://github.com/acme/widgets';
    expect(md).toContain(`[notes](${gh}/blob/main/notes.txt#L3)`);
    expect(md).toContain(`[dir](${gh}/tree/main/sub)`);
    expect(md).toContain(`[spaced](${gh}/blob/main/my%20file.txt)`);
    expect(md).toContain(`[ref]: ${gh}/blob/main/notes.txt`);
  });

  it('leaves a missing target as written and warns', () => {
    expect(md).toContain('[gone](nope.md#x)');
    expect(result.stderr).toContain('md-artifact: unresolved link: nope.md#x');
  });

  it('leaves absolute URLs, anchors, absolute paths, images and code untouched', () => {
    for (const s of ['[web](https://example.com/a.md)', '[anchor](#main)', '[abs](/etc/hosts)', '[mail](mailto:a@b.c)',
      '![pic](notes.txt)', '`[plan](sub/plan.md)`', '``[x](notes.txt)``', '```md\n[fenced](sub/plan.md)\n```']) {
      expect(md).toContain(s);
    }
  });

  it('leaves indented code blocks untouched, but rewrites indented prose inside a list item', () => {
    expect(md).toContain('    [indented](notes.txt)\n    <a href="notes.txt">x</a>\n');
    expect(md).toContain('    [listprose](https://github.com/acme/widgets/blob/main/notes.txt)');
  });

  it('leaves raw HTML <code> content untouched', () => {
    expect(md).toContain('<code>[x](notes.txt)</code> and <code><a href="notes.txt">y</a></code>');
  });

  it('keeps reference definitions an image uses, even when a link shares them', () => {
    expect(md).toContain('\n[logo]: notes.txt\n');
    expect(md).toContain('\n[shared]: my%20file.txt\n');
  });

  it('rewrites a reference definition inside a blockquote', () => {
    expect(md).toContain('> [bq]: https://github.com/acme/widgets/blob/main/notes.txt');
  });

  it('gives untracked and gitignored files no GitHub URL: unresolved, with a warning', () => {
    expect(md).toContain('[stray](stray.txt)');
    expect(md).toContain('[ignored](output/draft.txt)');
    expect(result.stderr).toContain('md-artifact: unresolved link: stray.txt');
    expect(result.stderr).toContain('md-artifact: unresolved link: output/draft.txt');
  });

  it('treats a colon that is not a URL scheme as a path; a Windows path is unresolved', () => {
    expect(md).toContain('[colon](https://github.com/acme/widgets/blob/main/notes%3Ax.md)');
    expect(md).toContain('[win](C:\\docs\\a.md)');
    expect(result.stderr).toContain('md-artifact: unresolved link: C:\\docs\\a.md');
  });

  it('page script survives a malformed % in the URL fragment', () => {
    expect(html).toContain('try { id = decodeURIComponent(id); } catch (e) {}');
  });

  it('never changes the .md on disk', () => {
    expect(readFileSync(join(repo, 'main.md'), 'utf8')).toBe(SOURCE);
  });
});
