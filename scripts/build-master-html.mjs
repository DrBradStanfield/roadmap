#!/usr/bin/env node
// Build a Shopify article body from a topic master (US-50 AC9).
//
//   node scripts/build-master-html.mjs docs/blog/<handle>.md --store edu|commerce \
//     [--live <current-body.html>] --out <file>
//
// Content HTML only: the theme supplies the page. The master replaces the body
// of an article that already exists, so the frontmatter and the leading
// "*Read the full article at ...*" self-link go (a page should not link to
// itself). Everything else in the markdown is rendered or escaped; no raw HTML
// from the .md ever reaches the page.
//
// --live is the article's CURRENT body on the same store. Two things in it are
// not in the master and the site still uses them, so they carry over, each
// placed at the end of the master section whose heading matches the heading
// that preceded it in the live body:
//   - theme markers: `roadmap-embed` and `cta-roadmap` (edu only; the commerce
//     theme renders them as nothing) and `cta-pf` (both stores);
//   - commerce only: the "From the MicroVitamin range" product callout cards.
//     Their text is re-escaped, the link is rebuilt from a whitelisted product
//     handle, and their [n] markers are dropped: those numbers point at the old
//     reference list, not the master's.
// A carried block whose heading the master lacks fails the build, so nothing
// is dropped silently.
//
// Commerce links: a master's drstanfield.com/products/<h> link becomes the
// on-store /products/<h'> link, as the current commerce copies do.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// drstanfield.com product handle -> microvitamin.com product handle.
const COMMERCE_PRODUCTS = { microvitamin: 'microvitamin', 'microvitamin-powder': 'microvitamin-plus', 'microvitamin-plus': 'microvitamin-plus', sleep: 'sleep' };

const MARKERS = { 'roadmap-embed': ['edu'], 'cta-roadmap': ['edu'], 'cta-pf': ['edu', 'commerce'] };

/** Split a master into its frontmatter fields and its body. */
export function splitMaster(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error('no frontmatter: a topic master starts with a --- block');
  const meta = {};
  for (const line of fm[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  const body = md.slice(fm[0].length).replace(/^\s*\*Read the full article at [^\n]*\*[ \t]*\n/, '');
  return { meta, body };
}

/** Heading text reduced for matching across the old and new bodies: "3. Blood <b>Pressure</b>" -> "blood pressure". */
export const headingKey = (s) =>
  s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/^\s*\d+\.\s+/, '').replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Anchor id: the live bodies use "Forms-and-Bioavailability"; keep that shape so old #links still land. */
const anchorId = (s) => s.replace(/^\s*\d+\.\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

const safeHref = (url) => /^(https?:\/\/|mailto:|\/|#)/i.test(url);

function makeInline({ store }) {
  const nonce = randomBytes(4).toString('hex');
  return (src) => {
    const held = [];
    const hold = (html) => `@@M${nonce}${held.push(html) - 1}@@`;
    let s = src.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
    // [text](url), one level of parentheses allowed in the URL (DOIs carry them).
    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, text, url) => {
      if (!safeHref(url)) return m;
      let href = url;
      const prod = store === 'commerce' && url.match(/^https?:\/\/(?:www\.)?drstanfield\.com\/products\/([a-z0-9-]+)\/?$/i);
      if (prod && COMMERCE_PRODUCTS[prod[1]]) href = `/products/${COMMERCE_PRODUCTS[prod[1]]}`;
      return hold(`<a href="${esc(href)}">${renderEmphasis(esc(text))}</a>`);
    });
    s = s.replace(/https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:]/g, (url) => hold(`<a href="${esc(url)}">${esc(url)}</a>`));
    s = renderEmphasis(esc(s)).replace(/\[(\d+)\]/g, '<a href="#ref-$1">[$1]</a>');
    return s.replace(new RegExp(`@@M${nonce}(\\d+)@@`, 'g'), (_, i) => held[i]);
  };
}

