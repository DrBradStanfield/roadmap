/**
 * Client-side .docx text extraction (US-12 AC13) using JSZip.
 * Bundled in health-upload.js (separate IIFE), NOT in main widget.
 *
 * A .docx is a ZIP of XML parts. The text a lab sheet holds is in
 * word/document.xml, with a report date often in a header. Each table row
 * becomes one line, its cells joined by " | ", so a result keeps its unit,
 * range and previous result beside it. Regex over the XML, no DOM: only
 * text nodes and the paragraph, row and cell boundaries matter.
 */
import JSZip from 'jszip';
import { inflateCapped } from '@roadmap/health-core';
import { cutText } from './cut-text';

/** XML inflated across every part read: a ZIP bomb stops here, not in memory. */
const MAX_XML_BYTES = 4 * 1024 * 1024;
/** Header and footer parts read, in all: a file of thousands of empty ones stops here. */
const MAX_EXTRA_PARTS = 50;
/** About the text of the 20 PDF pages the website reads (`IMPORT_LIMITS.websitePdfPages`). */
const MAX_TEXT_CHARS = 60_000;
/** Text gathered before reading stops: the cap and a margin, so a merge's
 *  copied text can never outgrow memory before the cut. */
const MAX_KEPT_CHARS = MAX_TEXT_CHARS + 1_000;

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** One pass, so `&amp;lt;` stays `&lt;`. A code point out of range, or half a surrogate pair, stays as written. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()];
    const code = parseInt(hex ?? dec ?? '', hex ? 16 : 10);
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** The prefix, colon included and escaped for a RegExp, that the part's root
 *  element binds to `uri`; `fallback` when the root does not declare it. */
function prefixFor(xml: string, uri: string, fallback: string): string {
  const root = /<[^?!][^<>]*>/.exec(xml)?.[0] ?? '';
  const bound = new RegExp(`\\sxmlns(?::([\\w.-]+))?\\s*=\\s*(["'])${uri.replace(/\./g, '\\.')}\\2`).exec(root);
  const name = bound ? bound[1] ?? '' : fallback;
  return name && `${name.replace(/\./g, '\\.')}:`;
}

/** A text run, or a tag that shapes the text: a paragraph, row or cell; a
 *  character written as a tag; a row's or cell's merge or deletion. `w:delText`
 *  and `w:instrText` never match, so tracked deletions and field codes drop out. */
function tokens(w: string): RegExp {
  return new RegExp(`<${w}t(?:\\s[^<>]*)?>([^<]*)</${w}t>|<(/?)${w}(p|tbl|tr|tc|tab|br|cr|ptab|noBreakHyphen|sym|trPr|del|gridSpan|gridBefore|gridAfter|vMerge)(?=[\\s/>])([^<>]*)>`, 'g');
}

/** Characters Word writes as tags. A soft hyphen is not one: it shows only at a line break. */
const CHAR_TAGS: Record<string, string> = { tab: ' ', br: ' ', cr: ' ', ptab: ' ', noBreakHyphen: '-' };
/** The Symbol font's private-use codes for the signs a lab sheet uses. */
const SYMBOL_CHARS: Record<number, string> = {
  0xf03c: '<', 0xf03e: '>', 0xf0a3: '≤', 0xf0b3: '≥', 0xf06d: 'µ', 0xf0b1: '±',
  0xf0b4: '×', 0xf0b0: '°', 0xf0d7: '·', 0xf061: 'α', 0xf062: 'β', 0xf067: 'γ',
};
/** Word's widest table; a merge never pads a row past it. */
const MAX_COLUMNS = 63;
/** Rows open at once, tables in tables; Word never nests near this deep. Past it reading stops, cut short. */
const MAX_OPEN_ROWS = 64;

/** One attribute's value, whatever its prefix, either quote, spaces around "=". */
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? m[1] ?? m[2] : undefined;
};

/** A `w:sym` character: a code outside the private-use area is itself; in the
 *  Symbol font, a sign above or a digit or punctuation mark it shares with
 *  ASCII. Anything else shows as "?", so a symbol never silently vanishes. */
function symChar(attrs: string): string {
  const char = attr(attrs, 'char') ?? '';
  const code = /^[0-9a-f]{1,6}$/i.test(char) ? parseInt(char, 16) : NaN;
  if ((code >= 0x20 && code < 0xd800) || (code > 0xf8ff && code <= 0x10ffff)) return String.fromCodePoint(code);
  if (attr(attrs, 'font')?.toLowerCase() !== 'symbol') return '?';
  if (SYMBOL_CHARS[code]) return SYMBOL_CHARS[code];
  const ascii = code - 0xf000;
  return ascii >= 0x20 && ascii <= 0x3f && !'"$\''.includes(String.fromCharCode(ascii)) ? String.fromCharCode(ascii) : '?';
}

