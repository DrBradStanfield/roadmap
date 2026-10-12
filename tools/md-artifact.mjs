#!/usr/bin/env node
/**
 * md-artifact.mjs — build a claude.ai Artifact page FROM a Markdown file.
 *
 * Standing rule (Brad, 2026-10-12, both repos): the .md is the single source of
 * truth for every planning document and piece of documentation. The Artifact is
 * a VIEW built from it by this tool — never hand-edited HTML. Edit the .md,
 * rebuild, republish to the same URL.
 *
 * How it stays drift-proof: the page embeds the .md text verbatim and renders it
 * in the browser (marked + mermaid, pinned from cdnjs). There is no conversion
 * step that could silently diverge, so the page can only ever say what the .md
 * says. If the CDN is unreachable the page falls back to showing the raw .md.
 *
 * Usage (from either repo):
 *   node ~/Documents/roadmap/tools/md-artifact.mjs <file.md>
 * Output: <repo>/.artifacts/<name>.html (gitignored — a build product, not a
 * source). The tool prints the Artifact URL recorded in the .md's front matter;
 * publish the output there (Artifact tool: `file_path` = output, `url` = that URL).
 * First publish: no URL yet — publish, then add it to the front matter:
 *
 *   ---
 *   artifact: https://claude.ai/artifact/<id>
 *   ---
 *
 * Mermaid: ```mermaid fences render as diagrams. Tables, task lists and all
 * GitHub-flavoured Markdown render as on GitHub.
 *
 * Links: a relative link would resolve against claude.ai on the published page
 * and 404, so the EMBEDDED copy (never the .md on disk) has each relative link
 * target rewritten at build time, resolved against the .md's own directory: to
 * the linked .md's `artifact:` URL when it has one, else to its GitHub blob URL
 * (owner/repo from that file's own repo's `origin`, branch main), keeping any
 * #fragment. Missing targets stay as written and print `unresolved link` on
 * stderr. Only files git tracks get a GitHub URL; an untracked or gitignored
 * file would 404 there, so it counts as unresolved too. Applies to
 * [text](target), reference definitions (blockquoted ones too) and raw
 * <a href>. Left alone: URLs with a scheme (`x://`, mailto:, tel:, data:,
 * javascript:), #anchors, /paths, images (inline, and any reference definition
 * an image uses, even if a link shares it) and code (spans, raw <code>/<pre>,
 * fenced and indented blocks). A Windows path (C:\...) is unresolved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MARKED = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js';
const MERMAID = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js';

function die(msg) { console.error(`md-artifact: ${msg}`); process.exit(1); }

const src = process.argv[2];
if (!src || !src.endsWith('.md')) die('usage: node md-artifact.mjs <file.md>');
const abs = path.resolve(src);
if (!fs.existsSync(abs)) die(`not found: ${abs}`);

const raw = fs.readFileSync(abs, 'utf8');

// Front matter: a leading --- block of `key: value` lines. Only `artifact` and
// `title` are read; anything else is ignored and stays out of the rendered page.
function frontMatter(text) {
  const meta = {};
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return { body: text, meta };
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { body: text.slice(fm[0].length), meta };
}
const { body: mdBody, meta } = frontMatter(raw);

const h1 = mdBody.match(/^#\s+(.+)$/m);
const title = (meta.title || (h1 && h1[1]) || path.basename(abs, '.md'))
  .replace(/[`*_]/g, '').replace(/\s+[—–-]\s+.*$/, '').trim();

// The git repo holding `dir` and its GitHub web base, cached per directory.
const repos = new Map();
function repoOf(dir) {
  if (!repos.has(dir)) {
    let r = null;
    try {
      const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      let web = null;
      try {
        const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
        if (m) web = `https://github.com/${m[1]}/${m[2]}`;
      } catch {}
      r = { root, web };
    } catch {}
    repos.set(dir, r);
  }
  return repos.get(dir);
}

const repo = repoOf(path.dirname(abs));
if (!repo) die('the .md must live inside a git repository');
const repoRoot = repo.root;
const rel = path.relative(repoRoot, abs);

// Rewrite relative link targets (see header). Code blocks (fenced or
// indented) pass through whole; in the rest, code spans and raw <code>/<pre>
// are matched first so nothing inside them is touched.
const counts = { artifact: 0, github: 0, unresolved: 0 };
function isTracked(r, relPath, dir) {
  r.files ??= new Set(execFileSync('git', ['-C', r.root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0'));
  if (!dir) return r.files.has(relPath);
  const pre = relPath ? relPath + '/' : '';
  for (const f of r.files) if (f && f.startsWith(pre)) return true;
  return false;
}
function rewriteTarget(target) {
  const bare = target.replace(/^<(.*)>$/, '$1');
  if (!bare || /^(#|\/|[a-z][a-z0-9+.-]*:\/\/|(mailto|tel|data|javascript):)/i.test(bare)) return target;
  const hash = bare.indexOf('#');
  const p = hash < 0 ? bare : bare.slice(0, hash);
  const frag = hash < 0 ? '' : bare.slice(hash);
  let file = p;
  try { file = decodeURI(p); } catch {}
  file = path.resolve(path.dirname(abs), file);
  if (!/^[a-z]:[\\/]/i.test(bare) && fs.existsSync(file)) { // a Windows path never resolves
    file = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); // git reports real paths
    const dir = fs.statSync(file).isDirectory();
    if (!dir && file.endsWith('.md')) {
      const url = frontMatter(fs.readFileSync(file, 'utf8')).meta.artifact;
      if (url) { counts.artifact++; return url + frag; }
    }
    const r = repoOf(dir ? file : path.dirname(file));
    const relPath = r && path.relative(r.root, file).split(path.sep).join('/');
    // Only tracked files exist on GitHub: untracked or gitignored ones would 404.
    if (r && r.web && !relPath.startsWith('..') && isTracked(r, relPath, dir)) {
      counts.github++;
      return `${r.web}/${dir ? 'tree' : 'blob'}/main/${relPath.split('/').map(encodeURIComponent).join('/')}${frag}`;
    }
  }
  counts.unresolved++;
  console.error(`md-artifact: unresolved link: ${target}`);
  return target;
}

// Split the body into code chunks (verbatim) and prose chunks. Indented code
// follows CommonMark, conservatively: a line indented 4+ columns past the
// enclosing list item's content column, after a blank line, a heading or a
// fence. Indented code inside a blockquote is not detected.
function chunks(text) {
  const out = [];
  const add = (code, line) => { const last = out.at(-1); if (last && last.code === code) last.text += line; else out.push({ code, text: line }); };
  const cols = s => { let c = 0; for (const ch of s) c = ch === '\t' ? c + 4 - (c % 4) : c + 1; return c; };
  const items = []; // content columns of the open list items
  let fence = null, codeCol = -1, boundary = true;
  for (const line of text.split(/(?<=\n)/)) {
    const blank = !line.trim();
    const ind = cols(line.match(/^[ \t]*/)[0]);
    if (fence) {
      add(true, line);
      const f = line.match(/^[ \t]*(`{3,}|~{3,})\s*$/);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; boundary = true; }
      continue;
    }
    if (codeCol >= 0 && (blank || ind >= codeCol)) { add(true, line); boundary = blank; continue; }
    codeCol = -1;
    if (blank) { add(false, line); boundary = true; continue; }
    const item = line.match(/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?: {1,4}(?! )|[ \t]|(?=\r?\n|$))/);
    if (boundary || item) while (items.length && ind < items.at(-1)) items.pop();
    if (boundary && ind >= (items.at(-1) ?? 0) + 4) { codeCol = (items.at(-1) ?? 0) + 4; add(true, line); boundary = false; continue; }
    const f = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (f) fence = f[1];
    else if (item) items.push(cols(item[0]) + (/\S$/.test(item[0]) ? 1 : 0));
    add(!!f, line);
    boundary = /^ {0,3}#{1,6}(\s|$)/.test(line);
  }
  return out;
}

const CODE = String.raw`(?<tick>` + '`' + String.raw`+)(?:[^\n]|\n(?![ \t]*\n))*?[^` + '`' + String.raw`]\k<tick>(?!` + '`' + String.raw`)|<(?<tag>code|pre)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>`;
const LINKISH = new RegExp(CODE + '|' + [
  String.raw`!\[[^\]\n]*\]\([^)\n]*\)`, // inline image
  String.raw`(?<linkPre>\]\(\s*)(?<linkT><[^>\n]*>|[^\s)]+)`,
  String.raw`(?<defPre>^(?: {0,3}>[ \t]?)* {0,3}\[(?<label>(?!\^)[^\]\n]+)\]:[ \t]*)(?<defT><[^>\n]*>|\S+)`,
  String.raw`(?<aPre><a\s[^>]*?\bhref\s*=\s*)(?<q>["'])(?<aT>.*?)\k<q>`,
].join('|'), 'gim');
// Reference-style images: ![alt][label], ![label][], ![label]. Their
// definitions keep their destinations, even when a link shares them.
const IMAGE_REF = new RegExp(CODE + '|' + String.raw`!\[(?<alt>[^\]\n]*)\](?:\[(?<ref>[^\]\n]*)\])?(?!\()`, 'gi');
const label = s => s.trim().replace(/\s+/g, ' ').toLowerCase();
const parts = chunks(mdBody);
const imageLabels = new Set();
for (const c of parts) if (!c.code) for (const m of c.text.matchAll(IMAGE_REF)) if (m.groups.alt !== undefined) imageLabels.add(label(m.groups.ref || m.groups.alt));
function rewriteLinks(text) {
  return text.replace(LINKISH, (m, ...args) => {
    const g = args.at(-1);
    if (g.linkPre !== undefined) return g.linkPre + rewriteTarget(g.linkT);
    if (g.defPre !== undefined) return imageLabels.has(label(g.label)) ? m : g.defPre + rewriteTarget(g.defT);
    if (g.aPre !== undefined) return g.aPre + g.q + rewriteTarget(g.aT) + g.q;
    return m;
  });
}
const body = parts.map(c => (c.code ? c.text : rewriteLinks(c.text))).join('');
const outDir = path.join(repoRoot, '.artifacts');
const out = path.join(outDir, path.basename(abs, '.md') + '.html');

// Embed the Markdown as a JSON string. `<` is escaped to < so no sequence in
// the document can close the script element early.
const mdJson = JSON.stringify(body).replace(/</g, '\\u003c');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const built = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const html = `<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: one readable column; tables and diagrams scroll inside their own boxes. */
:root {
  --bg: #f6f7f5; --surface: #ffffff; --ink: #15201c; --ink-soft: #4f5d58; --ink-faint: #7d8a84;
  --rule: #dfe4e0; --accent: #0b6b54; --accent-wash: #e6efeb; --code-bg: #eef1ee;
  --font-display: "IBM Plex Serif", Georgia, serif;
  --font-body: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1412; --surface: #171e1b; --ink: #e8ede9; --ink-soft: #a9b6b0; --ink-faint: #7e8c86;
    --rule: #2a3430; --accent: #4fbf9d; --accent-wash: #15302a; --code-bg: #1d2622; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1412; --surface: #171e1b; --ink: #e8ede9; --ink-soft: #a9b6b0; --ink-faint: #7e8c86;
  --rule: #2a3430; --accent: #4fbf9d; --accent-wash: #15302a; --code-bg: #1d2622; color-scheme: dark;
}
body { background: var(--bg); color: var(--ink); font-family: var(--font-body); line-height: 1.6; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 50rem; margin: 0 auto; padding-inline: 18px; padding-block: 2.2rem 4rem; }
.doc { min-width: 0; }
h1, h2, h3, h4 { font-family: var(--font-display); font-weight: 600; text-wrap: balance; letter-spacing: -0.01em; line-height: 1.25; }
h1 { font-size: clamp(1.7rem, 4.5vw, 2.3rem); margin: 0 0 1rem; padding-bottom: 0.9rem; border-bottom: 2px solid var(--ink); }
h2 { font-size: 1.35rem; margin: 2.6rem 0 0.8rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: 1.08rem; margin: 1.8rem 0 0.6rem; }
h4 { font-size: 0.98rem; margin: 1.4rem 0 0.5rem; }
p, ul, ol, blockquote, .tablewrap, pre { margin: 0 0 1rem; }
ul, ol { padding-left: 1.3rem; }
li { margin: 0.2rem 0; }
li > ul, li > ol { margin: 0.2rem 0 0.4rem; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; overflow-wrap: anywhere; }
strong { font-weight: 600; }
code { font-family: var(--font-mono); font-size: 0.86em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 3px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 0.85rem 1rem; border-radius: 4px; overflow-x: auto; }
pre code { background: none; padding: 0; overflow-wrap: normal; }
blockquote { border-left: 3px solid var(--accent); background: var(--surface); padding: 0.7rem 1rem; color: var(--ink-soft); }
blockquote > :last-child { margin-bottom: 0; }
hr { border: none; border-top: 1px solid var(--rule); margin: 2rem 0; }
.tablewrap { overflow-x: auto; border: 1px solid var(--rule); background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.8rem; border-bottom: 1px solid var(--rule); }
th { font-family: var(--font-mono); font-size: 0.74rem; font-weight: 500; color: var(--ink-faint); background: var(--bg); }
tbody tr:last-child td { border-bottom: none; }
td { font-variant-numeric: tabular-nums; }
pre.mermaid { background: var(--surface); border: 1px solid var(--rule); text-align: center; }
nav.toc { background: var(--surface); border: 1px solid var(--rule); padding: 0.8rem 1rem; margin: 0 0 1.6rem; font-size: 0.9rem; }
nav.toc p { margin: 0 0 0.4rem; font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-faint); }
nav.toc ol { margin: 0; columns: 2 16rem; column-gap: 2rem; }
.src-note { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.8rem; color: var(--ink-faint); }
.fallback { white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.85rem; }
</style>

<div class="wrap">
  <article class="doc" id="doc"><p class="src-note">Loading ${esc(rel)}…</p></article>
  <p class="src-note">Built from <code>${esc(rel)}</code> on ${built}. The Markdown file is the source of truth; edit it, never this page.</p>
</div>

<script>window.__MD__ = ${mdJson};</script>
<script src="${MARKED}"></script>
<script src="${MERMAID}"></script>
<script>
(function () {
  var doc = document.getElementById('doc');
  if (!window.marked) {
    doc.innerHTML = '';
    var pre = document.createElement('pre');
    pre.className = 'fallback';
    pre.textContent = window.__MD__;
    doc.appendChild(pre);
    return;
  }
  doc.innerHTML = window.marked.parse(window.__MD__, { gfm: true });

  doc.querySelectorAll('table').forEach(function (t) {
    var w = document.createElement('div');
    w.className = 'tablewrap';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });
  doc.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });

  var used = {};
  var h2s = doc.querySelectorAll('h2');
  h2s.forEach(function (h) {
    var id = h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
    while (used[id]) id += '-x';
    used[id] = 1;
    h.id = id;
  });
  if (h2s.length >= 4) {
    var nav = document.createElement('nav');
    nav.className = 'toc';
    var label = document.createElement('p');
    label.textContent = 'Contents';
    var ol = document.createElement('ol');
    h2s.forEach(function (h) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      ol.appendChild(li);
    });
    nav.appendChild(label);
    nav.appendChild(ol);
    var h1 = doc.querySelector('h1');
    if (h1) h1.insertAdjacentElement('afterend', nav); else doc.prepend(nav);
  }

  var blocks = doc.querySelectorAll('pre > code.language-mermaid');
  if (blocks.length && window.mermaid) {
    blocks.forEach(function (code) {
      var pre = document.createElement('pre');
      pre.className = 'mermaid';
      pre.textContent = code.textContent;
      code.parentNode.replaceWith(pre);
    });
    var root = document.documentElement.getAttribute('data-theme');
    var dark = root ? root === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict' });
    window.mermaid.run({ querySelector: 'pre.mermaid' });
  }
  // The page renders after load, so the browser's own jump to #fragment found
  // nothing; scroll to it now that the anchors exist.
  if (location.hash) {
    var id = location.hash.slice(1);
    try { id = decodeURIComponent(id); } catch (e) {} // a malformed % stays raw
    var target = document.getElementById(id);
    if (target) target.scrollIntoView();
  }
})();
</script>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, html);

console.log(`built:    ${out}`);
console.log(`title:    ${title}`);
console.log(`source:   ${rel}`);
console.log(`links:    ${counts.artifact} rewritten to artifacts, ${counts.github} to GitHub, ${counts.unresolved} unresolved`);
console.log(meta.artifact
  ? `publish:  ${meta.artifact}   (Artifact tool: file_path = the built file, url = this)`
  : 'publish:  no `artifact:` URL in the front matter yet — first publish, then record the URL there');
