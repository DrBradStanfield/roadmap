#!/usr/bin/env node
// Build a Shopify article body from a guide markdown master.
//
//   node scripts/build-guide-html.mjs docs/guides/getting-started.md --out build/guide.html
//   node scripts/build-guide-html.mjs docs/guides/getting-started.md --no-script
//
// Content HTML only — the theme supplies the page. A fence tagged
// bootstrap-prompt or copy-box becomes a copy box; its Copy button reads the
// text out of its own <pre>, so the page carries each block once and a second
// box cannot copy the first one's text.
// --no-script drops the clipboard JS and degrades every copy box to a plain
// block with a select-all hint, for hosts that strip <script>.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const noScript = argv.includes('--no-script');
const outIdx = argv.indexOf('--out');
const outPath = outIdx === -1 ? null : argv[outIdx + 1];
const mdPath = argv.find((a) => a.endsWith('.md'));
if (!mdPath) {
  console.error('Usage: build-guide-html.mjs <guide.md> [--out file] [--no-script]');
  process.exit(1);
}

const ASSETS = new URL('../docs/guides/assets/', import.meta.url);
const md = readFileSync(mdPath, 'utf8');
const diagram = readFileSync(new URL('diagram.svg', ASSETS), 'utf8').trim();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm) {
  console.error(`${mdPath}: no front matter. A guide starts with a --- block carrying at least title: and slug:.`);
  process.exit(1);
}
const fmRaw = fm[1];
const meta = Object.fromEntries(
  fmRaw.split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
  }),
);

// --- held HTML ------------------------------------------------------------
// Generated HTML and code alike are parked as one-line tokens before the
// markdown pass runs: that pass splits on blank lines and escapes angle
// brackets, and either would wreck a <div> or a code block. ONE namespace,
// restored ONCE over the finished document.
//
// The token carries a per-build nonce so a guide can write `@@T0@@` as prose —
// a guide about this builder is exactly the guide that would — without the
// restore pass swapping the reader's words for held fragment 0.
const NONCE = randomBytes(4).toString('hex');
const held = [];
const hold = (html) => `@@T${NONCE}${held.push(html) - 1}@@`;

// A block-level fragment alone in a paragraph loses the paragraph — a <div> or
// a <pre> is not a phrase, but a lone code span still wants one. Anything the
// builder did not park is prose: put it back verbatim.
const restore = (html) =>
  html.replace(new RegExp(`<p>@@T${NONCE}(\\d+)@@</p>|@@T${NONCE}(\\d+)@@`, 'g'), (match, alone, inline) => {
    const fragment = held[alone ?? inline];
    if (fragment === undefined) return match;
    return alone !== undefined && fragment.startsWith('<code') ? `<p>${fragment}</p>` : fragment;
  });

let body = md.slice(md.indexOf('\n---\n', 4) + 5).replace('[diagram:local-first]', () => hold(diagram));

// --- [connect:*] markers ---------------------------------------------------
const providers = JSON.parse(readFileSync(new URL('providers.json', ASSETS), 'utf8'));
const button = (key) => {
  const p = providers[key];
  const mono = `<span class="rmg-mono" style="background:${p.colour}">${p.mono}</span>`;
  const inner = `${mono}<span class="rmg-blabel">${p.label}</span><span class="rmg-bnote">${p.note}</span>`;
  if (p.mode === 'soon') return `<span class="rmg-btn rmg-btn-soon" aria-disabled="true">${inner}</span>`;
  // A live button is either an anchor to the steps further down the same page
  // or a link off the site. Only the second one gets a new tab.
  const away = p.url.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
  return `<a class="rmg-btn" href="${p.url}"${away}>${inner}</a>`;
};
body = body.replace(
  /\[connect:chatgpt\]\n\[connect:claude\]/,
  () => hold(`<div class="rmg-btnrow">${['chatgpt', 'claude'].map(button).join('')}</div>`),
);

// A copy box is a fence the reader is meant to take whole: the setup prompt, a
// config block, a server address. A guide may hold several, so the button
// copies its own <pre> rather than one prompt baked into the script.
let copyBoxes = 0;
body = body.replace(/^```(?:bootstrap-prompt|copy-box)\n([\s\S]*?)\n```$/gm, (_, text) => {
  copyBoxes += 1;
  return hold(
    noScript
      ? `<div class="rmg-promptbox"><p class="rmg-hint">Select the whole block below and copy it.</p><pre>${esc(text)}</pre></div>`
      : `<div class="rmg-promptbox"><button class="rmg-copy" type="button">Copy</button><pre>${esc(text)}</pre></div>`,
  );
});

// Every other fenced block is code. Anchored to whole lines: unanchored, the
// backticks inside a quoted `\`\`\`npm test\`\`\`` read as an opener and swallow
// the document down to the next real fence.
body = body.replace(/^```[^\n]*\n([\s\S]*?)\n```$/gm, (_, code) => hold(`<pre><code>${esc(code)}</code></pre>`));

