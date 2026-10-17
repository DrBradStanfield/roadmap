/**
 * Client-side .docx text extraction (US-12 AC12) using JSZip.
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

/** XML inflated across every part read: a ZIP bomb stops here, not in memory. */
const MAX_XML_BYTES = 4 * 1024 * 1024;

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** One pass, so `&amp;lt;` stays `&lt;`. A code point out of range stays as written. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()];
    const code = parseInt(hex ?? dec ?? '', hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** A text run, or a paragraph, row, cell, tab or break tag. `w:delText` and
 *  `w:instrText` never match, so tracked deletions and field codes drop out. */
const TOKEN = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<(\/?)w:(p|tr|tc|tab|br|cr)(?=[\s/>])[^<>]*>/g;

const FALLBACK_OPEN = '<mc:Fallback';
const FALLBACK_CLOSE = '</mc:Fallback>';

/** A text box is written twice, the modern copy and a fallback: keep one.
 *  A scan, not a lazy regex, so an open tag with no close costs one pass. */
function dropFallbacks(xml: string): string {
  let out = '';
  let at = 0;
  for (let open = xml.indexOf(FALLBACK_OPEN); open >= 0; open = xml.indexOf(FALLBACK_OPEN, open + 1)) {
    if (open < at || /\w/.test(xml[open + FALLBACK_OPEN.length] ?? '')) continue;
    const close = xml.indexOf(FALLBACK_CLOSE, open);
    if (close < 0) break;
    out += xml.slice(at, open);
    at = close + FALLBACK_CLOSE.length;
  }
  return out + xml.slice(at);
}

/** Add one XML part's lines to `lines`: paragraphs and table rows in document order. */
function addPartLines(xml: string, lines: string[]): void {
  const source = dropFallbacks(xml);
  /** Open rows, innermost last; each holds its cells, and the paragraphs of the open cell. */
  const rows: Array<{ cells: string[]; cell: string[] }> = [];
  let para = '';
  /** A finished paragraph or nested row goes to the open cell, or out as a line. */
  const emit = (text: string) => {
    if (!text) return;
    if (rows.length) rows[rows.length - 1].cell.push(text);
    else lines.push(text);
  };
  for (const [, text, close, tag] of source.matchAll(TOKEN)) {
    if (text !== undefined) { para += decodeEntities(text); continue; }
    if (tag === 'tab' || tag === 'br' || tag === 'cr') { para += ' '; continue; }
    if (tag === 'p') {
      if (close) { emit(para.replace(/\s+/g, ' ').trim()); para = ''; }
    } else if (tag === 'tr') {
      if (!close) rows.push({ cells: [], cell: [] });
      else {
        const row = rows.pop();
        if (row && row.cells.some(Boolean)) emit(row.cells.join(' | '));
      }
    } else if (close && rows.length) { // tc
      const row = rows[rows.length - 1];
      row.cells.push(row.cell.join(' '));
      row.cell = [];
    }
  }
}

/**
 * The document's text, headers first and footers last, one table row per
 * line. Empty when it holds no words; throws when it is not a .docx or its
 * XML passes MAX_XML_BYTES.
 */
export async function docxToText(data: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const body = zip.file('word/document.xml');
  if (!body) throw new Error('not a docx');
  const byName = (re: RegExp) => zip.file(re).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  const parts = [...byName(/^word\/header\d*\.xml$/), body, ...byName(/^word\/footer\d*\.xml$/)];
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let budget = MAX_XML_BYTES;
  for (const part of parts) {
    const bytes = await inflateCapped(part, budget);
    if (!bytes) throw new Error('docx too large');
    budget -= bytes.byteLength;
    addPartLines(decoder.decode(bytes), lines);
  }
  return lines.join('\n');
}