/**
 * Drop each element `names` matches, with all it holds; a self-closing one,
 * or an empty pair (a row's `<w:del …></w:del>`), holds nothing and is kept.
 * Nesting is counted, so an inner close never ends an outer element. One
 * pass, not a lazy regex: an element never closed is kept.
 */
function dropElements(xml: string, names: string): string {
  let out = '';
  let at = 0;
  let depth = 0;
  let start = 0;
  let emptyPairClose = -1;
  /** The close tag right after an open one, whitespace allowed: an empty pair. */
  const closeNext = /\s*<\/([^\s<>]+)\s*>/y;
  for (const tag of xml.matchAll(new RegExp(`<(/?)(${names})(?=[\\s/>])[^<>]*>`, 'g'))) {
    if (tag[0].endsWith('/>') || tag.index === emptyPairClose) continue;
    const end = tag.index + tag[0].length;
    closeNext.lastIndex = end;
    if (!tag[1] && closeNext.exec(xml)?.[1] === tag[2]) {
      emptyPairClose = xml.indexOf('<', end);
      continue;
    }
    if (!tag[1]) {
      if (depth++ === 0) start = tag.index;
    } else if (depth > 0 && --depth === 0) {
      out += xml.slice(at, start);
      at = tag.index + tag[0].length;
    }
  }
  return out + xml.slice(at);
}

/** An open table row: its cells, the paragraphs of its open cell, that cell's
 *  span and vertical merge, the empty cells owed at its end, whether it was
 *  deleted, and its table's restart text per grid column. */
interface Row { cells: string[]; cell: string[]; span: number; vMerge?: 'restart' | 'continue'; after: number; deleted: boolean; merges: Map<number, string>; copied: number }

/** A merge's `w:val`, at most MAX_COLUMNS. */
function count(attrs: string): number {
  return Math.min(Number(attr(attrs, 'val') ?? 1) || 1, MAX_COLUMNS);
}

/** Empty cells for a merge, so a row keeps the header's columns. */
function pad(row: Row, count: number): void {
  for (let i = 0; i < count && row.cells.length < MAX_COLUMNS; i++) row.cells.push('');
}

/** Add one XML part's lines to `lines`: paragraphs and table rows in document
 *  order. `kept` counts the lines' characters across parts; true when it has
 *  passed MAX_KEPT_CHARS, with merge text copied into open rows counted too. */
