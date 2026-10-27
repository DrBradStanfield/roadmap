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
// it sat under in the live body (tags read quote-aware, so a quoted ">" cannot
// hide one). Edu carries all three; commerce carries
// `cta-pf` and drops the other two, which its theme renders as nothing. The
// build refuses to write when a marker cannot be placed, when the path matches
// no master heading or more than one, or when a marker sits where it cannot be
// read (inside a heading), so nothing is dropped silently.
// One exception: `roadmap-embed` renders nothing on the current drstanfield.com
// theme and is kept only as a position hint. When its exact path is gone it
// goes to the end of the deepest master section matching a prefix of the path,
// else before References; one before the first live heading goes after the
// table of contents. Each such fallback is logged; an ambiguous match still fails.
//
// Commerce product callouts ("From the MicroVitamin range" cards) are NOT
// carried: their live text holds old product claims. A commerce build takes
// --callouts <json>, the card text Brad approved, as a list of
// { handle, heading: [parent heading..., heading], text, linkText, product }.
// A commerce build whose live body has callouts fails without that file, or
// when it approves fewer cards for the article than the live body has. Live
// cards are counted on the visible text, so markup inside the eyebrow cannot
// hide one.
//
// Commerce also drops Brad's personal voice and the master's own product text
// (Brad 2026-10-27; see stripForCommerce). Edu is unchanged.
//
// References are renumbered: the master's list replaces the old one, so an old
// #ref-n bookmark can now point at a different source.
//
// Commerce links: a master's drstanfield.com/products/<h> link becomes the
// on-store /products/<h'> link, as the current commerce copies do.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// drstanfield.com product handle -> microvitamin.com product handle.
const COMMERCE_PRODUCTS = { microvitamin: 'microvitamin', 'microvitamin-powder': 'microvitamin-plus', 'microvitamin-plus': 'microvitamin-plus', sleep: 'sleep' };

const MARKERS = { 'roadmap-embed': ['edu'], 'cta-roadmap': ['edu'], 'cta-pf': ['edu', 'commerce'] };
const CALLOUT_EYEBROW = 'From the MicroVitamin range';
const CALLOUT_TEXT = /from\s*the\s*microvitamin\s*range/gi;

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

// [1], [3][5], [3,5], [51-54]: each number, or a range's start, links its reference. A run of
// adjacent brackets, [1][48][49], renders as one small group, [1, 48, 49], styled by MASTER_CSS.
const CITE = /\[(\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-\u2013]\s*\d+)?)*)\]/g;
const CITE_RUN = new RegExp(`(?:${CITE.source})+`, 'g');
const linkCitations = (s) =>
  s.replace(CITE_RUN, (run) => {
    const parts = [...run.matchAll(CITE)].flatMap((m) => m[1].split(/\s*,\s*/));
    return `<sup class="master-cite">[${parts.map((part) => `<a href="#ref-${part.match(/\d+/)[0]}">${part}</a>`).join(', ')}]</sup>`;
  });

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
      // The theme scrolls .rte-table-wrapper sideways, so a wide table never crushes its words on a phone.
      blocks.push({ html: `<div class="rte-table-wrapper master-table"><table>\n${head}<tbody>\n${bodyRows.join('\n')}\n</tbody>\n</table></div>` });
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
    // A reference's own [n] label stays a plain bracket, not a citation group.
    const ref = inRefs && para[0].match(/^\[(\d+)\]\s*/);
    if (ref) para[0] = para[0].slice(ref[0].length);
    const label = ref ? `<a href="#ref-${ref[1]}">[${ref[1]}]</a>${para[0] ? ' ' : ''}` : '';
    blocks.push({ html: `<p${ref ? refId(ref[1]) : ''}>${label}${para.map(inline).join('<br>')}</p>` });
  }
  return blocks;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
  if (dec || hex) { const c = Number.parseInt(dec ?? hex, dec ? 10 : 16); return c === 160 ? ' ' : String.fromCodePoint(c); }
  return ENTITIES[name.toLowerCase()] ?? m;
});

/**
 * The live body's tags in order, read the way a browser reads them: a quoted
 * attribute value may hold ">" or "class=", so a regex up to the first ">"
 * could hide a marker (Codex R1). Comments are skipped; the first copy of a
 * repeated attribute wins.
 */
