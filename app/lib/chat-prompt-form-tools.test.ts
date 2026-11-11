/**
 * US-16 AC4: the website chat prompt's `propose_field_edit` line names the
 * measurements the tool takes, and only those. The tool's enum is
 * EDITABLE_FIELDS (chat-edits.ts); a field outside it is dropped, so a prompt
 * that names it tells the model it can pre-fill a cell that never fills.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { EDITABLE_FIELDS } from '../../packages/health-core/src/chat-edits';
import { LONGITUDINAL_FIELDS } from '../../packages/health-core/src/mappings';

const system = readFileSync('app/lib/chat-system-prompt.md', 'utf-8');
const fieldEditLine = system.split('\n').find((line) => line.startsWith('- **`propose_field_edit`**')) ?? '';

/** How the prompt line names each longitudinal field. */
const PROMPT_NAME: Record<string, RegExp> = {
  weightKg: /\bweight\b/,
  waistCm: /\bwaist\b/,
  systolicBp: /\bsystolic\b/,
  diastolicBp: /\bdiastolic\b/,
  ldlC: /\bLDL\b/,
  hdlC: /\bHDL\b/,
  totalCholesterol: /\btotal cholesterol\b/,
  triglycerides: /\btriglycerides\b/,
  hba1c: /\bHbA1c\b/,
  apoB: /\bApoB\b/,
  creatinine: /\bcreatinine\b/,
  lpa: /\bLp\(a\)/,
  psa: /\bPSA\b/,
};

/** The list the line gives, cut before its example sentence ("my LDL was ..."). */
const listed = fieldEditLine.slice(0, fieldEditLine.indexOf('Use it when'));

describe('US-16 AC4: the chat prompt offers propose_field_edit only for the fields it takes', () => {
  it('has a name for every longitudinal field', () => {
    expect(fieldEditLine).not.toBe('');
    expect(Object.keys(PROMPT_NAME).sort()).toEqual([...LONGITUDINAL_FIELDS].sort());
  });

  it.each([...LONGITUDINAL_FIELDS])('%s is named exactly when EDITABLE_FIELDS holds it', (field) => {
    const editable = (EDITABLE_FIELDS as readonly string[]).includes(field);
    expect(PROMPT_NAME[field].test(editable ? listed : fieldEditLine), `${field} editable=${editable}`).toBe(editable);
  });
});