function addPartLines(xml: string, lines: string[], kept: { chars: number }): boolean {
  const w = prefixFor(xml, W_NS, 'w');
  // A text box is written twice, the modern copy and a fallback: keep one. Text
  // moved with tracked changes is written twice too: keep where it went. A
  // tracked formatting change keeps the old properties: never re-apply them.
  // A deleted run is dropped with all it holds; a row's empty `w:del` marker
  // (self-closing or an empty pair) stays.
  const source = dropElements(xml, `${prefixFor(xml, MC_NS, 'mc')}Fallback|${w}(?:del|moveFrom|trPrChange|tcPrChange|pPrChange|rPrChange|tblPrChange|sectPrChange)`);
  /** Open rows, innermost last. */
  const rows: Row[] = [];
  /** Each open table's restart text per grid column, innermost last. */
  const tables: Array<Map<number, string>> = [];
  /** The open paragraph's text, and how many are open: a paragraph that opens
   *  inside another (a text box's) ends the outer's text so far as a line. */
  let para = '';
  let depth = 0;
  let inRowProps = false;
  /** A finished paragraph or nested row goes to the open cell, or out as a line. */
  const emit = (text: string) => {
    if (!text) return;
    if (rows.length) rows[rows.length - 1].cell.push(text);
    else {
      lines.push(text);
      kept.chars += text.length + 1;
    }
  };
  /** Merge text copied into rows still open: one running count, so a check is O(1). */
  let openCopied = 0;
  const full = () => kept.chars + openCopied > MAX_KEPT_CHARS;
  const flush = () => { emit(para.replace(/\s+/g, ' ').trim()); para = ''; };
  const add = (text: string) => { if (depth) para += text; };
  /** An early stop: the open rows' text so far goes out as lines, outermost
   *  first, up to a deleted row: a row's closed cells as one, then each
   *  paragraph or nested row its open cell holds, so the cut keeps whole lines. */
  const stop = () => {
    flush();
    for (const r of rows) {
      if (r.deleted) break;
      if (r.cells.some(Boolean)) lines.push(r.cells.join(' | '));
      for (const text of r.cell) lines.push(text); // no spread: a cell can hold more than a call takes
    }
    return true;
  };
  for (const [, text, close, tag, attrs] of source.matchAll(tokens(w))) {
    if (text !== undefined) { add(decodeEntities(text)); continue; }
    const row = rows[rows.length - 1];
    if (close) {
      if (tag === 'p' && depth) {
        flush();
        depth--;
      } else if (tag === 'tr') {
        rows.pop();
        // A nested row's copies move to its parent; a top-level row's leave the count as its line joins `kept`.
        if (row && rows.length && !row.deleted) rows[rows.length - 1].copied += row.copied;
        else if (row) openCopied -= row.copied;
        if (row && !row.deleted) {
          pad(row, row.after);
          if (row.cells.some(Boolean)) emit(row.cells.join(' | '));
          if (full()) return stop();
        }
      } else if (tag === 'tbl') tables.pop();
      else if (tag === 'tc' && row) {
        // An empty continued cell shows its restart cell's text, as Word does.
        // A deleted row neither starts, ends nor copies a merge.
        const col = row.cells.length;
        const own = row.cell.join(' ');
        const text = row.vMerge === 'continue' && !own && !row.deleted ? row.merges.get(col) ?? '' : own;
        if (!row.deleted && row.vMerge === 'restart') row.merges.set(col, text);
        else if (!row.deleted && !row.vMerge) for (let c = col; c < col + row.span; c++) row.merges.delete(c);
        if (text !== own) {
          row.copied += text.length;
          openCopied += text.length;
        }
        row.cells.push(text);
        row.vMerge = undefined;
        pad(row, row.span - 1);
        row.cell = [];
        row.span = 1;
        if (full()) return stop();
      } else if (tag === 'trPr') inRowProps = false;
    } else if (tag in CHAR_TAGS) add(CHAR_TAGS[tag]);
    else if (tag === 'sym') add(symChar(attrs));
    else if (attrs.endsWith('/') && (tag === 'p' || tag === 'trPr')) continue;
    else if (tag === 'p') {
      if (depth) flush();
      depth++;
    } else if (tag === 'tbl') tables.push(new Map());
    else if (tag === 'tr') {
      if (rows.length >= MAX_OPEN_ROWS) return stop();
      // A row nested in a deleted row is deleted with it.
      rows.push({ cells: [], cell: [], span: 1, after: 0, deleted: row?.deleted ?? false, merges: tables[tables.length - 1] ?? new Map(), copied: 0 });
    }
    else if (tag === 'trPr') inRowProps = true;
    else if (tag === 'gridSpan' && row) row.span = count(attrs);
    else if (tag === 'vMerge' && row) row.vMerge = attr(attrs, 'val') === 'restart' ? 'restart' : 'continue';
    else if (inRowProps && row) {
      if (tag === 'del') row.deleted = true;
      else if (tag === 'gridBefore') pad(row, count(attrs));
      else if (tag === 'gridAfter') row.after = count(attrs);
    }
  }
  return false;
}

/**
 * The document's text, headers first and footers last, one table row per
 * line, cut within MAX_TEXT_CHARS at a boundary (`truncated`; `cutText`).
 * `picturesOnly`: no text, but pictures. Throws when it is not a .docx or
 * its XML passes MAX_XML_BYTES.
 */
export async function docxToText(data: ArrayBuffer): Promise<{ text: string; truncated: boolean; picturesOnly: boolean }> {
  const zip = await JSZip.loadAsync(data);
  const body = zip.file('word/document.xml');
  if (!body) throw new Error('not a docx');
  const byName = (re: RegExp) => zip.file(re).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const headers = byName(/^word\/header\d*\.xml$/).slice(0, MAX_EXTRA_PARTS);
  const footers = byName(/^word\/footer\d*\.xml$/).slice(0, MAX_EXTRA_PARTS - headers.length);
  const decoder = new TextDecoder();
  const lines: string[] = [];
  const kept = { chars: 0 };
  let budget = MAX_XML_BYTES;
  let stopped = false;
  for (const part of [...headers, body, ...footers]) {
    const bytes = await inflateCapped(part, budget);
    if (!bytes) throw new Error('docx too large');
    budget -= bytes.byteLength;
    if ((stopped = addPartLines(decoder.decode(bytes), lines, kept))) break;
  }
  const whole = lines.join('\n');
  const text = cutText(whole, MAX_TEXT_CHARS);
  return { text, truncated: stopped || text.length < whole.length, picturesOnly: !text && zip.file(/^word\/media\//).length > 0 };
}