export function tokenizeTags(html) {
  const tags = [];
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i)) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e === -1 ? html.length : e + 3; continue; }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/i.exec(html.slice(i, i + 40));
    if (!m) { i++; continue; }
    const attrs = {};
    let j = i + m[0].length;
    while (j < html.length && html[j] !== '>') {
      if (/[\s/]/.test(html[j])) { j++; continue; }
      const name = /^[^\s"'>/=]+|^["'=]/.exec(html.slice(j))[0];
      j += name.length;
      while (/\s/.test(html[j] ?? '')) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (/\s/.test(html[j] ?? '')) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          value = html.slice(j + 1, e === -1 ? html.length : e);
          j = e === -1 ? html.length : e + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(j))[0];
          j += value.length;
        }
      }
      const key = name.toLowerCase();
      if (!Object.hasOwn(attrs, key)) attrs[key] = decode(value);
    }
    tags.push({ close: !!m[1], name: m[2].toLowerCase(), attrs, start: i, end: Math.min(j + 1, html.length) });
    i = j + 1;
  }
  return tags;
}

/** Visible text: tags removed (quote-aware), entities decoded. */
const textOf = (html) => {
  let text = '';
  let at = 0;
  for (const t of tokenizeTags(html)) { text += html.slice(at, t.start); at = t.end; }
  return decode(text + html.slice(at));
};

const markersIn = (attrs) => (attrs.class ?? '').split(/\s+/).filter((t) => Object.hasOwn(MARKERS, t));

