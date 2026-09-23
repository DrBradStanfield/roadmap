// @vitest-environment jsdom
/**
 * US-09 AC15 — a refused connect is SAID, above the widget where every connect
 * path lands, with the way back into the picker. A refusal the user never sees
 * reads as "the connect just did nothing".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { OPEN_PICKER_EVENT } from '../src/lib/storage-notice';
import { ConnectRefusedNotice } from './connect-refused';

afterEach(cleanup);

describe('ConnectRefusedNotice (US-09 AC15)', () => {
  it('shows the refusal, and "Try again" opens the storage picker', () => {
    const opened = vi.fn();
    window.addEventListener(OPEN_PICKER_EVENT, opened);
    const { getByRole, getByText } = render(<ConnectRefusedNotice message="Google Drive was not connected." />);

    expect(getByRole('alert').textContent).toContain('Google Drive was not connected.');
    fireEvent.click(getByText('Try again'));
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_PICKER_EVENT, opened);
  });

  it('can be dismissed', () => {
    const { getByText, queryByRole } = render(<ConnectRefusedNotice message="x" />);
    fireEvent.click(getByText('Dismiss'));
    expect(queryByRole('alert')).toBeNull();
  });
});
