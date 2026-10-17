/** US-12 AC12: one rule for what a picked file is, read by the modal and counted the same way. */
import { describe, it, expect } from 'vitest';
import { isDocx, isLegacyDoc } from './file-kinds';

describe('US-12 AC12: isDocx and isLegacyDoc', () => {
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
