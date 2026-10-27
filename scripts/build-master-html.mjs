#!/usr/bin/env node
// Build a Shopify article body from a topic master (US-50 AC9).
//
//   node scripts/build-master-html.mjs docs/blog/<handle>.md --store edu|commerce \
//     --live <current-body.html> [--callouts <approved.json>] --out <file>
//
// Content HTML only: the theme supplies the page. The master replaces the body
// of an article that already exists, so the frontmatter and the leading
// "*Read the full article at ...*" self-link go (a page should not link to
// itself). Everything else in the markdown is rendered or escaped; no raw HTML
// from the .md ever reaches the page.
//
// --live (required) is the article's CURRENT body on the same store. Theme
// markers in it are not in the master and the site still uses them, so they
// carry over. A marker is any element whose class list holds `roadmap-embed`,
// `cta-roadmap` or `cta-pf` (claude_business docs/blog-callout-cards.md; any
// attribute order or quoting). Each is placed at the end of the master section
// whose heading path (parent headings, the heading, its level) matches the one
// it sat under in the live body. Edu carries all three; commerce carries
// `cta-pf` and drops the other two, which its theme renders as nothing. The
// build refuses to write when a marker cannot be placed, when the path matches
// no master heading or more than one, or when a marker sits where it cannot be
// read (inside a heading), so nothing is dropped silently.
//
// Commerce product callouts ("From the MicroVitamin range" cards) are NOT
// carried: their live text holds old product claims. A commerce build takes
// --callouts <json>, the card text Brad approved, as a list of
// { handle, heading: [parent heading..., heading], text, linkText, product }.
// A commerce build whose live body has callouts fails without that file, or
// when it approves fewer cards for the article than the live body has.
//
// References are renumbered: the master's list replaces the old one, so an old
// #ref-n bookmark can now point at a different source.
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
const CALLOUT_EYEBROW = 'From the MicroVitamin range';

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

// A site-relative path, never a protocol-relative //host.
const safeHref = (url) => /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url);

// [1], [3][5], [3,5], [51-54]: each number, or a range's start, links its reference.
const CITE = /\[(\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013]\s*\d+)?)*)\]/g;
const linkCitations = (s) =>
  s.replace(CITE, (m, inner) => (/,/.test(inner)
    ? `[${inner.replace(/(\d+)(?:\s*[-\u2013]\s*\d+)?/g, (part, n) => `<a href="#ref-${n}">${part}</a>`)}]`
    : `<a href="#ref-${inner.match(/\d+/)[0]}">${m}</a>`));

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
    s = linkCitations(renderEmphasis(esc(s)));
    // Held HTML can hold placeholders itself (code inside link text): resolve until none remain.
    while (s.includes(`@@M${nonce}`)) s = s.replace(new RegExp(`@@M${nonce}(\\d+)@@`, 'g'), (_, i) => held[i]);
    return s;
  };
}

