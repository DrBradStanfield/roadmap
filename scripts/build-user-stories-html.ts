/**
 * Generate docs/user-stories.html from docs/user-stories.md.
 *
 * The .md is the SOURCE OF TRUTH (agents read/edit it, tests cite its US-ids);
 * the .html is the browser-readable companion linked from architecture-v2.html.
 * Regenerate after every .md edit:  npx tsx scripts/build-user-stories-html.ts
 * (Same derived-artifact pattern as rebuild-blog-index.ts.)
 *
 * It is also the spec's integrity gate. On 2026-09-01 a session read the .md
 * through a truncating reader, wrote the whole file back, and silently dropped
 * 17 stories (US-12–US-28); this script then regenerated the .html from the
 * truncated source, so both copies agreed and nothing noticed for four days.
 * Two checks now refuse that build: a story present in the previous .html but
 * absent from the .md (removal needs ALLOW_STORY_REMOVAL=1), and a US-id the
 * text references but never defines.
 *
 * Usage: npx tsx scripts/build-user-stories-html.ts [source.md] [out.html]
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ?? join(root, 'docs', 'user-stories.md');
const OUT = process.argv[3] ?? join(root, 'docs', 'user-stories.html');

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown: code, bold, links (applied after escaping). */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function render(md: string): { body: string; toc: string } {
  const lines = md.split('\n');
  const out: string[] = [];
  const toc: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const line of lines) {
    const h = line.match(/^(#{1,3}) (.+)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2];
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      if (level === 2) toc.push(`<a href="#${id}">${inline(text.replace(/^Epic [A-Z] — /, ''))}</a>`);
      if (level === 3) toc.push(`<a class="toc-sub" href="#${id}">${inline(text.split('·')[0].trim())}</a>`);
      continue;
    }
    if (/^---\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const li = line.match(/^- (.+)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === '') { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return { body: out.join('\n'), toc: toc.join('\n  ') };
}

/** Story ids the markdown DEFINES (`### US-12 · …`). */
const definedIds = (md: string) => new Set([...md.matchAll(/^### US-(\d+)\b/gm)].map((m) => Number(m[1])));
/** Story ids the markdown MENTIONS anywhere (`US-12`, `US-12/US-15`, `US-12 AC3`). */
const referencedIds = (md: string) => new Set([...md.matchAll(/\bUS-(\d+)\b/g)].map((m) => Number(m[1])));
/** Story ids the previously generated html carried (`<h3 id="us-12-…">`). */
const publishedIds = (html: string) => new Set([...html.matchAll(/<h3 id="us-(\d+)(?:-|")/g)].map((m) => Number(m[1])));

/** The names of the checks that failed, or none. Pure, so the test can drive it without a filesystem. */
export function integrityProblems(md: string, previousHtml: string | null, allowRemoval: boolean): string[] {
  const defined = definedIds(md);
  const problems: string[] = [];
  const dangling = [...referencedIds(md)].filter((id) => !defined.has(id)).sort((a, b) => a - b);
  if (dangling.length) {
    problems.push(`references stories it never defines: ${dangling.map((id) => `US-${id}`).join(', ')}`);
  }
  if (previousHtml !== null && !allowRemoval) {
    const dropped = [...publishedIds(previousHtml)].filter((id) => !defined.has(id)).sort((a, b) => a - b);
    if (dropped.length) {
      problems.push(
        `drops stories the published html still carries: ${dropped.map((id) => `US-${id}`).join(', ')} ` +
          '(a truncated read written back whole looks exactly like this; set ALLOW_STORY_REMOVAL=1 for a deliberate removal)',
      );
    }
  }
  return problems;
}

function main(): void {
  const md = readFileSync(SRC, 'utf8');
  const previousHtml = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  const problems = integrityProblems(md, previousHtml, process.env.ALLOW_STORY_REMOVAL === '1');
  if (problems.length) {
    for (const p of problems) console.error(`user-stories.md ${p}`);
    console.error(`Nothing written to ${OUT}.`);
    process.exit(1);
  }
  const { body, toc } = render(md);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health by Dr Brad — User Stories</title>
<style>
  :root {
    --bg: #f8f9fa; --card: #ffffff; --ink: #1a1a2e; --muted: #6b7280;
    --primary: #2563eb; --border: #e5e7eb; --ok: #16a34a; --warn: #d97706;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink); line-height: 1.55;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  }
  .layout { display: flex; max-width: 1200px; margin: 0 auto; gap: 32px; padding: 32px 20px; }
  nav.toc {
    flex: 0 0 230px; position: sticky; top: 24px; align-self: flex-start;
    max-height: calc(100vh - 48px); overflow-y: auto; font-size: 13.5px;
  }
  nav.toc a { display: block; color: var(--muted); text-decoration: none; padding: 3px 0; }
  nav.toc a:hover { color: var(--primary); }
  nav.toc a.toc-sub { padding-left: 14px; font-size: 12.5px; }
  main { flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 36px 42px; }
  h1 { font-size: 26px; margin-top: 0; }
  h2 { font-size: 20px; margin-top: 36px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 16px; margin-top: 26px; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em;
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
  }
  a { color: var(--primary); }
  hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  .generated {
    font-size: 12.5px; color: var(--muted); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 22px;
  }
  @media (max-width: 900px) { .layout { flex-direction: column; } nav.toc { position: static; max-height: none; } }
</style>
</head>
<body>
<div class="layout">
<nav class="toc">
  <a href="architecture-v2.html">← Architecture (v2)</a>
  ${toc}
</nav>
<main>
<div class="generated">Generated from <code>docs/user-stories.md</code> (the source of truth — edit that, then run <code>npx tsx scripts/build-user-stories-html.ts</code>). Do not edit this file by hand.</div>
${body}
</main>
</div>
</body>
</html>
`;

  writeFileSync(OUT, html);
  console.log(`Wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
}

// Importable for its checks (the test), runnable as the build (everything else).
// Node realpaths the entry module, so a symlinked invocation must be realpathed
// too — a guard that silently does nothing is the failure class this file exists to kill.
const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : '';
if (entry === realpathSync(fileURLToPath(import.meta.url))) main();