const renderEmphasis = (s) =>
  s.replace(/\*\*((?:[^*]|\*[^*]+\*)+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Render the master body to blocks: [{ html, level?, key? }] so carried blocks can be placed by heading. */
export function renderBlocks(body, opts) {
  const inline = makeInline(opts);
  const lines = body.split('\n');
  const blocks = [];
  let inRefs = false;
  const refId = (n) => (inRefs ? ` id="ref-${n}"` : '');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.max(2, h[1].length);
      const text = h[2].trim();
      inRefs = headingKey(text) === 'references';
      const id = level === 2 ? ` id="${anchorId(text)}"` : '';
      blocks.push({ html: `<h${level}${id}>${inline(text)}</h${level}>`, level, key: headingKey(text), text });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({ html: '<hr>' }); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const sep = rows.length > 1 && /^\|?[\s:|-]+\|?$/.test(rows[1]) && rows[1].includes('-');
      const head = sep ? `<thead><tr>${splitRow(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>\n` : '';
      const bodyRows = (sep ? rows.slice(2) : rows).map((r) => `<tr>${splitRow(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      blocks.push({ html: `<table>\n${head}<tbody>\n${bodyRows.join('\n')}\n</tbody>\n</table>` });
      continue;
    }
    const item = (l) => l.match(/^([-*]|(\d+)\.)\s+(.*)$/);
    if (item(line)) {
      const ordered = !!item(line)[2];
      const items = [];
      while (i < lines.length) {
        const m = item(lines[i]);
        if (m && !!m[2] === ordered) { items.push({ n: m[2], text: m[3] }); i++; continue; }
        if (items.length && /^\s+\S/.test(lines[i])) { items[items.length - 1].text += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      const lis = items.map((it) => (ordered ? `<li value="${it.n}"${refId(it.n)}>${inline(it.text)}</li>` : `<li>${inline(it.text)}</li>`));
      const tag = ordered ? 'ol' : 'ul';
      blocks.push({ html: `<${tag}>\n${lis.join('\n')}\n</${tag}>` });
      continue;
    }
    if (line.startsWith('>')) {
      const q = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ html: `<blockquote><p>${q.map(inline).join('<br>')}</p></blockquote>` });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\||>|[-*]\s|\d+\.\s)/.test(lines[i])) para.push(lines[i++].trim());
    const ref = para[0].match(/^\[(\d+)\]/);
    blocks.push({ html: `<p${ref ? refId(ref[1]) : ''}>${para.map(inline).join('<br>')}</p>` });
  }
  return blocks;
}

/** Blocks the live body carries that the master lacks, each with the key of the heading before it. */
export function extractCarried(liveHtml, store) {
  const carried = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<(div|p)\s+class="(roadmap-embed|cta-pf|cta-roadmap)"[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*<\/\3>|<div style="[^"]*">\s*<p[^>]*>From the MicroVitamin range<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/div>/gi;
  let heading = null;
  for (const m of liveHtml.matchAll(re)) {
    if (m[1]) { heading = { key: headingKey(m[2]), level: Number(m[1]), text: m[2].replace(/<[^>]+>/g, '').trim() }; continue; }
    if (m[4]) {
      if (MARKERS[m[4]].includes(store)) carried.push({ kind: m[4], heading, html: `<div class="${m[4]}"></div>` });
      continue;
    }
    if (store !== 'commerce') continue;
    carried.push({ kind: 'callout', heading, html: renderCallout(m[5]) });
  }
  return carried;
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (html) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s*\[\d+\](?:\[\d+\])*/g, '');

/** Rebuild a callout card from its live inner HTML: escaped text, one whitelisted product link. */
export function renderCallout(inner) {
  const link = inner.match(/<a\s[^>]*href="\/products\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!link || !Object.values(COMMERCE_PRODUCTS).includes(link[1])) throw new Error(`callout without a known /products/ link: ${plain(inner).slice(0, 80)}`);
  const before = esc(plain(inner.slice(0, link.index)));
  const after = esc(plain(inner.slice(link.index + link[0].length)));
  const a = `<a href="/products/${link[1]}" target="_blank" rel="noopener">${esc(plain(link[2]))}</a>`;
  return `<div style="border:1px solid #dde7e3;border-left:4px solid #0a6b57;background:#f0f7f4;border-radius:8px;padding:16px 18px;margin:22px 0;">
<p style="margin:0 0 6px;font-weight:700;">From the MicroVitamin range</p>
<p style="margin:0;">${before}${a}${after}</p>
</div>`;
}

/** Insert each carried block at the end of the master section its live heading names. */
export function placeCarried(blocks, carried) {
  const out = blocks.map((b) => ({ ...b, after: [] }));
  const unplaced = [];
  for (const c of carried) {
    const at = c.heading ? out.findIndex((b) => b.key === c.heading.key) : -1;
    if (at === -1) { unplaced.push(c); continue; }
    let end = at;
    while (end + 1 < out.length && !(out[end + 1].level && out[end + 1].level <= out[at].level)) end++;
    out[end].after.push(c.html);
  }
  return { html: out.flatMap((b) => [b.html, ...b.after]).join('\n'), unplaced };
}

/** Table of contents from the H2s, as the live bodies open with one. */
const toc = (blocks) => {
  const h2 = blocks.filter((b) => b.level === 2);
  if (h2.length < 3) return '';
  const items = h2.map((b) => `<li><a href="#${anchorId(b.text)}">${esc(b.text.replace(/^\s*\d+\.\s+/, '').replace(/\*/g, ''))}</a></li>`);
  return `<h2>Table of Contents</h2>\n<ul>\n${items.join('\n')}\n</ul>\n`;
};

export function buildMasterHtml(md, { store, liveHtml = '' }) {
  if (store !== 'edu' && store !== 'commerce') throw new Error('--store edu|commerce is required');
  const { meta, body } = splitMaster(md);
  const blocks = renderBlocks(body, { store });
  const carried = extractCarried(liveHtml, store);
  const { html, unplaced } = placeCarried(blocks, carried);
  return { meta, html: `${toc(blocks)}${html}\n`, carried, unplaced };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
  const mdPath = argv.find((a) => a.endsWith('.md'));
  const store = arg('--store');
  const out = arg('--out');
  if (!mdPath || !store) {
    console.error('Usage: build-master-html.mjs <master.md> --store edu|commerce [--live current.html] [--out file]');
    process.exit(1);
  }
  const live = arg('--live');
  const { meta, html, carried, unplaced } = buildMasterHtml(readFileSync(mdPath, 'utf8'), { store, liveHtml: live ? readFileSync(live, 'utf8') : '' });
  for (const c of carried) console.error(`carried ${c.kind} after "${c.heading?.text ?? '(no heading)'}"`);
  if (unplaced.length) {
    for (const c of unplaced) console.error(`UNPLACED ${c.kind}: the master has no heading "${c.heading?.text ?? '(none)'}"`);
    process.exit(1);
  }
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, html);
    console.error(`wrote ${out} (${html.length} bytes) for ${store}: ${meta.title}`);
  } else {
    process.stdout.write(html);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
