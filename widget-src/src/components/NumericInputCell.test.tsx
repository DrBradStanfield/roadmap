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
    expect(getByRole('textbox').getAttribute('title')).toBe('Canonical error');
  });

  it('keeps external save errors ahead of an explicit valid result', () => {
    const { getByRole } = render(<NumericInputCell {...props} validationResult={null} externalError="Save failed" />);
    expect(getByRole('textbox').getAttribute('title')).toBe('Save failed');
  });
});
