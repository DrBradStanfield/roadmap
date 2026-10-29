// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { NumericInputCell } from './NumericInputCell';

afterEach(cleanup);

// US-02 AC4: strip safe decorations, never join separate numeric tokens.
describe('NumericInputCell pasted syntax', () => {
  function cell(canonical = false) {
    function Cell() {
      const [value, setValue] = useState('');
      return <NumericInputCell value={value} onChange={setValue} wrapperClass="test-cell"
        validationResult={canonical ? null : undefined} />;
    }
    return render(<Cell />);
  }

  it.each(['-5', '+5', '−5', '1e1', '1E+1', '1\t2', '1 2', '1/2', '<5', '≤5', '≥5', '±5', '1.2.3', '－5', '＋5', '＜5', '＞5', '10³', '⁻5', '1５'])('keeps %j invalid, including free-form lab rows', text => {
    const view = cell();
    const input = view.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    expect(input.value).toBe(text);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByText(text === '1.2.3' ? 'Enter a number' : 'Type one decimal number, without signs, < > or spaces')).toBeTruthy();
    fireEvent.change(input, { target: { value: '5,2' } });
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it.each([['5,2', '5,2'], [' 5.2 % ', '5.2'], ['5.2 mg/dL', '5.2'], ['(5.2)', '5.2'], ['abc', '']])('keeps safe paste %j as %j', (text, expected) => {
    const input = cell().getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: text } });
    expect(input.value).toBe(expected);
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('refuses spreadsheet lines before a single-line input can remove the separator', () => {
    const view = cell();
    const input = view.getByRole('textbox') as HTMLInputElement;
    fireEvent.paste(input, { clipboardData: { getData: () => '1\n2' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByText('Type one decimal number, without signs, < > or spaces')).toBeTruthy();
  });

  it.each(['1\n2', '1\r\n2', '1\r2'])('US-02 AC4: select-all corrects bad paste %j without a leftover digit', text => {
    const input = cell().getByRole('textbox') as HTMLInputElement;
    fireEvent.paste(input, { clipboardData: { getData: () => text } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.select();
    fireEvent.paste(input, { clipboardData: { getData: () => '5.2' } });
    expect(input.value).toBe('5.2');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });
  it.each(['<0.5', '1 234'])('US-02 AC4: explains how to correct %j', text => {
    const view = cell();
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: text } });
    expect(view.getByRole('textbox', { description: 'Type one decimal number, without signs, < > or spaces' })).toBe(input);
  });

  it.each(['1\n2', '1\r\n2', '1\t2'])('US-02 AC4: intercepts dropped spreadsheet text %j before the browser joins digits', text => {
    const input = cell().getByRole('textbox') as HTMLInputElement;
    const event = createEvent.drop(input, { dataTransfer: { getData: () => text } });
    fireEvent(input, event);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe(text.replace(/\r\n|[\r\n]/g, ' '));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.select();
    fireEvent.drop(input, { dataTransfer: { getData: () => '5,2 %' } });
    expect(input.value).toBe('5,2');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });
});

// US-02 AC5 / US-13 AC5: only review's canonical result may replace local
// display validation. Existing save-error callers keep null-as-fallback.
describe('NumericInputCell validation authority', () => {
  const props = { metric: 'hdl' as const, display: 'conventional' as const,
    value: '201', onChange: () => {}, wrapperClass: 'test-cell' };

  it.each([undefined, null])('keeps local range validation when externalError is %s', externalError => {
    const { getByRole, getByText } = render(<NumericInputCell {...props} externalError={externalError} />);
    expect(getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
    expect(getByText('Max 200 mg/dL')).toBeTruthy();
  });

  it('accepts an explicit canonical-valid result without a rounded-local error', () => {
    const { getByRole, queryByText } = render(<NumericInputCell {...props} validationResult={null} />);
    expect(getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
    expect(queryByText('Max 200 mg/dL')).toBeNull();
  });

  it('shows an authoritative canonical error instead of the rounded-local error', () => {
    const { getByRole } = render(<NumericInputCell {...props} validationResult="Canonical error" />);
    expect(getByRole('textbox', { description: 'Canonical error' }).getAttribute('title')).toBeNull();
  });

  it('keeps external save errors ahead of an explicit valid result', () => {
    const { getByRole } = render(<NumericInputCell {...props} validationResult={null} externalError="Save failed" />);
    expect(getByRole('textbox', { description: 'Save failed' }).getAttribute('title')).toBeNull();
  });
});

// US-02 AC7: "1,234" asks which was meant where both readings could be right.
describe('NumericInputCell: an ambiguous comma (US-02 AC7)', () => {
  const base = { onChange: () => {}, wrapperClass: 'test-cell' };
  const ASK = 'Did you mean 1234 or 1.234?';

  it('asks in a metric cell where both readings are in range', () => {
    const { getByRole } = render(<NumericInputCell {...base} metric="triglycerides" display="conventional" value="1,234" />);
    expect(getByRole('textbox', { description: ASK }).getAttribute('aria-invalid')).toBe('true');
  });

  it('accepts thousands where the decimal reading is below the range (creatinine in µmol/L)', () => {
    const { getByRole, queryByText } = render(<NumericInputCell {...base} metric="creatinine" display="si" value="1,234" />);
    expect(getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
    expect(queryByText(ASK)).toBeNull();
  });

  // Adversary R1: the decimal reading is never chosen, even where only it fits.
  it('asks where only the decimal reading is in range (triglycerides in mmol/L)', () => {
    const { getByRole } = render(<NumericInputCell {...base} metric="triglycerides" display="si" value="1,234" />);
    expect(getByRole('textbox', { description: ASK }).getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses grouped thousands in a free-form cell, which has no range to check them', () => {
    const { getByRole } = render(<NumericInputCell {...base} value="1,234,567" />);
    expect(getByRole('textbox', { description: 'Type the number without commas.' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('asks in a free-form cell, which has no range', () => {
    const { getByRole } = render(<NumericInputCell {...base} value="1,234" />);
    expect(getByRole('textbox', { description: ASK }).getAttribute('aria-invalid')).toBe('true');
  });

  it('shows nothing while the value is still on its way ("1,2", "1,23")', () => {
    for (const value of ['1,2', '1,23']) {
      const { getByRole } = render(<NumericInputCell {...base} value={value} />);
      expect(getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
      cleanup();
    }
  });
});