const renderEmphasis = (s) =>
  s.replace(/\*\*((?:[^*]|\*[^*]+\*)+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, '$1<em>$2</em>');

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Push a heading onto its ancestor stack; returns the heading's path, outermost first. */
const pushPath = (stack, h) => {
  while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
  stack.push(h);
  return stack.slice();
};

/** Render the master body to blocks: [{ html, level?, key?, path? }] so carried blocks can be placed by heading path. */
export function renderBlocks(body, opts) {
  const inline = makeInline(opts);
  const lines = body.split('\n');
  const blocks = [];
  const stack = [];
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
      const path = pushPath(stack, { key: headingKey(text), level, text });
      blocks.push({ html: `<h${level}${id}>${inline(text)}</h${level}>`, level, key: headingKey(text), text, path });
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
    const item = (l) => l.match(/^(\s*)([-*]|(\d+)\.)\s+(.*)$/);
    if (item(line)) {
      // Indented items nest under the item above them.
      const base = item(line)[1].length;
      const ordered = !!item(line)[3];
      const levels = [{ indent: base, items: [] }];
      while (i < lines.length) {
        const m = item(lines[i]);
        if (m && m[1].length >= base && (m[1].length > base || !!m[3] === ordered)) {
          const indent = m[1].length;
          while (levels.length > 1 && indent < levels[levels.length - 1].indent) levels.pop();
          const top = levels[levels.length - 1];
          if (indent > top.indent && top.items.length) levels.push({ indent, items: (top.items[top.items.length - 1].children ??= []) });
          levels[levels.length - 1].items.push({ n: m[3], text: m[4] });
          i++;
          continue;
        }
        const last = levels[levels.length - 1].items;
        if (!m && /^\s+\S/.test(lines[i])) { last[last.length - 1].text += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      const list = (items, top) => {
        const tag = items[0].n ? 'ol' : 'ul';
        const lis = items.map((it) => {
          const kids = it.children?.length ? `\n${list(it.children, false)}\n` : '';
          return it.n ? `<li value="${it.n}"${top ? refId(it.n) : ''}>${inline(it.text)}${kids}</li>` : `<li>${inline(it.text)}${kids}</li>`;
        });
        return `<${tag}>\n${lis.join('\n')}\n</${tag}>`;
      };
      blocks.push({ html: list(levels[0].items, true) });
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

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** An element's class tokens, whatever the attribute order or quoting. */
const classTokens = (attrs) => {
  const m = attrs.match(/(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  return m ? (m[1] ?? m[2] ?? m[3]).split(/\s+/).filter(Boolean) : [];
};
const markersIn = (attrs) => classTokens(attrs).filter((t) => Object.hasOwn(MARKERS, t));
const TAG = /<[a-z][a-z0-9-]*\b([^>]*)>/gi;

/** Theme markers in the live body, each with the heading path it sat under: carried, or dropped for this store. */
export function extractCarried(liveHtml, store) {
  const carried = [];
  const dropped = [];
  const stack = [];
  let path = null;
  for (const m of liveHtml.matchAll(new RegExp(`<h([1-6])\\b[^>]*>([\\s\\S]*?)<\\/h\\1\\s*>|${TAG.source}`, 'gi'))) {
    if (m[1]) {
      path = pushPath(stack, { key: headingKey(m[2]), level: Number(m[1]), text: decode(m[2].replace(/<[^>]+>/g, '')).trim() });
      continue;
    }
    for (const kind of markersIn(m[3])) (MARKERS[kind].includes(store) ? carried : dropped).push({ kind, path, html: `<div class="${kind}"></div>` });
  }
  const total = [...liveHtml.matchAll(TAG)].reduce((n, m) => n + markersIn(m[1]).length, 0);
  if (total !== carried.length + dropped.length) {
    throw new Error(`the live body has ${total} theme markers but only ${carried.length + dropped.length} outside a heading, where they can be placed`);
  }
  return { carried, dropped };
}

/** A Brad-approved callout card: escaped text and one whitelisted product link. */
export function renderCallout({ text, linkText, product }) {
  if (!Object.values(COMMERCE_PRODUCTS).includes(product)) throw new Error(`approved callout names an unknown product "${product}"`);
  if (typeof text !== 'string' || !text.trim() || typeof linkText !== 'string' || !linkText.trim()) throw new Error('an approved callout needs text and linkText');
  return `<div style="border:1px solid #dde7e3;border-left:4px solid #0a6b57;background:#f0f7f4;border-radius:8px;padding:16px 18px;margin:22px 0;">
<p style="margin:0 0 6px;font-weight:700;">${CALLOUT_EYEBROW}</p>
<p style="margin:0;">${esc(text)} <a href="/products/${product}" target="_blank" rel="noopener">${esc(linkText)}</a></p>
</div>`;
}

const pathText = (path) => (path ? path.map((h) => h.text).join(' > ') : '(before the first heading)');
// Same headings outermost first; a level is compared where the carried path has one.
const samePath = (a, b) => a.length === b.length && a.every((h, i) => h.key === b[i].key && (h.level === undefined || h.level === b[i].level));

/** Insert each carried block at the end of the one master section whose heading path matches its own. */
export function placeCarried(blocks, carried) {
  const out = blocks.map((b) => ({ ...b, after: [] }));
  const unplaced = [];
  for (const c of carried) {
    const hits = c.path ? out.flatMap((b, i) => (b.path && samePath(c.path, b.path) ? [i] : [])) : [];
    if (hits.length !== 1) {
      const reason = hits.length ? `"${pathText(c.path)}" matches ${hits.length} master headings` : `the master has no heading "${pathText(c.path)}"`;
      unplaced.push({ ...c, reason });
      continue;
    }
    const at = hits[0];
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

/** The article handles a master's callouts may name: its drstanfield.com one and its microvitamin.com one. */
const handlesOf = (meta) => [meta.url, meta.commerceUrl].filter(Boolean).map((u) => u.replace(/\/+$/, '').split('/').pop());

export function buildMasterHtml(md, { store, liveHtml, callouts }) {
  if (store !== 'edu' && store !== 'commerce') throw new Error('--store edu|commerce is required');
  if (typeof liveHtml !== 'string') throw new Error('--live <current body> is required: every theme marker in it must be carried');
  const { meta, body } = splitMaster(md);
  const blocks = renderBlocks(body, { store });
  const { carried, dropped } = extractCarried(liveHtml, store);
  if (store === 'commerce') {
    const live = liveHtml.split(CALLOUT_EYEBROW).length - 1;
    const handles = handlesOf(meta);
    if (live && !callouts) throw new Error(`the live body has ${live} product callout(s), whose old text is not carried: pass --callouts <json> with the card text Brad approved`);
    const approved = (callouts ?? []).filter((c) => handles.includes(c.handle));
    if (approved.length < live) throw new Error(`the live body has ${live} product callout(s) but --callouts approves ${approved.length} for ${handles.join(' / ')}`);
    for (const c of approved) {
      if (!Array.isArray(c.heading) || !c.heading.length || !c.heading.every((t) => typeof t === 'string')) throw new Error(`approved callout for ${c.handle} needs a heading path: [parent heading..., heading]`);
      carried.push({ kind: 'callout', path: c.heading.map((t) => ({ key: headingKey(t), text: t })), html: renderCallout(c) });
    }
  } else if (callouts) {
    throw new Error('--callouts is for commerce builds only');
  }
  const { html, unplaced } = placeCarried(blocks, carried);
  return { meta, html: `${toc(blocks)}${html}\n`, carried, dropped, unplaced };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i === -1 ? undefined : argv[i + 1]; };
  const mdPath = argv.find((a) => a.endsWith('.md'));
  const store = arg('--store');
  const out = arg('--out');
  const live = arg('--live');
  if (!mdPath || !store || !live) {
    console.error('Usage: build-master-html.mjs <master.md> --store edu|commerce --live current.html [--callouts approved.json] [--out file]');
    process.exit(1);
  }
  const calloutsPath = arg('--callouts');
  let result;
  try {
    result = buildMasterHtml(readFileSync(mdPath, 'utf8'), {
      store,
      liveHtml: readFileSync(live, 'utf8'),
      callouts: calloutsPath ? JSON.parse(readFileSync(calloutsPath, 'utf8')) : undefined,
    });
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
  const { meta, html, carried, dropped, unplaced } = result;
  for (const c of carried) console.error(`carried ${c.kind} after "${pathText(c.path)}"`);
  for (const c of dropped) console.error(`dropped ${c.kind}: the ${store} theme renders it as nothing`);
  if (unplaced.length) {
    for (const c of unplaced) console.error(`UNPLACED ${c.kind}: ${c.reason}`);
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
