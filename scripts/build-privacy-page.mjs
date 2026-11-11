// Render a privacy addendum master to the body of its Shopify page:
// docs/privacy-connector-addendum.md to drstanfield.com/pages/connector-privacy
// (the default), docs/privacy-app-addendum.md to /pages/app-privacy. Writes the
// HTML to --out (default: stdout summary only); with --publish it PUTs the
// page, or creates it the first time, needing SHOPIFY_EDU_SHOP and
// SHOPIFY_EDU_ACCESS_TOKEN (write_content) in the environment. Drops the
// header paragraph, the internal blockquote and "Items to verify"; refuses em
// dashes, [VERIFY] markers and relative links, so nothing internal reaches the page.
// The page opens with "Last updated <date>", the UTC day it is built; --date sets
// that clock for tests and is refused with --publish. The Last updated date is the
// publish day, so publish only when the notice text changed; republishing unchanged
// text would claim an update that did not happen.
//   node scripts/build-privacy-page.mjs [connector|app] [--out file] [--publish] [--date iso]
import { readFileSync, writeFileSync } from 'node:fs';
import { requireMergedCode } from '../tools/write-gate.mjs';
import { escapeHtml as esc } from '../tools/escape-html.mjs';

// `start`: the first line of the public body. `id`: a page that exists; `handle`: found or created.
const PAGES = {
  connector: { md: 'privacy-connector-addendum.md', start: 'This section covers one optional feature', heading: 'Privacy policy addendum: the AI connector', id: 133434343623 },
  app: { md: 'privacy-app-addendum.md', start: 'This policy covers the Health Roadmap iPhone app', heading: 'Privacy policy addendum: the iPhone app', handle: 'app-privacy', title: 'iPhone app privacy' },
};
const arg = process.argv[2];
const page = PAGES[arg && !arg.startsWith('--') ? arg : 'connector'];
if (!page) throw new Error('which page? ' + Object.keys(PAGES).join(' or '));
const md = readFileSync(new URL(`../docs/${page.md}`, import.meta.url), 'utf8');
const inline = (s) => {
  const held = [];
  let t = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${held.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  t = esc(t)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  if (/—/.test(t)) throw new Error('em dash in: ' + s.slice(0, 60));
  if (/\[VERIFY\]/.test(t)) throw new Error('VERIFY marker in body');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
};

// Body: from the first "## " heading to (not including) "## Items still to verify".
const start = md.indexOf('\n' + page.start);
const end = md.indexOf('\n## Items still to verify');
if (start < 0 || end < 0) throw new Error('addendum shape changed');
const body = md.slice(start, end).trim();

const dateIdx = process.argv.indexOf('--date');
if (dateIdx !== -1 && process.argv.includes('--publish')) throw new Error('--date is for tests; a publish dates itself');
const builtOn = dateIdx !== -1 ? new Date(process.argv[dateIdx + 1]) : new Date();
if (Number.isNaN(builtOn.getTime())) throw new Error('bad --date: ' + process.argv[dateIdx + 1]);
const updated = builtOn.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const out = [`<h2>${page.heading}</h2>`, `<p>Last updated ${updated}</p>`];
for (const raw of body.split(/\n\n+/)) {
  const b = raw.trim();
  if (!b || b === '---') continue;
  if (b.startsWith('## ')) { out.push(`<h2>${inline(b.slice(3))}</h2>`); continue; }
  if (b.startsWith('### ')) { out.push(`<h3>${inline(b.slice(4))}</h3>`); continue; }
  if (b.startsWith('> ')) throw new Error('blockquote in body: ' + b.slice(0, 40));
  if (/^\d+\. /.test(b)) {
    const items = b.split(/\n(?=\d+\. )/).map((it) => it.replace(/^\d+\. /, '').replace(/\n\s+/g, ' '));
    out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
    continue;
  }
  if (b.startsWith('- ')) {
    const items = b.split(/\n(?=- )/).map((it) => it.replace(/^- /, '').replace(/\n\s+/g, ' '));
    out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
    continue;
  }
  out.push(`<p>${inline(b.replace(/\n/g, ' '))}</p>`);
}
out.push('<h2>Questions about this feature</h2>');
out.push('<p>Contact us at <a href="https://drstanfield.com/pages/contact">drstanfield.com/pages/contact</a>.</p>');
const html = out.join('\n').replace('href="guides/connect-claude-desktop.md"', 'href="https://drstanfield.com/blogs/guides/connect-claude"');
if (/href="(?!https:)/.test(html)) throw new Error('relative link left');
const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1) writeFileSync(process.argv[outIdx + 1], html);
console.log('rendered', html.length, 'chars,', out.length, 'blocks');

if (process.argv.includes('--publish')) {
  requireMergedCode('build-privacy-page --publish'); // merged code only (docs/git-workflow.md)
  const shop = process.env.SHOPIFY_EDU_SHOP, tok = process.env.SHOPIFY_EDU_ACCESS_TOKEN;
  if (!shop || !tok) throw new Error('SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN are needed to publish');
  const api = `https://${shop}/admin/api/2025-07/pages`;
  const headers = { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' };
  let id = page.id;
  if (!id) {
    const found = await fetch(`${api}.json?handle=${page.handle}`, { headers });
    if (!found.ok) throw new Error('page lookup failed: ' + found.status);
    id = (await found.json()).pages?.find((p) => p.handle === page.handle)?.id;
  }
  const res = id
    ? await fetch(`${api}/${id}.json`, { method: 'PUT', headers, body: JSON.stringify({ page: { id, body_html: html } }) })
    : await fetch(`${api}.json`, { method: 'POST', headers, body: JSON.stringify({ page: { title: page.title, handle: page.handle, body_html: html, published: true } }) });
  const j = await res.json();
  console.log(id ? 'PUT' : 'POST', res.status, j.page?.handle, j.page?.updated_at, 'len', j.page?.body_html?.length, j.errors ?? '');
}
