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

/** XML inflated across every part read: a ZIP bomb stops here, not in memory. */
const MAX_XML_BYTES = 4 * 1024 * 1024;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** JSZip's streaming reader, which its typings leave undeclared (the connector's `inflateCapped` uses it too). */
interface EntryStream {
  on(event: 'data', handler: (chunk: Uint8Array) => void): EntryStream;
  on(event: 'end' | 'error', handler: (error?: Error) => void): EntryStream;
  pause(): EntryStream;
  resume(): EntryStream;
}

/** Inflate one part, counting bytes against what is left of the cap. */
function inflateCapped(entry: JSZip.JSZipObject, budget: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array');
    stream.on('data', (chunk) => {
      if (size > budget) return;
      size += chunk.byteLength;
      if (size > budget) {
        stream.pause();
        reject(new Error('docx too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error) => reject(error));
    stream.on('end', () => {
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.byteLength; }
      resolve(out);
    });
    stream.resume();
  });
}

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
const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<(\/?)w:(p|tr|tc|tab|br|cr)(?=[\s/>])[^>]*>/g;

/** One XML part's lines: paragraphs and table rows in document order. */
function partLines(xml: string): string[] {
  // A text box is written twice, the modern copy and a fallback: keep one.
  const source = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
  const lines: string[] = [];
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
    } else if (rows.length) {
      const row = rows[rows.length - 1];
      if (close) row.cells.push(row.cell.join(' ')); // tc
      row.cell = [];
    }
  }
  return lines;
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
    budget -= bytes.byteLength;
    lines.push(...partLines(decoder.decode(bytes)));
  }
  return lines.join('\n');
}

/** Returns true if the file looks like a .docx */
export function isDocx(file: File): boolean {
  return file.type === DOCX_MIME || file.name.toLowerCase().endsWith('.docx');
}

/** Returns true for a legacy Word .doc, which this reader cannot open. */
export function isLegacyDoc(file: File): boolean {
  return file.type === 'application/msword' || file.name.toLowerCase().endsWith('.doc');
}
