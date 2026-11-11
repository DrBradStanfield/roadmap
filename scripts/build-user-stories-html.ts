/**
 * Generate docs/user-stories.html from docs/user-stories.md, and guard the .md.
 *
 * The .md is the SOURCE OF TRUTH (agents read/edit it, tests cite its US-ids).
 * The .html is a browser copy, no longer tracked in git (Brad 2026-11-04: every
 * PR rebuilt the 1.7 MB file, so every merge conflicted with every other PR).
 * pages.yml builds it to https://drbradstanfield.github.io/roadmap/user-stories.html;
 * a local copy is `npx tsx scripts/build-user-stories-html.ts` (gitignored).
 *
 * It is also the spec's integrity gate. On 2026-09-01 a session read the .md
 * through a truncating reader, wrote the whole file back, and silently dropped
 * 17 stories (US-12–US-28); nothing noticed for four days. Two checks refuse
 * that now: a US-id the text references but never defines (every run), and,
 * with `--check-against <git-ref>` (CI, against the PR's base), a story the
 * base defines that the .md dropped. A story is retired by keeping its heading
 * and saying so, never removed; ALLOW_STORY_REMOVAL=1 lets a local check through.
 *
 * Usage: npx tsx scripts/build-user-stories-html.ts [--link-base <url>] [source.md] [out.html]
 *        npx tsx scripts/build-user-stories-html.ts --check-against <git-ref> [source.md]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml as esc } from '../tools/escape-html.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Prefix for relative links, so a copy served away from docs/ (Pages) still resolves them. HTML-escaped once, where it is set. */
let linkBase = '';

/** Inline markdown: code, bold, links (applied after escaping). */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
      // The Pages copy shares its origin with the self-hosted app and its stored record and keys,
      // so a link may only go somewhere safe: http(s), mailto, an anchor, or a relative path.
      // Browsers drop leading control characters before reading a scheme, so a link holding any is refused.
      if (/[\x00-\x1f\x7f]/.test(href)) return text;
      const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
      if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return text;
      const url = linkBase && !scheme && !/^[#/]/.test(href) ? linkBase + href : href;
      return `<a href="${url}">${text}</a>`; // href and linkBase are both escaped, quotes included
    });
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
/** The names of the checks that failed, or none. Pure, so the test can drive it without a filesystem. */
export function integrityProblems(md: string, baselineMd: string | null, allowRemoval: boolean): string[] {
  const defined = definedIds(md);
  const problems: string[] = [];
  const dangling = [...referencedIds(md)].filter((id) => !defined.has(id)).sort((a, b) => a - b);
  if (dangling.length) {
    problems.push(`references stories it never defines: ${dangling.map((id) => `US-${id}`).join(', ')}`);
  }
  if (baselineMd !== null && !allowRemoval) {
    const dropped = [...definedIds(baselineMd)].filter((id) => !defined.has(id)).sort((a, b) => a - b);
    if (dropped.length) {
      problems.push(
        `drops stories the base still defines: ${dropped.map((id) => `US-${id}`).join(', ')} ` +
          '(a truncated read written back whole looks exactly like this; retire a story by keeping its heading and marking it retired)',
      );
    }
  }
  return problems;
}

/** The source as `ref` holds it; null when that commit has no such file (a first build). Throws on a bad ref. */
function sourceAt(ref: string, src: string): string | null {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dirname(src), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  try {
    return git(['show', `${ref}:./${basename(src)}`]);
  } catch (e) {
    // Only "that commit has no such path" means a first build; any other failure must not pass the gate.
    if (/does not exist in|exists on disk, but not in/.test(String((e as { stderr?: unknown }).stderr ?? ''))) return null;
    throw e;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : (args.splice(i, 2)[1] ?? ''); // a flag with no value is an empty one, never absent
  };
  const against = option('--check-against');
  linkBase = esc(option('--link-base') ?? '');
  const SRC = args[0] ?? join(root, 'docs', 'user-stories.md');
  const OUT = args[1] ?? join(root, 'docs', 'user-stories.html');
  const md = readFileSync(SRC, 'utf8');
  let baseline: string | null = null;
  if (against !== undefined) {
    try {
      baseline = sourceAt(against, SRC);
    } catch {
      console.error(`user-stories.md: cannot read git ref ${against || '(empty)'}; nothing checked.`);
      process.exit(1);
    }
  }
  const problems = integrityProblems(md, baseline, process.env.ALLOW_STORY_REMOVAL === '1');
  if (problems.length) {
    for (const p of problems) console.error(`user-stories.md ${p}`);
    console.error(against === undefined ? `Nothing written to ${OUT}.` : 'Check failed.');
    process.exit(1);
  }
  if (against !== undefined) {
    console.log(`user-stories.md: ${definedIds(md).size} stories, none dropped since ${against}.`);
    return;
  }
  const { body, toc } = render(md);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'">
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
  <a href="${linkBase}architecture-v2.md">← Architecture (v2)</a>
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