/** Theme markers in the live body, each with the heading path it sat under: carried, or dropped for this store. */
export function extractCarried(liveHtml, store) {
  const carried = [];
  const dropped = [];
  const stack = [];
  let path = null;
  let heading = null;
  let inHeading = 0;
  for (const t of tokenizeTags(liveHtml)) {
    const level = /^h([1-6])$/.exec(t.name)?.[1];
    if (level && !t.close && !heading) { heading = { level: Number(level), from: t.end }; continue; }
    if (level && t.close && heading && Number(level) === heading.level) {
      const text = textOf(liveHtml.slice(heading.from, t.start)).trim();
      path = pushPath(stack, { key: headingKey(text), level: heading.level, text });
      heading = null;
      continue;
    }
    if (t.close) continue;
    for (const kind of markersIn(t.attrs)) {
      if (heading) inHeading++;
      else (MARKERS[kind].includes(store) ? carried : dropped).push({ kind, path, html: `<div class="${kind}"></div>` });
    }
  }
  if (inHeading) {
    throw new Error(`the live body has ${carried.length + dropped.length + inHeading} theme markers but only ${carried.length + dropped.length} outside a heading, where they can be placed`);
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
  const out = blocks.map((b) => ({ ...b, before: [], after: [] }));
  const unplaced = [];
  const fallbacks = [];
  const find = (path) => out.flatMap((b, i) => (b.path && samePath(path, b.path) ? [i] : []));
  const endOf = (at) => {
    let end = at;
    while (end + 1 < out.length && !(out[end + 1].level && out[end + 1].level <= out[at].level)) end++;
    return end;
  };
  for (const c of carried) {
    const hits = c.path ? find(c.path) : [];
    if (hits.length === 1) { out[endOf(hits[0])].after.push(c.html); continue; }
    let reason = hits.length ? `"${pathText(c.path)}" matches ${hits.length} master headings` : `the master has no heading "${pathText(c.path)}"`;
    // roadmap-embed renders nothing on the current theme; it is kept only as a position hint, so a lost heading falls back.
    const fb = !hits.length && c.kind === 'roadmap-embed' ? fallbackPlace(out, c.path, find, endOf) : null;
    if (fb?.at !== undefined) {
      out[fb.at][fb.side].push(c.html);
      fallbacks.push({ ...c, placed: fb.placed });
      continue;
    }
    if (fb?.reason) reason += `; ${fb.reason}`;
    unplaced.push({ ...c, reason });
  }
  return { html: out.flatMap((b) => [...b.before, b.html, ...b.after]).join('\n'), unplaced, fallbacks };
}

/** Where a roadmap-embed goes when its exact heading path is gone: the deepest surviving ancestor, else before References. */
function fallbackPlace(out, path, find, endOf) {
  if (!path) {
    const at = out.findIndex((b) => b.level);
    return at === -1 ? { reason: 'the master has no heading' } : { at, side: 'before', placed: `after the table of contents, before "${out[at].text}"` };
  }
  for (let k = path.length - 1; k >= 1; k--) {
    const hits = find(path.slice(0, k));
    if (hits.length > 1) return { reason: `its ancestor "${pathText(path.slice(0, k))}" matches ${hits.length} master headings` };
    if (hits.length === 1) return { at: endOf(hits[0]), side: 'after', placed: `end of "${pathText(out[hits[0]].path)}"` };
  }
  const refs = out.flatMap((b, i) => (b.level === 2 && b.key === 'references' ? [i] : []));
  return refs.length === 1 ? { at: refs[0], side: 'before', placed: 'before "References"' } : { reason: `the master has ${refs.length} References headings` };
}

// One scoped style block per article: every rule sits under a master-* class, so nothing else on the
// page changes. Callout teal is the drstanfield.com theme's table-header accent (#00a38b). The theme forces td padding to 0 !important and breaks words anywhere in narrow cells;
// the table wrapper scrolls sideways instead (theme base.css: .rte .rte-table-wrapper{overflow-x:auto}).
const MASTER_CSS = `<style>
.master-table{margin:1.5em 0;-webkit-overflow-scrolling:touch}
.master-table table{min-width:560px;margin:0}
.master-table th,.master-table td{word-break:normal;overflow-wrap:normal;hyphens:manual;vertical-align:top;line-height:1.5;padding-top:.5em!important;padding-bottom:.5em!important}
.master-table th:first-child,.master-table td:first-child{min-width:9em}
.master-callout{background:#f1f9f7;border:1px solid #d5ebe5;border-left:4px solid #00a38b;border-radius:10px;padding:1.2em 1.4em .5em;margin:2em 0}
.master-callout h2{margin:0 0 .4em;font-size:1.75em}
.master-refs li,.master-refs p{font-size:15px;line-height:1.55;margin:0 0 .6em}
.master-refs a[href^="http"]{overflow-wrap:anywhere}
.master-cite{font-size:.68em;line-height:0;vertical-align:super;font-weight:400;white-space:nowrap;opacity:.85}
.master-cite a{text-decoration:none}
</style>
`;

/** Wrap an H2 section (heading through its last block) in a styled div: the safety callout and the references. */
const SECTION_CLASS = { 'key safety points': 'master-callout', references: 'master-refs' };
function wrapSections(blocks) {
  blocks.forEach((b, at) => {
    const cls = b.level === 2 && SECTION_CLASS[b.key];
    if (!cls) return;
    let end = at;
    while (end + 1 < blocks.length && !(blocks[end + 1].level <= 2)) end++;
    b.html = `<div class="${cls}">\n${b.html}`;
    blocks[end].html += '\n</div>';
  });
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

// Commerce drops Brad's personal voice and the master's own product promotion
// (Brad 2026-10-27): the approved card does that job. A section goes, heading
// and subsections, when its heading is the current-view, evidence-position or
// videos section, or names a product. A paragraph or list item linking a
// drstanfield.com product page loses everything from the sentence holding that
// link to its end, and goes whole when nothing comes before it.
const COMMERCE_DROP_HEADING = /^(?:current view\b|current evidence position\b|brad['\u2019]s videos on this topic$|product (?:mention|note)\b)|\bmicrovitamin\b|\bsleep by dr brad\b|\bdr brad stanfield['\u2019]s products?\b/i;
const PRODUCT_LINK = /\[[^\]]*\]\(https?:\/\/(?:www\.)?drstanfield\.com\/products\/[a-z0-9-]+\/?\)/i;
const SENTENCE_END = /[.!?](?:\*\*?|\))?\s+/g;
// Pointers to the dropped Current view section, and unlinked product sentences, go too, so the
// sentences left still read: "(see the Current view above)", "; Brad's view is in the Current view.",
// a whole sentence naming it, and "...exclude vitamin E from MicroVitamin, his ... formulation."
// A "Disclosure:" sentence stays: it tells the reader about Brad's interest.
const POINTER_PAREN = /\s*\((?:see\s+)?(?:the\s+)?Current view(?:\s+(?:above|below))?\)/g;
// Inside a sentence a "." is fine when no space follows it (27.5 mg, 1.004).
const IN = String.raw`(?:[^.!?]|[.!?](?!\s|$))*`;
const POINTER_CLAUSE = new RegExp(String.raw`;\s*(?:[^;.!?]|[.!?](?!\s|$))*\bCurrent view\b(?:[^;.!?]|[.!?](?!\s|$))*([.!?])(?=\s|$)`, 'g');
const DROP_SENTENCE = new RegExp(String.raw`(^|[.!?]\s+)(?!Disclosure:)${IN}\b(?:Current view|MicroVitamin)\b${IN}[.!?](?=\s|$)`, 'g');
const dropPointers = (line) =>
  line.replace(POINTER_PAREN, '').replace(POINTER_CLAUSE, '$1').replace(DROP_SENTENCE, (m, pre) => pre.trimEnd());

/** The master body without the sections and product text commerce drops, and a list of what went. */
export function stripForCommerce(body) {
  const kept = [];
  const stripped = [];
  const stack = [];
  let skip = 0;
  for (const line of body.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.max(2, h[1].length);
      const text = h[2].trim();
      if (skip && level > skip) { stripped[stripped.length - 1].text.push(line); continue; }
      skip = 0;
      const path = pushPath(stack, { level, text });
      if (COMMERCE_DROP_HEADING.test(text.replace(/^\s*\d+(?:\.\d+)*\.?\s+/, ''))) {
        skip = level;
        stripped.push({ kind: 'section', heading: path.map((x) => x.text), text: [] });
        continue;
      }
      kept.push(line);
      continue;
    }
    if (skip) { if (line.trim()) stripped[stripped.length - 1].text.push(line); continue; }
    if (line.startsWith('|')) { kept.push(line); continue; }
    const link = line.match(PRODUCT_LINK);
    if (!link) {
      const cleaned = dropPointers(line);
      if (cleaned === line) { kept.push(line); continue; }
      stripped.push({ kind: 'phrase', heading: stack.map((x) => x.text), text: [line] });
      if (/\S/.test(cleaned.replace(/^\s*(?:[-*]|\d+\.)\s*/, ''))) kept.push(cleaned);
      continue;
    }
    let cut = 0;
    for (const m of line.slice(0, link.index).matchAll(SENTENCE_END)) cut = m.index + m[0].length;
    const rest = line.slice(0, cut).trimEnd();
    const whole = !/\S/.test(rest.replace(/^\s*(?:[-*]|\d+\.)\s*/, ''));
    stripped.push({ kind: whole ? 'paragraph' : 'sentences', heading: stack.map((x) => x.text), text: [line.slice(whole ? 0 : cut)] });
    if (!whole) kept.push(rest);
  }
  return { body: kept.join('\n'), stripped: stripped.map((x) => ({ ...x, text: x.text.join('\n') })) };
}

