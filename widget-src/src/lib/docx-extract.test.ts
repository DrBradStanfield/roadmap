/**
 * US-12 AC12: a .docx is read in the browser into one text page. Each table
 * row is one line, its cells in order joined by " | "; headers come first,
 * footers last. Synthetic files built here with JSZip; every value is made up.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { docxToText } from './docx-extract';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
/** A paragraph of runs, each with formatting the extractor must ignore. */
const p = (...runs: string[]) =>
  `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.map(t => `<w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;
const tc = (...paras: string[]) =>
  `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paras.length ? paras.map(t => p(t)).join('') : '<w:p/>'}</w:tc>`;
const tr = (...cells: string[]) => `<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>${cells.map(c => (c ? tc(c) : tc())).join('')}</w:tr>`;
const tbl = (...rows: string[]) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${rows.join('')}</w:tbl>`;

async function docx(body: string, parts: Record<string, string> = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`);
  zip.file('word/styles.xml', `<w:styles ${NS}><w:style><w:name w:val="Not body text"/></w:style></w:styles>`);
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
const hdr = (xml: string) => `<w:hdr ${NS}>${xml}</w:hdr>`;
const ftr = (xml: string) => `<w:ftr ${NS}>${xml}</w:ftr>`;

describe('US-12 AC12: docxToText', () => {
  it('keeps each table row on one line, its cells in order, an empty previous result in its column', async () => {
    const text = await docxToText(await docx(tbl(
      tr('Test', 'Result', 'Previous result', 'Unit', 'Reference range'),
      tr('Ferritin', '85', '60', 'ug/L', '30-400'),
      tr('HbA1c', '38', '', 'mmol/mol', '20-41'),
    )));
    expect(text).toBe([
      'Test | Result | Previous result | Unit | Reference range',
      'Ferritin | 85 | 60 | ug/L | 30-400',
      'HbA1c | 38 |  | mmol/mol | 20-41',
    ].join('\n'));
  });

  it('keeps paragraphs and tables in document order, and drops empty paragraphs and all-empty rows', async () => {
    const text = await docxToText(await docx(
      p('Baseline bloods') + '<w:p/>' + p('') + tbl(tr('LDL', '2.9'), tr('', ''), tr('HDL', '1.4')) + p('Comment: fasting sample'),
    ));
    expect(text).toBe('Baseline bloods\nLDL | 2.9\nHDL | 1.4\nComment: fasting sample');
  });

  it('joins runs split mid-word, a cell of several paragraphs, tabs and breaks', async () => {
    const split = '<w:p><w:r><w:t>Ferr</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>itin</w:t></w:r><w:r><w:tab/><w:t>85</w:t><w:br/><w:t>ug/L</w:t></w:r></w:p>';
    const text = await docxToText(await docx(split + tbl(tr('Lipids', 'LDL 2.9')).replace(p('LDL 2.9'), p('LDL 2.9') + p('HDL 1.4'))));
    expect(text).toBe('Ferritin 85 ug/L\nLipids | LDL 2.9 HDL 1.4');
  });

  it('decodes XML entities once', async () => {
    const text = await docxToText(await docx(p('eGFR &gt;90 &amp; CRP &lt;1.0 &#x2264;5 &#956;mol &quot;a&quot; &apos;b&apos; &amp;lt;')));
    expect(text).toBe('eGFR >90 & CRP <1.0 ≤5 μmol "a" \'b\' &lt;');
  });

  it('reads headers first and footers last, where a report date often sits', async () => {
    const text = await docxToText(await docx(p('Body line'), {
      'word/header1.xml': hdr(p('Collected 01/02/2024')),
      'word/footer1.xml': ftr(p('Page 1 of 1')),
    }));
    expect(text).toBe('Collected 01/02/2024\nBody line\nPage 1 of 1');
  });

  it('ignores tracked deletions, field codes and a text box fallback copy', async () => {
    const body = '<w:p><w:del><w:r><w:delText>old 99</w:delText></w:r></w:del><w:ins><w:r><w:t>new 42</w:t></w:r></w:ins></w:p>'
      + '<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>Lab ref</w:t></w:r></w:p>'
      + '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>' + p('Boxed') + '</w:txbxContent></mc:Choice>'
      + '<mc:Fallback><w:pict><w:txbxContent>' + p('Boxed') + '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>';
    expect(await docxToText(await docx(body))).toBe('new 42\nLab ref\nBoxed');
  });

  it('gives empty text for a document with no words', async () => {
    expect(await docxToText(await docx('<w:p/>' + tbl(tr('', ''))))).toBe('');
  });

  it('rejects a file that is not a ZIP, and a ZIP with no document part', async () => {
    await expect(docxToText(new TextEncoder().encode('not a zip').buffer as ArrayBuffer)).rejects.toThrow();
    const zip = new JSZip();
    zip.file('notes.txt', 'x');
    await expect(docxToText(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow();
  });

  it('stops inflating past the XML cap: a small file that inflates huge (a ZIP bomb) is refused', async () => {
    const bomb = await docx(p('a'.repeat(5 * 1024 * 1024)));
    expect(bomb.byteLength).toBeLessThan(100 * 1024);
    await expect(docxToText(bomb)).rejects.toThrow(/too large/);
  });

  it('reads crafted XML of unclosed tags in linear time, not quadratic', async () => {
    // 1 MB of `<w:t ` and `<mc:Fallback` opens with no close: each once scanned to the end of the part.
    const crafted = '<w:t x'.repeat(90_000) + '<mc:Fallback>'.repeat(40_000);
    expect(crafted.length).toBeGreaterThan(1_000_000);
    const file = await docx(crafted);
    const started = performance.now();
    expect(await docxToText(file)).toBe('');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps every line of a document with more paragraphs than a call takes arguments', async () => {
    // JavaScriptCore caps a call near 65k arguments, V8 near 125k; a spread push past it throws.
    const count = 150_000;
    const text = await docxToText(await docx('<w:p><w:t>a</w:t></w:p>'.repeat(count)));
    expect(text.split('\n')).toHaveLength(count);
  });

  it('counts headers and footers toward the cap too', async () => {
    const big = 'b'.repeat(3 * 1024 * 1024);
    await expect(docxToText(await docx(p(big), { 'word/header1.xml': hdr(p(big)) }))).rejects.toThrow(/too large/);
  });
});
