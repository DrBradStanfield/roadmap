/**
 * US-12 AC13: a .docx is read in the browser into one text page. Each table
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

describe('US-12 AC13: docxToText', () => {
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

  it('leaves a lone surrogate code point as written, never half a character', async () => {
    const { text } = await docxToText(await docx(p('a &#xD800; b &#56320; c')));
    expect(text).toBe('a &#xD800; b &#56320; c');
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

describe('US-12 AC13: what a lab sheet in Word holds beyond plain runs', () => {
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
    expect(await read(raw(t('WBC 6.1 '), sym('F0B4'), t('10^9/L, 37'), sym('F0B0'), t('C, 2'), sym('F0D7'), t('3, '), sym('F061'), sym('F062'), sym('F067')))).toBe('WBC 6.1 ×10^9/L, 37°C, 2·3, αβγ');
    expect(await read(raw(t('Haemo'), run('<w:softHyphen/>'), t('globin 140')))).toBe('Haemoglobin 140');
  });

  it('shows a symbol it cannot map as a visible "?", never nothing', async () => {
    expect(await read(raw(t('Done '), run('<w:sym w:font="Wingdings" w:char="F0FC"/>')))).toBe('Done ?');
    expect(await read(raw(t('A '), run('<w:sym w:font="Symbol" w:char="F0E5"/>'), t(' B')))).toBe('A ? B');
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
    expect(await read(raw(t('Result: 4'), box, t(' end')))).toBe('Result: 4\n5 mmol/L\nend');
  });

  it('keeps each label before its boxed value, in reading order', async () => {
    const boxed = (value: string) => run('<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>' + p(value)
      + '</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>' + p(value)
      + '</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent>');
    expect(await read(raw(t('LDL '), boxed('2.9 mmol/L')) + raw(t('Ferritin '), boxed('85 ug/L')))).toBe('LDL\n2.9 mmol/L\nFerritin\n85 ug/L');
  });

  it('drops a fallback nested inside another whole, never leaking the outer one\'s tail', async () => {
    const inner = '<w:r><mc:AlternateContent><mc:Choice Requires="w14"></mc:Choice><mc:Fallback><w:t>x</w:t></mc:Fallback></mc:AlternateContent></w:r>';
    const box = run('<mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>' + p('85 ug/L') + '</w:txbxContent></mc:Choice>'
      + '<mc:Fallback><w:pict><w:txbxContent><w:p>' + inner + t('85 ug/L') + '</w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>');
    expect(await read(raw(t('Ferritin '), box))).toBe('Ferritin\n85 ug/L');
  });

  it('ignores the old properties a tracked formatting change keeps, so they never re-apply a merge or a deletion', async () => {
    const head = tr('Test', 'Result', 'Prev', 'Unit');
    const rowChange = '<w:tr><w:trPr><w:gridBefore w:val="1"/><w:trPrChange w:id="9" w:author="a"><w:trPr><w:gridBefore w:val="1"/></w:trPr></w:trPrChange></w:trPr>'
      + tc('42') + tc('40') + tc('mmol/mol') + '</w:tr>';
    const cellChange = '<w:tr>' + tc('HbA1c') + '<w:tc><w:tcPr><w:tcPrChange w:id="5" w:author="a"><w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tcPrChange></w:tcPr>'
      + p('38') + '</w:tc>' + tc('36') + tc('mmol/mol') + '</w:tr>';
    const delAfterChange = '<w:tr><w:trPr><w:trPrChange w:id="7" w:author="a"><w:trPr><w:cantSplit/></w:trPr></w:trPrChange><w:del w:id="3" w:author="a"/></w:trPr>'
      + tc('Ferritin') + tc('58') + tc('') + tc('ug/L') + '</w:tr>';
    const changes = '<w:p><w:pPr><w:pPrChange w:id="1" w:author="a"><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr></w:pPrChange></w:pPr>'
      + '<w:r><w:rPr><w:rPrChange w:id="2" w:author="a"><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>Comment</w:t></w:r></w:p>';
    const tableChange = '<w:tbl><w:tblPr><w:tblPrChange w:id="4" w:author="a"><w:tblPr/></w:tblPrChange></w:tblPr>' + tr('LDL', '2.9') + '</w:tbl>';
    expect(await read(tbl(head, rowChange, cellChange, delAfterChange) + changes + tableChange)).toBe([
      'Test | Result | Prev | Unit',
      ' | 42 | 40 | mmol/mol',
      'HbA1c | 38 | 36 | mmol/mol',
      'Comment',
      'LDL | 2.9',
    ].join('\n'));
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

  it('cuts one line longer than the cap at its last space, never inside a number', async () => {
    const { text, truncated } = await docxToText(await docx(p('Ferritin 85 ug/L '.repeat(4000))));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(text.endsWith('Ferritin 85 ug/L')).toBe(true);
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

describe('US-12 AC13: a document whose WordprocessingML prefix is not w:', () => {
  it('reads the prefixes the root binds to the main and markup-compatibility namespaces', async () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    const body = '<ns0:p><ns0:r><ns0:t>Ferritin</ns0:t></ns0:r></ns0:p>'
      + '<ns0:tbl><ns0:tr><ns0:tc><ns0:p><ns0:r><ns0:t>LDL</ns0:t></ns0:r></ns0:p></ns0:tc><ns0:tc><ns0:p><ns0:r><ns0:t>2.9</ns0:t></ns0:r></ns0:p></ns0:tc></ns0:tr></ns0:tbl>'
      + '<ns0:p><ns0:r><compat:AlternateContent><compat:Choice Requires="wps"><ns0:t>Box</ns0:t></compat:Choice><compat:Fallback><ns0:t>Box</ns0:t></compat:Fallback></compat:AlternateContent></ns0:r></ns0:p>';
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><ns0:document xmlns:ns0="${W}" xmlns:compat="${MC}"><ns0:body>${body}</ns0:body></ns0:document>`);
    const { text } = await docxToText(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(text).toBe('Ferritin\nLDL | 2.9\nBox');
  });
});

// Review 2026-10-18 (adversary R3, Codex): what a real Word table writes.
describe('US-12 AC13: vertical merges, run-level deletions and loose attribute syntax', () => {
  const read = async (body: string) => (await docxToText(await docx(body))).text;
  const vm = (val: string | null, text: string) =>
    `<w:tc><w:tcPr>${val === null ? '<w:vMerge/>' : `<w:vMerge w:val="${val}"/>`}</w:tcPr>${text ? p(text) : '<w:p/>'}</w:tc>`;

  it('a vertically merged unit column gives each continued row its restart cell\'s text', async () => {
    expect(await read(tbl(
      tr('Test', 'Result', 'Unit'),
      `<w:tr>${tc('Ferritin')}${tc('85')}${vm('restart', 'ug/L')}</w:tr>`,
      `<w:tr>${tc('Iron')}${tc('18')}${vm(null, '')}</w:tr>`,
      `<w:tr>${tc('B12')}${tc('400')}${vm('continue', '')}</w:tr>`,
      `<w:tr>${tc('Folate')}${tc('20')}${tc('nmol/L')}</w:tr>`,
      `<w:tr>${tc('Zinc')}${tc('14')}${vm(null, '')}</w:tr>`,
    ))).toBe([
      'Test | Result | Unit',
      'Ferritin | 85 | ug/L',
      'Iron | 18 | ug/L',
      'B12 | 400 | ug/L',
      'Folate | 20 | nmol/L',
      'Zinc | 14 | ',
    ].join('\n'));
  });

  // Final review 2026-10-18 (Codex + adversary).
  it('a row deletion marker deletes its row whether written self-closing or as an empty pair', async () => {
    const row = (marker: string) => `<w:tr><w:trPr>${marker}</w:trPr>${tc('Ferritin')}${tc('58')}</w:tr>`;
    for (const marker of ['<w:del w:id="9" w:author="Lab" w:date="2024-01-02T00:00:00Z"/>', '<w:del w:id="9" w:author="Lab" w:date="2024-01-02T00:00:00Z"></w:del>']) {
      expect(await read(tbl(tr('Test', 'Result'), row(marker), tr('HbA1c', '38'))), marker).toBe('Test | Result\nHbA1c | 38');
    }
  });

  it('a continuation cell with its own text keeps it', async () => {
    expect(await read(tbl(`<w:tr>${tc('A')}${vm('restart', 'x')}</w:tr>`, `<w:tr>${tc('B')}${vm(null, 'y')}</w:tr>`))).toBe('A | x\nB | y');
  });

  it('a deleted row never starts a merge (probe A)', async () => {
    const deleted = `<w:tr><w:trPr><w:del w:id="1" w:author="a" w:date="2024"/></w:trPr>${tc('Old')}${vm('restart', 'mg/dL')}</w:tr>`;
    expect(await read(tbl(tr('Test', 'Unit'), deleted, `<w:tr>${tc('LDL')}${vm(null, '')}</w:tr>`))).toBe('Test | Unit\nLDL | ');
  });

  it('an unmerged cell spanning columns ends every merge it covers (probe B)', async () => {
    const wide = '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="3"/></w:tcPr>' + p('wide') + '</w:tc></w:tr>';
    expect(await read(tbl(`<w:tr>${tc('a')}${tc('b')}${vm('restart', 'U')}</w:tr>`, wide, `<w:tr>${tc('c')}${tc('d')}${vm(null, '')}</w:tr>`)))
      .toBe('a | b | U\nwide |  | \nc | d | ');
  });

  it('stops copying merged text once past the cap: a thousand rows of merged columns finish fast, truncated', async () => {
    // 15 merged columns of 40,000 characters down 1,000 rows: 600 million
    // characters copied, past the longest string JavaScript can hold.
    const restart = 'Long unit note '.repeat(2667);
    const cols = 15;
    const rows = [
      `<w:tr>${tc('Test')}${vm('restart', restart).repeat(cols)}</w:tr>`,
      ...Array.from({ length: 1000 }, (_, i) => `<w:tr>${tc(`T${i}`)}${vm(null, '').repeat(cols)}</w:tr>`),
    ];
    const started = performance.now();
    const { text, truncated } = await docxToText(await docx(tbl(...rows)));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
  });

  // Review of c1362acd (Codex + adversary).
  it('reads many open rows then many cell closes, and deep balanced nesting, in linear time', async () => {
    // 64 open rows (the cap) and many cell closes, so every close runs the running count.
    let started = performance.now();
    await docxToText(await docx('<w:tr>'.repeat(64) + '<w:tc></w:tc>'.repeat(200_000)));
    expect(performance.now() - started).toBeLessThan(3000);
    const nest = (depth: number): string => (depth ? `<w:tbl><w:tr><w:tc>${nest(depth - 1)}</w:tc></w:tr></w:tbl>` : p('core'));
    // Within the cap of 64 open rows, nesting reads whole.
    expect(await docxToText(await docx(nest(64)))).toMatchObject({ text: 'core', truncated: false });
    // Past it, reading stops and says so (Word never nests tables near that deep).
    started = performance.now();
    expect(await docxToText(await docx(p('top') + nest(2000)))).toMatchObject({ text: 'top', truncated: true });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // The adversary's perf probe: 16,000 nested rows around 1 MB of text would
  // copy it up through every level.
  it('stops at the nesting cap before deep rows copy a long text up each level', async () => {
    const depth = 16_000;
    const body = '<w:tr><w:tc>'.repeat(depth) + `<w:p><w:r><w:t>${'a '.repeat(500_000)}</w:t></w:r></w:p>` + '</w:tc><w:tc></w:tc></w:tr>'.repeat(depth);
    const file = await docx(body);
    const started = performance.now();
    expect((await docxToText(file)).truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // stop2 R1: rows nested in a deleted row are deleted too.
  it('a row nested in a deleted row is deleted with it: it copies nothing and an early stop never prints it', async () => {
    const note = 'N'.repeat(500);
    const inner = tbl(`<w:tr>${tc('Head')}${vm('restart', note)}</w:tr>`, ...Array.from({ length: 200 }, (_, i) => `<w:tr>${tc(`DELETEDTEXT${i}`)}${vm(null, '')}</w:tr>`));
    const deleted = `<w:tr><w:trPr><w:del w:id="1" w:author="a" w:date="2024"/></w:trPr><w:tc>${inner}</w:tc></w:tr>`;
    expect(await docxToText(await docx(p('Before') + tbl(deleted) + p('After 58')))).toMatchObject({ text: 'Before\nAfter 58', truncated: false });
  });

  it('a deleted row neither copies merge text nor counts it, so what follows is kept', async () => {
    const mid = 'Fasting sample; result reported per local reference interval. '.repeat(40);
    const head = `<w:tr>${tc('Head')}${vm('restart', mid).repeat(15)}</w:tr>`;
    const gone = `<w:tr><w:trPr><w:del w:id="1" w:author="a" w:date="2024"/></w:trPr>${tc('Old')}${vm(null, '').repeat(15)}</w:tr>`;
    const { text, truncated } = await docxToText(await docx(tbl(head, gone) + p('Ferritin 58 ug/L')));
    expect(text.endsWith('\nFerritin 58 ug/L')).toBe(true);
    expect(truncated).toBe(false);
  });

  it('an empty pair with whitespace between the tags, or inside the close, is still a row marker', async () => {
    const row = `<w:tr><w:trPr><w:del w:id="1" w:author="a" w:date="2024"> </w:del ></w:trPr>${tc('Gone')}${tc('9')}</w:tr>`;
    expect(await read(tbl(tr('Keep', '1'), row))).toBe('Keep | 1');
  });

  it('an early stop inside a nested table keeps the text the enclosing row held so far', async () => {
    const note = 'Serum, collected 01/05/2024 08:00, fasting, ref lab ABC 12345';
    const inner = tbl(`<w:tr>${tc('Ferritin')}${tc('58')}${vm('restart', note)}</w:tr>`, ...Array.from({ length: 1100 }, (_, i) => `<w:tr>${tc(`Test${i}`)}${tc(String(i))}${vm(null, '')}</w:tr>`));
    const { text, truncated } = await docxToText(await docx(p('Patient summary') + tbl(`<w:tr><w:tc>${p('Report 2024-05-01')}${inner}</w:tc></w:tr>`)));
    expect(truncated).toBe(true);
    // Each piece the open cell holds is its own line, so the cut keeps whole rows.
    expect(text.startsWith('Patient summary\nReport 2024-05-01\nFerritin | 58 | Serum')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
  });

  it('a merge in one table never reaches into the next', async () => {
    expect(await read(
      tbl(`<w:tr>${tc('Ferritin')}${vm('restart', 'ug/L')}</w:tr>`)
      + tbl(`<w:tr>${tc('Iron')}${vm(null, '')}</w:tr>`),
    )).toBe('Ferritin | ug/L\nIron | ');
  });

  it('drops a deleted run whole, with the symbol, tab and hyphen it holds', async () => {
    const deleted = '<w:del w:id="3" w:author="Lab" w:date="2024-01-02T00:00:00Z"><w:r><w:sym w:font="Symbol" w:char="F03C"/><w:tab/><w:noBreakHyphen/><w:delText>99</w:delText></w:r></w:del>';
    expect(await read(`<w:p><w:r><w:t>CRP </w:t></w:r>${deleted}<w:r><w:t>1.0</w:t></w:r></w:p>`)).toBe('CRP 1.0');
  });

  it('reads attributes with spaces around "=" and single quotes', async () => {
    const spanned = "<w:tc><w:tcPr><w:gridSpan w:val='2'/></w:tcPr>" + p('38') + '</w:tc>';
    expect(await read(tbl(tr('Test', 'Result', 'Previous', 'Unit'), `<w:tr>${tc('HbA1c')}${spanned}${tc('mmol/mol')}</w:tr>`)))
      .toBe('Test | Result | Previous | Unit\nHbA1c | 38 |  | mmol/mol');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><ns0:document xmlns:ns0 = '${W}'><ns0:body><ns0:p><ns0:r><ns0:t>Ferritin 85</ns0:t></ns0:r></ns0:p></ns0:body></ns0:document>`);
    expect((await docxToText(await zip.generateAsync({ type: 'arraybuffer' }))).text).toBe('Ferritin 85');
  });
});
