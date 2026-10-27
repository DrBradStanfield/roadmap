// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NumericInputCell } from './NumericInputCell';

afterEach(cleanup);

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
