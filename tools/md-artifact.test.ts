/**
 * US-47 (docs/user-stories.md): documentation Artifacts built from Markdown.
 * tools/md-artifact.mjs embeds the .md unchanged plus a build-time map
 * {relative target path -> URL} (the linked doc's Artifact, else GitHub; else
 * left out with a warning). The page's marked walkTokens hook applies the map
 * to Markdown link tokens only, so the real parser decides what is a link: the
 * e2e test renders the built page in WebKit and checks code, images and raw HTML
 * (including <a href>) are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOL = resolve(__dirname, 'md-artifact.mjs');
const ART = 'https://claude.ai/artifact/abc123';
const GH = 'https://github.com/acme/widgets';
const MARKED = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js';
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
- crlf: [crlf](\r\nnotes.txt), and a tracked file named like a prototype key: [proto](__proto__)
- images by reference: ![logo][logo], ![both][shared], and a link [see][shared]
- [reflink][ref]
- \`\`\`
  [listfence](notes.txt) [fencegone](fence-gone.md)
  \`\`\`

[ref]: notes.txt
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
  for (const f of ['notes.txt', 'my file.txt', 'notes:x.md', 'notes(1).md', 'image.png', '__proto__']) writeFileSync(join(repo, f), 'n\n');
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
    expect(result.stdout).toContain('links:    1 mapped to artifacts, 8 to GitHub, 5 unresolved (distinct targets)');
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

// The page itself, rendered by the real marked in WebKit (every iPhone browser).
describe('md-artifact rendered page (WebKit e2e)', () => {
  it('rewrites Markdown link tokens only: code, raw HTML and images keep what the .md says', async (ctx) => {
    const online = await fetch(MARKED, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(r => r.ok, () => false);
    if (!online) {
      console.warn(`SKIPPED md-artifact e2e: cannot reach ${MARKED} (the page loads marked from cdnjs)`);
      return ctx.skip();
    }
    const { webkit } = await import('playwright');
    let browser;
    try { browser = await webkit.launch(); } catch (e) {
      console.warn(`SKIPPED md-artifact e2e: Playwright WebKit will not launch (${(e as Error).message.split('\n')[0]})`);
      return ctx.skip();
    }
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(join(repo, '.artifacts', 'main.html')).href);
      await page.waitForFunction(() => document.querySelector('#doc h1'), null, { timeout: 15000 });
      const got = await page.evaluate(() => {
        const doc = document.getElementById('doc')!;
        const a: Record<string, string | null> = {};
        doc.querySelectorAll('a').forEach(el => { a[el.textContent!.trim()] = el.getAttribute('href'); });
        const img: Record<string, string | null> = {};
        doc.querySelectorAll('img').forEach(el => { img[el.getAttribute('alt')!] = el.getAttribute('src'); });
        const pre = [...doc.querySelectorAll('pre')].find(p => !p.querySelector('code'));
        return { a, img, code: [...doc.querySelectorAll('code')].map(c => c.textContent), pre: pre?.textContent };
      });
      expect(got.a).toMatchObject({
        plan: `${ART}#goals`, bare: ART,
        notes: `${GH}/blob/main/notes.txt#L3`, dir: `${GH}/tree/main/sub`, spaced: `${GH}/blob/main/my%20file.txt`,
        parens: `${GH}/blob/main/notes(1).md`, escaped: `${GH}/blob/main/notes(1).md`,
        colon: `${GH}/blob/main/notes%3Ax.md`, see: `${GH}/blob/main/my%20file.txt`,
        crlf: `${GH}/blob/main/notes.txt`, proto: `${GH}/blob/main/__proto__`, // CRLF before the destination; __proto__ key (Codex)
        reflink: `${GH}/blob/main/notes.txt`, incode: `${GH}/blob/main/notes.txt`, quoted: `${GH}/blob/main/notes.txt`, listprose: `${GH}/blob/main/notes.txt`,
        gone: 'nope.md#x', ctor: 'constructor', stray: 'stray.txt', ignored: 'output/draft.txt',
        web: 'https://example.com/a.md', anchor: '#main', abs: '/etc/hosts', mail: 'mailto:a@b.c',
        // raw HTML <a href> is left as written, wherever it sits (Codex: a <div> nesting a <pre>)
        rawhtml: 'sub/plan.md#top', preanchor: 'notes.txt', divpre: 'notes.txt', divplain: 'sub/plan.md',
      });
      for (const t of ['span', 'span2', 'codegone', 'listfence', 'fencegone', 'fenced', 'indented', 'pre']) {
        expect(Object.hasOwn(got.a, t)).toBe(false);
      }
      expect(got.img).toEqual({ pic: 'notes.txt', 'an [example]': 'image.png', lost: 'missing.png', logo: 'notes.txt', both: 'my%20file.txt' });
      expect(got.code).toEqual(expect.arrayContaining([
        '[span](sub/plan.md)', '[span2](notes.txt)', '[codegone](in-code.md)',
        '[listfence](notes.txt) [fencegone](fence-gone.md)\n', '[fenced](sub/plan.md)\n', '[indented](notes.txt)\n',
      ]));
      expect(got.pre).toContain('[pre](notes.txt)\n    preanchor indented');
    } finally {
      await browser.close();
    }
  }, 60000);
});