export function buildMasterHtml(md, { store, liveHtml, callouts }) {
  if (store !== 'edu' && store !== 'commerce') throw new Error('--store edu|commerce is required');
  if (typeof liveHtml !== 'string') throw new Error('--live <current body> is required: every theme marker in it must be carried');
  const { meta, body: master } = splitMaster(md);
  const { body, stripped } = store === 'commerce' ? stripForCommerce(master) : { body: master, stripped: [] };
  const blocks = renderBlocks(body, { store });
  wrapSections(blocks);
  const { carried, dropped } = extractCarried(liveHtml, store);
  if (store === 'commerce') {
    // Counted on the visible text, so markup or an entity inside the eyebrow cannot hide a card (Codex R2).
    const live = (textOf(liveHtml).match(CALLOUT_TEXT) ?? []).length;
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
  const { html, unplaced, fallbacks } = placeCarried(blocks, carried);
  return { meta, html: `${MASTER_CSS}${toc(blocks)}${html}\n`, carried, dropped, unplaced, fallbacks, stripped };
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
  const { meta, html, carried, dropped, unplaced, fallbacks, stripped } = result;
  for (const x of stripped) console.error(`stripped ${x.kind} under "${x.heading.join(' > ')}": ${x.text.slice(0, 80).replace(/\n/g, ' ')}`);
  for (const c of carried) console.error(`carried ${c.kind} after "${pathText(c.path)}"`);
  const handle = basename(mdPath, '.md');
  for (const c of fallbacks) console.error(`FALLBACK ${handle} ${c.kind}: live "${pathText(c.path)}" -> ${c.placed}`);
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
