/** US-12 AC13: one rule for what a picked file is, read by the modal and counted the same way. */
import { describe, it, expect } from 'vitest';
import { isDocx, isLegacyDoc, viewableType } from './file-kinds';

describe('US-12 AC13: isDocx and isLegacyDoc', () => {
  const file = (name: string, type = '') => new File([], name, { type });
  it('knows a .docx by its mime type or its extension, in any case', () => {
    expect(isDocx(file('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe(true);
    expect(isDocx(file('Baseline.DOCX'))).toBe(true);
    expect(isDocx(file('baseline.doc'))).toBe(false);
    expect(isDocx(file('baseline.pdf', 'application/pdf'))).toBe(false);
  });
  it('knows a legacy .doc by its mime type or its extension, never a .docx', () => {
    expect(isLegacyDoc(file('x', 'application/msword'))).toBe(true);
    expect(isLegacyDoc(file('Old.DOC'))).toBe(true);
    expect(isLegacyDoc(file('new.docx'))).toBe(false);
  });
});

describe('US-14 AC3: viewableType', () => {
  it('opens a passive type when the ref and the stored bytes agree', () => {
    expect(viewableType('Lab reports/2024-06-01 Panel.pdf', 'application/pdf')).toBe('application/pdf');
    expect(viewableType('Other documents/2024-06-01 Scan.PNG', 'image/png')).toBe('image/png');
    expect(viewableType('Other documents/2024-06-01 Scan.jpg', 'image/jpeg')).toBe('image/jpeg');
    expect(viewableType('Other documents/2024-06-01 Scan.jpeg', 'image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(viewableType('Other documents/2024-06-01 Scan.heic', 'image/heic')).toBe('image/heic');
  });
  it('goes by the extension when the backend returns untyped bytes (Dropbox, GitHub)', () => {
    expect(viewableType('Lab reports/2024-06-01 Panel.pdf', '')).toBe('application/pdf');
    expect(viewableType('Lab reports/2024-06-01 Panel.pdf', 'application/octet-stream')).toBe('application/pdf');
  });
  it('downloads anything else: an active type, a mismatch, an unknown or missing extension', () => {
    expect(viewableType('Other documents/2024-06-01 Chart.svg', 'image/svg+xml')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Chart.svg', '')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Scan.png', 'image/svg+xml')).toBeNull();
    expect(viewableType('Lab reports/2024-06-01 Panel.pdf', 'text/html')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Page.html', 'text/html')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Data.xml', 'application/xml')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
    expect(viewableType('Other documents/2024-06-01 Letter', '')).toBeNull();
  });
});
