/**
 * US-47 (docs/user-stories.md): documentation Artifacts built from Markdown.
 * tools/md-artifact.mjs embeds the .md unchanged plus a build-time map
 * {relative target path -> URL} (the linked doc's Artifact, else GitHub; else
 * left out with a warning). The page's marked walkTokens hook applies the map
 * to Markdown link tokens only, so the real parser decides what is a link. The
 * hook (tools/md-artifact-links.mjs) is tested here as a pure function.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { linkHook } from './md-artifact-links.mjs';

const TOOL = resolve(__dirname, 'md-artifact.mjs');
const ART = 'https://claude.ai/artifact/abc123';
const GH = 'https://github.com/acme/widgets';
const SOURCE = `---
title: Main
---
# Main

- artifact: [plan](sub/plan.md#goals) and [bare](sub/plan.md)
- github: [notes](notes.txt#L3), [dir](sub/), [spaced](<my file.txt>), [parens](notes(1).md), [escaped](notes\\(1\\).md)
- missing: [gone](nope.md#x), [ctor](constructor)
- left alone: [web](https://example.com/a.md), [anchor](#main), [abs](/etc/hosts), [mail](mailto:a@b.c)
- image: ![pic](notes.txt), ![an [example]](image.png), ![lost](missing.png)
- code span: \`[span](sub/plan.md)\` and \`\`[span2](notes.txt)\`\` and \`[codegone](in-code.md)\`
- html: <a href="sub/plan.md#top">rawhtml</a> and <code>[incode](notes.txt)</code>
- untracked: [stray](stray.txt), [ignored](output/draft.txt)
- colon: [colon](notes:x.md), [win](C:\\docs\\a.md)
- crlf: [crlf](\r\ncrlf.txt), [cr](\rcr.txt), [crref][crref], and a tracked file named like a prototype key: [proto](__proto__)
- images by reference: ![logo][logo], ![both][shared], and a link [see][shared]
- [reflink][ref]
- \`\`\`
  [listfence](notes.txt) [fencegone](fence-gone.md)
  \`\`\`

[ref]: notes.txt
[crref]:\r\ncrref.txt
[logo]: notes.txt
[shared]: my%20file.txt

> [bq]: notes.txt
> [quoted][bq]

<pre>
[pre](notes.txt)
    <a href="notes.txt">preanchor</a> indented
</pre>

\`\`\`md
[fenced](sub/plan.md)
\`\`\`

An indented code block:

    [indented](notes.txt)

- a list item

    [listprose](notes.txt)

<div>
<pre><a href="notes.txt">divpre</a></pre>
<a href="sub/plan.md">divplain</a>
</div>
`;

let repo: string;
let result: ReturnType<typeof spawnSync>;
let html: string;
let md: string;
let links: Record<string, string>;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'md-artifact-'))); // macOS /var -> /private/var
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'plan.md'), `---\nartifact: ${ART}\n---\n# Plan\n`);
  for (const f of ['notes.txt', 'my file.txt', 'notes:x.md', 'notes(1).md', 'image.png', '__proto__', 'crlf.txt', 'cr.txt', 'crref.txt']) writeFileSync(join(repo, f), 'n\n');
  writeFileSync(join(repo, 'main.md'), SOURCE);
  writeFileSync(join(repo, '.gitignore'), 'output/\n');
  git('add', '-A');
  mkdirSync(join(repo, 'output'));
  writeFileSync(join(repo, 'output', 'draft.txt'), 'n\n'); // gitignored
  writeFileSync(join(repo, 'stray.txt'), 'n\n'); // untracked
  result = spawnSync('node', [TOOL, join(repo, 'main.md')], { encoding: 'utf8' });
  html = readFileSync(join(repo, '.artifacts', 'main.html'), 'utf8');
  md = JSON.parse(html.match(/window\.__MD__ = (".*?");\n/s)![1]);
  links = JSON.parse(JSON.parse(html.match(/window\.__LINKS__ = JSON\.parse\((".*?")\);<\/script>/s)![1]));
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('md-artifact link map (build time)', () => {
  it('builds and prints the summary line (distinct targets by kind)', () => {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('links:    1 mapped to artifacts, 11 to GitHub, 5 unresolved (distinct targets)');
  });

  it('embeds the Markdown body exactly as written (front matter stripped) and never changes the .md', () => {
    expect(md).toBe(SOURCE.replace(/^---\n[\s\S]*?\n---\n/, ''));
    expect(readFileSync(join(repo, 'main.md'), 'utf8')).toBe(SOURCE);
  });

  it('maps .md links with artifact: front matter to the Artifact, other tracked files to GitHub', () => {
    expect(Object.fromEntries(Object.entries(links).filter(([k]) => k !== '__proto__'))).toEqual({
      'sub/plan.md': ART,
      'notes.txt': `${GH}/blob/main/notes.txt`,
      'sub/': `${GH}/tree/main/sub`,
      'my file.txt': `${GH}/blob/main/my%20file.txt`,
      'notes(1).md': `${GH}/blob/main/notes(1).md`, // balanced parens, and the \( escaped form
      'image.png': `${GH}/blob/main/image.png`, // collected liberally; the page never touches images
      'notes:x.md': `${GH}/blob/main/notes%3Ax.md`, // a colon that is not a scheme is a path
      'my%20file.txt': `${GH}/blob/main/my%20file.txt`,
      // reached only after a CRLF / bare CR (inline and reference), so these prove the line-ending fix (Codex)
      'crlf.txt': `${GH}/blob/main/crlf.txt`, 'cr.txt': `${GH}/blob/main/cr.txt`, 'crref.txt': `${GH}/blob/main/crref.txt`,
    });
    // A literal '__proto__' key would set the prototype, so check that own key separately (Codex).
    expect(Object.hasOwn(links, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(links, '__proto__')!.value).toBe(`${GH}/blob/main/__proto__`);
  });

  it('leaves missing, untracked, gitignored and Windows targets out of the map, with a warning', () => {
    for (const t of ['nope.md#x', 'constructor', 'stray.txt', 'output/draft.txt', 'C:\\docs\\a.md']) {
      expect(result.stderr).toContain(`md-artifact: unresolved link: ${t}\n`);
    }
    for (const k of ['nope.md', 'stray.txt', 'output/draft.txt', 'C:\\docs\\a.md', 'constructor']) {
      expect(Object.hasOwn(links, k)).toBe(false);
    }
  });

  it('does not warn for unresolved targets of images or inside code', () => {
    for (const t of ['missing.png', 'in-code.md', 'fence-gone.md']) expect(result.stderr).not.toContain(t);
  });

  it('never maps scheme URLs, anchors or absolute paths', () => {
    for (const k of ['https://example.com/a.md', '', '#main', '/etc/hosts', 'mailto:a@b.c']) expect(Object.hasOwn(links, k)).toBe(false);
  });

  it('page script survives a malformed % in the URL fragment', () => {
    expect(html).toContain('try { id = decodeURIComponent(id); } catch (e) {}');
  });
});

// The page's rewrite (linkHook, inlined into the page) as a pure function, fed the tokens marked
// hands its walkTokens hook, with the map this file's build made. No network, no browser (test audit T21).
// Which spans marked calls a link (code and raw HTML are not) is marked's own parsing, not checked here.
describe('md-artifact page link rewrite (linkHook)', () => {
  const walk = (token: Record<string, string>) => { linkHook(links).walkTokens(token); return token; };
  const href = (h: string) => walk({ type: 'link', href: h }).href;

  it('the page runs exactly this function on the build map', () => {
    // The module's source text, as node's toString inlines it (vitest's transform would reformat linkHook.toString()).
    const source = readFileSync(resolve(__dirname, 'md-artifact-links.mjs'), 'utf8');
    expect(html).toContain(`var linkHook = ${source.slice(source.indexOf('function linkHook')).trimEnd()};`);
    expect(html).toContain('window.marked.use(linkHook(window.__LINKS__));');
  });

  it('maps a link href found in the map, keeping its #fragment', () => {
    expect({
      plan: href('sub/plan.md#goals'), bare: href('sub/plan.md'),
      notes: href('notes.txt#L3'), dir: href('sub/'), spaced: href('my%20file.txt'), spacedRaw: href('my file.txt'),
      parens: href('notes(1).md'), colon: href('notes:x.md'),
      // marked's hrefs after a CRLF / bare CR, and the __proto__ key (Codex)
      crlf: href('crlf.txt'), cr: href('cr.txt'), crref: href('crref.txt'), proto: href('__proto__'),
    }).toEqual({
      plan: `${ART}#goals`, bare: ART,
      notes: `${GH}/blob/main/notes.txt#L3`, dir: `${GH}/tree/main/sub`, spaced: `${GH}/blob/main/my%20file.txt`, spacedRaw: `${GH}/blob/main/my%20file.txt`,
      parens: `${GH}/blob/main/notes(1).md`, colon: `${GH}/blob/main/notes%3Ax.md`,
      crlf: `${GH}/blob/main/crlf.txt`, cr: `${GH}/blob/main/cr.txt`, crref: `${GH}/blob/main/crref.txt`, proto: `${GH}/blob/main/__proto__`,
    });
  });

  it('leaves a link outside the map as written: missing, untracked, ignored, scheme, anchor, absolute, malformed %', () => {
    for (const h of ['nope.md#x', 'constructor', 'stray.txt', 'output/draft.txt', 'https://example.com/a.md', '#main', '/etc/hosts', 'mailto:a@b.c', 'notes%zz.txt']) {
      expect(href(h), h).toBe(h);
    }
  });

  it('never touches a token that is not a link: images, code spans, code blocks, raw HTML', () => {
    const tokens: Record<string, string>[] = [
      { type: 'image', href: 'notes.txt', text: 'pic' }, { type: 'image', href: 'my%20file.txt', text: 'both' },
      { type: 'codespan', text: '[span](sub/plan.md)' }, { type: 'code', text: '[fenced](sub/plan.md)' },
      { type: 'html', text: '<a href="sub/plan.md#top">rawhtml</a>' },
    ];
    for (const t of tokens) expect(walk({ ...t })).toEqual(t);
  });
});