// --- tiny markdown render --------------------------------------------------
// Smart quotes FIRST: running them after tag generation turns href="..." into
// href=“...”, an unquoted attribute that swallows the curly quotes into the URL.
// Code spans come out first, for the same reason: a quote inside `--out "x"`
// is a literal, not prose, and the smart-quote pass would curl it.
const inline = (s) =>
  esc(s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`)))
    .replace(/"([^"]+)"/g, '“$1”')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

const rendered = restore(
  body
    .split(/\n\n+/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (b.startsWith('<')) return b;
      if (b.startsWith('> ')) return `<blockquote><p>${inline(b.split('\n').map((l) => l.replace(/^>\s?/, '')).join(' '))}</p></blockquote>`;
      if (b.startsWith('### ')) return `<h3>${inline(b.slice(4))}</h3>`;
      if (b.startsWith('## ')) { const x = b.slice(3); return `<h2 id="${x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}">${inline(x)}</h2>`; }
      return `<p>${inline(b)}</p>`;
    })
    .join('\n'),
);

// Every rule is scoped to .rmguide so nothing leaks into the theme, and the
// doubled class outranks theme styles reaching in.
const style = `<style>
.rmguide .rmg-fig{margin:30px 0 34px;padding:22px 18px 16px;background:#fafcfd;border:1px solid #e3e9ef;border-radius:14px}
.rmguide .rmg-fig figcaption{font-size:15px;line-height:1.5;color:#5c6b7a;text-align:center;margin-top:14px}
.rmguide .rmg-fig svg{width:100%;height:auto;display:block}
.rmguide .rmg-btnrow{display:grid;gap:12px;margin:24px 0}
@media(min-width:640px){.rmguide .rmg-btnrow{grid-template-columns:repeat(2,1fr)}}
.rmguide .rmg-btn.rmg-btn{display:flex;flex-direction:column;align-items:center;gap:7px;text-align:center;
 padding:20px 14px;border:1px solid #d7e0e8;border-radius:13px;background:#fff;text-decoration:none;
 color:#16202a;box-shadow:0 1px 2px rgba(16,32,48,.05)}
.rmguide .rmg-btn-soon.rmg-btn-soon{background:#f7f9fb;border-style:dashed;border-color:#ccd7e1;box-shadow:none;cursor:not-allowed}
.rmguide .rmg-btn-soon .rmg-mono{filter:grayscale(1);opacity:.45}
.rmguide .rmg-btn-soon .rmg-blabel{color:#7d8c9a}
.rmguide .rmg-btn-soon .rmg-bnote{font-weight:650;color:#96703a;letter-spacing:.04em;text-transform:uppercase;font-size:11.5px}
.rmguide .rmg-mono{display:inline-block;min-width:30px;height:30px;padding:0 10px;border-radius:15px;color:#fff;
 font:700 14px/30px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.02em}
.rmguide .rmg-blabel{font-weight:650;font-size:15.5px;line-height:1.25}
.rmguide .rmg-bnote{font-size:13px;color:#5c6b7a;line-height:1.3}
.rmguide .rmg-promptbox{position:relative;background:#131e28;border-radius:13px;margin:22px 0 28px}
.rmguide .rmg-promptbox pre{margin:0;padding:24px 20px;overflow-x:auto;background:none;border:0;color:#d5e2ec;
 font:400 13.5px/1.62 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.rmguide .rmg-hint{margin:0;padding:14px 20px 0;color:#8fa4b4;font-size:13.5px}
.rmguide .rmg-copy.rmg-copy{position:absolute;top:11px;right:11px;background:#2c3e4d;color:#d5e2ec;border:0;border-radius:6px;
 padding:6px 13px;font:650 13px/1 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;width:auto;min-height:0}
.rmguide code{font:500 .92em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#eff3f6;padding:2px 6px;border-radius:4px}
.rmguide .rmg-md{margin:34px 0 0;font-size:13.5px;line-height:1.5;color:#5c6b7a}
</style>`;

const script = noScript || !copyBoxes ? '' : `
<script>
document.querySelectorAll('.rmg-copy').forEach(function (el) {
  var pre = el.parentNode.querySelector('pre');
  el.addEventListener('click', function () {
    if (navigator.clipboard && pre) navigator.clipboard.writeText(pre.textContent);
    var was = el.textContent;
    el.textContent = 'Copied';
    setTimeout(function () { el.textContent = was; }, 1500);
  });
});
</script>`;

// The .md is the master, so every page says where it lives: an agent handed a
// guide URL can fetch the source instead of scraping the rendered page.
const mdFile = `docs/guides/${basename(mdPath)}`;
const mdLink = `<p class="rmg-md">This guide is also published as plain Markdown for AI agents: <a href="https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/${mdFile}">${mdFile}</a>. The Markdown is the master; this page is built from it.</p>`;

const html = `${style}\n<div class="rmguide">\n${rendered}\n${mdLink}\n</div>${script}\n`;

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, html);
  console.error(`wrote ${outPath} (${html.length} bytes)${noScript ? ' [--no-script]' : ''}`);
} else {
  process.stdout.write(html);
}
console.error(`title: ${meta.title}`);
console.error(`slug:  ${meta.slug}`);
