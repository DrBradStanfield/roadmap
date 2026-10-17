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
    const { text } = await docxToText(await docx(tbl(
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
    const { text } = await docxToText(await docx(
      p('Baseline bloods') + '<w:p/>' + p('') + tbl(tr('LDL', '2.9'), tr('', ''), tr('HDL', '1.4')) + p('Comment: fasting sample'),
    ));
    expect(text).toBe('Baseline bloods\nLDL | 2.9\nHDL | 1.4\nComment: fasting sample');
  });

  it('joins runs split mid-word, a cell of several paragraphs, tabs and breaks', async () => {
    const split = '<w:p><w:r><w:t>Ferr</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>itin</w:t></w:r><w:r><w:tab/><w:t>85</w:t><w:br/><w:t>ug/L</w:t></w:r></w:p>';
    const { text } = await docxToText(await docx(split + tbl(tr('Lipids', 'LDL 2.9')).replace(p('LDL 2.9'), p('LDL 2.9') + p('HDL 1.4'))));
    expect(text).toBe('Ferritin 85 ug/L\nLipids | LDL 2.9 HDL 1.4');
  });

  it('decodes XML entities once', async () => {
    const { text } = await docxToText(await docx(p('eGFR &gt;90 &amp; CRP &lt;1.0 &#x2264;5 &#956;mol &quot;a&quot; &apos;b&apos; &amp;lt;')));
    expect(text).toBe('eGFR >90 & CRP <1.0 ≤5 μmol "a" \'b\' &lt;');
  });

  it('reads headers first and footers last, where a report date often sits', async () => {
    const { text } = await docxToText(await docx(p('Body line'), {
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
    expect((await docxToText(await docx(body))).text).toBe('new 42\nLab ref\nBoxed');
  });

  it('gives empty text for a document with no words', async () => {
    expect((await docxToText(await docx('<w:p/>' + tbl(tr('', ''))))).text).toBe('');
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
    expect((await docxToText(file)).text).toBe('');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps every line of a document with more paragraphs than a call takes arguments', async () => {
    // JavaScriptCore caps a call near 65k arguments, V8 near 125k; a spread push past it throws.
    // The text cap then keeps the first 30,000 of its 150,000 one-letter lines.
    const { text, truncated } = await docxToText(await docx('<w:p><w:t>a</w:t></w:p>'.repeat(150_000)));
    expect(truncated).toBe(true);
    expect(text.split('\n')).toHaveLength(30_000);
  });

  it('counts headers and footers toward the cap too', async () => {
    const big = 'b'.repeat(3 * 1024 * 1024);
    await expect(docxToText(await docx(p(big), { 'word/header1.xml': hdr(p(big)) }))).rejects.toThrow(/too large/);
  });
});

describe('US-12 AC12: what a lab sheet in Word holds beyond plain runs', () => {
  const run = (xml: string) => `<w:r>${xml}</w:r>`;
  const t = (s: string) => run(`<w:t>${s}</w:t>`);
  const raw = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
  const read = async (body: string, parts?: Record<string, string>) => (await docxToText(await docx(body, parts))).text;

  it('skips a table row deleted with tracked changes, whole', async () => {
    const deleted = '<w:tr><w:trPr><w:del w:id="9" w:author="Lab" w:date="2024-01-02T00:00:00Z"/></w:trPr>' + tc('Ferritin') + tc('58') + '</w:tr>';
    expect(await read(tbl(tr('Test', 'Result'), deleted, tr('HbA1c', '38')))).toBe('Test | Result\nHbA1c | 38');
  });

  it('reads a non-breaking hyphen, a positional tab and the Symbol font\'s signs; drops a soft hyphen', async () => {
    const sym = (char: string, font = 'Symbol') => run(`<w:sym w:font="${font}" w:char="${char}"/>`);
    expect(await read(raw(t('Range 30'), run('<w:noBreakHyphen/>'), t('400')))).toBe('Range 30-400');
    expect(await read(raw(t('Ferritin'), run('<w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/>'), t('85')))).toBe('Ferritin 85');
    expect(await read(raw(t('CRP '), sym('F03C'), t('1.0 '), sym('F03E'), t('0 '), sym('F0A3'), t('5 '), sym('F0B3'), t('6 '), sym('F06D'), t('mol '), sym('F0B1'), t('2')))).toBe('CRP <1.0 >0 ≤5 ≥6 µmol ±2');
    expect(await read(raw(t('eGFR '), sym('2265', 'Cambria Math'), t('90')))).toBe('eGFR ≥90');
    expect(await read(raw(t('Ratio '), sym('F033'), sym('F02E'), sym('F032')))).toBe('Ratio 3.2');
    expect(await read(raw(t('Haemo'), run('<w:softHyphen/>'), t('globin 140')))).toBe('Haemoglobin 140');
  });

  it('shows a symbol it cannot map as a visible "?", never nothing', async () => {
    expect(await read(raw(t('Done '), run('<w:sym w:font="Wingdings" w:char="F0FC"/>')))).toBe('Done ?');
    expect(await read(raw(t('A '), run('<w:sym w:font="Symbol" w:char="F061"/>'), t(' B')))).toBe('A ? B');
  });

  it('never starts a drop at a self-closing fallback', async () => {
    const box = '<mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>' + p('Box') + '</w:txbxContent></mc:Choice><mc:Fallback><w:pict>' + p('Box') + '</w:pict></mc:Fallback></mc:AlternateContent>';
    const empty = '<mc:AlternateContent><mc:Choice Requires="x"/><mc:Fallback/></mc:AlternateContent>';
    expect(await read(p('Before') + empty + p('Ferritin 85') + box + p('After'))).toBe('Before\nFerritin 85\nBox\nAfter');
  });

  it('pads merged cells, so a row keeps the header\'s columns', async () => {
    const spanned = '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + p('38') + '</w:tc>';
    const before = '<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>' + tc('42') + tc('40') + tc('mmol/mol') + '</w:tr>';
    const after = '<w:tr><w:trPr><w:gridAfter w:val="2"/></w:trPr>' + tc('LDL') + tc('2.9') + '</w:tr>';
    const merged = '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>' + tc('HDL') + tc('1.4') + tc('mmol/L') + '</w:tr>';
    expect(await read(tbl(
      tr('Test', 'Result', 'Previous', 'Unit'),
      `<w:tr>${tc('HbA1c')}${spanned}${tc('mmol/mol')}</w:tr>`,
      before, after, merged,
    ))).toBe([
      'Test | Result | Previous | Unit',
      'HbA1c | 38 |  | mmol/mol',
      ' | 42 | 40 | mmol/mol',
      'LDL | 2.9 |  | ',
      ' | HDL | 1.4 | mmol/L',
    ].join('\n'));
  });

  it('drops text moved away with tracked changes, keeps it where it moved to', async () => {
    const markedMark = '<w:p><w:pPr><w:rPr><w:moveFrom w:id="3" w:author="Lab" w:date="2024-01-02T00:00:00Z"/></w:rPr></w:pPr>' + t('Comment') + '</w:p>';
    expect(await read(
      raw('<w:moveFromRangeStart w:id="1" w:name="m"/><w:moveFrom w:id="1">' + t('Ferritin 85') + '</w:moveFrom><w:moveFromRangeEnd w:id="1"/>')
      + p('LDL 2.9') + markedMark
      + raw('<w:moveTo w:id="2">' + t('Ferritin 85') + '</w:moveTo>'),
    )).toBe('LDL 2.9\nComment\nFerritin 85');
  });

  it('keeps a text box\'s paragraph off the paragraph it sits in', async () => {
    const box = run('<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' + p('5 mmol/L') + '</w:txbxContent></w:drawing></mc:Choice></mc:AlternateContent>');
    const lines = (await read(raw(t('Result: 4'), box, t(' end')))).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining(['5 mmol/L', 'Result: 4 end']));
  });

  it('stops at 60,000 characters, at a line end, and says it was cut short', async () => {
    const line = 'Ferritin | 85 | 60 | ug/L | 30-400'; // 34 characters
    const whole = await docxToText(await docx(p(line).repeat(1000)));
    expect(whole.truncated).toBe(false);
    const long = await docxToText(await docx(p(line).repeat(3000)));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(60_000);
    expect(long.text.length).toBeGreaterThan(59_000);
    expect(long.text.split('\n').every(l => l === line)).toBe(true);
  });

  it('reads at most 50 header and footer parts in all', async () => {
    const parts: Record<string, string> = {};
    for (let i = 1; i <= 30; i++) parts[`word/header${i}.xml`] = hdr(p(`h${i}`));
    for (let i = 1; i <= 30; i++) parts[`word/footer${i}.xml`] = ftr(p(`f${i}`));
    const lines = (await read(p('Body'), parts)).split('\n');
    expect(lines).toHaveLength(51);
    expect(lines.slice(0, 31)).toEqual([...Array.from({ length: 30 }, (_, i) => `h${i + 1}`), 'Body']);
    expect(lines.at(-1)).toBe('f20');
  });

  it('flattens what formatting means, as a PDF text layer does: hidden text is read, a superscript joins the line (not covered)', async () => {
    const sup = run('<w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>9</w:t>');
    expect(await read(raw(t('WBC 6.1 x10'), sup, t('/L')))).toBe('WBC 6.1 x109/L');
    expect(await read(raw(t('Ferritin '), run('<w:rPr><w:vanish/></w:rPr><w:t>draft </w:t>'), t('85')))).toBe('Ferritin draft 85');
  });

  it('says when a file with no text holds pictures', async () => {
    const zipped = async (withText: boolean) => {
      const zip = await JSZip.loadAsync(await docx(withText ? p('Ferritin 85') : '<w:p/>'));
      zip.file('word/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      return docxToText(await zip.generateAsync({ type: 'arraybuffer' }));
    };
    expect(await zipped(false)).toEqual({ text: '', truncated: false, picturesOnly: true });
    expect(await zipped(true)).toEqual({ text: 'Ferritin 85', truncated: false, picturesOnly: false });
    expect((await docxToText(await docx('<w:p/>'))).picturesOnly).toBe(false);
  });
});
